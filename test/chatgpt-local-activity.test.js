import assert from "node:assert/strict";
import test from "node:test";

import { createChatGptLocalActivityProvider } from "../src/presentation/chatgpt-local-activity.js";

const turnA = "11111111-1111-4111-8111-111111111111";
const turnB = "22222222-2222-4222-8222-222222222222";
const streamA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const streamB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function event(id, time, fields) {
  return { id, time, status: "ok", ...fields };
}

function started(id, time, turn, workstream, summary) {
  return event(id, time, {
    kind: "session",
    action: "turn_started",
    summary,
    details: { turn_token: turn, workstream_token: workstream },
  });
}

test("ChatGPT local activity groups many Local turns into one stable ChatGPT workstream", async () => {
  const entries = [
    started("a1", "2026-10-01T00:00:01.000Z", turnA, streamA, "First user turn"),
    event("a2", "2026-10-01T00:00:02.000Z", {
      kind: "session", action: "turn_ended", summary: "First user turn",
      details: { turn_token: turnA, workstream_token: streamA, note: "done" },
    }),
    started("b1", "2026-10-01T00:00:03.000Z", turnB, streamA, "Second user turn"),
    event("b2", "2026-10-01T00:00:04.000Z", {
      kind: "mcp", action: "tools/call", tool: "run_command", summary: "npm test",
      details: { turn_token: turnB, arguments: { command: "npm test", turn_token: turnB } },
    }),
  ];
  const provider = createChatGptLocalActivityProvider({
    baseUrl: "http://127.0.0.1:3001",
    cacheTtlMs: 0,
    now: () => Date.parse("2026-10-01T00:00:30.000Z"),
    fetchImpl: async () => ({ ok: true, json: async () => ({ entries }) }),
  });

  const sessions = await provider.list();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].intent, "First user turn", "workstream title stays stable across later Local turns");
  assert.equal(sessions[0].state, "live");
  assert.equal(sessions[0].source, "chatgpt_local");
  assert.equal(sessions[0].source_title, "ChatGPT Local");
  assert.equal("origin_hermes_session_id" in sessions[0], false);

  const timeline = await provider.timeline(sessions[0].id);
  assert.equal(timeline.spans.length, 2);
  assert.deepEqual(timeline.spans.map((span) => span.label), ["First user turn", "Second user turn"]);
  assert.deepEqual(timeline.spans.map((span) => span.state), ["completed", "live"]);
  assert.deepEqual(timeline.spans.map((span) => span.actor), ["chatgpt", "chatgpt"]);
  assert.equal(timeline.spans[1].stream.some((item) => item.title === "run_command" && item.detail === "npm test"), true);
  assert.equal(JSON.stringify(timeline).includes(streamA), false, "raw workstream token must not leak through Wave");
});

test("a later Local turn supersedes an abandoned earlier turn in the same ChatGPT workstream", async () => {
  const entries = [
    started("a1", "2026-10-01T00:00:00.000Z", turnA, streamA, "Interrupted turn"),
    started("b1", "2026-10-01T00:03:00.000Z", turnB, streamA, "Current turn"),
  ];
  const provider = createChatGptLocalActivityProvider({
    cacheTtlMs: 0,
    now: () => Date.parse("2026-10-01T00:03:30.000Z"),
    fetchImpl: async () => ({ ok: true, json: async () => ({ entries }) }),
  });

  const [session] = await provider.list();
  const timeline = await provider.timeline(session.id);
  assert.deepEqual(timeline.spans.map((span) => span.state), ["cancelled", "live"]);
  assert.equal(timeline.spans[0].finished_at, "2026-10-01T00:03:00.000Z");
});

test("ChatGPT local activity prefers the durable workstream journal and falls back to the legacy activity window", async () => {
  const entries = [
    started("a1", "2026-10-01T00:00:01.000Z", turnA, streamA, "Durable chat"),
  ];
  const requested = [];
  const provider = createChatGptLocalActivityProvider({
    cacheTtlMs: 0,
    fetchImpl: async (url) => {
      requested.push(String(url));
      if (String(url).includes("/api/activity/workstreams")) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({ entries }) };
    },
  });
  const sessions = await provider.list();
  assert.equal(sessions.length, 1);
  assert.equal(requested[0].includes("/api/activity/workstreams?limit=20000"), true);
  assert.equal(requested[1].includes("/api/activity?limit=500"), true);
});

test("ChatGPT local activity advances the durable cursor instead of refetching the whole history", async () => {
  const tool = event("a2", "2026-10-01T00:00:02.000Z", {
    kind: "mcp",
    action: "tools/call",
    tool: "run_command",
    summary: "npm test",
    details: { turn_token: turnA },
  });
  const requested = [];
  let durableCalls = 0;
  const provider = createChatGptLocalActivityProvider({
    cacheTtlMs: 0,
    now: () => Date.parse("2026-10-01T00:00:30.000Z"),
    fetchImpl: async (url) => {
      requested.push(String(url));
      durableCalls += 1;
      if (durableCalls === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            entries: [started("a1", "2026-10-01T00:00:01.000Z", turnA, streamA, "Cursor chat")],
            latest_id: "a1",
            reset: false,
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ entries: [tool], latest_id: "a2", reset: false }),
      };
    },
  });

  const [session] = await provider.list();
  const timeline = await provider.timeline(session.id);
  assert.equal(requested[0].includes("limit=20000"), true);
  assert.equal(requested[0].includes("since="), false);
  assert.equal(requested[1].includes("since=a1"), true);
  assert.equal(timeline.spans[0].stream.some((item) => item.title === "run_command"), true);
});

test("parallel ChatGPT workstreams stay separate and inactive unended turns become waiting instead of falsely live", async () => {
  const entries = [
    started("a1", "2026-10-01T00:00:00.000Z", turnA, streamA, "Chat A"),
    started("b1", "2026-10-01T00:04:00.000Z", turnB, streamB, "Chat B"),
  ];
  const provider = createChatGptLocalActivityProvider({
    cacheTtlMs: 0,
    now: () => Date.parse("2026-10-01T00:05:00.000Z"),
    fetchImpl: async () => ({ ok: true, json: async () => ({ entries }) }),
  });

  const sessions = await provider.list();
  assert.equal(sessions.length, 2);
  const a = sessions.find((session) => session.intent === "Chat A");
  const b = sessions.find((session) => session.intent === "Chat B");
  assert.equal(a.state, "waiting");
  assert.equal(b.state, "live");
  assert.notEqual(a.id, b.id);
});

test("legacy turn-only activity is not misrepresented as a ChatGPT session", async () => {
  const entries = [
    event("legacy", "2026-10-01T00:00:00.000Z", {
      kind: "session", action: "turn_started", summary: "Old turn",
      details: { turn_token: turnA },
    }),
  ];
  const provider = createChatGptLocalActivityProvider({
    cacheTtlMs: 0,
    fetchImpl: async () => ({ ok: true, json: async () => ({ entries }) }),
  });
  assert.deepEqual(await provider.list(), []);
});

test("ended workstreams settle and the provider keeps its last good snapshot on transient failure", async () => {
  const entries = [
    started("e1", "2026-10-01T00:01:01.000Z", turnA, streamA, "Ended"),
    event("e2", "2026-10-01T00:01:02.000Z", {
      kind: "session", action: "turn_ended", summary: "Ended",
      details: { turn_token: turnA, workstream_token: streamA, note: "done" },
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
  assert.deepEqual(await provider.list(), first);
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
