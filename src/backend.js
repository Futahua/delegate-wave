import fs from "node:fs";
import path from "node:path";
import { runProcess } from "./process.js";

const INLINE_POLICY = {
  $schema: "https://opencode.ai/config.json",
  agent: {
    "delegate-wave-reader": {
      description: "Bounded read-only repository investigator confined to one attempt worktree",
      mode: "primary",
      steps: 16,
      permission: {
        read: "allow",
        edit: "deny",
        glob: "allow",
        grep: "allow",
        list: "allow",
        lsp: "deny",
        bash: "deny",
        external_directory: "deny",
        task: "deny",
        skill: "deny",
        webfetch: "deny",
        websearch: "deny",
        question: "deny",
      },
    },
    "delegate-wave-worker": {
      description: "Bounded implementation worker confined to one disposable attempt worktree",
      mode: "primary",
      steps: 24,
      permission: {
        read: "allow",
        edit: "allow",
        glob: "allow",
        grep: "allow",
        list: "allow",
        lsp: "deny",
        bash: "deny",
        external_directory: "deny",
        task: "deny",
        skill: "deny",
        webfetch: "deny",
        websearch: "deny",
        question: "deny",
      },
    },
  },
};

export class FakeBackend {
  constructor(handler = async () => ({ exitCode: 0, stdout: "fake success", stderr: "" })) {
    this.handler = handler;
  }

  async run(context) {
    return this.handler(context);
  }
}

export class OpenCodeBackend {
  constructor({ executable, prefixArgs, attach, timeoutMs = 30 * 60_000, launchResolver = defaultOpenCodeLaunch } = {}) {
    if (executable) {
      this.executable = executable;
      this.prefixArgs = prefixArgs ?? [];
    } else {
      const launch = launchResolver();
      this.executable = launch.executable;
      this.prefixArgs = prefixArgs ?? launch.prefixArgs;
    }
    this.attach = attach;
    this.timeoutMs = timeoutMs;
  }

  async run({ attemptId, worktreePath, instruction, goal, model, artifactDir, mode, onSpawn }) {
    // Both dispatcher-contract checks happen before any side effect.
    //
    // The model check used to sit after the artifact streams were opened, so a refusal still left
    // two empty log files behind for an attempt that never ran.
    //
    // Fail closed rather than omit the flag: without --model OpenCode falls back to its own ambient
    // default provider, which is exactly the non-deterministic behaviour this dispatcher forbids.
    if (!model) throw new Error("OpenCodeBackend requires an explicit --model; the dispatcher must resolve one");
    // No fallback to the objective. A managed attempt whose brief failed to arrive would otherwise
    // run against the human's sentence and leave no trace that it happened.
    if (typeof instruction !== "string" || !instruction.trim()) {
      throw new Error("OpenCodeBackend requires an explicit instruction; the dispatcher must resolve one");
    }
    const task = instruction;
    fs.mkdirSync(artifactDir, { recursive: true });
    const stdoutPath = path.join(artifactDir, "opencode-events.jsonl");
    const stderrPath = path.join(artifactDir, "opencode-stderr.log");
    const stdoutStream = fs.createWriteStream(stdoutPath, { flags: "wx" });
    const stderrStream = fs.createWriteStream(stderrPath, { flags: "wx" });
    const prompt = mode === "read"
      ? `Investigate this task without modifying files. Return concise findings with exact file paths and evidence.\n\nTask: ${task}`
      : `Implement this bounded task in the current worktree. Do not commit, push, modify Git metadata, or access files outside this worktree. Shell access is intentionally disabled; edit only the necessary files.\n\nTask: ${task}`;
    const args = [...this.prefixArgs,
      "run", prompt,
      "--agent", mode === "read" ? "delegate-wave-reader" : "delegate-wave-worker",
      "--format", "json",
      "--dir", worktreePath,
      "--title", `delegate-wave ${attemptId}`,
    ];
    args.push("--model", model);
    if (this.attach) args.push("--attach", this.attach);
    const result = await runProcess(this.executable, args, {
      cwd: worktreePath,
      timeoutMs: this.timeoutMs,
      env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(INLINE_POLICY) },
      onSpawn,
      onStdout: (text) => stdoutStream.write(text),
      onStderr: (text) => stderrStream.write(text),
    });
    await Promise.all([
      new Promise((resolve) => stdoutStream.end(resolve)),
      new Promise((resolve) => stderrStream.end(resolve)),
    ]);
    return {
      ...result, stdoutPath, stderrPath,
      // Set only when this adapter recognises one of ITS OWN local-initialization failures. Null
      // otherwise, which leaves the conservative UNKNOWN path in force.
      preProviderFailure: classifyPreProviderFailure({ result, stdoutPath, stderrPath }),
      // What can honestly be claimed here: delegate-wave launched OpenCode with this exact --model,
      // and that argv is mechanical evidence. Nothing in this path observes what the provider then
      // served, and this backend has no reasoning-effort parameter at all -- so effort stays null
      // rather than inheriting the value the Harness path happens to use.
      provenance: {
        appliedModel: model,
        appliedExecutor: "opencode",
        appliedSource: "opencode-argv",
      },
    };
  }
}

