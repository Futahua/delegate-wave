// The DeepSeek Harness executor backend.
//
// Satisfies the same contract as OpenCodeBackend -- run one bounded attempt in one disposable
// worktree, return a process result, leave raw evidence on disk -- so cancel, timeout, budget
// enforcement and the attempt invariant apply unchanged.
//
// Design notes that are not obvious from the code:
//
//  * Transport. The planned design was JSON-RPC over stdio. That surface does not exist in
//    @deepseek-ai/dsh@0.1.0-rc.6: the RPC layer rides a Cordis connection whose transport is
//    HTTP-up/WebSocket-down, which would mean a listening socket per worker on a product whose
//    Control API is deliberately the only listening surface. So this drives `--profile headless` as
//    a child process, and takes its evidence from the session log the run persists.
//
//  * Evidence. Headless batches session writes and exits before the batch drains, which is why an
//    earlier canary found an empty session file and concluded usage was unobtainable. Configuring
//    the persistence plugin to flush immediately, uncompressed, into the attempt's own artifact
//    directory makes the full event stream durable -- including per-call usage and the `turn/end`
//    that marks the turn genuinely finished.
//
//  * Authority. The restricted patch removes every capability the worker contract forbids, and the
//    filesystem service is replaced outright, because Harness's sandbox fences writes only and a
//    live worker demonstrated reading an absolute path outside its workspace.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runProcess } from "../process.js";
import { observeHarnessArtifact } from "./usage.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export const HARNESS_PACKAGE = "@deepseek-ai/dsh";
export const HARNESS_VERSION = "0.1.0-rc.6";
export const SESSION_LOG_NAME = "harness-session.jsonl";

// Capabilities removed from the stock headless profile.
//
// Each is a capability the worker contract does not grant, not a preference. `permission` is
// disabled because the presets service waits on the shell service, so removing the shell requires
// removing its dependent; its presets exist to gate shell and exec permissions this worker has no
// way to use. `code-runtime` is included because Harness documents its worker-thread runtime as
// containment rather than a security boundary, with authority comparable to a shell -- and unlike
// what an earlier survey assumed, it IS present in stock headless.
const DISABLED_PLUGINS = Object.freeze([
  "tool-bash", "tool-pwsh", "bash-sandbox", "pwsh-sandbox", "shell-env",
  "permission",
  "tool-skill", "skill", "skill-filesystem", "skill-badge",
  "user-questions",
  "code-runtime",
]);

const yamlString = (value) => JSON.stringify(String(value));

// fs-local validates this on construction; 1 MiB matches its own default scale and bounds how much
// of a file is held for diff comparison.
const DIFF_BASIS_MAX_BYTES = 1024 * 1024;

