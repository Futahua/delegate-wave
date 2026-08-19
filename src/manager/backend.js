// Where the scarce manager's model actually lives.
//
// Separated from the orchestration policy for the same reason AgentRuntime is separated from the
// dispatcher: the state machine must be provable without spending quota. FakeManagerBackend is not a
// testing convenience bolted on afterwards -- it is how the entire semantic loop gets exercised,
// adversarially and repeatedly, before a single real Codex turn is bought.
//
// The contract is deliberately small. A backend opens one conversation, runs one turn, reports what
// the model said and what it cost, and closes. It does not parse decisions, does not know what a
// brief is, and does not decide anything.
import fs from "node:fs";
import { CodexAppServer } from "./codex-app-server.js";
import { observeCodexUsage, unknownManagerUsage } from "./usage.js";

export class ManagerBackend {
  get name() { return "abstract"; }

  // Opens one conversation and returns its durable identity.
  async startRun() { throw new Error(`${this.name} manager backend cannot start a run`); }

  // Reattaches to a conversation started by an earlier process.
  async resumeRun({ threadId }) { return threadId; }

  // Runs one turn. Returns { text, usage, turnId, status }, or throws with `uncertain` set when no
  // terminal signal arrived after the call was accepted.
  async runTurn() { throw new Error(`${this.name} manager backend cannot run a turn`); }

  async close() { /* nothing to release by default */ }
}

// A deterministic manager, driven by a script or a handler.
//
// Exists so the state machine can be attacked -- malformed responses, ACCEPT without a candidate,
// review of the wrong attempt, revision loops that never converge -- at zero cost and with exact
// reproducibility. A live model can produce none of those on demand.
export class FakeManagerBackend extends ManagerBackend {
  constructor(script = []) {
    super();
    // Either a list of responses consumed in order, or a function of the turn context. The function
    // form is what adversarial tests need: they must react to the phase and subject rather than
    // assume a fixed sequence.
    this.script = script;
    this.turns = [];
    this.threads = 0;
  }

  get name() { return "fake"; }

  async startRun({ model = "fake-manager" } = {}) {
    this.threads += 1;
    return { threadId: `fake-thread-${this.threads}`, requestedModel: model, actualModel: model };
  }

  async runTurn({ threadId, phase, prompt, subjectAttemptId = null }) {
    const context = { threadId, phase, prompt, subjectAttemptId, index: this.turns.length };
    this.turns.push(context);
    const produced = typeof this.script === "function"
      ? await this.script(context)
      : this.script[context.index];
    if (produced === undefined) {
      throw new Error(`FakeManagerBackend has no scripted response for turn ${context.index} (${phase})`);
    }
    // A scripted throw simulates a transport failure, including the uncertain kind.
    if (produced instanceof Error) throw produced;
    const text = typeof produced === "string" ? produced : JSON.stringify(produced.decision ?? produced);
    return {
      text,
      usage: produced.usage ?? null,
      turnId: `fake-turn-${context.index + 1}`,
      status: produced.status ?? "completed",
      error: null,
    };
  }
}

// The real thing: Codex over its App Server.
//
// The manager runs in a NEUTRAL working directory, never the project repository. Its information
// arrives as bounded evidence packs that delegate-wave assembled. A manager pointed at the repo would
// explore it with the most expensive tokens in the system, which is precisely the substitution this
// architecture exists to prevent -- cheap workers do the reading.
export class CodexManagerBackend extends ManagerBackend {
  constructor({
    executable = "codex",
    model = null,
    effort = "high",
    workingDirectory,
    turnTimeoutMs = undefined,
  } = {}) {
    super();
    if (!workingDirectory) {
      throw new Error("CodexManagerBackend requires a neutral working directory; it must not be the project repository");
    }
    this.executable = executable;
    this.model = model;
    this.effort = effort;
    this.workingDirectory = workingDirectory;
    this.turnTimeoutMs = turnTimeoutMs;
    this.server = null;
  }

  get name() { return "codex"; }

  async server_() {
    if (!this.server) {
      fs.mkdirSync(this.workingDirectory, { recursive: true });
      this.server = new CodexAppServer({
        executable: this.executable,
        cwd: this.workingDirectory,
        ...(this.turnTimeoutMs ? { turnTimeoutMs: this.turnTimeoutMs } : {}),
      });
      await this.server.start();
    }
    return this.server;
  }

  // Returns what was ASKED FOR and what actually RAN, as two separate facts.
  //
  // `model: this.model ?? "codex-default"` was provenance theatre: "codex-default" is a
  // configuration label describing the absence of a setting, and recording it would put a string
  // that names no model into the column that answers "which model did this cost pay for?". When the
  // App Server does not report a resolved model, unknown is the correct answer and null is how it is
  // written. Manufactured provenance is worse than missing provenance, because only one of them is
  // detectable later.
  async startRun() {
    const server = await this.server_();
    const started = await server.startThreadDetailed({
      cwd: this.workingDirectory,
      model: this.model,
      effort: this.effort,
      developerInstructions: MANAGER_SYSTEM_INSTRUCTIONS,
    });
    return {
      threadId: started.threadId,
      requestedModel: this.model ?? null,
      actualModel: started.model ?? null,
    };
  }

  async resumeRun({ threadId }) {
    const server = await this.server_();
    return server.resumeThread({ threadId, cwd: this.workingDirectory });
  }

