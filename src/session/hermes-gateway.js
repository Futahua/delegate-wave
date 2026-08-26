// Speaking to Hermes on its own documented terms, and only when there is something to say.
//
// This is a subprocess adapter over `python -m tui_gateway.entry`: newline-delimited JSON-RPC on
// stdin and stdout, the same surface the Hermes TUI itself uses. Three things about its shape are
// deliberate and were measured rather than assumed (docs/research/HERMES-WAKE-PATH.md).
//
// NO DAEMON.
//
// The gateway is spawned when a wake exists and killed when it is done. A resident process would be
// a second thing to supervise, a second thing to restart, and -- worse -- a process holding a live
// runtime handle on a durable session for hours at a time, which is exactly the ownership hazard
// this path is trying not to create. Nothing needs it to be resident: a wake is rare and the spawn
// is not the expensive part of it.
//
// RESUME IS A CONTINUATION, NOT A NEW CONVERSATION.
//
// `session.resume(S)` returns a RUNTIME handle R carrying S's history, and `prompt.submit(R, ...)`
// appends to the same durable session S. Measured: message_count went 6 -> 8 and the stored session
// count did not change. The CLI's `--resume` does something different -- it restores context into a
// new session -- which would have delivered every wake into a conversation the user was not having.
//
// THE ACKNOWLEDGEMENT IS NOT THE DELIVERY.
//
// `prompt.submit` returns `{"status": "streaming"}` before anything is durable, and this call does
// not deduplicate. So nothing this adapter returns is a receipt, and it is careful never to look
// like one. What a caller reasons from is the durable record -- and for the routed transport that
// means `session.canonical_history`, not the `history()` below, which is the display projection.
import { spawn } from "node:child_process";
import { processStartedAt } from "./liveness.js";

const DEFAULT_READY_MS = 60_000;
const DEFAULT_REQUEST_MS = 120_000;

// A refusal that means "not now", as distinct from "not ever".
//
// MATCHED EXACTLY, NEVER GUESSED.
//
// An earlier version of this also accepted 4030 and anything whose message contained the word
// "busy". Both were wrong. In Hermes 0.19.0, 4030 is "llm.oneshot requires a template" and "path
// outside spawn-trees root" -- nothing to do with ownership -- and inferring protocol semantics from
// human-readable prose is how a refusal silently changes meaning in a version bump. A code this
// system does not recognise is an error, which is the outcome that stops and asks rather than the
// one that retries.
//
// 4009 is Hermes's existing "session busy": no turn started, nothing durable written, ask again
// later. That is genuinely this shape and is matched.
//
// SESSION_NOT_OWNED is the contract the upstream per-session lease must emit (research section 8).
// Nothing produces it today, which is exactly why it is written down now: the branch that handles a
// refusal must not be authored for the first time on the day refusals start happening.
const BUSY_CODES = new Set([4009]);
export const OWNERSHIP_REFUSAL_REASON = "SESSION_NOT_OWNED";

export function isBusyRefusal(error) {
  if (!error) return false;
  if (BUSY_CODES.has(error.code)) return true;
  return error.data?.reason === OWNERSHIP_REFUSAL_REASON;
}

export class GatewayError extends Error {
  constructor(message, { code = null, data = null, busy = false } = {}) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
    this.data = data;
    this.busy = busy;
  }
}

