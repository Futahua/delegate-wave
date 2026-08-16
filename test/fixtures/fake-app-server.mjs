// A minimal stand-in for `codex app-server`, speaking the real protocol over stdio.
//
// It exists so the transport's TIMING can be tested. The bug this fixture was written to catch is
// invisible to any test that mocks runTurn(): acceptance and completion arriving as separate events,
// with a gap between them, is precisely the situation in which "check whether output happened yet"
// silently reads a race as an answer.
//
// The scenario is chosen by DW_FAKE_SCENARIO. Every scenario speaks newline-delimited JSON-RPC on
// stdout and reads the same on stdin, exactly as the real server does.
import readline from "node:readline";

// Exits immediately unless a scenario was requested.
//
// `node --test` globs every .?(c|m)js file under test/, including this one, and would otherwise run
// it as a test file -- where its stdin reader keeps the event loop alive forever and hangs the whole
// suite. Requiring the scenario makes an accidental invocation a no-op instead of a deadlock.
const scenario = process.env.DW_FAKE_SCENARIO;
if (!scenario) process.exit(0);

const THREAD = "thread-fake-1";

function send(payload) { process.stdout.write(`${JSON.stringify(payload)}\n`); }
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
function notify(method, params) { send({ jsonrpc: "2.0", method, params }); }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const usage = {
  last: {
    inputTokens: 1200, cachedInputTokens: 200, outputTokens: 340,
    reasoningOutputTokens: 90, totalTokens: 1540,
  },
  total: {
    inputTokens: 1200, cachedInputTokens: 200, outputTokens: 340,
    reasoningOutputTokens: 90, totalTokens: 1540,
  },
};

const decision = JSON.stringify({ action: "ACCEPT", reason: "the candidate satisfies the objective" });

async function completeTurn(turnId, { withMessage = true, withUsage = true } = {}) {
  // The gap that matters. A collector installed only around the turn/start round-trip sees none of
  // what follows.
  await sleep(40);
  if (withUsage) notify("thread/tokenUsage/updated", { threadId: THREAD, turnId, tokenUsage: usage });
  await sleep(10);
  if (withMessage) {
    notify("item/completed", {
      threadId: THREAD, turnId, item: { id: "item-1", type: "agentMessage", text: decision },
    });
  }
  await sleep(10);
  notify("turn/completed", { threadId: THREAD, turn: { id: turnId, status: "completed", items: [] } });
}

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  const text = line.trim();
  if (!text) return;
  let message;
  try { message = JSON.parse(text); } catch { return; }
  const { id, method } = message;

  if (method === "initialize") return reply(id, { userAgent: "fake-app-server/0" });
  if (method === "thread/start") return reply(id, { thread: { id: THREAD } });
  if (method === "thread/resume") return reply(id, { thread: { id: THREAD } });

  if (method === "turn/start") {
    const turnId = "turn-1";

    // Acceptance and completion are separate events, always.
    if (scenario === "delayed") {
      reply(id, { turn: { id: turnId } });
      return completeTurn(turnId);
    }
    if (scenario === "no-message") {
      reply(id, { turn: { id: turnId } });
      return completeTurn(turnId, { withMessage: false });
    }
    if (scenario === "no-usage") {
      reply(id, { turn: { id: turnId } });
      return completeTurn(turnId, { withUsage: false });
    }
    // Accepted, then the process dies before saying anything terminal. The quota may already be gone.
    if (scenario === "die-after-accept") {
      reply(id, { turn: { id: turnId } });
      await sleep(30);
      return process.exit(7);
    }
    // Accepted, then silence forever. Distinguishable from death only by the clock.
    if (scenario === "hang-after-accept") {
      return reply(id, { turn: { id: turnId } });
    }
    // Notifications for a DIFFERENT thread arrive first, and must not terminate this turn's wait.
    if (scenario === "foreign-thread") {
      reply(id, { turn: { id: turnId } });
      await sleep(20);
      notify("item/completed", {
        threadId: "thread-someone-else", turnId: "turn-x",
        item: { id: "i", type: "agentMessage", text: '{"action":"ESCALATE","reason":"wrong thread","question":"?"}' },
      });
      notify("turn/completed", {
        threadId: "thread-someone-else", turn: { id: "turn-x", status: "completed", items: [] },
      });
      return completeTurn(turnId);
    }
    // The turn really did finish, and it failed. That is a fact, not an uncertainty.
    if (scenario === "turn-failed") {
      reply(id, { turn: { id: turnId } });
      await sleep(20);
      notify("thread/tokenUsage/updated", { threadId: THREAD, turnId, tokenUsage: usage });
      return notify("turn/completed", {
        threadId: THREAD,
        turn: { id: turnId, status: "failed", error: { message: "model refused" }, items: [] },
      });
    }
    // Some versions answer inline with the whole completed turn.
    if (scenario === "inline") {
      return reply(id, {
        turn: {
          id: turnId, status: "completed",
          items: [{ id: "item-1", type: "agentMessage", text: decision }],
        },
      });
    }
    return reply(id, { turn: { id: turnId } });
  }

  if (method === "turn/interrupt") return reply(id, {});
  if (method === "account/rateLimits/read") return reply(id, { rateLimits: { primary: null } });
  return reply(id, {});
});
