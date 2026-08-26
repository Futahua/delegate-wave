// A stand-in for `python -m tui_gateway.entry` that speaks the same wire.
//
// It exists to test the part that is ours: newline-delimited JSON-RPC framing, the runtime-handle
// indirection, and -- above all -- that reconciliation reads DURABLE history rather than anything
// this process remembers. So the transcript lives in a FILE, not in memory: a second spawn sees what
// the first spawn appended, which is the only property that makes the crash boundaries testable at
// all.
//
// Behaviour is scripted through FAKE_HERMES_SCRIPT and deliberately covers the outcomes the real
// receiver produces and the one it does not produce YET: a typed BUSY refusal. Hermes gains that
// when per-session exclusivity lands; the branch that handles it must not be written for the first
// time on the day it starts happening.
import fs from "node:fs";

// Exits immediately unless a transcript was named.
//
// `node --test` globs every .?(c|m)js file under test/, including this one, and would otherwise run
// it as a test file -- where the stdin reader below keeps the event loop alive forever and hangs the
// whole suite rather than failing it. The sibling fixture carries the same guard for the same
// reason; the trap is worth documenting twice, because it presents as an infinitely slow test run
// rather than as an error.
const statePath = process.env.FAKE_HERMES_STATE;
if (!statePath) process.exit(0);

const script = JSON.parse(process.env.FAKE_HERMES_SCRIPT || "{}");

const load = () => {
  try { return JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { return { messages: [], submits: 0 }; }
};
const save = (state) => fs.writeFileSync(statePath, JSON.stringify(state));

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const ok = (id, result) => write({ jsonrpc: "2.0", id, result });
const err = (id, code, message, data) => write({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });
const emit = (type, payload) => write({ jsonrpc: "2.0", method: "event", params: { type, session_id: "R", payload } });

// The runtime handle is deliberately NOT the durable id. A caller that confuses the two reaches a
// session that does not exist, and that confusion should fail loudly in a test rather than quietly
// in production.
const RUNTIME = "runtime_1";
let resumedDurable = null;

if (script.crashOnStart) process.exit(7);

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) handle(JSON.parse(line));
    index = buffer.indexOf("\n");
  }
});

function handle(request) {
  const { id, method, params = {} } = request;
  // Today's Hermes has no capability surface at all, so the DEFAULT here is the unknown-method
  // refusal a real 0.19.0 gives. A stub that helpfully reported capabilities by default would make
  // every test pass through a gate that no real receiver currently opens.
  if (method === "gateway.capabilities") {
    if (!script.capabilities) return err(id, -32601, `unknown method: ${method}`);
    return ok(id, script.capabilities);
  }
  if (method === "session.resume") {
    if (script.resumeFails) return err(id, 4007, "session not found");
    resumedDurable = params.session_id;
    const state = load();
    // Counted so a test can assert that a resume-only kick actually resumed. Without it, "it must
    // resume" is unfalsifiable and passes even if the kick does nothing at all.
    state.resumes = (state.resumes ?? 0) + 1;
    // Which process resumed, so a test can name the kick's own listener as the event's owner and
    // check the decision the kick ACTUALLY makes rather than one asserted from outside.
    state.lastResumePid = process.pid;
    save(state);
    return ok(id, {
      session_id: RUNTIME,
      resumed: params.session_id,
      message_count: state.messages.length,
      messages: state.messages,
      status: "idle",
    });
  }
  if (method === "session.history") {
    if (params.session_id !== RUNTIME) return err(id, 4007, "session not found");
    const state = load();
    return ok(id, { count: state.messages.length, messages: state.messages });
  }
  if (method === "prompt.submit") {
    if (params.session_id !== RUNTIME) return err(id, 4007, "session not found");
    // The typed refusal the upstream per-session lease must produce: no turn started, nothing
    // durable written. The contract is that this is an ordinary outcome, not an error -- and that it
    // is identified by an exact machine-readable reason rather than by a code that means three other
    // things or by prose containing the word "busy".
    if (script.busy) {
      return err(id, 5001, "session is owned by another process", { reason: "SESSION_NOT_OWNED" });
    }
    const state = load();
    state.submits += 1;
    // The user row becoming durable BEFORE the assistant turn is the whole reason PARTIAL exists.
    if (!script.dropUserRow) state.messages.push({ role: "user", text: params.text });
    save(state);
    if (script.dieAfterUserRow) { ok(id, { status: "streaming" }); process.exit(9); return undefined; }
    ok(id, { status: "streaming" });
    if (script.noAssistantReply) return undefined;
    setTimeout(() => {
      const after = load();
      after.messages.push({ role: "assistant", text: script.reply || "Understood." });
      save(after);
      emit("message.complete", { text: script.reply || "Understood." });
    }, script.replyDelayMs ?? 5);
    return undefined;
  }
  return err(id, -32601, `unknown method: ${method}`);
}

setTimeout(() => emit("gateway.ready", { skin: "test" }), script.readyDelayMs ?? 0);