// Builds the profile patch for one attempt.
//
// Written per attempt rather than shared, because the persistence root and the fence root are both
// attempt-specific. A shared patch would leak one attempt's session log into another's evidence.
export function buildAttemptPatch({ worktreePath, artifactDir, model, baseUrl, apiKeyEnv, reasoningEffort }) {
  const lines = DISABLED_PLUGINS.map((id) => `- id: ${id}\n  disabled: true`);

  lines.push([
    "- id: llm-deepseek",
    "  name: '@deepseek-ai/dsh-llm-deepseek'",
    "  config:",
    `    apiKeyEnv: ${apiKeyEnv}`,
    `    baseURL: ${baseUrl}`,
    "    models:",
    `      - id: ${model}`,
    `        name: ${yamlString(model)}`,
  ].join("\n"));

  lines.push([
    "- id: agent-default-model",
    "  config:",
    "    provider: deepseek-official",
    `    model: ${model}`,
    // Pinned rather than left to the adapter's default, so reasoning effort is a stated property of
    // the run instead of whatever the route happened to choose.
    "    thinking: enabled",
    `    reasoningEffort: ${reasoningEffort}`,
  ].join("\n"));

  // Durable evidence, in this attempt's own artifact directory. Uncompressed so the log is readable
  // without a decompressor, and flushed immediately so a run that exits promptly does not discard
  // the events that prove what it cost.
  lines.push([
    "- id: session-persistence-jsonl",
    "  config:",
    `    root: ${yamlString(path.join(artifactDir, "sessions").replace(/\\/g, "/"))}`,
    "    compression: none",
    "    writeBatchMaxDelayMs: 1",
  ].join("\n"));

  // The filesystem fence. Replaces the provider rather than configuring the sandbox, because the
  // sandbox permits reads in every mode.
  // The filesystem provider is swapped: the stock one is disabled and the fenced one inserted.
  //
  // Two details of the loader make this the only correct shape, both learned by watching it refuse
  // the alternatives:
  //
  //  * Headless has no `fs-local` entry. `fs-sandbox` IS the provider of the `fs` service, so
  //    disabling it without inserting a replacement leaves the boot failing with
  //    `tool-fs: pending (waiting for service: fs)`.
  //  * `name` on an existing id is an ASSERTION, not a substitution. Pointing `fs-sandbox` at a
  //    different module logs "name mismatch ... skipping" and silently keeps the stock provider --
  //    a fence that looks configured and is not. `insert` adds a genuinely new entry instead.
  lines.push("- id: fs-sandbox\n  name: '@deepseek-ai/dsh-fs-sandbox'\n  disabled: true");
  lines.push([
    "- insert:",
    "    - id: delegate-wave-fenced-fs",
    // A file:// URL, not a path: Node's ESM loader reads a bare Windows path's drive letter as a
    // URL scheme and refuses it.
    `      name: ${yamlString(pathToFileURL(path.join(here, "fs-plugin.js")).href)}`,
    "      config:",
    `        attemptRoot: ${yamlString(worktreePath.replace(/\\/g, "/"))}`,
    // Inherited from fs-local's own config contract, which validates it regardless of subclassing.
    `        diffBasisMaxBytes: ${DIFF_BASIS_MAX_BYTES}`,
  ].join("\n"));

  return `${lines.join("\n")}\n`;
}

export class HarnessBackend {
  constructor({
    harnessHome,
    model = "deepseek-v4-flash",
    baseUrl = "https://opencode.ai/zen/go/v1",
    apiKeyEnv = "OPENCODE_GO_API_KEY",
    apiKey = null,
    reasoningEffort = "high",
    timeoutMs = 30 * 60_000,
  } = {}) {
    if (!harnessHome) throw new Error("HarnessBackend requires the directory where dsh is installed");
    this.harnessHome = harnessHome;
    this.entry = path.join(harnessHome, "node_modules", HARNESS_PACKAGE, "lib", "bin.js");
    this.model = model;
    this.baseUrl = baseUrl;
    this.apiKeyEnv = apiKeyEnv;
    this.apiKey = apiKey;
    this.reasoningEffort = reasoningEffort;
    this.timeoutMs = timeoutMs;
  }