// Recognises failures that happened before OpenCode could have issued a provider request.
//
// The bar is deliberately high, because the consequence of a false positive is recording real spend
// as zero. Three independent conditions must hold together:
//
//   1. the process did not exit cleanly;
//   2. its event stream is EMPTY -- not merely missing a usage record, but zero bytes, so no step,
//      no message and no tool call was ever emitted;
//   3. stderr carries a signature this adapter knows belongs to OpenCode's local startup.
//
// Condition 3 is what makes the claim positive rather than inferred. OpenCode opens a SQLite state
// database as one of its first acts; when that open fails the process aborts inside its own
// initialization, with no network stack engaged and no provider reachable. On 2026-08-19 three
// workers launched 8ms apart contended for one shared 717MB database and two of them died exactly
// here -- see docs/research/DOGFOOD-RUN-4.md.
//
// Conditions 1 and 2 alone are NOT sufficient and must never be used on their own: a worker that
// bought tokens and then crashed before flushing its log satisfies both.
const PRE_PROVIDER_SIGNATURES = [
  // Local SQLite state database could not be opened or configured.
  { pattern: /Failed to run the query 'PRAGMA /i, reason: "OpenCode failed to initialize its local SQLite state database" },
  { pattern: /unable to open database file/i, reason: "OpenCode could not open its local state database file" },
];

export function classifyPreProviderFailure({ result, stdoutPath, stderrPath }) {
  if (result?.exitCode === 0) return null;
  // An empty event stream, established by size rather than by parse: a file that failed to parse may
  // still describe provider work.
  let events = null;
  try { events = fs.statSync(stdoutPath); } catch { return null; }
  if (events.size !== 0) return null;

  let stderr = "";
  try { stderr = fs.readFileSync(stderrPath, "utf8"); } catch { return null; }
  const matched = PRE_PROVIDER_SIGNATURES.find(({ pattern }) => pattern.test(stderr));
  if (!matched) return null;

  return {
    evidence: `${matched.reason}. stderr: ${stderr.trim().replace(/s+/g, " ").slice(0, 400)}`,
    artifact: stderrPath,
    format: "opencode-stderr",
  };
}

function defaultOpenCodeLaunch() {
  if (process.platform !== "win32") return { executable: "opencode", prefixArgs: [] };
  const configuredEntry = process.env.OPENCODE_NODE_ENTRY;
  if (!configuredEntry && !process.env.APPDATA) {
    throw new Error("APPDATA is unavailable; set OPENCODE_NODE_ENTRY or pass an executable explicitly");
  }
  const entry = configuredEntry
    ?? path.join(process.env.APPDATA, "npm", "node_modules", "opencode-ai", "bin", "opencode");
  if (!fs.existsSync(entry)) {
    throw new Error("OpenCode Node entry was not found; set OPENCODE_NODE_ENTRY or pass an executable explicitly");
  }
  return { executable: process.execPath, prefixArgs: [entry] };
}
