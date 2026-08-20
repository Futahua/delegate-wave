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

// Threads and turns get genuinely distinct identities.
//
// An earlier version returned one fixed thread id and `turn-1` for every start, which made the
// concurrency test unfalsifiable: two turns collecting the same notifications both resolved, and the
// test saw two successes without ever proving they were different answers.
let threadCounter = 0;
let turnCounter = 0;
const nextThread = () => `thread-fake-${++threadCounter}`;
const nextTurn = () => `turn-${++turnCounter}`;

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

// The reply echoes the prompt, so a test can prove WHICH turn's answer it received rather than only
// that some answer arrived.
const decision = (prompt) => JSON.stringify({ action: "ACCEPT", reason: prompt });

async function completeTurn(threadId, turnId, prompt, { withMessage = true, withUsage = true } = {}) {
  // The gap that matters. A collector installed only around the turn/start round-trip sees none of
  // what follows.
  await sleep(40);
  if (withUsage) notify("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: usage });
  await sleep(10);
  if (withMessage) {
    notify("item/completed", {
      threadId, turnId, item: { id: `item-${turnId}`, type: "agentMessage", text: decision(prompt) },
    });
  }
  await sleep(10);
  notify("turn/completed", { threadId, turn: { id: turnId, status: "completed", items: [] } });
}

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  const text = line.trim();
  if (!text) return;
  let message;
  try { message = JSON.parse(text); } catch { return; }
  const { id, method } = message;

  if (method === "initialize") return reply(id, { userAgent: "fake-app-server/0" });
  if (method === "thread/start") return reply(id, { thread: { id: nextThread() } });
  if (method === "thread/resume") return reply(id, { thread: { id: message.params?.threadId ?? nextThread() } });

  if (method === "turn/start") {
    const turnId = nextTurn();
    // Every notification is tagged with the thread the client actually asked about, so two threads
    // are genuinely separable rather than separable-looking.
    const threadId = message.params?.threadId;
    const prompt = message.params?.input?.[0]?.text ?? "";

    // Acceptance and completion are separate events, always.
    if (scenario === "delayed") {
      reply(id, { turn: { id: turnId } });
      return completeTurn(threadId, turnId, prompt);
    }
    if (scenario === "no-message") {
      reply(id, { turn: { id: turnId } });
      return completeTurn(threadId, turnId, prompt, { withMessage: false });
    }
    if (scenario === "no-usage") {
      reply(id, { turn: { id: turnId } });
      return completeTurn(threadId, turnId, prompt, { withUsage: false });
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
      return completeTurn(threadId, turnId, prompt);
    }
    // Two threads in flight together. Each thread's completion is delayed by a different amount, so
    // a client that mixed them up would resolve with the other thread's answer.
    if (scenario === "two-threads") {
      reply(id, { turn: { id: turnId } });
      await sleep(prompt === "one" ? 120 : 20);
      return completeTurn(threadId, turnId, prompt);
    }
    // The turn really did finish, and it failed. That is a fact, not an uncertainty.
    if (scenario === "turn-failed") {
      reply(id, { turn: { id: turnId } });
      await sleep(20);
      notify("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: usage });
      return notify("turn/completed", {
        threadId,
        turn: { id: turnId, status: "failed", error: { message: "model refused" }, items: [] },
      });
    }
    // Some versions answer inline with the whole completed turn.
    if (scenario === "inline") {
      return reply(id, {
        turn: {
          id: turnId, status: "completed",
          items: [{ id: `item-${turnId}`, type: "agentMessage", text: decision(prompt) }],
        },
      });
    }
    return reply(id, { turn: { id: turnId } });
  }

  if (method === "turn/interrupt") return reply(id, {});
  if (method === "account/rateLimits/read") return reply(id, { rateLimits: { primary: null } });
  return reply(id, {});
});
