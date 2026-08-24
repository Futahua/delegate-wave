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
//  * Capability vs authority. What a worker MAY DO is a selectable profile, and `trusted` -- broad
//    machine access including shell and code execution -- is the default. What delegate-wave
//    ACCEPTS AS TRUE is not selectable: no profile changes who computes the Git diff, who runs
//    validation, what counts as cost evidence, or what may be integrated. A worker may affect the
//    machine; delegate-wave decides which effects become product state.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runProcess } from "../process.js";
import { observeHarnessArtifact } from "./usage.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export const HARNESS_PACKAGE = "@deepseek-ai/dsh";
export const HARNESS_VERSION = "0.1.0-rc.6";
export const SESSION_LOG_NAME = "harness-session.jsonl";

// What a worker may DO. Deliberately separate from what delegate-wave accepts as true.
//
// These are the two different concerns this system kept conflating: capability policy and
// authoritative control. Capability is a preference and may be broad. Authority is not a preference:
// no profile below changes who computes the Git diff, who runs validation, what counts as cost
// evidence, or what may be integrated. A worker can be powerful without being believed.
//
// `trusted` is the default because these workers are extensions of their operator, not adversaries.
// Denying a coding agent a shell makes it worse at its job, and the value delegate-wave adds was
// never "the worker couldn't reach the filesystem" -- it is that the worker's claims are checked.
//
// `restricted` exists for the case where containment genuinely is the point: the frozen executor
// comparison, whose trusted verifiers live outside the worker repository. A worker that can read
// them can pass every task without doing the work, which destroys the experiment rather than
// endangering the machine.
export const CAPABILITY_PROFILES = Object.freeze({
  // Broad machine access: shell, code execution, subprocesses, developer tooling, skills, and
  // filesystem reads beyond the worktree. Only the unattended-hang case is removed.
  trusted: Object.freeze({
    disabled: Object.freeze(["user-questions"]),
    fenced: false,
    description: "broad machine access; delegate-wave still decides what becomes true",
  }),
  // The original contract, preserved exactly. `permission` is disabled because its presets service
  // waits on the shell service, so removing the shell requires removing its dependent.
  // `code-runtime` is listed explicitly because it IS present in stock headless, contrary to an
  // earlier survey, and Harness documents it as containment rather than a security boundary.
  restricted: Object.freeze({
    disabled: Object.freeze([
      "tool-bash", "tool-pwsh", "bash-sandbox", "pwsh-sandbox", "shell-env",
      "permission",
      "tool-skill", "skill", "skill-filesystem", "skill-badge",
      "user-questions",
      "code-runtime",
    ]),
    fenced: true,
    description: "attempt-root filesystem fence and no shell, code, skills, or questions",
  }),
});

export const DEFAULT_CAPABILITY_PROFILE = "trusted";

export function capabilityProfile(name) {
  const profile = CAPABILITY_PROFILES[name];
  if (!profile) {
    throw new Error(
      `Unknown capability profile: ${name}. Known: ${Object.keys(CAPABILITY_PROFILES).join(", ")}`,
    );
  }
  return profile;
}

const yamlString = (value) => JSON.stringify(String(value));

// fs-local validates this on construction; 1 MiB matches its own default scale and bounds how much
// of a file is held for diff comparison.
const DIFF_BASIS_MAX_BYTES = 1024 * 1024;

// The dispatcher names models by route, as `provider/model`. Harness's DeepSeek adapter wants the
// bare wire model, and the route is expressed separately by baseURL -- so the prefix is stripped
// rather than passed through, which is what produced "Model opencode-go/deepseek-v4-flash is not
// supported" from a run that was otherwise correct.
//
// Only models known to exist on this route are accepted. Guessing by stripping any prefix would
// turn a typo, or a model this route does not carry, into a confusing auth failure deep inside the
// worker instead of a clear refusal here.
export const WIRE_MODELS = Object.freeze({
  "opencode-go/deepseek-v4-flash": "deepseek-v4-flash",
  "opencode-go/deepseek-v4-pro": "deepseek-v4-pro",
  "deepseek-v4-flash": "deepseek-v4-flash",
  "deepseek-v4-pro": "deepseek-v4-pro",
});

export function wireModel(model) {
  const wire = WIRE_MODELS[model];
  if (!wire) {
    throw new Error(
      `HarnessBackend has no wire model for ${model}. `
      + `Known: ${Object.keys(WIRE_MODELS).join(", ")}`,
    );
  }
  return wire;
}

