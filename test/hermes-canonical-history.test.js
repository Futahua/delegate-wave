import assert from "node:assert/strict";
import test from "node:test";

import {
  CanonicalHistoryError,
  HermesCanonicalHistory,
} from "../src/session/hermes-canonical-history.js";

test("canonical history is a read-only RPC and never resumes the conversation", async () => {
  const calls = [];
  let closed = 0;
  const gateway = {
    async start() { calls.push(["start"]); },
    async request(method, params) {
      calls.push([method, params]);
      assert.equal(method, "session.canonical_history");
      return {
        session_id: "S1",
        resolved_session_id: "S0",
        messages: [{ role: "user", text: "wake", display_kind: "delegate_wave_wake" }],
      };
    },
    async resume() { throw new Error("read path must never resume"); },
    async submit() { throw new Error("read path must never submit"); },
    async close() { closed += 1; },
  };
  const history = new HermesCanonicalHistory({ gateway: () => gateway });

  assert.deepEqual(await history.read("S1", { profile: "phone" }), {
    sessionId: "S1",
    resolvedSessionId: "S0",
    messages: [{ role: "user", text: "wake", display_kind: "delegate_wave_wake" }],
  });
  assert.deepEqual(calls, [
    ["start"],
    ["session.canonical_history", { session_id: "S1", profile: "phone" }],
  ]);
  assert.equal(closed, 1);
});

test("canonical history closes its gateway and preserves protocol error code", async () => {
  let closed = 0;
  const history = new HermesCanonicalHistory({ gateway: () => ({
    async start() {},
    async request() { const error = new Error("not found"); error.code = 4007; throw error; },
    async close() { closed += 1; },
  }) });
  await assert.rejects(history.read("missing"), (error) => {
    assert.ok(error instanceof CanonicalHistoryError);
    assert.equal(error.code, 4007);
    assert.match(error.message, /missing/);
    return true;
  });
  assert.equal(closed, 1);
});