  sessionLogPath(artifactDir) {
    const root = path.join(artifactDir, "sessions");
    if (!fs.existsSync(root)) return null;
    // The persistence plugin nests one directory per workspace and one per session. Exactly one
    // session exists per attempt, so the first log found is this attempt's.
    const stack = [root];
    while (stack.length) {
      const current = stack.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.name === "session.jsonl") return full;
      }
    }
    return null;
  }

  // The dispatcher prefers this over artifact scraping. It supplies a neutral observation only;
  // pricing stays in the finalizer so no executor computes the comparator it is measured by.
  observeUsage({ artifactDir }) {
    return observeHarnessArtifact(this.sessionLogPath(artifactDir));
  }

  // Boots the profile in config-dump mode and confirms the composed tree really is fenced.
  //
  // Checks both halves, because either alone is insufficient: the fenced provider must be present,
  // AND the stock sandbox must be gone. A tree containing both would be ambiguous about which one
  // provides `fs`, and the answer must never be left to load order.
  async assertFenceComposed(patchPath, artifactDir) {
    const dump = await runProcess(process.execPath, [
      this.entry, "--profile", "headless", "--patch", patchPath, "--dump-config",
    ], {
      cwd: this.harnessHome,
      timeoutMs: 120_000,
      env: { [this.apiKeyEnv]: this.apiKey, DELEGATE_WAVE_HARNESS_HOME: this.harnessHome },
    });

    if (artifactDir) {
      // Kept as evidence: what the tree actually was, not what the patch asked for.
      fs.writeFileSync(path.join(artifactDir, "harness-composed-config.txt"), dump.stdout ?? "");
    }
    if (dump.exitCode !== 0) {
      throw new Error(`Harness refused to compose the fenced profile: ${(dump.stderr ?? "").slice(-500)}`);
    }

    const composed = dump.stdout ?? "";
    if (!composed.includes("delegate-wave-fenced-fs")) {
      throw new Error(
        "Refusing to run: the fenced filesystem is not in the composed Harness profile. "
        + `The loader skipped it. ${(dump.stderr ?? "").slice(-300)}`,
      );
    }
    // The stock sandbox permits every read, so it must be disabled rather than merely outranked.
    const sandbox = composed.match(/- id: fs-sandbox\n(?:.*\n)*?(?=- id: |$)/);
    if (sandbox && !sandbox[0].includes("disabled: true")) {
      throw new Error("Refusing to run: the stock Harness fs-sandbox is still active alongside the fence");
    }
  }

  async run({ attemptId, worktreePath, goal, model, artifactDir, mode, onSpawn }) {
    if (!model) throw new Error("HarnessBackend requires an explicit model; the dispatcher must resolve one");
    if (!fs.existsSync(this.entry)) {
      throw new Error(`Harness is not installed at ${this.entry}; expected ${HARNESS_PACKAGE}@${HARNESS_VERSION}`);
    }
    if (!this.apiKey) throw new Error("HarnessBackend requires an API key; it is never read from the ambient environment");

    fs.mkdirSync(artifactDir, { recursive: true });
    const patchPath = path.join(artifactDir, "harness-profile.patch.yml");
    fs.writeFileSync(patchPath, buildAttemptPatch({
      worktreePath,
      artifactDir,
      model,
      baseUrl: this.baseUrl,
      apiKeyEnv: this.apiKeyEnv,
      reasoningEffort: this.reasoningEffort,
    }));

    // Verify the fence is actually in the tree the process will boot, before any worker runs.
    //
    // The loader skips patch entries it does not accept and merely WARNS -- it does not fail. A
    // rejected fence would leave the worker running against the stock provider, which permits every
    // read, while every visible signal said the attempt was confined. That failure is silent by
    // construction, so it is checked rather than assumed.
    await this.assertFenceComposed(patchPath, artifactDir);

    const stdoutPath = path.join(artifactDir, "harness-stdout.log");
    const stderrPath = path.join(artifactDir, "harness-stderr.log");
    const stdoutStream = fs.createWriteStream(stdoutPath, { flags: "wx" });
    const stderrStream = fs.createWriteStream(stderrPath, { flags: "wx" });

    const prompt = mode === "read"
      ? `Investigate this task without modifying files. Return concise findings with exact file paths and evidence.\n\nTask: ${goal}`
      : `Implement this bounded task in the current worktree. Do not commit, push, modify Git metadata, or access files outside this worktree. Shell access is intentionally disabled; edit only the necessary files.\n\nTask: ${goal}`;

    const result = await runProcess(process.execPath, [
      this.entry, "--profile", "headless", "--patch", patchPath, prompt,
    ], {
      cwd: worktreePath,
      timeoutMs: this.timeoutMs,
      // The key is passed explicitly rather than inherited, so a worker's credentials are exactly
      // what this call granted it. The Harness home travels the same way, because the fenced
      // filesystem plugin is loaded by absolute path and cannot otherwise resolve Harness's own
      // packages from delegate-wave's module graph.
      env: {
        [this.apiKeyEnv]: this.apiKey,
        DELEGATE_WAVE_HARNESS_HOME: this.harnessHome,
      },
      onSpawn,
      onStdout: (text) => stdoutStream.write(text),
      onStderr: (text) => stderrStream.write(text),
    });

    await Promise.all([
      new Promise((resolve) => stdoutStream.end(resolve)),
      new Promise((resolve) => stderrStream.end(resolve)),
    ]);

    return { ...result, stdoutPath, stderrPath, sessionLogPath: this.sessionLogPath(artifactDir) };
  }
}