// What the worker is told it may do.
//
// This must match the profile it was actually granted. A worker configured with a shell but
// instructed that "shell access is intentionally disabled" will usually obey the instruction, which
// silently throws away the capability the profile was chosen to provide -- the config says trusted
// and the behaviour stays restricted.
//
// The line that belongs in BOTH prompts is the one about acceptance. A worker may use the machine
// freely; what it may not do is treat its own claims as the verdict. That is the invariant, and it
// is stated to the worker rather than left implicit.
export function workerPrompt({ instruction, mode, profile = DEFAULT_CAPABILITY_PROFILE }) {
  // Required, with no fallback to the objective.
  //
  // A fallback here would be invisible exactly when it matters: a managed attempt whose brief failed
  // to arrive would run against the human's sentence instead, produce a plausible candidate, and pass
  // review -- with nothing in the record showing the manager's instruction never reached anyone. The
  // dispatcher resolves direct mode's objective-as-instruction explicitly before calling, so by the
  // time execution reaches here there is exactly one right answer.
  if (typeof instruction !== "string" || !instruction.trim()) {
    throw new Error("workerPrompt requires an explicit instruction; the dispatcher must resolve one");
  }
  const task = instruction;
  const capabilities = capabilityProfile(profile);
  const acceptance = "Do not treat your own claims as acceptance: delegate-wave validates the result "
    + "afterwards and decides independently what is integrated.";

  if (mode === "read") {
    return "Investigate this task without modifying files. Return concise findings with exact file "
      + `paths and evidence.\n\nTask: ${task}`;
  }

  if (capabilities.fenced) {
    return "Implement this bounded task in the current worktree. Do not commit, push, modify Git "
      + "metadata, or access files outside this worktree. Shell access is intentionally disabled; "
      + `edit only the necessary files. ${acceptance}\n\nTask: ${task}`;
  }

  return "Implement this task, working from the current attempt worktree. Use the machine and "
    + "developer tools available to you: shell, code execution, package and build tools, network, "
    + "tests, and other local project resources, whenever they help you get it right. Local Git is "
    + "yours to use as well -- status, diff, log, blame, bisect, temporary branches, local commits. "
    + "Do not push. Your Git history is workspace activity, not integration: delegate-wave captures "
    + `the resulting tree relative to the base commit and builds its own candidate. ${acceptance}`
    + `\n\nTask: ${task}`;
}

// Builds the profile patch for one attempt.
//
// Written per attempt rather than shared, because the persistence root and the fence root are both
// attempt-specific. A shared patch would leak one attempt's session log into another's evidence.
export function buildAttemptPatch({
  worktreePath, artifactDir, model, baseUrl, apiKeyEnv, reasoningEffort,
  profile = DEFAULT_CAPABILITY_PROFILE,
}) {
  const capabilities = capabilityProfile(profile);
  const lines = capabilities.disabled.map((id) => `- id: ${id}\n  disabled: true`);

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

  // The filesystem provider.
  //
  // Fencing is a PROFILE decision, not an architectural invariant. Under `trusted` the worker keeps
  // Harness's own provider and may read the machine freely, because these workers are extensions of
  // their operator rather than adversaries -- and delegate-wave's guarantees never rested on the
  // worker being unable to reach a file. Under `restricted` the provider is replaced outright,
  // because there containment IS the point: the frozen comparison's verifiers live outside the
  // worker repository, and a worker that reads them passes every task without doing the work.
  //
  // Two details of the loader make the swap's shape the only correct one, both learned by watching
  // it refuse the alternatives:
  //
  //  * Headless has no `fs-local` entry. `fs-sandbox` IS the provider of the `fs` service, so
  //    disabling it without inserting a replacement leaves the boot failing with
  //    `tool-fs: pending (waiting for service: fs)`.
  //  * `name` on an existing id is an ASSERTION, not a substitution. Pointing `fs-sandbox` at a
  //    different module logs "name mismatch ... skipping" and silently keeps the stock provider --
  //    a fence that looks configured and is not. `insert` adds a genuinely new entry instead.
  if (capabilities.fenced) {
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
  }

  return `${lines.join("\n")}\n`;
}

