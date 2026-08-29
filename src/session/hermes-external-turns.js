// Handing an event to Hermes, and asking what became of it.
//
// This is the whole of delegate-wave's write surface to the external-turn protocol: four calls,
// none of which deliver anything. The producer enqueues and stops. Whichever Hermes process
// legitimately owns the stored session picks the event up and runs it as its next turn.
//
// WHY THE PRODUCER MUST NOT CHOOSE THE TRANSPORT.
//
// The obvious design asks "does this session have a live owner right now?" and submits directly if
// not. That answer is stale the instant it is read -- a person can open the conversation, or the
// owner can die, in the gap before the write -- and one branch of it is then wrong in a way that
// either loses the event or says it twice. Enqueueing removes the branch entirely: there is one
// durable event, and Hermes' own per-session lease decides who may run it, atomically, at the
// moment of consumption rather than as a preflight guess.
//
// NEVER SQLITE DIRECTLY.
//
// Every call goes through Hermes' own module API in the Hermes interpreter. delegate-wave does not
// know the shape of `session_external_turns`, does not open `state.db`, and cannot be broken by a
// schema change it was not told about -- it would find a missing attribute rather than silently
// reading a renamed column as NULL. The receiver owns its storage; this file owns a contract.
//
// ONE-SHOT, NOT RESIDENT.
//
// Each call spawns the Hermes interpreter, does one thing and exits, for the same reason the
// gateway adapter is not a daemon: a long-lived process holding a handle on somebody's conversation
// is the ownership hazard this whole path exists to avoid. These calls are rare and small.
import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 60_000;

// JSON can represent lone UTF-16 surrogates (for example `"\\udc9d"`), but
// UTF-8 cannot. Windows subprocess pipes expose that mismatch when Python later
// persists the decoded string: encoding correctly refuses the invalid scalar.
// Preserve real surrogate pairs and every other character; replace only lone
// code units at this transport boundary so one malformed manager glyph cannot
// permanently starve every wake behind it.
export function replaceLoneSurrogates(value) {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        result += value[index] + value[index + 1];
        index += 1;
      } else {
        result += "\uFFFD";
      }
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) {
      result += "\uFFFD";
    } else {
      result += value[index];
    }
  }
  return result;
}

// The Hermes-side program. One script for all three operations, reading its arguments as JSON on
// stdin rather than being formatted into the source -- a session key or a wake body interpolated
// into Python source is an injection, and wake bodies contain arbitrary text by design.
const BRIDGE = `
import json, sys
sys.stdin.reconfigure(encoding="utf-8", errors="strict")
sys.stdout.reconfigure(encoding="utf-8", errors="strict")
out = {"ok": False, "error": "unset"}
try:
    from tools.session_external_turns import (
        SESSION_EXTERNAL_TURNS_V1,
        enqueue_external_turn,
        get_external_turn,
        reopen_external_turn,
    )
    request = json.load(sys.stdin)
    op = request["op"]
    if op == "enqueue":
        out = {"ok": True, "result": enqueue_external_turn(
            event_id=request["event_id"],
            target_session_key=request["session_key"],
            body=request["body"],
            source=request.get("source") or "delegate-wave",
            display_metadata=request.get("display_metadata"),
        )}
    elif op == "status":
        out = {"ok": True, "result": get_external_turn(request["event_id"])}
    elif op == "reopen":
        out = {"ok": True, "result": reopen_external_turn(
            request["event_id"], request.get("reason") or ""
        )}
    elif op == "present":
        out = {"ok": True, "result": bool(SESSION_EXTERNAL_TURNS_V1)}
    else:
        out = {"ok": False, "error": "unknown op " + str(op)}
except Exception as exc:
    out = {"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}
sys.stdout.write(json.dumps(out))
`;

export class ExternalTurnError extends Error {
  constructor(message, { op = null } = {}) {
    super(message);
    this.name = "ExternalTurnError";
    this.op = op;
  }
}

export class HermesExternalTurns {
  constructor({
    command = process.env.DELEGATE_WAVE_HERMES_PYTHON || "python",
    cwd = process.env.DELEGATE_WAVE_HERMES_AGENT_DIR || null,
    env = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    this.command = command;
    this.cwd = cwd;
    this.env = env;
    this.timeoutMs = timeoutMs;
  }

  static configured(environment = process.env) {
    return Boolean(environment.DELEGATE_WAVE_HERMES_AGENT_DIR);
  }

  async #call(op, request) {
    const payload = JSON.stringify(
      { op, ...request },
      (_key, value) => typeof value === "string" ? replaceLoneSurrogates(value) : value,
    );
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, ["-c", BRIDGE], {
        cwd: this.cwd ?? undefined,
        env: this.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
        finish(new ExternalTurnError(`${op} timed out after ${this.timeoutMs}ms`, { op }));
      }, this.timeoutMs);

      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", (error) => finish(
        new ExternalTurnError(`${op} could not start Hermes: ${error.message}`, { op }),
      ));
      child.on("close", () => {
        let parsed;
        try {
          parsed = JSON.parse(stdout.trim());
        } catch {
          // The interpreter said something that is not our contract. Reported with its stderr
          // attached, because the cause is almost always visible there -- a missing module on a
          // build without the inbox, a bad interpreter path, an import error.
          finish(new ExternalTurnError(
            `${op} returned no usable answer: ${stderr.trim().slice(-400) || stdout.trim().slice(-200)}`,
            { op },
          ));
          return;
        }
        if (!parsed.ok) {
          finish(new ExternalTurnError(`${op} failed: ${parsed.error}`, { op }));
          return;
        }
        finish(null, parsed.result);
      });
      child.stdin.end(payload);
    });
  }

  // Queue one event. True if it was newly queued, false if this id was already there.
  //
  // False is a SUCCESS, not a conflict: the event id is delegate-wave's own wake id, so a producer
  // that could not tell whether its last attempt landed may safely say it again and will not create
  // a second turn. That idempotence is what makes the enqueue step safely retryable at all.
  async enqueue({ eventId, sessionKey, body, source = "delegate-wave", displayMetadata = null }) {
    return this.#call("enqueue", {
      event_id: eventId, session_key: sessionKey, body, source,
      display_metadata: displayMetadata,
    });
  }

  // What the receiver currently says about the event, or null if it has never heard of it.
  //
  // Returns the row plus `owner_alive`, which is the field the whole reconciliation turns on: a
  // STARTED event whose owner is alive is a turn still being reasoned about, and the same row with
  // a dead owner is a turn that stopped. The transcript looks identical in both cases.
  async status(eventId) {
    return this.#call("status", { event_id: eventId });
  }

  // Protocol-shaped spelling used by new delivery code. Keep status() as a
  // compatibility alias for the earlier experimental branch while Stage 1 is
  // still adapter-only.
  async get(eventId) {
    return this.status(eventId);
  }

  // Make a dead STARTED event deliverable again.
  //
  // Only ever called after reading canonical history and finding the marker ABSENT. Hermes refuses
  // while the owner is alive, so this cannot interrupt a running turn -- but the narrower rule is
  // ours to keep: absence of a marker is the only evidence that authorises replay, and the only
  // measured case that produces it is a process killed between dispatch and marker persistence.
  async reopen(eventId, reason = "") {
    return this.#call("reopen", { event_id: eventId, reason });
  }

  // Whether this Hermes build has the inbox at all.
  //
  // The gateway capability handshake is the real gate; this exists so a misconfigured interpreter
  // path fails with something a person can act on rather than as a timeout at delivery time.
  async present() {
    return this.#call("present", {});
  }
}
