// JSON-RPC transport to `codex app-server`.
//
// This is the scarce manager's wire, and it is deliberately the integration surface OpenAI publishes
// for exactly this purpose rather than a scrape of the interactive TUI. Terminal scraping would make
// the most expensive component in the system depend on the least stable contract in it.
//
// The protocol below was not written from documentation. It was read out of the installed binary:
//
//   codex app-server generate-json-schema --out <dir>
//
// which emits ClientRequest.json / ServerNotification.json describing every method and notification
// the local version accepts. The names, parameter shapes and notification payloads used here come
// from that output, so a version whose protocol has moved fails against a checkable artifact instead
// of silently misbehaving. Verified against codex-cli 0.125.0.
//
// The parts of the protocol this uses:
//
//   initialize                     handshake; must precede everything
//   thread/start                   opens one conversation, returns its id
//   thread/resume                  reattaches to that id in a later process
//   turn/start                     asks one question
//   turn/interrupt                 cancellation
//   turn/completed        (notif)  the turn genuinely finished
//   item/completed        (notif)  carries item.type === "agentMessage" and its text
//   thread/tokenUsage/updated      carries tokenUsage.last, this turn's own usage
//   error                 (notif)  transport-level failure
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

export const CODEX_CLIENT_INFO = Object.freeze({ name: "delegate-wave", version: "0.1.0" });

// Requests that legitimately take a long time. A scarce-model turn on a hard question is minutes of
// wall time, and a timeout that fired mid-reasoning would throw away a call already paid for.
const DEFAULT_TURN_TIMEOUT_MS = 20 * 60_000;
const HANDSHAKE_TIMEOUT_MS = 60_000;

// Statuses that mean the turn is OVER. "inProgress" is acceptance, not completion, and treating it
// as terminal settles the turn before any item or usage notification has arrived.
const TERMINAL_TURN_STATUS = new Set(["completed", "failed", "cancelled", "interrupted"]);

// Whether a rejection positively establishes that the thread is gone.
//
// Deliberately narrow, because the consequence of a false positive is replaying a turn that already
// ran: the manager pays twice and the second answer overwrites the first. Three conditions must
// hold together --
//
//   the call was REJECTED rather than timed out, so inference never began;
//   the message says the thread is missing, in the server's own words;
//   the message names the exact thread that was sent, so a rejection about some other conversation
//     cannot be read as being about this one.
//
// Anything else -- a timeout, a transport drop, a 500, an unexplained refusal -- stays uncertain and
// stops the run. "We do not know whether that spent money" is not a retryable condition.
const STALE_THREAD_PHRASES = /thread not found|unknown thread|no such thread|thread .{0,80}(does not exist|expired)/i;

export function isStaleThreadRejection(error, threadId) {
  if (!threadId) return false;
  const message = String(error?.message ?? "");
  if (!STALE_THREAD_PHRASES.test(message)) return false;
  return message.includes(String(threadId));
}

export class CodexAppServer {
  constructor({
    executable = "codex",
    args = ["app-server"],
    cwd = undefined,
    env = {},
    turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS,
    onNotification = null,
  } = {}) {
    this.executable = executable;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.turnTimeoutMs = turnTimeoutMs;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    // A SET of listeners, not one mutable slot.
    //
    // The single-slot version worked only because exactly one turn was ever in flight. Two
    // concurrent turns -- or one turn plus an observer -- would overwrite each other's collector,
    // and the loser would wait forever for notifications now being delivered to someone else. That
    // failure is silent and arrives the day the manager first overlaps two calls.
    this.listeners = new Set();
    if (onNotification) this.listeners.add(onNotification);
    // Turn collectors awaiting a terminal signal. Held so a process exit can settle them as
    // UNCERTAIN rather than leaving them pending until their timeout.
    this.turns = new Set();
    // One active turn per thread, enforced rather than multiplexed.
    //
    // Notifications carry a threadId, so turns on DIFFERENT threads separate cleanly. Two turns on
    // the SAME thread do not: both collectors would match every notification and both would resolve
    // on the first completion, each believing it had received its own answer. Two manager turns
    // silently sharing one response is the most expensive possible failure here.
    //
    // Multiplexing by turnId is not the fix, because the turnId only arrives with the notifications
    // being demultiplexed. The real observation is that the architecture never needs this: one
    // managed job is one thread, and PLAN -> SYNTHESIS -> REVIEW -> REVIEW is inherently sequential.
    // So the invariant is enforced at the door and the ambiguity cannot arise.
    this.activeTurnByThread = new Map();
    this.buffer = "";
    this.stderr = "";
    this.closed = false;
    this.exitReason = null;
  }