export class HarnessBackend {
  constructor({
    harnessHome,
    // Route-qualified, matching how the dispatcher names models; wireModel() strips the route.
    model = "opencode-go/deepseek-v4-flash",
    baseUrl = "https://opencode.ai/zen/go/v1",
    apiKeyEnv = "OPENCODE_GO_API_KEY",
    apiKey = null,
    reasoningEffort = "high",
    profile = DEFAULT_CAPABILITY_PROFILE,
    timeoutMs = 30 * 60_000,
  } = {}) {
    if (!harnessHome) throw new Error("HarnessBackend requires the directory where dsh is installed");
    this.harnessHome = harnessHome;
    // Identity recorded on every attempt, so "which executor ran this" never needs archaeology.
    this.executorId = "harness";
    // The version actually installed, read from the package rather than remembered. A release
    // candidate that mangles a provider's streamed tool calls is a fact about a VERSION, and an
    // attempt that fails under it should say which one it ran.
    try {
      const manifest = path.join(harnessHome, "node_modules", HARNESS_PACKAGE, "package.json");
      this.executorVersion = HARNESS_PACKAGE + "@" + JSON.parse(fs.readFileSync(manifest, "utf8")).version;
    } catch { this.executorVersion = null; }
    this.entry = path.join(harnessHome, "node_modules", HARNESS_PACKAGE, "lib", "bin.js");
    this.model = model;
    this.baseUrl = baseUrl;
    this.apiKeyEnv = apiKeyEnv;
    this.apiKey = apiKey;
    this.reasoningEffort = reasoningEffort;
    // Validated here rather than at first use, so an unknown profile fails before any attempt row
    // exists instead of partway through one.
    this.profile = capabilityProfile(profile) && profile;
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

  async run({ attemptId, worktreePath, instruction, goal, model, artifactDir, mode, onSpawn }) {
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
      // Translated, not passed through: the route is carried by baseUrl, and the adapter wants the
      // bare wire model. An unknown id throws here rather than failing as an auth error mid-run.
      model: wireModel(model),
      baseUrl: this.baseUrl,
      apiKeyEnv: this.apiKeyEnv,
      reasoningEffort: this.reasoningEffort,
      profile: this.profile,
    }));

    // Verify the fence is actually in the tree the process will boot, before any worker runs.
    //
    // The loader skips patch entries it does not accept and merely WARNS -- it does not fail. A
    // rejected fence would leave the worker running against the stock provider, which permits every
    // read, while every visible signal said the attempt was confined. That failure is silent by
    // construction, so it is checked rather than assumed.
    if (capabilityProfile(this.profile).fenced) await this.assertFenceComposed(patchPath, artifactDir);

    const stdoutPath = path.join(artifactDir, "harness-stdout.log");
    const stderrPath = path.join(artifactDir, "harness-stderr.log");
    const stdoutStream = fs.createWriteStream(stdoutPath, { flags: "wx" });
    const stderrStream = fs.createWriteStream(stderrPath, { flags: "wx" });

    const prompt = workerPrompt({ instruction, mode, profile: this.profile });

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

    return {
      ...result, stdoutPath, stderrPath,
      sessionLogPath: this.sessionLogPath(artifactDir),
      capabilityProfile: this.profile,
      // The strongest LOCAL provenance available, and precisely bounded: delegate-wave writes this
      // patch itself, so what it SUPPLIED TO HARNESS AT LAUNCH is mechanically known.
      //
      // Not "composed". This file already documents that the loader skips patch entries it does not
      // accept and merely warns -- which is exactly why assertFenceComposed() exists for the fenced
      // profile. Without a config dump or runtime evidence, the patch proves the invocation, not
      // that every entry survived composition. `harness-profile-patch` names that weaker claim
      // honestly; a `--dump-config` run would be needed to name the stronger one.
      //
      // Every field is APPLIED, never observed. The session log is parsed for usage and for the
      // turn/end marker and reports no model identity, so nothing here may claim what DeepSeek
      // actually served -- observed_* stays null and the receipt reads UNVERIFIED, which is the
      // honest description of a local executor whose provider reports no identity.
      provenance: {
        appliedModel: wireModel(model),
        appliedEffort: this.reasoningEffort,
        appliedExecutor: "harness",
        appliedCapabilityProfile: this.profile,
        appliedSource: fs.existsSync(patchPath) ? "harness-profile-patch" : null,
      },
    };
  }
}
