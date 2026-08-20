// The scarce manager's wire, tested for the one property that everything above it depends on:
// `turn/start` resolving means the turn was ACCEPTED, not that it finished.
//
// An earlier version of runTurn() checked for collected output the instant acceptance returned. That
// reads a race as an answer -- usually finding nothing and declaring the turn empty, occasionally
// finding a partial message and parsing it as the manager's decision. Every one of these tests fails
// against that version, which is the point of writing them before the state machine exists.
//
// The other property under test is the difference between "this failed" and "I do not know whether
// this was billed". Retrying the first is free; retrying the second spends the scarce resource twice
// to answer a question that may already have an answer.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CodexAppServer, scrubbedEnvironment, CONTROL_PLANE_VARIABLES } from "../src/manager/codex-app-server.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, "fixtures", "fake-app-server.mjs");

function server(scenario, options = {}) {
  return new CodexAppServer({
    executable: process.execPath,
    args: [FAKE],
    env: { DW_FAKE_SCENARIO: scenario },
    ...options,
  });
}

async function withServer(t, scenario, options, body) {
  const client = server(scenario, options);
  t.after(async () => { await client.close(); });
  await client.start();
  const threadId = await client.startThread({ cwd: here });
  return body(client, threadId);
}

test("a turn accepted now and completed later is waited for, not sampled", async (t) => {
  await withServer(t, "delayed", {}, async (client, threadId) => {
    const result = await client.runTurn({ threadId, text: "decide" });
    assert.equal(result.status, "completed");
    assert.ok(result.text, "the agent message must be collected after acceptance returned");
    assert.equal(JSON.parse(result.text).action, "ACCEPT");
    assert.equal(result.usage.inputTokens, 1200);
  });
});

test("a turn that completes without an agent message returns facts rather than throwing", async (t) => {
  // The turn genuinely finished and was genuinely billed. That is a fact the transport reports;
  // deciding it is unusable is policy, and policy needs the usage to write a receipt.
  await withServer(t, "no-message", {}, async (client, threadId) => {
    const result = await client.runTurn({ threadId, text: "decide" });
    assert.equal(result.status, "completed");
    assert.equal(result.text, null);
    assert.ok(result.usage, "usage survives so the turn can still be accounted for");
  });
});

test("a completed turn with no usage report succeeds with unknown usage, never zero", async (t) => {
  await withServer(t, "no-usage", {}, async (client, threadId) => {
    const result = await client.runTurn({ threadId, text: "decide" });
    assert.equal(result.status, "completed");
    assert.ok(result.text);
    assert.equal(result.usage, null, "absent usage is null, so the receipt records UNKNOWN");
  });
});

test("a process that dies after accepting a turn is UNCERTAIN, not failed", async (t) => {
  await withServer(t, "die-after-accept", {}, async (client, threadId) => {
    await assert.rejects(
      client.runTurn({ threadId, text: "decide" }),
      (error) => {
        // The whole point: the model may have run and the quota may be gone. Anything that reports
        // this as a clean failure invites a retry that pays twice.
        assert.equal(error.uncertain, true, "an accepted turn that vanished is uncertain");
        return true;
      },
    );
  });
});

test("a turn that hangs after acceptance times out as UNCERTAIN", async (t) => {
  await withServer(t, "hang-after-accept", { turnTimeoutMs: 300 }, async (client, threadId) => {
    await assert.rejects(
      client.runTurn({ threadId, text: "decide" }),
      (error) => {
        assert.equal(error.uncertain, true);
        assert.equal(error.timedOut, true);
        assert.match(error.message, /accepted but did not complete/);
        return true;
      },
    );
  });
});

test("notifications for another thread do not terminate this turn's wait", async (t) => {
  await withServer(t, "foreign-thread", {}, async (client, threadId) => {
    const result = await client.runTurn({ threadId, text: "decide" });
    // A sibling conversation completed first, with different content. Absorbing it would have
    // resolved this wait with the wrong answer.
    assert.equal(JSON.parse(result.text).action, "ACCEPT");
    assert.notEqual(JSON.parse(result.text).action, "ESCALATE");
    assert.equal(result.turnId, "turn-1");
  });
});

test("a turn that completed having failed is a fact, not an uncertainty", async (t) => {
  await withServer(t, "turn-failed", {}, async (client, threadId) => {
    const result = await client.runTurn({ threadId, text: "decide" });
    assert.equal(result.status, "failed");
    assert.equal(result.error, "model refused");
    // It ran. It cost something. Both are recorded, and neither is guessed at.
    assert.ok(result.usage);
  });
});

test("a turn answered inline with a completed turn is a terminal signal", async (t) => {
  await withServer(t, "inline", {}, async (client, threadId) => {
    const result = await client.runTurn({ threadId, text: "decide" });
    assert.equal(result.status, "completed");
    assert.equal(JSON.parse(result.text).action, "ACCEPT");
  });
});

test("a second turn on the same thread is refused before it is ever started", async (t) => {
  // Notifications identify a thread, not a turn, so two collectors on one thread both match
  // everything and both resolve on the first completion -- each believing it received its own
  // answer. Two manager turns silently sharing one response is the most expensive failure available
  // here, and demultiplexing cannot fix it because the turn id arrives inside the very notifications
  // being demultiplexed.
  //
  // The architecture never needs it: one managed job is one thread, and PLAN -> SYNTHESIS -> REVIEW
  // is inherently sequential. So the ambiguity is refused at the door instead.
  await withServer(t, "delayed", {}, async (client, threadId) => {
    const first = client.runTurn({ threadId, text: "one" });
    await assert.rejects(
      client.runTurn({ threadId, text: "two" }),
      /already has an active turn/,
    );
    const result = await first;
    assert.equal(JSON.parse(result.text).reason, "one", "the first turn keeps its own answer");

    // The refusal is not a permanent lock: the thread is usable again once the turn settles.
    const next = await client.runTurn({ threadId, text: "three" });
    assert.equal(JSON.parse(next.text).reason, "three");
  });
});

test("turns on different threads run concurrently and keep their own answers", async (t) => {
  const client = server("two-threads");
  t.after(async () => { await client.close(); });
  await client.start();
  const alpha = await client.startThread({ cwd: here });
  const beta = await client.startThread({ cwd: here });
  assert.notEqual(alpha, beta, "the fixture must issue genuinely distinct threads");

  // Thread `alpha` is deliberately the slower one, so a client that confused the two would resolve
  // it with beta's answer.
  const [first, second] = await Promise.all([
    client.runTurn({ threadId: alpha, text: "one" }),
    client.runTurn({ threadId: beta, text: "two" }),
  ]);
  assert.equal(JSON.parse(first.text).reason, "one");
  assert.equal(JSON.parse(second.text).reason, "two");
  assert.notEqual(first.turnId, second.turnId);
});

test("delegate-wave control credentials are never inherited by the manager", async () => {
  // The manager is the one component with enough judgement to use a stolen operator token
  // deliberately -- it could approve its own work, which would dissolve the human integration gate.
  const source = {};
  for (const name of CONTROL_PLANE_VARIABLES) source[name] = "secret";
  source.PATH = "kept";
  const scrubbed = scrubbedEnvironment(source);
  for (const name of CONTROL_PLANE_VARIABLES) {
    assert.equal(scrubbed[name], undefined, `${name} must not reach the manager`);
  }
  assert.equal(scrubbed.PATH, "kept");
});
