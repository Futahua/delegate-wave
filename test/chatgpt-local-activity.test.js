import assert from "node:assert/strict";
import test from "node:test";

import { createChatGptLocalActivityProvider } from "../src/presentation/chatgpt-local-activity.js";

const tokenA = "11111111-1111-4111-8111-111111111111";
const tokenB = "22222222-2222-4222-8222-222222222222";

function event(id, time, fields) {
  return { id, time, status: "ok", ...fields };
}

test("ChatGPT local activity projects parallel turn tokens into separate Wave sessions", async () => {
  const entries = [
    event("a3", "2026-10-01T00:00:03.000Z", {
      kind: "session", action: "turn_progress", summary: "Alpha",
      details: { turn_token: tokenA, visible_report_text: "Alpha progress", next_step: "Alpha next" },
    }),
    event("b2", "2026-10-01T00:00:02.500Z", {
      kind: "mcp", action: "tools/call", tool: "read_text_file", summary: "D:\\work\\beta.txt",
      details: { turn_token: tokenB, arguments: { path: "D:\\work\\beta.txt", turn_token: tokenB } },
    }),
    event("a2", "2026-10-01T00:00:02.000Z", {
      kind: "mcp", action: "tools/call", tool: "run_command", summary: "npm test",
      details: { turn_token: tokenA, arguments: { command: "npm test", turn_token: tokenA } },
    }),
    event("b1", "2026-10-01T00:00:01.500Z", {
      kind: "session", action: "turn_started", summary: "Beta task",
      details: { turn_token: tokenB, turn_id: "turn-b" },
    }),
    event("a1", "2026-10-01T00:00:01.000Z", {
      kind: "session", action: "turn_started", summary: "Alpha task",
      details: { turn_token: tokenA, turn_id: "turn-a" },
    }),
  ];
  let calls = 0;
  const provider = createChatGptLocalActivityProvider({
    baseUrl: "http://127.0.0.1:3001",
    cacheTtlMs: 10_000,
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, json: async () => ({ entries }) };
    },
  });

  const sessions = await provider.list();
  assert.equal(calls, 1);
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions.map((item) => item.intent).sort(), ["Alpha task", "Beta task"]);
  assert.ok(sessions.every((item) => item.id.startsWith("chatgpt:")));
  assert.ok(sessions.every((item) => !item.id.includes("11111111") && !item.id.includes("22222222")),
    "opaque Local turn tokens must not be exposed as Wave session ids");
  assert.ok(sessions.every((item) => item.origin_hermes_session_title === "ChatGPT Local"));

  const alpha = sessions.find((item) => item.intent === "Alpha task");
  const timeline = await provider.timeline(alpha.id);
  assert.equal(calls, 1, "list and timeline share one short-lived source snapshot");
  assert.equal(timeline.session.id, alpha.id);
  assert.equal(timeline.spans.length, 1);
  assert.equal(timeline.spans[0].label, "ChatGPT");
  assert.equal(timeline.spans[0].stream.some((item) => item.title === "run_command" && item.detail === "npm test"), true);
  assert.equal(timeline.spans[0].stream.some((item) => item.title === "Alpha progress" && item.detail === "Alpha next"), true);
  assert.equal(JSON.stringify(timeline).includes(tokenA), false, "timeline must not leak the turn token");
});

test("ChatGPT local activity marks ended turns settled and keeps last good snapshot on transient failure", async () => {
  const entries = [
    event("e2", "2026-10-01T00:01:02.000Z", {
      kind: "session", action: "turn_ended", summary: "Ended",
      details: { turn_token: tokenA, note: "done" },
    }),
    event("e1", "2026-10-01T00:01:01.000Z", {
      kind: "session", action: "turn_started", summary: "Ended",
      details: { turn_token: tokenA },
    }),
  ];
  let fail = false;
  const provider = createChatGptLocalActivityProvider({
    baseUrl: "http://localhost:3001",
    cacheTtlMs: 0,
    fetchImpl: async () => {
      if (fail) throw new Error("offline");
      return { ok: true, json: async () => ({ entries }) };
    },
  });

  const first = await provider.list();
  assert.equal(first[0].state, "settled");
  fail = true;
  const cached = await provider.list();
  assert.deepEqual(cached, first);
  const timeline = await provider.timeline(first[0].id);
  assert.equal(timeline.spans[0].state, "completed");
  assert.equal(timeline.spans[0].stream.at(-1).detail, "done");
});

test("ChatGPT local activity refuses non-loopback sources", () => {
  assert.throws(
    () => createChatGptLocalActivityProvider({ baseUrl: "https://example.com" }),
    /loopback/,
  );
});