  async runTurn({ threadId, prompt }) {
    const server = await this.server_();
    const result = await server.runTurn({ threadId, text: prompt, effort: this.effort });
    return {
      text: result.text,
      usage: result.usage,
      turnId: result.turnId,
      status: result.status,
      error: result.error,
    };
  }

  // The subscription's remaining headroom, when the account exposes it. For a plan-authenticated
  // manager there is no marginal token price, so quota is the honest scarcity signal and dollars
  // would be an invention.
  async rateLimits() {
    const server = await this.server_();
    return server.rateLimits();
  }

  async close() {
    if (this.server) await this.server.close();
    this.server = null;
  }
}

// Standing instructions for the manager conversation. Deliberately about ROLE and OUTPUT SHAPE only;
// everything task-specific arrives per turn as evidence.
export const MANAGER_SYSTEM_INSTRUCTIONS = `You are the engineering manager in a delegation system.

You do not edit files and you have no repository access. Cheap workers read and write code; you
supply judgment. Your information comes only from the evidence you are given in each message.

You reply with ONE JSON object and nothing else. No prose before or after it.

"reason" is REQUIRED on every action. Field names are exact; a response using different names is
rejected unread rather than guessed at, because a misread instruction spends real money on the wrong
work.

  {"action":"EXPLORE","reason":"why facts are needed first","explorations":[
     {"question":"one question for one investigator",
      "deliver":["relevant files","observed behaviour","uncertainties"]}]}

  {"action":"IMPLEMENT","reason":"why this is the right change","brief":{
     "diagnosis":"what is actually wrong or missing",
     "instructions":"what this worker should do",
     "acceptance":["how to tell it worked"],
     "relevant_evidence":["established facts the worker should trust"],
     "uncertainties":["what to verify rather than assume"],
     "worker_tier":"ordinary"}}

  {"action":"ACCEPT","reason":"why this candidate solves the objective"}

  {"action":"REVISE","reason":"what is wrong with this implementation","brief":{...as IMPLEMENT...}}

  {"action":"RETHINK","reason":"why the diagnosis itself was wrong",
   "explorations":[...optional, same shape as EXPLORE...]}

  {"action":"ESCALATE","reason":"why you cannot decide",
   "question":"exactly what you need answered, and why the repository cannot answer it"}

Assign only work the selected worker can actually perform. Its capability envelope is supplied with
the evidence for each job, and it varies: different executors and profiles grant different powers.
Never instruct a worker to run commands, tests, builds, or Git operations unless its declared
capabilities permit them. A worker asked to do what it cannot do spends its whole budget failing and
produces nothing.

Deterministic validation belongs to delegate-wave and runs AFTER the worker finishes. Build, test or
lint success may appear in acceptance criteria as conditions that must end up true; they are never
steps for the worker unless the envelope says it can run them. Never conclude that the worker ran
validation, or that a validation result describes something the worker did.

Which actions a turn accepts depends on what it is. Answering with one the turn cannot accept ends
the run, so this is worth reading twice:

  planning a job, or synthesising after investigation
      EXPLORE, IMPLEMENT, ESCALATE
  reviewing a candidate you were shown
      ACCEPT, REVISE, RETHINK, ESCALATE  --  and NOT EXPLORE

When reviewing, you may still need facts before you can judge. EXPLORE is not how you ask for them:
use RETHINK, which carries "explorations" for exactly this, or ESCALATE if a person must decide.
Refusing to judge on evidence you consider insufficient is correct; naming an action the turn cannot
accept throws that judgment away.

Constraints that are enforced, not advisory:
  - at most 3 explorations per round, each with a non-empty "question"
  - "acceptance" must be non-empty: a brief without it is a goal with extra words, and the review
    turn would have nothing to judge the candidate against
  - "worker_tier" is "ordinary" or "hard". Never name a model; routing is not yours to choose.
  - EXPLORE and RETHINK carry no "brief"; IMPLEMENT and REVISE carry no "explorations".

Actions:
  EXPLORE    you need facts before you can plan. Supply "explorations".
  IMPLEMENT  you know what to build. Supply "brief".
  ACCEPT     the candidate you were shown solves the objective.
  REVISE     the approach is right; this implementation of it is wrong. Supply a corrected "brief".
  RETHINK    the diagnosis itself is wrong; correcting the code cannot help. Optionally supply
             "explorations" for what must be re-established.
  ESCALATE   a human must decide. Supply "question" stating exactly what you need answered and why
             the repository cannot answer it.

Rules that matter:
  - ACCEPT is a claim that the change solves the OBJECTIVE, not that the tests passed. Passing tests
    while misunderstanding the request is the specific failure you exist to catch.
  - Evidence marked truncated is a bounded view. Never reason about what you were not shown; ask for
    a targeted investigation instead.
  - The worker's report is testimony. The diff is evidence. When they disagree, the diff wins.
  - Accepting does not integrate anything. A human approves every change.`;

// Reads one manager turn's usage into a receipt observation. Absence stays absence: a turn whose
// usage never arrived consumed real quota, and recording zero would make the scarce side look free.
export function observeManagerUsage(backend, result) {
  if (!result?.usage) return unknownManagerUsage(backend?.name ?? "unknown");
  return observeCodexUsage(result.usage, backend?.name ?? "unknown");
}