  addListener(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(method, params) {
    for (const listener of [...this.listeners]) {
      try { listener(method, params); } catch { /* a bad observer must not break the transport */ }
    }
  }

  // Resolves what can actually be spawned on this platform.
  //
  // `codex` on Windows is an npm shim: a PowerShell script and a .cmd, neither
  // of which spawn without a shell -- bare spawn gives ENOENT, and the .cmd
  // gives EINVAL because Node refuses to run batch files without `shell: true`.
  // Using a shell to work around that would put the manager's launch behind
  // command-line parsing, so the real Node entry is located instead and run with
  // this process's own interpreter.
  resolveLaunch() {
    if (this.executable !== "codex" || process.platform !== "win32") {
      return { command: this.executable, args: this.args };
    }
    const candidates = [
      process.env.CODEX_JS_ENTRY,
      process.env.APPDATA && path.join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js"),
    ].filter(Boolean);
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return { command: process.execPath, args: [candidate, ...this.args] };
    }
    throw new Error(
      "The codex CLI could not be resolved to a runnable entry on Windows. "
      + "Set CODEX_JS_ENTRY to the path of @openai/codex/bin/codex.js.",
    );
  }

  async start() {
    if (this.child) return;
    const launch = this.resolveLaunch();
    this.child = spawn(launch.command, launch.args, {
      cwd: this.cwd,
      // The manager's environment is granted, not inherited wholesale. delegate-wave's own control
      // credentials must never reach it: a manager holding an operator token could approve its own
      // work, which would dissolve the human integration gate this whole system is built around.
      env: { ...scrubbedEnvironment(), ...this.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.consume(chunk));
    this.child.stderr.on("data", (chunk) => { this.stderr = (this.stderr + chunk).slice(-8000); });
    this.child.on("exit", (code, signal) => {
      this.closed = true;
      this.exitReason = `app-server exited (code ${code}, signal ${signal ?? "none"}): ${this.stderr.slice(-500)}`;
      // Every in-flight request fails with the same cause. They are NOT retried here: a request that
      // died in flight may have been answered and billed, and only the caller knows whether asking
      // again is affordable.
      for (const [, entry] of this.pending) entry.reject(new Error(this.exitReason));
      this.pending.clear();
      // A turn already ACCEPTED by the server, whose process then died before reporting completion,
      // is the textbook uncertain case: the model may well have run and the quota may well have been
      // consumed. Settling it as a plain failure would invite a retry that pays twice.
      for (const turn of [...this.turns]) {
        turn.settle(null, Object.assign(new Error(
          `the manager turn was accepted but the ${this.exitReason}`,
        ), { uncertain: true }));
      }
      this.turns.clear();
    });
    this.child.on("error", (error) => {
      this.closed = true;
      this.exitReason = `app-server could not start: ${error.message}`;
      // Fail the handshake NOW rather than letting it sit until the timeout. A
      // process that never launched produced a 60-second wait and then reported
      // "initialize timed out", which describes a slow server rather than a
      // missing one and sends the reader looking in the wrong place entirely.
      for (const [, entry] of this.pending) entry.reject(new Error(this.exitReason));
      this.pending.clear();
    });

    await this.request("initialize", { clientInfo: CODEX_CLIENT_INFO }, HANDSHAKE_TIMEOUT_MS);
  }

  consume(chunk) {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      this.route(message);
    }
  }

  route(message) {
    if (message.id !== undefined && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(`${message.error.code ?? "rpc"}: ${message.error.message ?? "request failed"}`));
      else entry.resolve(message.result ?? {});
      return;
    }
    // Server-initiated requests (approval prompts) are answered by policy, not by a person: the
    // manager runs in a neutral directory with nothing to approve, so anything asking is refused
    // rather than left hanging until the turn times out.
    if (message.id !== undefined && message.method) {
      this.write({ id: message.id, result: { decision: "denied" } });
      return;
    }
    if (message.method) this.emit(message.method, message.params ?? {});
  }

