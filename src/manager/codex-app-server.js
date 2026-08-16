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
import { spawn } from "node:child_process";
import { once } from "node:events";

export const CODEX_CLIENT_INFO = Object.freeze({ name: "delegate-wave", version: "0.1.0" });

// Requests that legitimately take a long time. A scarce-model turn on a hard question is minutes of
// wall time, and a timeout that fired mid-reasoning would throw away a call already paid for.
const DEFAULT_TURN_TIMEOUT_MS = 20 * 60_000;
const HANDSHAKE_TIMEOUT_MS = 60_000;

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
    this.onNotification = onNotification;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.stderr = "";
    this.closed = false;
    this.exitReason = null;
  }

  async start() {
    if (this.child) return;
    this.child = spawn(this.executable, this.args, {
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
    });
    this.child.on("error", (error) => {
      this.closed = true;
      this.exitReason = `app-server could not start: ${error.message}`;
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
    if (message.method && this.onNotification) this.onNotification(message.method, message.params ?? {});
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

  async resumeThread({ threadId, cwd }) {
    const result = await this.request("thread/resume", { threadId, cwd }, HANDSHAKE_TIMEOUT_MS);
    return result?.thread?.id ?? threadId;
  }

  // Runs one turn and collects its terminal evidence.
  //
  // Returns { text, usage, turnId, status }. `usage` is whatever `thread/tokenUsage/updated` reported
  // for THIS turn (tokenUsage.last), or null. Null is not zero: a turn whose usage never arrived
  // consumed real quota that this process cannot account for, and the receipt records UNKNOWN.
  async runTurn({ threadId, text, effort = null }) {
    const collected = { text: null, usage: null, turnId: null, status: null, error: null };
    const listener = (method, params) => {
      if (params?.threadId && threadId && params.threadId !== threadId) return;
      if (method === "thread/tokenUsage/updated") {
        collected.usage = params?.tokenUsage?.last ?? null;
        collected.turnId = params?.turnId ?? collected.turnId;
      } else if (method === "item/completed") {
        // The manager's answer. Later agentMessage items overwrite earlier ones, so the final
        // statement wins -- a model that thinks aloud in messages must not have its first draft
        // parsed as its decision.
        if (params?.item?.type === "agentMessage" && typeof params.item.text === "string") {
          collected.text = params.item.text;
        }
      } else if (method === "turn/completed") {
        collected.status = params?.turn?.status ?? "completed";
        collected.turnId = params?.turn?.id ?? collected.turnId;
        if (params?.turn?.error) collected.error = params.turn.error?.message ?? "turn failed";
      } else if (method === "error") {
        collected.error = params?.message ?? "app-server reported an error";
      }
    };
    const previous = this.onNotification;
    this.onNotification = (method, params) => {
      listener(method, params);
      if (previous) previous(method, params);
    };
    try {
      const params = { threadId, input: [{ type: "text", text }] };
      if (effort) params.effort = effort;
      const result = await this.request("turn/start", params);
      // turn/start resolves when the turn is accepted; the terminal evidence arrives as
      // notifications. If the response itself carried the completed turn, take it.
      if (result?.turn?.status) collected.status = result.turn.status;
      if (!collected.text && typeof result?.turn?.items?.at === "function") {
        const message = [...result.turn.items].reverse().find((item) => item?.type === "agentMessage");
        if (message?.text) collected.text = message.text;
      }
      if (collected.error) throw new Error(collected.error);
      if (collected.text === null) {
        throw new Error("the manager turn completed without producing an agent message");
      }
      return collected;
    } finally {
      this.onNotification = previous;
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
