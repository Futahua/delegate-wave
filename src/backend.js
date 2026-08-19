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
      description: "Implementation worker with build tooling, confined to one disposable worktree",
      mode: "primary",
      steps: 24,
      permission: {
        read: "allow",
        edit: "allow",
        glob: "allow",
        grep: "allow",
        list: "allow",
        lsp: "deny",
        // An implementation worker without a shell cannot install dependencies, compile, run tests,
        // or regenerate build output -- and this project's objective requires committed build
        // artifacts, which no amount of hand-editing can honestly reproduce. In dogfood run 6 both
        // attempts asked for a shell, were refused, and burned their entire budget failing.
        //
        // Withholding it never protected anything that mattered. delegate-wave's guarantees do not
        // rest on worker containment: the candidate is captured through delegate-wave's own Git
        // index rather than the worker's, validation runs independently afterwards, and no change
        // integrates without a human. What the worker CLAIMS is still worth nothing; what it can
        // REACH was never the control. This matches the Harness path, whose default profile is
        // 'trusted' for the same stated reason.
        //
        // The reader keeps its denial. An investigation has nothing to build, and the frozen
        // executor comparison depends on it not reaching verifiers outside its worktree.
        bash: "allow",
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

// What a worker running under one of these agents can be asked to do.
//
// Derived from the policy actually in force, not written out by hand, so the envelope cannot drift
// away from the permissions it describes. A hand-maintained copy would eventually lie, and a lying
// capability envelope is worse than none: the manager would trust it.
export function openCodeCapabilities(mode) {
  const agent = INLINE_POLICY.agent[mode === "read" ? "delegate-wave-reader" : "delegate-wave-worker"];
  const allowed = (name) => agent.permission[name] === "allow";
  return {
    read_files: allowed("read"),
    edit_files: allowed("edit"),
    shell: allowed("bash"),
    // Everything below needs a shell under this executor, so they follow it rather than being
    // asserted separately.
    run_build: allowed("bash"),
    run_tests: allowed("bash"),
    git: allowed("bash"),
    network: allowed("webfetch") || allowed("websearch"),
  };
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

  capabilities({ mode } = {}) { return openCodeCapabilities(mode); }

  async run({ attemptId, worktreePath, instruction, goal, model, artifactDir, mode, scratchDir, onSpawn }) {
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
    // Absent scratchDir the executor falls back to its shared per-user database, which is correct
    // for a single ad-hoc run and unsafe for concurrent ones.
    const openCodeDatabase = resolveOpenCodeDatabase(scratchDir);
    const stdoutStream = fs.createWriteStream(stdoutPath, { flags: "wx" });
    const stderrStream = fs.createWriteStream(stderrPath, { flags: "wx" });
    const prompt = mode === "read"
      ? `Investigate this task without modifying files. Return concise findings with exact file paths and evidence.\n\nTask: ${task}`
      : `Implement this bounded task in the current worktree.\n\nWrite code early and often. Make your first edit within the first few actions, then build the rest incrementally, checking as you go. Do not survey the whole repository before writing anything: the task below already carries what investigation established, and re-deriving it costs the budget you need for the work. An attempt that reads everything and writes nothing has failed, however well it understood the problem.\n\nYou may run commands: installing dependencies, building, and running tests are expected where the task needs them. Do not commit, push, or modify Git metadata -- delegate-wave captures the candidate from the resulting files itself, so committing is neither required nor honoured. Do not touch files outside this worktree.\n\nTask: ${task}`;
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
      env: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify(INLINE_POLICY),
        // One state database per attempt.
        //
        // OpenCode otherwise keeps a single per-user SQLite database, and delegate-wave's whole
        // shape is to fan out several workers at once. On 2026-08-19 three workers launched 8ms
        // apart and two died on PRAGMA journal_mode = WAL before reaching a provider -- the
        // contention grows with the database, and the shared one had reached 717MB.
        //
        // Isolation rather than serialization: throttling launches would trade away the parallelism
        // that makes cheap workers worth having, to work around state that was never meant to be
        // shared. OpenCode resolves this variable only when it is absolute or ":memory:", so the
        // path is resolved here rather than passed through as given.
        ...(openCodeDatabase ? { OPENCODE_DB: openCodeDatabase } : {}),
      },
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
      // What the TRANSCRIPT says happened, which is not what the exit code says.
      outcome: assessOpenCodeTranscript(stdoutPath),
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

// Whether the agent's turn actually completed, read from OpenCode's own event protocol.
//
// The exit code cannot answer this. During dogfood run 5 two investigations hit a provider 400 --
// [unsupported_tool_schema], non-retryable -- emitted an `error` event, produced no answer, and
// OpenCode still exited 0. delegate-wave recorded both as SUCCEEDED. The manager then spent strong
// turns reasoning around evidence that did not exist, which is the expensive part: a false worker
// success costs more than an honest failure, because the failure would have been retried cheaply.
//
// The protocol distinguishes these cleanly. Every step carries a finish reason; "stop" means the
// model concluded its turn, while "tool-calls" is a mid-turn continuation. The failing runs in run 5
// had six and ten `tool-calls` steps and no `stop` at all, then an error.
//
// Success is NOT tied to a report existing. A worker may legitimately finish with no useful text,
// and conflating "said something" with "completed" would fail honest runs. It is tied to
// protocol-level terminal evidence and nothing else.
//
// Ambiguity resolves to failure in every direction: an unreadable transcript, an empty one, or one
// that simply stops mid-turn is never reported as success.
const TERMINAL_FINISH_REASONS = new Set(["stop"]);

export function assessOpenCodeTranscript(stdoutPath) {
  let text = null;
  try { text = fs.readFileSync(stdoutPath, "utf8"); } catch {
    return { state: "FAILED", reason: "the executor transcript could not be read" };
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return { state: "FAILED", reason: "the executor produced an empty transcript" };

  let terminal = false;
  let malformed = 0;
  const reasons = new Set();
  for (const line of lines) {
    let record = null;
    try { record = JSON.parse(line); } catch { malformed += 1; continue; }
    const type = record?.type ?? record?.event ?? null;
    if (type === "error") {
      const error = record.error ?? {};
      const detail = error.data?.message ?? error.message ?? error.name ?? "unspecified";
      return { state: "FAILED", reason: `the executor reported an error: ${String(detail).slice(0, 300)}` };
    }
    if (type === "step_finish") {
      const reason = record?.part?.reason ?? record?.data?.reason ?? null;
      if (reason) reasons.add(String(reason));
      if (TERMINAL_FINISH_REASONS.has(String(reason))) terminal = true;
    }
  }
  if (terminal) return { state: "SUCCEEDED", reason: "the agent turn finished normally" };
  return {
    state: "FAILED",
    reason: "the transcript carries no terminal completion: "
      + (reasons.size ? `the turn only ever finished steps with reason ${[...reasons].join(", ")}` : "no step ever finished")
      + (malformed ? `, and ${malformed} line(s) were unparseable` : ""),
  };
}

// Where this attempt's private OpenCode state database lives, or null to leave the executor on its
// shared per-user default.
//
// OpenCode honours OPENCODE_DB only when the value is absolute or ":memory:", so a relative path
// would be silently ignored and every worker would quietly land back on the shared database -- the
// failure this exists to prevent, reintroduced with no visible symptom until two workers collide.
export function resolveOpenCodeDatabase(scratchDir) {
  if (!scratchDir) return null;
  const resolved = path.resolve(scratchDir);
  fs.mkdirSync(resolved, { recursive: true });
  return path.join(resolved, "opencode-state.db");
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