export class HermesGateway {
  // `command` and `args` are injected rather than hard-coded so this can be driven against a stub
  // that speaks the same framing. The framing is the part worth testing on every run; Hermes itself
  // is the part worth testing deliberately and rarely.
  constructor({
    command = process.env.DELEGATE_WAVE_HERMES_PYTHON || "python",
    args = ["-u", "-m", "tui_gateway.entry"],
    cwd = process.env.DELEGATE_WAVE_HERMES_AGENT_DIR || null,
    env = null,
    readyTimeoutMs = DEFAULT_READY_MS,
    requestTimeoutMs = DEFAULT_REQUEST_MS,
    onEvent = null,
  } = {}) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.readyTimeoutMs = readyTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.onEvent = onEvent;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = [];
    this.buffer = "";
    this.stderr = "";
    this.exit = null;
    this.readyPromise = null;
  }

  static configured(environment = process.env) {
    return Boolean(environment.DELEGATE_WAVE_HERMES_AGENT_DIR);
  }

  async start() {
    if (this.readyPromise) return this.readyPromise;
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd ?? undefined,
      env: this.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.#consume(chunk));
    // Kept, bounded, and reported only when something fails. A gateway that dies during startup says
    // why in stderr and nowhere else, and losing that turns a five-minute diagnosis into an hour of
    // guessing at an empty pipe.
    this.child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-8_000);
    });
    this.child.on("exit", (code, signal) => {
      this.exit = { code, signal };
      const error = new GatewayError(
        `Hermes gateway exited (code ${code}, signal ${signal})${this.stderr ? `: ${this.stderr.trim().split("\n").slice(-3).join(" | ")}` : ""}`,
      );
      for (const [, entry] of this.pending) entry.reject(error);
      this.pending.clear();
      for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    });
    this.child.on("error", (error) => {
      this.exit = { code: null, signal: null };
      for (const [, entry] of this.pending) entry.reject(error);
      this.pending.clear();
      for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    });

    // Ready is an EVENT, not a response: the gateway announces itself once its own startup work --
    // including MCP discovery -- has settled. Sending before it arrives is how a request gets
    // answered by a process that is still deciding what it can do.
    this.readyPromise = this.waitForEvent("gateway.ready", { timeoutMs: this.readyTimeoutMs })
      .catch((error) => { this.readyPromise = null; throw error; });
    return this.readyPromise;
  }

  #consume(chunk) {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) {
        // A gateway that prints anything unframed is not a protocol error worth killing the delivery
        // over -- Python libraries write to stdout for their own reasons. Skipped, not fatal.
        try { this.#receive(JSON.parse(line)); } catch { /* not a frame */ }
      }
      index = this.buffer.indexOf("\n");
    }
  }

  #receive(message) {
    if (message.method === "event") {
      const type = message.params?.type;
      if (this.onEvent) this.onEvent(type, message.params);
      for (const waiter of [...this.waiters]) {
        if (waiter.match(type, message.params)) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(message.params);
        }
      }
      return;
    }
    if (message.id === undefined || message.id === null) return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    if (message.error) {
      const error = message.error;
      entry.reject(new GatewayError(error.message || "gateway error", {
        code: error.code ?? null, data: error.data ?? null, busy: isBusyRefusal(error),
      }));
      return;
    }
    entry.resolve(message.result ?? {});
  }

  // A null timeout waits indefinitely -- for the event, or for the child to die.
  //
  // Not an oversight. The exit handler rejects every waiter, so "wait forever" is still bounded by
  // the process actually being there; what it is not bounded by is a clock, which for a hosted turn
  // is the difference between waiting and killing.
  waitForEvent(type, { timeoutMs = this.requestTimeoutMs, match = null } = {}) {
    return new Promise((resolve, reject) => {
      const waiter = {
        match: match ?? ((observed) => observed === type),
        resolve: (params) => { clearTimeout(timer); resolve(params); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      };
      const timer = timeoutMs === null ? null : setTimeout(() => {
        const at = this.waiters.indexOf(waiter);
        if (at >= 0) this.waiters.splice(at, 1);
        reject(new GatewayError(`Timed out after ${timeoutMs}ms waiting for ${type}`));
      }, timeoutMs);
      if (timer && typeof timer.unref === "function") timer.unref();
      this.waiters.push(waiter);
    });
  }

  request(method, params = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (!this.child || this.exit) return Promise.reject(new GatewayError("Hermes gateway is not running"));
    const requestId = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new GatewayError(`Timed out after ${timeoutMs}ms calling ${method}`));
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      this.pending.set(requestId, {
        resolve: (result) => { clearTimeout(timer); resolve(result); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
    });
  }

  // The durable session S, continued. Returns the RUNTIME handle every later call needs.
  //
  // The distinction is the whole mechanism and is easy to lose: `session_id` in the result is the
  // runtime handle R, and `resumed` is the durable S it carries. Passing S where R belongs reaches a
  // session that does not exist.
  async resume(durableSessionId) {
    const result = await this.request("session.resume", { session_id: durableSessionId });
    const runtimeSessionId = result.session_id;
    if (!runtimeSessionId) throw new GatewayError(`session.resume returned no runtime handle for ${durableSessionId}`);
    return {
      runtimeSessionId,
      durableSessionId: result.resumed ?? durableSessionId,
      messageCount: result.message_count ?? (result.messages?.length ?? 0),
      messages: result.messages ?? [],
    };
  }

  // Canonical durable history: the delivery authority, not a convenience.
  // THE DISPLAY PROJECTION. What a person should see, not what durably happened.
  //
  // Hermes drops `display_kind="hidden"` rows from this -- machine scaffolding, compaction
  // references, and the routed transport's own wake rows. A producer reconciling its own delivery
  // against this will never find its marker and will conclude, forever, that nothing was written.
  // That bug shipped; see HermesCanonicalHistory, which is what routed reconciliation uses.
  //
  // This remains correct for anything asking what the conversation LOOKS like, and for the legacy
  // direct-submit path, whose wakes were ordinary visible user rows.
  async history(runtimeSessionId) {
    const result = await this.request("session.history", { session_id: runtimeSessionId });
    return result.messages ?? [];
  }

  // Appends a turn to the durable session. Resolves on the ACKNOWLEDGEMENT, which is not evidence
  // that anything is durable -- the caller must reconcile against history before believing it.
  async submit(runtimeSessionId, text) {
    return this.request("prompt.submit", { session_id: runtimeSessionId, text });
  }

  // Waits for the hosted turn to finish. By default it waits as long as the turn takes.
  //
  // Closing this gateway kills the turn running inside it -- that is how the research produced the
  // PARTIAL boundary in the first place. So a deadline here is a CANCELLATION POLICY, not a timeout,
  // and callers pass null unless they specifically mean "interrupt a wake that is still being
  // answered". The wait ends when the turn completes or when the child dies.
  async waitForTurn({ timeoutMs = null } = {}) {
    return this.waitForEvent("message.complete", { timeoutMs });
  }

  // What the receiver says it guarantees.
  //
  // An unknown method is a definitive answer rather than a failure: a Hermes with no capability
  // surface is a Hermes that does not enforce per-session exclusivity, and it must read as an empty
  // set -- the caller then withholds, which is the safe direction.
  async capabilities() {
    try {
      const result = await this.request("gateway.capabilities", {}, { timeoutMs: 30_000 });
      return result && typeof result === "object" ? result : {};
    } catch (error) {
      if (error.code === -32601) return {};
      throw error;
    }
  }

  // The child's own (pid, start time), so a later process can tell "still speaking" from "gone".
  async identity() {
    if (!this.child?.pid) return null;
    return { pid: this.child.pid, startedAt: await processStartedAt(this.child.pid) };
  }

  async close() {
    if (!this.child || this.exit) return;
    try { this.child.stdin.end(); } catch { /* already gone */ }
    const child = this.child;
    await new Promise((resolve) => {
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } resolve(); }, 5_000);
      if (typeof timer.unref === "function") timer.unref();
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      try { child.kill(); } catch { clearTimeout(timer); resolve(); }
    });
  }
}