  write(payload) {
    if (!this.child || this.closed) throw new Error(this.exitReason ?? "app-server is not running");
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  request(method, params, timeoutMs = this.turnTimeoutMs) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Named as a timeout rather than a failure. The distinction survives into the manager's turn
        // record: a timed-out turn may have been billed, and the orchestrator treats it as UNCERTAIN
        // rather than as a call that did not happen.
        reject(Object.assign(new Error(`${method} timed out after ${timeoutMs}ms`), { timedOut: true }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  // Opens one conversation. `cwd` is the manager's working directory, and it is deliberately NOT the
  // project repository: the manager's information comes from evidence packs that delegate-wave
  // assembled and bounded. A manager pointed at the repo would explore it directly with the most
  // expensive tokens in the system, which is the exact substitution this architecture exists to
  // prevent.
  async startThread({ cwd, model, effort = null, developerInstructions = null }) {
    const params = { cwd, ephemeral: false };
    if (model) params.config = { model };
    if (effort) params.config = { ...(params.config ?? {}), model_reasoning_effort: effort };
    if (developerInstructions) params.developerInstructions = developerInstructions;
    const result = await this.request("thread/start", params, HANDSHAKE_TIMEOUT_MS);
    const threadId = result?.thread?.id ?? result?.threadId ?? null;
    if (!threadId) throw new Error("thread/start returned no thread id");
    return threadId;
  }

  // The same call, reporting what the server said about the resolved model rather than only the id.
  //
  // Returns `model: null` when nothing was reported. That null is a real answer -- "this version does
  // not tell us what ran" -- and it must survive to the receipt rather than being backfilled with the
  // requested model, which would record a preference as an observation.
  async startThreadDetailed({ cwd, model, effort = null, developerInstructions = null }) {
    const params = { cwd, ephemeral: false };
    if (model) params.config = { model };
    if (effort) params.config = { ...(params.config ?? {}), model_reasoning_effort: effort };
    if (developerInstructions) params.developerInstructions = developerInstructions;
    const result = await this.request("thread/start", params, HANDSHAKE_TIMEOUT_MS);
    const threadId = result?.thread?.id ?? result?.threadId ?? null;
    if (!threadId) throw new Error("thread/start returned no thread id");
    return { threadId, model: result?.thread?.model ?? result?.model ?? null };
  }

  async resumeThread({ threadId, cwd }) {
    const result = await this.request("thread/resume", { threadId, cwd }, HANDSHAKE_TIMEOUT_MS);
    return result?.thread?.id ?? threadId;
  }

  // Runs one turn and waits for its TERMINAL signal.
  //
  // The distinction this method exists to respect: `turn/start` resolving means the turn was
  // ACCEPTED, not that it finished. An earlier version checked for collected output the moment
  // acceptance returned, which reads a race as an answer -- on a fast machine it would usually find
  // nothing and declare the turn empty, and on a slow one it would occasionally find a partial
  // message and parse it as the manager's decision. Everything above this method would then have
  // been built on a false terminal signal.
  //
  //   install collector
  //        -> turn/start                    (acceptance only)
  //        -> WAIT
  //             item/completed              collect the final agent message
  //             thread/tokenUsage/updated   collect this turn's usage
  //             turn/completed              TERMINAL -- only now is there an answer
  //
  // Returns facts whenever a terminal signal was observed, including a turn that completed with no
  // agent message or with status `failed`; interpreting those is policy, not transport. Throws only
  // when no terminal signal arrived at all, and marks `uncertain` on the throw when the turn had
  // already been accepted -- because a turn that was accepted may have run and been billed, and a
  // blind retry would spend the scarce resource twice to answer a question that may already have an
  // answer.
  //
  // `usage` is whatever `thread/tokenUsage/updated` reported for THIS turn (tokenUsage.last), or
  // null. Null is not zero: a turn whose usage never arrived consumed real quota this process cannot
  // account for, and its receipt records UNKNOWN.
  async runTurn({ threadId, text, effort = null }) {
    // Refused before `turn/start`, so a mistake costs nothing. Checked synchronously at entry: an
    // await between the check and the claim would reopen the window it exists to close.
    if (this.activeTurnByThread.has(threadId)) {
      throw new Error(
        `thread ${threadId} already has an active turn. A manager conversation runs one turn at a `
        + "time; concurrent turns on one thread cannot be told apart from their notifications.",
      );
    }
    this.activeTurnByThread.set(threadId, true);

    const collected = { text: null, usage: null, turnId: null, status: null, error: null };
    let settle = null;
    const terminal = new Promise((resolve, reject) => {
      settle = (value, error) => (error ? reject(error) : resolve(value));
    });
    const turn = { threadId, settle: (value, error) => { if (!turn.done) { turn.done = true; settle(value, error); } }, done: false };

    const listener = (method, params) => {
      // Notifications for other threads belong to other turns. Silently absorbing them would let a
      // sibling conversation's completion terminate this wait with the wrong answer.
      if (params?.threadId && threadId && params.threadId !== threadId) return;
      if (method === "thread/tokenUsage/updated") {
        collected.usage = params?.tokenUsage?.last ?? null;
        collected.turnId = params?.turnId ?? collected.turnId;
      } else if (method === "item/completed") {
        // Later agentMessage items overwrite earlier ones, so the final statement wins: a model that
        // thinks aloud across messages must not have its first draft parsed as its decision.
        if (params?.item?.type === "agentMessage" && typeof params.item.text === "string") {
          collected.text = params.item.text;
        }
      } else if (method === "turn/completed") {
        collected.status = params?.turn?.status ?? "completed";
        collected.turnId = params?.turn?.id ?? collected.turnId;
        if (params?.turn?.error) collected.error = params.turn.error?.message ?? "turn failed";
        turn.settle({ ...collected });
      } else if (method === "error") {
        collected.error = params?.message ?? "app-server reported an error";
        turn.settle(null, Object.assign(new Error(collected.error), { uncertain: true }));
      }
    };

    const remove = this.addListener(listener);
    this.turns.add(turn);
    let accepted = false;
    let timer = null;
    try {
      const params = { threadId, input: [{ type: "text", text }] };
      if (effort) params.effort = effort;
      let response;
      try {
        response = await this.request("turn/start", params);
        accepted = true;
      } catch (error) {
        // A clean protocol rejection means the turn never started, so nothing was billed. A timeout
        // means we do not know whether it started, which is a different and more expensive fact.
        //
        // A rejection that positively names THIS thread as missing is narrower still, and is the one
        // case a caller may safely replay: the server refused before inference, so there is no
        // answer to lose and no spend to duplicate.
        throw Object.assign(error, {
          uncertain: Boolean(error.timedOut),
          staleThread: !error.timedOut && isStaleThreadRejection(error, threadId),
        });
      }

      // Some versions answer turn/start with the completed turn inline, which IS terminal and must
      // be taken rather than waited on. But codex-cli 0.125.0 answers with `status: "inProgress"` --
      // that is the ACCEPTANCE, carrying no items and no usage.
      //
      // Accepting any status here reintroduced the exact bug this method exists to prevent, one
      // level down: the turn settled instantly with text null, before a single notification arrived,
      // and every manager turn failed as "no agent message". Only a genuinely terminal status counts.
      if (TERMINAL_TURN_STATUS.has(response?.turn?.status)) {
        collected.status = response.turn.status;
        collected.turnId = response.turn.id ?? collected.turnId;
        if (response.turn.error) collected.error = response.turn.error?.message ?? "turn failed";
        if (Array.isArray(response.turn.items)) {
          const message = [...response.turn.items].reverse().find((item) => item?.type === "agentMessage");
          if (message?.text && collected.text === null) collected.text = message.text;
        }
        turn.settle({ ...collected });
      }

      timer = setTimeout(() => {
        turn.settle(null, Object.assign(
          new Error(`the manager turn was accepted but did not complete within ${this.turnTimeoutMs}ms`),
          { uncertain: true, timedOut: true },
        ));
      }, this.turnTimeoutMs);

      return await terminal;
    } catch (error) {
      // Anything thrown after acceptance is uncertain by construction; before acceptance it keeps
      // whatever certainty the transport could establish.
      if (accepted && error.uncertain === undefined) error.uncertain = true;
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      remove();
      this.turns.delete(turn);
      this.activeTurnByThread.delete(threadId);
    }
  }

  async interrupt(threadId) {
    try { await this.request("turn/interrupt", { threadId }, 15_000); } catch { /* already stopping */ }
  }

  // The subscription's remaining quota, when the account exposes it. This is the scarce resource in
  // its own units: for a plan-authenticated manager there is no marginal token price, so rate-limit
  // headroom is the honest budget signal and dollars would be an invention.
  async rateLimits() {
    try { return await this.request("account/rateLimits/read", {}, 30_000); } catch { return null; }
  }

  async close() {
    if (!this.child || this.closed) return;
    try { this.child.stdin.end(); } catch { /* already closed */ }
    const exited = once(this.child, "exit");
    const timer = setTimeout(() => { try { this.child.kill(); } catch { /* gone */ } }, 5_000);
    try { await exited; } finally { clearTimeout(timer); }
    this.closed = true;
  }
}

// delegate-wave's own control-plane secrets, which no child of any kind may inherit.
//
// Derived from one declared list rather than filtered ad hoc, so adding a role cannot silently leave
// it inheritable -- the same rule the executor path already enforces for cheap workers, applied to
// the manager because the manager is the one component with enough judgment to use a stolen operator
// token deliberately.
const CONTROL_PLANE_VARIABLES = Object.freeze([
  "DELEGATE_WAVE_OPERATOR_TOKEN",
  "DELEGATE_WAVE_OBSERVER_TOKEN",
  "DELEGATE_WAVE_PROPOSER_TOKEN",
  "DELEGATE_WAVE_EXECUTOR_TOKEN",
  "DELEGATE_WAVE_CONTROL_TOKEN",
]);

export function scrubbedEnvironment(source = process.env) {
  const copy = { ...source };
  for (const name of CONTROL_PLANE_VARIABLES) delete copy[name];
  return copy;
}

export { CONTROL_PLANE_VARIABLES };
