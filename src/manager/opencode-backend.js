// A manager that runs on the OpenCode route instead of Codex.
//
// Same contract, different supplier. The manager is defined by what it is NOT allowed to do -- it
// has no repository, no tools, and no way to look at anything delegate-wave did not hand it -- so
// which vendor serves the tokens is an implementation detail, and having two proves the boundary is
// real rather than incidental to Codex.
//
// It exists because the Codex plan is a weekly allowance that runs out. When it does, the whole
// system stops having a brain, and a strong model available through the same API as the cheap
// workers is the obvious fallback. This is not a cheaper manager: `opencode-go/gpt-5.6-luna` is
// metered in dollars like any other route, and its cost lands in the same receipts.
import fs from "node:fs";
import path from "node:path";
import { ManagerBackend } from "./backend.js";
import { MANAGER_SYSTEM_INSTRUCTIONS } from "./backend.js";
import { defaultOpenCodeLaunch } from "../backend.js";
import { runProcess } from "../process.js";
import { USAGE_COMPLETE, USAGE_UNKNOWN } from "../usage.js";

// A manager agent with nothing. Every tool is denied, including read: the manager reasons over the
// evidence pack it is given and nothing else. This is the same rule the Codex manager follows by
// running in a neutral directory, expressed here as a capability instead of a working directory,
// because OpenCode would otherwise happily read whatever it was pointed at.
const MANAGER_POLICY = (instructions) => ({
  $schema: "https://opencode.ai/config.json",
  agent: {
    "delegate-wave-manager": {
      description: "Text-only engineering manager with no repository access",
      mode: "primary",
      // One model turn per call. The manager decides; it does not iterate.
      steps: 1,
      prompt: instructions,
      permission: {
        read: "deny",
        edit: "deny",
        glob: "deny",
        grep: "deny",
        list: "deny",
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
});

export class OpenCodeManagerBackend extends ManagerBackend {
  constructor({
    executable, prefixArgs, model, workingDirectory, turnTimeoutMs = 20 * 60_000,
    launchResolver = defaultOpenCodeLaunch,
  } = {}) {
    super();
    if (!workingDirectory) {
      throw new Error("OpenCodeManagerBackend requires a neutral working directory; it must not be the project repository");
    }
    if (!model) {
      throw new Error("OpenCodeManagerBackend requires an explicit --model; the manager must not inherit an ambient default");
    }
    if (executable) {
      this.executable = executable;
      this.prefixArgs = prefixArgs ?? [];
    } else {
      const launch = launchResolver();
      this.executable = launch.executable;
      this.prefixArgs = prefixArgs ?? launch.prefixArgs;
    }
    this.model = model;
    this.workingDirectory = workingDirectory;
    this.turnTimeoutMs = turnTimeoutMs;
  }

  get name() { return "opencode-manager"; }

  // No session yet.
  //
  // OpenCode creates one when the first message is sent, so there is nothing to open in advance.
  // Returning null rather than priming with a throwaway call keeps a wasted turn off the ledger;
  // runTurn reports the id it was given, and the service records it.
  async startRun({ model = this.model } = {}) {
    fs.mkdirSync(this.workingDirectory, { recursive: true });
    return { threadId: null, requestedModel: model, actualModel: null };
  }

  async resumeRun({ threadId }) { return threadId; }

  async runTurn({ threadId, prompt }) {
    fs.mkdirSync(this.workingDirectory, { recursive: true });
    const args = [
      ...this.prefixArgs,
      "run", prompt,
      "--agent", "delegate-wave-manager",
      "--format", "json",
      "--model", this.model,
      // Never the project repository. The manager has no tools, so this only decides where
      // OpenCode keeps its own scratch, but pointing it at the repo would still be wrong in the
      // way that matters: it would stop being true that the manager cannot see the code.
      "--dir", this.workingDirectory,
    ];
    if (threadId) args.push("--session", threadId);

    const result = await runProcess(this.executable, args, {
      cwd: this.workingDirectory,
      timeoutMs: this.turnTimeoutMs,
      env: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify(MANAGER_POLICY(MANAGER_SYSTEM_INSTRUCTIONS)),
        // Its own database, for the same reason every worker has one: concurrent managers would
        // otherwise contend for a single file, which is how dogfood run 4 died.
        OPENCODE_DB: path.join(path.resolve(this.workingDirectory), "manager-state.db"),
      },
    });

    const parsed = readTranscript(result.stdout);

    // A turn whose transport failed has NOT necessarily failed to spend. Reported as uncertain so
    // the service records it as such rather than as a clean failure.
    if (result.exitCode !== 0 && !parsed.text) {
      const error = new Error(
        `opencode manager turn exited ${result.exitCode}: ${(result.stderr || "").slice(-600)}`,
      );
      // The session may exist and the model may have been billed; only the answer is missing.
      error.uncertain = parsed.sessionId !== null;
      throw error;
    }

    return {
      text: parsed.text || null,
      usage: parsed.usage,
      turnId: parsed.sessionId ? `${parsed.sessionId}:${parsed.steps}` : null,
      // OpenCode has no separate turn status; a transcript carrying an error is a failed turn.
      status: parsed.error ? "failed" : "completed",
      error: parsed.error,
      // The service persists this so the next turn continues the same conversation.
      threadId: parsed.sessionId,
    };
  }

  async close() { /* nothing is held open between turns */ }
}

// Pulls the answer, the session identity and the usage out of one turn's event stream.
//
// Text is CONCATENATED across every text event. A single-part reader loses multi-part answers, and
// a manager decision truncated at the first part would be malformed JSON that the contract layer
// then rejects as a bad decision rather than as a bad read -- the exact confusion that cost dogfood
// run 3 its whole exploration lane.
export function readTranscript(stdout) {
  const lines = String(stdout ?? "").split(/\r?\n/).filter((line) => line.trim());
  let text = "";
  let sessionId = null;
  let error = null;
  let steps = 0;
  const totals = { input: 0, output: 0, reasoning: 0, read: 0, write: 0, total: 0 };
  let sawTokens = false;

  for (const line of lines) {
    let record = null;
    try { record = JSON.parse(line); } catch { continue; }
    sessionId = sessionId ?? record.sessionID ?? null;
    const type = record.type ?? record.event ?? null;
    if (type === "error") {
      const data = record.error ?? {};
      error = String(data.data?.message ?? data.message ?? data.name ?? "unspecified error").slice(0, 400);
      continue;
    }
    if (type === "text") {
      const part = record.part ?? record.data ?? {};
      if (typeof part.text === "string") text += part.text;
      continue;
    }
    if (type === "step_finish") {
      steps += 1;
      const tokens = record.part?.tokens;
      if (tokens) {
        sawTokens = true;
        totals.input += tokens.input ?? 0;
        totals.output += tokens.output ?? 0;
        totals.reasoning += tokens.reasoning ?? 0;
        totals.read += tokens.cache?.read ?? 0;
        totals.write += tokens.cache?.write ?? 0;
        totals.total += tokens.total
          ?? ((tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.reasoning ?? 0));
      }
    }
  }

  return {
    text: text.trim(),
    sessionId,
    error,
    steps,
    // Absence stays absence. A turn whose usage never arrived consumed real money, and recording
    // zero would make the scarce side look free.
    usage: sawTokens
      ? {
        status: USAGE_COMPLETE,
        input_tokens: totals.input,
        output_tokens: totals.output,
        reasoning_tokens: totals.reasoning,
        cache_read_tokens: totals.read,
        cache_write_tokens: totals.write,
        total_tokens: totals.total,
        source: "opencode",
      }
      : {
        status: USAGE_UNKNOWN,
        input_tokens: null, output_tokens: null, reasoning_tokens: null,
        cache_read_tokens: null, cache_write_tokens: null, total_tokens: null,
        source: "opencode",
      },
  };
}
