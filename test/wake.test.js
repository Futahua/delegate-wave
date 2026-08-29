// The wake layer, falsified against its own contract rather than against a hope.
//
// The claims under test are the ones the research measured (docs/research/HERMES-WAKE-PATH.md), and
// each of them is a claim that could be wrong in a way nobody would notice for weeks:
//
//   - watching a working session costs nothing, and says nothing
//   - a second question is a second event; the same question waiting is not
//   - an acknowledgement is not delivery; canonical history is
//   - marker absent -> retry; marker + reply -> suppress; marker + no reply -> PARTIAL, and PARTIAL
//     never retries by itself
//   - a crash between submitting and hearing back is reconciled from the transcript, not guessed at
//   - the runtime handle and the durable session id are different things
//
// The gateway under test is a stub speaking the real framing over a real pipe, with the transcript
// in a real file, because "reconciliation reads durable history" is only proven if the second
// process genuinely cannot see the first one's memory.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { initializeDataRoot, openDatabase } from "../src/db.js";
import { SessionWatcher, registerWatch, wakeMarker } from "../src/session/watcher.js";
import {
  WakeDeliverer, classifyHistory, classifyRoutedWake, REQUIRED_CAPABILITY,
} from "../src/session/wake.js";
import { HermesGateway, isBusyRefusal, OWNERSHIP_REFUSAL_REASON } from "../src/session/hermes-gateway.js";
import { ALIVE, DEAD, UNKNOWN } from "../src/session/liveness.js";

const FAKE_GATEWAY = fileURLToPath(new URL("./fixtures/fake-hermes-gateway.mjs", import.meta.url));

function world(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-wake-"));
  const paths = initializeDataRoot(path.join(temp, "data"));
  const db = openDatabase(paths.database);
  t.after(() => {
    try { db.close(); } catch { /* already closed */ }
    fs.rmSync(temp, { recursive: true, force: true });
  });
  db.prepare(`INSERT INTO projects(id, name, repo_path, integration_branch, created_at)
    VALUES ('proj', 'p', ?, 'main', ?)`).run(path.join(temp, "repo"), new Date().toISOString());

  let counter = 0;
  const session = (state = "WORKING", mode = "AUTO", outcome = null) => {
    counter += 1;
    const sessionId = `asess_${counter}`;
    db.prepare(`INSERT INTO autonomous_sessions(
      id, project_id, job_id, intent, mode, state, outcome, created_at, updated_at
    ) VALUES (?, 'proj', NULL, 'make the exporter emit json', ?, ?, ?, ?, ?)`).run(
      sessionId, mode, state, outcome, new Date().toISOString(), new Date().toISOString(),
    );
    return sessionId;
  };
  const setState = (sessionId, state, outcome = null) => {
    db.prepare("UPDATE autonomous_sessions SET state = ?, outcome = ?, updated_at = ? WHERE id = ?")
      .run(state, outcome, new Date().toISOString(), sessionId);
  };
  const ask = (sessionId, body) => {
    const ordinal = (db.prepare("SELECT MAX(ordinal) AS max FROM autonomous_session_messages WHERE session_id = ?")
      .get(sessionId).max ?? 0) + 1;
    const messageId = `amsg_${sessionId}_${ordinal}`;
    db.prepare(`INSERT INTO autonomous_session_messages(
      id, session_id, ordinal, direction, body, why_it_matters, created_at
    ) VALUES (?, ?, ?, 'TO_HERMES', ?, 'it changes what gets built', ?)`).run(
      messageId, sessionId, ordinal, body, new Date().toISOString(),
    );
    setState(sessionId, "WAITING_FOR_HERMES");
    return messageId;
  };
  const answer = (sessionId, questionId) => {
    const ordinal = db.prepare("SELECT MAX(ordinal) AS max FROM autonomous_session_messages WHERE session_id = ?")
      .get(sessionId).max + 1;
    const messageId = `amsg_${sessionId}_${ordinal}`;
    db.prepare(`INSERT INTO autonomous_session_messages(
      id, session_id, ordinal, direction, body, created_at
    ) VALUES (?, ?, ?, 'FROM_HERMES', 'yes', ?)`).run(messageId, sessionId, ordinal, new Date().toISOString());
    db.prepare("UPDATE autonomous_session_messages SET answered_by = ? WHERE id = ?").run(messageId, questionId);
    setState(sessionId, "WORKING");
  };

  // The watcher needs a session service for exactly two things: the database and "does this session
  // exist". Handing it the real one would drag a manager, a dispatcher and a git repository into a
  // test about SQL.
  const sessions = {
    db,
    get: (sessionId) => db.prepare("SELECT * FROM autonomous_sessions WHERE id = ?").get(sessionId) ?? null,
  };
  const watcher = new SessionWatcher({ sessions, intervalMs: 5 });
  t.after(() => watcher.stop());
  return { temp, db, session, setState, ask, answer, watcher, sessions };
}

// A gateway factory pointed at the stub. Each call spawns a NEW process against the SAME transcript
// file, which is what makes "the previous process crashed" expressible.
function fakeGateway(w, script = {}) {
  const statePath = path.join(w.temp, `hermes-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(statePath, JSON.stringify({ messages: script.messages ?? [], submits: 0 }));
  const factory = (override = {}) => () => new HermesGateway({
    command: process.execPath,
    args: [FAKE_GATEWAY],
    env: {
      ...process.env,
      FAKE_HERMES_STATE: statePath,
      FAKE_HERMES_SCRIPT: JSON.stringify({ ...script, ...override }),
    },
    readyTimeoutMs: 10_000,
    requestTimeoutMs: 10_000,
  });
  return {
    factory,
    transcript: () => JSON.parse(fs.readFileSync(statePath, "utf8")),
    append: (message) => {
      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      state.messages.push(message);
      fs.writeFileSync(statePath, JSON.stringify(state));
    },
  };
}

// Liveness, stated rather than probed.
//
// The real probe spawns a process per question, which is right in production and absurd in a test
// that asks a hundred times. More importantly, a test needs to say "this owner is alive" as a
// PREMISE -- the whole point of these cases is what the deliverer does with an answer it cannot
// influence.
//
// THE DELIVERER'S OWN PID IS ALIVE, ALWAYS.
//
// An earlier version of this let the blanket verdict answer for SELF_PID too, so every test quietly
// modelled a deliverer that was dead while it ran. That is not a state that exists, and it hid a
// real bug: the ordinary failure is a dead gateway under a LIVE owner, and no test was expressing
// it. A process asking whether it is itself alive can only get one answer.
const SELF_PID = 4242;

function fakeLiveness(verdict = DEAD) {
  const answers = new Map([[SELF_PID, ALIVE]]);
  return {
    identity: async () => ({ pid: SELF_PID, startedAt: "self-start" }),
    probe: async (pid) => answers.get(pid) ?? verdict,
    say: (pid, value) => answers.set(pid, value),
  };
}

// A deliverer wired for tests: stated liveness, and the capability granted unless a case is about
// withholding it.
function deliverer(w, fake, { allowSubmit = false, liveness = fakeLiveness(), ...rest } = {}) {
  return new WakeDeliverer({
    db: w.db,
    gateway: fake.factory(),
    allowSubmit,
    probe: liveness.probe,
    identity: liveness.identity,
    investigateAfterMs: 0,
    ...rest,
  });
}

function fakeExternalTurns() {
  const rows = new Map();
  const calls = { enqueue: 0, get: 0, reopen: 0 };
  let enqueueError = null;
  let throwAfterStore = false;
  const getErrors = [];
  const getErrorsAt = new Map();
  const api = {
    async enqueue({ eventId, sessionKey, body, source }) {
      calls.enqueue += 1;
      if (enqueueError && !throwAfterStore) throw enqueueError;
      if (rows.has(eventId)) return false;
      rows.set(eventId, {
        event_id: eventId, target_session_key: sessionKey, body, source,
        state: "PENDING", owner_alive: null,
      });
      if (enqueueError) throw enqueueError;
      return true;
    },
    async get(eventId) {
      calls.get += 1;
      if (getErrorsAt.has(calls.get)) throw getErrorsAt.get(calls.get);
      if (getErrors.length) throw getErrors.shift();
      return rows.has(eventId) ? { ...rows.get(eventId) } : null;
    },
    async reopen(eventId) {
      calls.reopen += 1;
      const row = rows.get(eventId);
      if (!row) return false;
      rows.set(eventId, { ...row, state: "PENDING", owner_alive: null });
      return true;
    },
  };
  return {
    factory: () => api,
    calls,
    put: (row) => rows.set(row.event_id, { ...row }),
    row: (id) => rows.get(id),
    failEnqueue: (error, { afterStore = false } = {}) => {
      enqueueError = error;
      throwAfterStore = afterStore;
    },
    failNextGet: (error) => getErrors.push(error),
    failGetCall: (call, error) => getErrorsAt.set(call, error),
  };
}

function fakeCanonical(messages = []) {
  const calls = { read: 0 };
  return {
    calls,
    factory: () => ({
      async read(sessionId) {
        calls.read += 1;
        return { sessionId, resolvedSessionId: `runtime_${sessionId}`, messages };
      },
    }),
  };
}

function routedDeliverer(w, receiver, canonical = fakeCanonical(), rest = {}) {
  return new WakeDeliverer({
    db: w.db,
    allowEnqueue: true,
    // If routed delivery ever falls through, this makes the test fail loudly rather than merely
    // observing that no legacy submission happened.
    allowSubmit: true,
    externalTurns: receiver.factory,
    canonicalHistory: canonical.factory,
    kick: null,
    gateway: () => { throw new Error("routed delivery must not construct a Hermes gateway"); },
    probe: fakeLiveness(DEAD).probe,
    identity: fakeLiveness(DEAD).identity,
    investigateAfterMs: 0,
    ...rest,
  });
}

function completedWake(w, hermesSessionId = "hermes_routed") {
  const sessionId = w.session();
  registerWatch(w.db, sessionId, hermesSessionId);
  w.setState(sessionId, "COMPLETED");
  w.watcher.pass();
  return w.db.prepare("SELECT * FROM wake_outbox WHERE session_id = ?").get(sessionId);
}

function remoteFor(wake, rest = {}) {
  return {
    event_id: wake.id,
    target_session_key: wake.hermes_session_id,
    body: wake.body,
    source: "delegate-wave",
    state: "PENDING",
    owner_alive: null,
    ...rest,
  };
}

function fakeKickGateways({ onResume = null, onClose = null, resumeError = null } = {}) {
  const calls = { start: 0, resume: [], close: 0, created: 0 };
  const gateways = [];
  return {
    calls,
    gateways,
    factory: () => {
      calls.created += 1;
      const gateway = {
        exit: null,
        async start() { calls.start += 1; },
        async resume(sessionId) {
          calls.resume.push(sessionId);
          if (onResume) await onResume(sessionId, gateway);
          if (resumeError) throw resumeError;
          return { runtimeSessionId: `runtime_${sessionId}`, durableSessionId: sessionId };
        },
        async close() {
          calls.close += 1;
          if (onClose) await onClose(gateway);
        },
      };
      gateways.push(gateway);
      return gateway;
    },
  };
}

// The capability a real Hermes does not yet report. Granting it in a test is granting the PREMISE
// of the upstream lease, which is exactly what those tests are for.
const EXCLUSIVE = { [REQUIRED_CAPABILITY]: true };

test("routed wake is enqueued once and adopted from exact receiver readback", async (t) => {
  const w = world(t);
  const wake = completedWake(w);
  const receiver = fakeExternalTurns();
  const routed = routedDeliverer(w, receiver);

  assert.deepEqual((await routed.pass()).map((item) => item.outcome), ["ENQUEUED"]);
  assert.equal(receiver.calls.enqueue, 1);
  assert.equal(w.db.prepare("SELECT state FROM wake_outbox WHERE id = ?").get(wake.id).state, "ENQUEUED");

  assert.deepEqual((await routed.pass()).map((item) => item.outcome), ["WAITING"]);
  assert.equal(receiver.calls.enqueue, 1, "observing the same wake must never enqueue it again");
});

test("restart adopts a matching remote event after crash before local ENQUEUED", async (t) => {
  const w = world(t);
  const wake = completedWake(w);
  const receiver = fakeExternalTurns();
  receiver.put(remoteFor(wake));
  w.db.prepare(`UPDATE wake_outbox SET state = 'PREPARING', owner_pid = 7001,
                                       owner_started_at = 'dead', updated_at = ? WHERE id = ?`)
    .run("2020-01-01T00:00:00.000Z", wake.id);

  const outcomes = await routedDeliverer(w, receiver).pass();
  assert.deepEqual(outcomes.map((item) => item.outcome), ["ADOPTED"]);
  assert.equal(receiver.calls.enqueue, 0, "the durable event is the receipt; it is adopted, not rewritten");
  assert.equal(w.db.prepare("SELECT state FROM wake_outbox WHERE id = ?").get(wake.id).state, "ENQUEUED");
});

test("receiver collision fails closed and blocks the watch", async (t) => {
  const w = world(t);
  const wake = completedWake(w);
  const receiver = fakeExternalTurns();
  receiver.put(remoteFor(wake, { body: `${wake.body} forged` }));

  assert.deepEqual((await routedDeliverer(w, receiver).pass()).map((item) => item.outcome),
    ["INTEGRITY_FAILURE"]);
  assert.equal(receiver.calls.enqueue, 0);
  assert.equal(w.db.prepare("SELECT state FROM wake_outbox WHERE id = ?").get(wake.id).state, "PARTIAL");
  assert.equal(w.db.prepare("SELECT state FROM session_watches WHERE id = ?").get(wake.watch_id).state, "BLOCKED");
});

test("routed readback compares the transport-normalized lone-surrogate body", async (t) => {
  const w = world(t);
  const wake = completedWake(w);
  const malformed = `${wake.body}\uDC9D`;
  w.db.prepare("UPDATE wake_outbox SET body = ? WHERE id = ?").run(malformed, wake.id);
  const receiver = fakeExternalTurns();
  // The real Python bridge repairs this at its UTF-8 boundary; model that exact remote receipt.
  receiver.put(remoteFor({ ...wake, body: malformed }, { body: `${wake.body}\uFFFD` }));
  w.db.prepare(`UPDATE wake_outbox SET state = 'PREPARING', owner_pid = 7002,
                                       owner_started_at = 'dead', updated_at = ? WHERE id = ?`)
    .run("2020-01-01T00:00:00.000Z", wake.id);

  assert.deepEqual((await routedDeliverer(w, receiver).pass()).map((item) => item.outcome), ["ADOPTED"]);
});

test("PENDING, CLAIMED, and live STARTED receiver events wait without reading history", async (t) => {
  for (const [state, owner_alive] of [["PENDING", null], ["CLAIMED", false], ["STARTED", true]]) {
    const w = world(t);
    const wake = completedWake(w, `hermes_${state}`);
    w.db.prepare("UPDATE wake_outbox SET state = 'ENQUEUED', enqueued_at = ? WHERE id = ?")
      .run(new Date().toISOString(), wake.id);
    const receiver = fakeExternalTurns();
    receiver.put(remoteFor(wake, { state, owner_alive }));
    const canonical = fakeCanonical([{ role: "user", display_kind: "delegate_wave_wake", text: wake.body }]);

    assert.deepEqual((await routedDeliverer(w, receiver, canonical).pass()).map((item) => item.outcome),
      ["WAITING"]);
    assert.equal(canonical.calls.read, 0, `${state} is not evidence that history is ready to classify`);
    assert.equal(receiver.calls.reopen, 0);
  }
});

test("dead STARTED without typed marker reopens exactly once", async (t) => {
  const w = world(t);
  const wake = completedWake(w);
  w.db.prepare("UPDATE wake_outbox SET state = 'ENQUEUED', enqueued_at = ? WHERE id = ?")
    .run(new Date().toISOString(), wake.id);
  const receiver = fakeExternalTurns();
  receiver.put(remoteFor(wake, { state: "STARTED", owner_alive: false }));
  const routed = routedDeliverer(w, receiver, fakeCanonical([]));

  assert.deepEqual((await routed.pass()).map((item) => item.outcome), ["REOPENED"]);
  assert.equal(receiver.calls.reopen, 1);
  assert.deepEqual((await routed.pass()).map((item) => item.outcome), ["WAITING"]);
  assert.equal(receiver.calls.reopen, 1);
});

test("dead STARTED with typed marker but no reply becomes PARTIAL and never reopens", async (t) => {
  const w = world(t);
  const wake = completedWake(w);
  w.db.prepare("UPDATE wake_outbox SET state = 'ENQUEUED', enqueued_at = ? WHERE id = ?")
    .run(new Date().toISOString(), wake.id);
  const receiver = fakeExternalTurns();
  receiver.put(remoteFor(wake, { state: "STARTED", owner_alive: false }));
  const canonical = fakeCanonical([{ role: "user", display_kind: "delegate_wave_wake", text: wake.body }]);

  assert.deepEqual((await routedDeliverer(w, receiver, canonical).pass()).map((item) => item.outcome),
    ["PARTIAL"]);
  assert.equal(receiver.calls.reopen, 0);
  assert.equal(w.db.prepare("SELECT state FROM wake_outbox WHERE id = ?").get(wake.id).state, "PARTIAL");
});

test("PARTIAL question blocks a queued completion from passing the same watch", async (t) => {
  const w = world(t);
  const sessionId = w.session();
  registerWatch(w.db, sessionId, "hermes_blocked_routed");
  w.ask(sessionId, "Which API should I use?");
  w.watcher.pass();
  const question = w.db.prepare("SELECT * FROM wake_outbox WHERE session_id = ?").get(sessionId);
  w.db.prepare("UPDATE wake_outbox SET state = 'ENQUEUED', enqueued_at = ? WHERE id = ?")
    .run(new Date().toISOString(), question.id);

  w.setState(sessionId, "COMPLETED");
  w.watcher.pass();
  const completion = w.db.prepare("SELECT * FROM wake_outbox WHERE session_id = ? AND id != ?")
    .get(sessionId, question.id);
  assert.equal(completion.state, "PENDING");

  const receiver = fakeExternalTurns();
  receiver.put(remoteFor(question, { state: "STARTED", owner_alive: false }));
  const canonical = fakeCanonical([
    { role: "user", display_kind: "delegate_wave_wake", text: question.body },
  ]);
  const outcomes = await routedDeliverer(w, receiver, canonical).pass();

  assert.deepEqual(outcomes.map((item) => item.outcome), ["PARTIAL"]);
  assert.equal(w.db.prepare("SELECT state FROM session_watches WHERE id = ?").get(question.watch_id).state,
    "BLOCKED");
  assert.equal(w.db.prepare("SELECT state FROM wake_outbox WHERE id = ?").get(completion.id).state,
    "PENDING", "a later terminal wake cannot overtake an ambiguous question");
  assert.equal(receiver.calls.enqueue, 0);
});

test("FINISHED with typed marker and attributable assistant response is DELIVERED", async (t) => {
  const w = world(t);
  const wake = completedWake(w);
  w.db.prepare("UPDATE wake_outbox SET state = 'ENQUEUED', enqueued_at = ? WHERE id = ?")
    .run(new Date().toISOString(), wake.id);
  const receiver = fakeExternalTurns();
  receiver.put(remoteFor(wake, { state: "FINISHED", owner_alive: false }));
  const canonical = fakeCanonical([
    { role: "user", display_kind: "delegate_wave_wake", text: wake.body },
    { role: "assistant", text: "I checked the delegated result; validation passed." },
  ]);

  assert.deepEqual((await routedDeliverer(w, receiver, canonical).pass()).map((item) => item.outcome),
    ["DELIVERED"]);
  assert.equal(w.db.prepare("SELECT state FROM wake_outbox WHERE id = ?").get(wake.id).state, "DELIVERED");
});

test("wake-shaped human prose without durable display kind is not delivery evidence", () => {
  const wake = { marker: "[delegate-wave-wake:wake_human]" };
  assert.equal(classifyRoutedWake([
    { role: "user", text: `Delegate Wave finished. ${wake.marker}` },
    { role: "assistant", text: "Looks complete." },
  ], wake), "ABSENT");
});

test("failure before enqueue invocation returns safely to PENDING", async (t) => {
  const w = world(t);
  const wake = completedWake(w);
  const receiver = fakeExternalTurns();
  receiver.failNextGet(new Error("Hermes receiver unavailable before enqueue"));
  const errors = [];

  await routedDeliverer(w, receiver, fakeCanonical(), { onError: (error) => errors.push(error) }).pass();
  assert.equal(w.db.prepare("SELECT state FROM wake_outbox WHERE id = ?").get(wake.id).state, "PENDING");
  assert.equal(receiver.calls.enqueue, 0);
  assert.equal(errors.length, 1);
});

test("post-enqueue transport ambiguity preserves PREPARING and restart adopts once", async (t) => {
  const w = world(t);
  const wake = completedWake(w);
  const receiver = fakeExternalTurns();
  receiver.failEnqueue(new Error("stdout timed out after commit"), { afterStore: true });
  const errors = [];

  await routedDeliverer(w, receiver, fakeCanonical(), { onError: (error) => errors.push(error) }).pass();
  let local = w.db.prepare("SELECT * FROM wake_outbox WHERE id = ?").get(wake.id);
  assert.equal(local.state, "PREPARING", "invoking enqueue makes a missing receipt ambiguous");
  assert.match(local.last_error, /outcome uncertain/);
  assert.equal(receiver.calls.enqueue, 1);
  assert.equal(errors.length, 1);

  assert.deepEqual((await routedDeliverer(w, receiver).pass()).map((item) => item.outcome), ["ADOPTED"]);
  local = w.db.prepare("SELECT * FROM wake_outbox WHERE id = ?").get(wake.id);
  assert.equal(local.state, "ENQUEUED");
  assert.equal(receiver.calls.enqueue, 1, "recovery adopts the committed event without invoking enqueue again");
});

test("successful enqueue followed by failed readback also preserves PREPARING", async (t) => {
  const w = world(t);
  const wake = completedWake(w);
  const receiver = fakeExternalTurns();
  // First get is the pre-enqueue absence check; second is the receipt readback.
  receiver.failGetCall(2, new Error("readback transport failed"));

  await routedDeliverer(w, receiver, fakeCanonical()).pass();
  assert.equal(w.db.prepare("SELECT state FROM wake_outbox WHERE id = ?").get(wake.id).state, "PREPARING");
  assert.equal(receiver.calls.enqueue, 1);
  assert.ok(receiver.row(wake.id), "the receiver commit happened before readback failed");

  assert.deepEqual((await routedDeliverer(w, receiver).pass()).map((item) => item.outcome), ["ADOPTED"]);
  assert.equal(receiver.calls.enqueue, 1);
});

test("one producer lease serializes ENQUEUED reconciliation across runtimes", async (t) => {
  const w = world(t);
  const wake = completedWake(w);
  w.db.prepare("UPDATE wake_outbox SET state = 'ENQUEUED', enqueued_at = ? WHERE id = ?")
    .run(new Date().toISOString(), wake.id);
  const receiver = fakeExternalTurns();
  receiver.put(remoteFor(wake, { state: "STARTED", owner_alive: false }));

  let releaseHistory;
  let historyStarted;
  const enteredHistory = new Promise((resolve) => { historyStarted = resolve; });
  const historyGate = new Promise((resolve) => { releaseHistory = resolve; });
  const canonicalA = {
    factory: () => ({
      async read(sessionId) {
        historyStarted();
        await historyGate;
        return { sessionId, resolvedSessionId: `runtime_${sessionId}`, messages: [] };
      },
    }),
  };
  const ownerA = { pid: 9101, startedAt: "owner-a" };
  const ownerB = { pid: 9102, startedAt: "owner-b" };
  let kicksA = 0;
  let kicksB = 0;
  const a = routedDeliverer(w, receiver, canonicalA, {
    identity: async () => ownerA,
    probe: async () => ALIVE,
    kick: async () => { kicksA += 1; },
  });
  const canonicalB = fakeCanonical([
    { role: "user", display_kind: "delegate_wave_wake", text: wake.body },
  ]);
  const b = routedDeliverer(w, receiver, canonicalB, {
    identity: async () => ownerB,
    probe: async (pid, startedAt) => (
      pid === ownerA.pid && startedAt === ownerA.startedAt ? ALIVE : DEAD
    ),
    kick: async () => { kicksB += 1; },
  });

  const passA = a.pass();
  await enteredHistory;
  assert.deepEqual(await b.pass(), [], "the second runtime cannot inspect under a live producer lease");
  assert.equal(canonicalB.calls.read, 0);

  releaseHistory();
  assert.deepEqual((await passA).map((item) => item.outcome), ["REOPENED"]);
  await a.settleKicks();
  assert.equal(kicksA, 1);
  assert.equal(kicksB, 0, "the runtime without the producer lease cannot kick");
  receiver.put(remoteFor(wake, { state: "STARTED", owner_alive: true }));
  assert.deepEqual(await b.pass(), [], "the successor Hermes attempt is still owned by producer A");
  assert.equal(canonicalB.calls.read, 0, "B cannot turn a healthy new attempt into stale PARTIAL evidence");
  assert.notEqual(w.db.prepare("SELECT state FROM session_watches WHERE id = ?").get(wake.watch_id).state,
    "BLOCKED");
});

test("an ENQUEUED observer lease is reclaimed only after its exact owner is proven dead", async (t) => {
  const w = world(t);
  const wake = completedWake(w);
  w.db.prepare(`UPDATE wake_outbox SET state = 'ENQUEUED', enqueued_at = ?,
                                        owner_pid = 9301, owner_started_at = 'old-birth' WHERE id = ?`)
    .run(new Date().toISOString(), wake.id);
  const receiver = fakeExternalTurns();
  receiver.put(remoteFor(wake));
  const successor = { pid: 9302, startedAt: "new-birth" };
  const probes = [];
  const routed = routedDeliverer(w, receiver, fakeCanonical(), {
    identity: async () => successor,
    probe: async (pid, startedAt) => {
      probes.push([pid, startedAt]);
      return DEAD;
    },
  });

  assert.deepEqual((await routed.pass()).map((item) => item.outcome), ["WAITING"]);
  assert.deepEqual(probes, [[9301, "old-birth"]]);
  const local = w.db.prepare("SELECT owner_pid, owner_started_at FROM wake_outbox WHERE id = ?").get(wake.id);
  assert.equal(local.owner_pid, successor.pid);
  assert.equal(local.owner_started_at, successor.startedAt);
});

test("a dead producer's live listener preserves the ENQUEUED fence across runtimes", async (t) => {
  const w = world(t);
  const wake = completedWake(w);
  w.db.prepare(`UPDATE wake_outbox SET state = 'ENQUEUED', enqueued_at = ?,
                 owner_pid = 9401, owner_started_at = 'dead-owner',
                 gateway_pid = 9402, gateway_started_at = 'live-listener' WHERE id = ?`)
    .run(new Date().toISOString(), wake.id);
  const receiver = fakeExternalTurns();
  receiver.put(remoteFor(wake));
  const answers = new Map([[9401, DEAD], [9402, ALIVE]]);
  const routed = routedDeliverer(w, receiver, fakeCanonical(), {
    identity: async () => ({ pid: 9403, startedAt: "successor" }),
    probe: async (pid) => answers.get(pid) ?? UNKNOWN,
  });

  assert.deepEqual(await routed.pass(), []);
  assert.equal(receiver.calls.get, 0, "a successor cannot inspect beneath an orphan listener");
  assert.equal(w.db.prepare("SELECT owner_pid FROM wake_outbox WHERE id = ?").get(wake.id).owner_pid, 9401);

  answers.set(9402, DEAD);
  assert.deepEqual((await routed.pass()).map((item) => item.outcome), ["WAITING"]);
  assert.equal(w.db.prepare("SELECT owner_pid FROM wake_outbox WHERE id = ?").get(wake.id).owner_pid, 9403);
});

test("a dormant PENDING event resumes its session without prompt.submit", async (t) => {
  const w = world(t);
  const wake = completedWake(w);
  w.db.prepare("UPDATE wake_outbox SET state = 'ENQUEUED', enqueued_at = ? WHERE id = ?")
    .run(new Date().toISOString(), wake.id);
  const receiver = fakeExternalTurns();
  receiver.put(remoteFor(wake));
  const gateways = fakeKickGateways({
    onResume: () => receiver.put(remoteFor(wake, { state: "FINISHED", owner_alive: false })),
  });
  const routed = routedDeliverer(w, receiver, fakeCanonical(), {
    kick: undefined,
    gateway: gateways.factory,
    kickPollMs: 0,
    sleepFn: async () => {},
  });

  assert.deepEqual((await routed.pass()).map((item) => item.outcome), ["WAITING"]);
  await routed.settleKicks();
  assert.deepEqual(gateways.calls.resume, [wake.hermes_session_id]);
  assert.equal(gateways.calls.start, 1);
  assert.equal(gateways.calls.close, 1);
  assert.equal("submit" in gateways.gateways[0], false, "the listener has no prompt submission surface");
});

test("enqueue and adoption defer kicking until receiver-state observation", async (t) => {
  {
    const w = world(t);
    completedWake(w, "hermes_new_pending");
    const receiver = fakeExternalTurns();
    let kicks = 0;
    const routed = routedDeliverer(w, receiver, fakeCanonical(), {
      kick: async () => { kicks += 1; },
    });
    assert.deepEqual((await routed.pass()).map((item) => item.outcome), ["ENQUEUED"]);
    await routed.settleKicks();
    assert.equal(kicks, 0, "enqueue readback is a receipt, not a kick decision");
    assert.deepEqual((await routed.pass()).map((item) => item.outcome), ["WAITING"]);
    await routed.settleKicks();
    assert.equal(kicks, 1, "the following PENDING observation supplies kick authority");
  }

  for (const [state, owner_alive] of [
    ["PENDING", null], ["CLAIMED", false], ["CLAIMED", true],
    ["STARTED", true], ["FINISHED", false],
  ]) {
    const w = world(t);
    const wake = completedWake(w, `hermes_adopt_${state}_${owner_alive}`);
    const receiver = fakeExternalTurns();
    receiver.put(remoteFor(wake, { state, owner_alive }));
    let kicks = 0;
    const routed = routedDeliverer(w, receiver, fakeCanonical([
      { role: "user", display_kind: "delegate_wave_wake", text: wake.body },
      { role: "assistant", text: "done" },
    ]), { kick: async () => { kicks += 1; } });

    assert.deepEqual((await routed.pass()).map((item) => item.outcome), ["ADOPTED"]);
    await routed.settleKicks();
    assert.equal(kicks, 0, `${state}/${owner_alive} adoption must not speculate about listener need`);
  }
});

test("dead CLAIMED needs a listener; live CLAIMED does not", async (t) => {
  for (const ownerAlive of [false, true]) {
    const w = world(t);
    const wake = completedWake(w, `hermes_claimed_${ownerAlive}`);
    w.db.prepare("UPDATE wake_outbox SET state = 'ENQUEUED', enqueued_at = ? WHERE id = ?")
      .run(new Date().toISOString(), wake.id);
    const receiver = fakeExternalTurns();
    receiver.put(remoteFor(wake, { state: "CLAIMED", owner_alive: ownerAlive }));
    let kicks = 0;
    const routed = routedDeliverer(w, receiver, fakeCanonical(), {
      kick: async () => { kicks += 1; },
    });

    assert.deepEqual((await routed.pass()).map((item) => item.outcome), ["WAITING"]);
    await routed.settleKicks();
    assert.equal(kicks, ownerAlive ? 0 : 1);
  }
});

test("kick remains alive through PENDING and live STARTED until FINISHED", async (t) => {
  const w = world(t);
  const wake = completedWake(w);
  w.db.prepare("UPDATE wake_outbox SET state = 'ENQUEUED', enqueued_at = ? WHERE id = ?")
    .run(new Date().toISOString(), wake.id);
  const receiver = fakeExternalTurns();
  receiver.put(remoteFor(wake));
  const gateways = fakeKickGateways();
  let polls = 0;
  const routed = routedDeliverer(w, receiver, fakeCanonical(), {
    kick: undefined,
    gateway: gateways.factory,
    kickPollMs: 0,
    sleepFn: async () => {
      polls += 1;
      if (polls === 2) receiver.put(remoteFor(wake, { state: "STARTED", owner_alive: true }));
      if (polls === 4) receiver.put(remoteFor(wake, { state: "FINISHED", owner_alive: false }));
      if (polls < 4) assert.equal(gateways.calls.close, 0, "elapsed polls cannot authorize closing");
    },
  });

  assert.equal(await routed.resumeKick(wake), "HOSTED");
  assert.equal(polls, 4);
  assert.equal(gateways.calls.close, 1);
  assert.deepEqual(gateways.calls.resume, [wake.hermes_session_id]);
});

test("dead old STARTED cannot close the listener that hosts its reopened successor", async (t) => {
  const w = world(t);
  const wake = completedWake(w);
  w.db.prepare("UPDATE wake_outbox SET state = 'ENQUEUED', enqueued_at = ? WHERE id = ?")
    .run(new Date().toISOString(), wake.id);
  const receiver = fakeExternalTurns();
  receiver.put(remoteFor(wake, { state: "STARTED", owner_alive: false }));
  const gateways = fakeKickGateways();
  let polls = 0;
  const routed = routedDeliverer(w, receiver, fakeCanonical(), {
    kick: undefined,
    gateway: gateways.factory,
    kickPollMs: 0,
    sleepFn: async () => {
      polls += 1;
      if (polls === 2) {
        // Stage-3 observer found no marker and reopened between listener observations.
        receiver.put(remoteFor(wake, { state: "PENDING", owner_alive: null }));
      }
      if (polls === 3) {
        // The still-live resumed gateway becomes the legitimate owner of the successor attempt.
        receiver.put(remoteFor(wake, { state: "STARTED", owner_alive: true }));
      }
      if (polls === 5) receiver.put(remoteFor(wake, { state: "FINISHED", owner_alive: false }));
      if (polls < 5) assert.equal(gateways.calls.close, 0, "old-owner death cannot close the successor host");
    },
  });

  assert.equal(await routed.resumeKick(wake), "HOSTED");
  assert.equal(polls, 5);
  assert.equal(gateways.calls.close, 1);
});

test("successor wake stays fenced until the prior listener has actually closed", async (t) => {
  const w = world(t);
  const sessionId = w.session();
  registerWatch(w.db, sessionId, "hermes_successive");
  const questionId = w.ask(sessionId, "Which format?");
  w.watcher.pass();
  w.answer(sessionId, questionId);
  w.setState(sessionId, "COMPLETED");
  w.watcher.pass();
  const [first, second] = w.db.prepare("SELECT * FROM wake_outbox ORDER BY created_at").all();
  w.db.prepare("UPDATE wake_outbox SET state = 'ENQUEUED', enqueued_at = ? WHERE id = ?")
    .run(new Date().toISOString(), first.id);

  const receiver = fakeExternalTurns();
  receiver.put(remoteFor(first));
  let releasePoll;
  let pollEntered;
  const pollIsWaiting = new Promise((resolve) => { pollEntered = resolve; });
  const pollGate = new Promise((resolve) => { releasePoll = resolve; });
  let releaseClose;
  let closeEntered;
  const closeIsWaiting = new Promise((resolve) => { closeEntered = resolve; });
  const closeGate = new Promise((resolve) => { releaseClose = resolve; });
  const gateways = fakeKickGateways({
    onClose: async () => {
      closeEntered();
      await closeGate;
    },
  });
  const canonical = fakeCanonical([
    { role: "user", display_kind: "delegate_wave_wake", text: first.body },
    { role: "assistant", text: "The answer was recorded." },
  ]);
  const routed = routedDeliverer(w, receiver, canonical, {
    kick: undefined,
    gateway: gateways.factory,
    kickPollMs: 0,
    sleepFn: async () => {
      pollEntered();
      await pollGate;
    },
  });

  assert.deepEqual((await routed.pass()).map((item) => item.outcome), ["WAITING"]);
  await pollIsWaiting;
  receiver.put(remoteFor(first, { state: "FINISHED", owner_alive: false }));
  let terminalPassDone = false;
  const terminalPass = routed.pass().then((result) => {
    terminalPassDone = true;
    return result;
  });
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(terminalPassDone, false);
  assert.equal(w.db.prepare("SELECT state FROM wake_outbox WHERE id = ?").get(first.id).state, "ENQUEUED");
  assert.equal(w.db.prepare("SELECT state FROM wake_outbox WHERE id = ?").get(second.id).state, "PENDING");
  assert.equal(receiver.row(second.id), undefined, "the old listener cannot consume a wake not yet handed over");

  releasePoll();
  await closeIsWaiting;
  assert.equal(w.db.prepare("SELECT state FROM wake_outbox WHERE id = ?").get(first.id).state, "ENQUEUED",
    "the durable fence remains until gateway.close resolves");
  assert.equal(w.db.prepare("SELECT state FROM wake_outbox WHERE id = ?").get(second.id).state, "PENDING");
  releaseClose();
  assert.deepEqual((await terminalPass).map((item) => item.outcome), ["DELIVERED"]);
  assert.equal(w.db.prepare("SELECT state FROM wake_outbox WHERE id = ?").get(first.id).state, "DELIVERED");
  assert.equal(w.db.prepare("SELECT state FROM wake_outbox WHERE id = ?").get(second.id).state, "PENDING",
    "successor waits for a fresh pass after listener teardown");

  assert.deepEqual((await routed.pass()).map((item) => item.outcome), ["ENQUEUED"]);
  assert.ok(receiver.row(second.id));
});

test("missing receiver readback cannot authorize closing a resumed listener", async (t) => {
  const w = world(t);
  const wake = completedWake(w);
  w.db.prepare("UPDATE wake_outbox SET state = 'ENQUEUED', enqueued_at = ? WHERE id = ?")
    .run(new Date().toISOString(), wake.id);
  const receiver = fakeExternalTurns();
  const gateways = fakeKickGateways();
  let polls = 0;
  const routed = routedDeliverer(w, receiver, fakeCanonical(), {
    kick: undefined,
    gateway: gateways.factory,
    kickPollMs: 0,
    sleepFn: async () => {
      polls += 1;
      if (polls === 2) receiver.put(remoteFor(wake, { state: "STARTED", owner_alive: true }));
      if (polls === 3) receiver.put(remoteFor(wake, { state: "FINISHED", owner_alive: false }));
      if (polls < 3) assert.equal(gateways.calls.close, 0);
    },
  });

  assert.equal(await routed.resumeKick(wake), "HOSTED");
  assert.equal(polls, 3);
  assert.equal(gateways.calls.close, 1);
});

test("ambiguous session.resume timeout is monitored instead of closing a possible owner", async (t) => {
  const w = world(t);
  const wake = completedWake(w);
  w.db.prepare("UPDATE wake_outbox SET state = 'ENQUEUED', enqueued_at = ? WHERE id = ?")
    .run(new Date().toISOString(), wake.id);
  const receiver = fakeExternalTurns();
  receiver.put(remoteFor(wake));
  const gateways = fakeKickGateways({ resumeError: new Error("session.resume timed out") });
  let polls = 0;
  const events = [];
  const routed = routedDeliverer(w, receiver, fakeCanonical(), {
    kick: undefined,
    gateway: gateways.factory,
    kickPollMs: 0,
    sleepFn: async () => {
      polls += 1;
      if (polls === 1) receiver.put(remoteFor(wake, { state: "STARTED", owner_alive: true }));
      if (polls === 2) receiver.put(remoteFor(wake, { state: "FINISHED", owner_alive: false }));
      if (polls < 2) assert.equal(gateways.calls.close, 0);
    },
    onEvent: (kind) => events.push(kind),
  });

  assert.equal(await routed.resumeKick(wake), "HOSTED");
  assert.equal(gateways.calls.close, 1);
  assert.ok(events.includes("WAKE_KICK_RESUME_UNCERTAIN"));
});

test("a killed listener can be replaced without changing the durable event", async (t) => {
  const w = world(t);
  const wake = completedWake(w);
  w.db.prepare("UPDATE wake_outbox SET state = 'ENQUEUED', enqueued_at = ? WHERE id = ?")
    .run(new Date().toISOString(), wake.id);
  const receiver = fakeExternalTurns();
  receiver.put(remoteFor(wake));
  const gateways = fakeKickGateways();
  let firstPoll = true;
  const routed = routedDeliverer(w, receiver, fakeCanonical(), {
    kick: undefined,
    gateway: gateways.factory,
    kickPollMs: 0,
    sleepFn: async () => {
      if (firstPoll) {
        firstPoll = false;
        gateways.gateways.at(-1).exit = { code: 9 };
      } else {
        receiver.put(remoteFor(wake, { state: "FINISHED", owner_alive: false }));
      }
    },
  });

  await routed.pass();
  await routed.settleKicks();
  assert.equal(gateways.calls.created, 1);
  assert.equal(receiver.calls.enqueue, 0);
  assert.equal(w.db.prepare("SELECT state FROM wake_outbox WHERE id = ?").get(wake.id).state, "ENQUEUED");

  await routed.pass();
  await routed.settleKicks();
  assert.equal(gateways.calls.created, 2, "a later pass may supply a fresh legitimate listener");
  assert.equal(receiver.calls.enqueue, 0);
});

test("a working session produces no wake and no cost", (t) => {
  const w = world(t);
  const sessionId = w.session("WORKING");
  registerWatch(w.db, sessionId, "hermes_1");
  assert.deepEqual(w.watcher.pass(), []);
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM wake_outbox").get().n, 0);
});

test("a question, a completion and a failure each become exactly one wake", (t) => {
  const w = world(t);
  for (const [state, reason] of [["COMPLETED", "COMPLETED"], ["FAILED", "FAILED"]]) {
    const sessionId = w.session("WORKING");
    registerWatch(w.db, sessionId, `hermes_${state}`);
    w.setState(sessionId, state, state === "FAILED" ? "the manager gave up" : null);
    assert.equal(w.watcher.pass().length, 1);
    // Said once. A state that persists is not an event that repeats.
    assert.deepEqual(w.watcher.pass(), []);
    const wake = w.db.prepare("SELECT * FROM wake_outbox WHERE session_id = ?").get(sessionId);
    assert.equal(wake.reason, reason);
    assert.equal(wake.state, "PENDING");
    assert.ok(wake.body.includes(wake.marker));
    // A terminal session cannot change again, so the watch has nothing left to notice.
    assert.equal(w.db.prepare("SELECT state FROM session_watches WHERE session_id = ?").get(sessionId).state, "CLOSED");
  }
});

test("a second question is a second wake; the same question waiting is not", (t) => {
  const w = world(t);
  const sessionId = w.session("WORKING");
  registerWatch(w.db, sessionId, "hermes_q");
  const first = w.ask(sessionId, "which export format did they mean?");
  assert.equal(w.watcher.pass().length, 1);
  assert.deepEqual(w.watcher.pass(), [], "the same unanswered question is not a new event");
  w.answer(sessionId, first);
  assert.deepEqual(w.watcher.pass(), [], "working again is not an event");
  w.ask(sessionId, "should the old format keep working?");
  assert.equal(w.watcher.pass().length, 1, "a genuinely different question must reach the user");
  const wakes = w.db.prepare("SELECT * FROM wake_outbox WHERE session_id = ? ORDER BY created_at").all(sessionId);
  assert.equal(wakes.length, 2);
  assert.notEqual(wakes[0].message_id, wakes[1].message_id);
  assert.ok(wakes[1].body.includes("should the old format keep working?"));
});

test("a finished MANUAL session is told about; a mid-flight AUTO one is not", (t) => {
  const w = world(t);
  const manual = w.session("WORKING", "MANUAL");
  const auto = w.session("WORKING", "AUTO");
  registerWatch(w.db, manual, "hermes_manual");
  registerWatch(w.db, auto, "hermes_auto");
  w.setState(manual, "SEMANTICALLY_ACCEPTED");
  w.setState(auto, "SEMANTICALLY_ACCEPTED");
  assert.equal(w.watcher.pass().length, 1);
  const wake = w.db.prepare("SELECT * FROM wake_outbox").get();
  assert.equal(wake.session_id, manual);
  assert.equal(wake.reason, "READY");
});

test("watching is idempotent per conversation", (t) => {
  const w = world(t);
  const sessionId = w.session();
  const first = registerWatch(w.db, sessionId, "hermes_1");
  const again = registerWatch(w.db, sessionId, "hermes_1");
  assert.equal(first.id, again.id);
  const other = registerWatch(w.db, sessionId, "hermes_2");
  assert.notEqual(other.id, first.id);
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM session_watches").get().n, 2);
});

test("an ENQUEUED logical event remains open and is not recreated", (t) => {
  const w = world(t);
  const sessionId = w.session();
  registerWatch(w.db, sessionId, "hermes_enqueued_dedup");
  w.setState(sessionId, "COMPLETED");
  assert.equal(w.watcher.pass().length, 1);
  const wake = w.db.prepare("SELECT * FROM wake_outbox WHERE session_id = ?").get(sessionId);
  w.db.prepare("UPDATE wake_outbox SET state = 'ENQUEUED', enqueued_at = ? WHERE id = ?")
    .run(new Date().toISOString(), wake.id);
  // Simulate a watcher restart that lost its denormalized notification cursor. The durable open
  // outbox row must still be enough to suppress a duplicate logical event.
  w.db.prepare(`UPDATE session_watches
    SET notified_state = NULL, notified_message_id = NULL WHERE session_id = ?`).run(sessionId);

  assert.deepEqual(w.watcher.pass(), []);
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM wake_outbox WHERE session_id = ?")
    .get(sessionId).n, 1);
});

test("an ENQUEUED wake fences a later pending wake for the same conversation", async (t) => {
  const w = world(t);
  const first = w.session();
  const second = w.session();
  registerWatch(w.db, first, "hermes_enqueued_fence");
  registerWatch(w.db, second, "hermes_enqueued_fence");
  w.setState(first, "COMPLETED");
  w.setState(second, "COMPLETED");
  w.watcher.pass();
  const wakes = w.db.prepare("SELECT * FROM wake_outbox ORDER BY created_at, id").all();
  w.db.prepare("UPDATE wake_outbox SET state = 'ENQUEUED', enqueued_at = ? WHERE id = ?")
    .run(new Date().toISOString(), wakes[0].id);

  const fake = fakeGateway(w);
  assert.deepEqual(await deliverer(w, fake).pass(), []);
  assert.equal(w.db.prepare("SELECT state FROM wake_outbox WHERE id = ?").get(wakes[1].id).state,
    "PENDING");
  assert.equal(fake.transcript().submits, 0);
});

test("history classification follows the measured crash boundaries", () => {
  const marker = wakeMarker("wake_x");
  assert.equal(classifyHistory([], marker), "ABSENT");
  assert.equal(classifyHistory([{ role: "user", text: "unrelated" }], marker), "ABSENT");
  assert.equal(classifyHistory([{ role: "user", text: `wake\n${marker}` }], marker), "PARTIAL");
  assert.equal(
    classifyHistory([{ role: "user", text: marker }, { role: "assistant", text: "on it" }], marker),
    "DELIVERED",
  );
  // A tool ran, but nothing answered. Still PARTIAL -- and this is the case where a retry would be
  // most tempting and most wrong, because the tool may have been session_answer.
  assert.equal(
    classifyHistory([{ role: "user", text: marker }, { role: "tool", name: "session_answer" }], marker),
    "PARTIAL",
  );
  // THE ONE THAT LOSES A WAKE SILENTLY.
  //
  // The wake process died; an hour later the person typed something unrelated and got an answer to
  // THAT. There is an assistant row after the marker, and it has nothing to do with the marker.
  // Reading it as DELIVERED means nobody is ever told and nothing ever retries, and the evidence
  // says it went fine. Attribution has to stop at the next user turn.
  assert.equal(
    classifyHistory([
      { role: "user", text: marker },
      { role: "user", text: "unrelated question I typed later" },
      { role: "assistant", text: "unrelated answer" },
    ], marker),
    "AMBIGUOUS",
  );
  // AN ASSISTANT THAT QUOTES THE MARKER BACK IS NOT THE MARKER.
  //
  // Acknowledging a wake by repeating its identifier is an entirely reasonable thing for a model to
  // do. A reverse search over every row would anchor on that reply, find nothing after it, and call
  // a perfectly successful delivery PARTIAL. Only a user row can BE the delivery.
  assert.equal(
    classifyHistory([
      { role: "user", text: marker },
      { role: "assistant", text: `Got it -- that was ${marker}, I will tell them.` },
    ], marker),
    "DELIVERED",
  );
  // Tool and system rows sit INSIDE a turn and are not a boundary on it.
  assert.equal(
    classifyHistory([
      { role: "user", text: marker },
      { role: "tool", name: "read" },
      { role: "system", text: "note" },
      { role: "assistant", text: "on it" },
    ], marker),
    "DELIVERED",
  );
  // An assistant turn with only reasoning still answered it.
  assert.equal(
    classifyHistory([{ role: "user", text: marker }, { role: "assistant", text: "", reasoning: "..." }], marker),
    "DELIVERED",
  );
});

test("a BUSY refusal is matched exactly, never inferred from prose", () => {
  // Hermes' existing "session busy": no turn started, nothing durable.
  assert.ok(isBusyRefusal({ code: 4009, message: "session busy" }));
  // The contract the upstream per-session lease must emit.
  assert.ok(isBusyRefusal({ code: 5000, data: { reason: OWNERSHIP_REFUSAL_REASON } }));
  assert.ok(!isBusyRefusal({ code: 4007, message: "session not found" }));
  // 4030 in Hermes 0.19.0 is "llm.oneshot requires a template" and "path outside spawn-trees root".
  // Treating it as an ownership refusal was guessing, and guessing at protocol semantics is how a
  // refusal quietly changes meaning in a version bump.
  assert.ok(!isBusyRefusal({ code: 4030, message: "path outside spawn-trees root" }));
  // Prose is not a contract. A message containing the word "busy" proves nothing about whether a
  // turn started or whether anything became durable.
  assert.ok(!isBusyRefusal({ code: 5000, message: "the disk is busy" }));
  assert.ok(!isBusyRefusal({ code: 5000, data: { reason: "SESSION_BUSY" } }));
});

test("the gateway resumes into a runtime handle that is not the durable id", async (t) => {
  const w = world(t);
  const fake = fakeGateway(w, { messages: [{ role: "user", text: "hello" }] });
  const gateway = fake.factory()();
  t.after(() => gateway.close());
  await gateway.start();
  const runtime = await gateway.resume("20260824_233004_5d8271");
  assert.equal(runtime.durableSessionId, "20260824_233004_5d8271");
  assert.notEqual(runtime.runtimeSessionId, runtime.durableSessionId);
  assert.equal(runtime.messageCount, 1);
  // History is fetched through the RUNTIME handle. Passing the durable id would be a session that
  // does not exist, and the stub refuses it exactly as Hermes does.
  assert.equal((await gateway.history(runtime.runtimeSessionId)).length, 1);
  await assert.rejects(() => gateway.history(runtime.durableSessionId), /session not found/);
});

test("with submission withheld, everything but the mutation runs", async (t) => {
  const w = world(t);
  const sessionId = w.session();
  registerWatch(w.db, sessionId, "hermes_gate");
  w.setState(sessionId, "COMPLETED");
  w.watcher.pass();
  const fake = fakeGateway(w);
  const withheld = deliverer(w, fake, { allowSubmit: false });

  assert.deepEqual((await withheld.pass()).map((o) => o.outcome), ["WITHHELD"]);
  // Nothing was said into the conversation, and the wake is still the right thing to say.
  assert.deepEqual(fake.transcript().messages, []);
  const wake = w.db.prepare("SELECT * FROM wake_outbox").get();
  assert.equal(wake.state, "PENDING");
  assert.equal(wake.attempts, 1);
  assert.match(wake.last_error, /withheld/);
  // Recorded loudly enough that a standing-still queue reads as a decision, not a broken watcher.
  assert.equal(
    w.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'WAKE_SUBMISSION_WITHHELD'").get().n, 1,
  );
});

test("the flag alone does not authorise submission; the receiver must say it is safe", async (t) => {
  // The gate that survives a Hermes downgrade, an unexpected PATH, or a copied config. An operator
  // can turn submission on; they cannot turn a receiver into one that enforces per-session
  // exclusivity, and this refuses to pretend otherwise.
  const w = world(t);
  const sessionId = w.session();
  registerWatch(w.db, sessionId, "hermes_nocap");
  w.setState(sessionId, "COMPLETED");
  w.watcher.pass();
  // No capabilities scripted: the stub answers "unknown method", exactly as Hermes 0.19.0 does.
  const fake = fakeGateway(w);
  const eager = deliverer(w, fake, { allowSubmit: true });

  assert.deepEqual((await eager.pass()).map((o) => o.outcome), ["WITHHELD"]);
  assert.deepEqual(fake.transcript().messages, [], "nothing may be written into a conversation on trust");
  const wake = w.db.prepare("SELECT * FROM wake_outbox").get();
  assert.equal(wake.state, "PENDING");
  assert.match(wake.last_error, new RegExp(REQUIRED_CAPABILITY));
  // And a receiver that reports the guarantee is believed.
  const safe = fakeGateway(w, { capabilities: EXCLUSIVE });
  assert.deepEqual((await deliverer(w, safe, { allowSubmit: true }).pass()).map((o) => o.outcome), ["DELIVERED"]);
});

test("an accepted submission is DELIVERED only once history proves it", async (t) => {
  const w = world(t);
  const sessionId = w.session();
  registerWatch(w.db, sessionId, "hermes_ok");
  w.setState(sessionId, "COMPLETED");
  w.watcher.pass();
  const fake = fakeGateway(w, { reply: "thanks, I'll tell them", capabilities: EXCLUSIVE });
  const sender = deliverer(w, fake, { allowSubmit: true });

  assert.deepEqual((await sender.pass()).map((o) => o.outcome), ["DELIVERED"]);
  const wake = w.db.prepare("SELECT * FROM wake_outbox").get();
  assert.equal(wake.state, "DELIVERED");
  assert.ok(wake.reconciled_at, "DELIVERED is not claimable without having read the history");
  assert.ok(wake.submitted_at);
  assert.equal(wake.runtime_session_id, "runtime_1");
  const transcript = fake.transcript();
  assert.equal(transcript.submits, 1);
  assert.ok(transcript.messages[0].text.includes(wake.marker));

  // And it stays said. A second pass must not deliver it again.
  assert.deepEqual(await sender.pass(), []);
  assert.equal(fake.transcript().submits, 1);
});

test("BUSY leaves the wake pending and writes nothing", async (t) => {
  const w = world(t);
  const sessionId = w.session();
  registerWatch(w.db, sessionId, "hermes_busy");
  w.setState(sessionId, "FAILED", "no");
  w.watcher.pass();
  const fake = fakeGateway(w, { busy: true, capabilities: EXCLUSIVE });
  const sender = deliverer(w, fake, { allowSubmit: true });

  assert.deepEqual((await sender.pass()).map((o) => o.outcome), ["BUSY"]);
  const wake = w.db.prepare("SELECT * FROM wake_outbox").get();
  assert.equal(wake.state, "PENDING");
  assert.equal(wake.submitted_at, null, "a typed BUSY means no turn started and nothing durable");
  assert.deepEqual(fake.transcript().messages, []);
  assert.equal(
    w.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'WAKE_REFUSED_BUSY'").get().n, 1,
  );
});

test("a durable marker with no assistant turn is PARTIAL, and never retries itself", async (t) => {
  const w = world(t);
  const sessionId = w.session();
  registerWatch(w.db, sessionId, "hermes_partial");
  w.setState(sessionId, "COMPLETED");
  w.watcher.pass();
  const wakeId = w.db.prepare("SELECT id FROM wake_outbox").get().id;

  // The measured boundary: the user row became durable and the process died before the assistant
  // one. Written straight into the transcript, because that is exactly what the dead process left.
  const fake = fakeGateway(w, { capabilities: EXCLUSIVE });
  fake.append({ role: "user", text: `wake\n${wakeMarker(wakeId)}` });
  w.db.prepare(`UPDATE wake_outbox SET state = 'SUBMITTED', submitted_at = ?, updated_at = ?,
                                       owner_pid = 5150, owner_started_at = 'gone' WHERE id = ?`)
    .run("2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z", wakeId);

  const sender = deliverer(w, fake, { allowSubmit: true });
  assert.deepEqual((await sender.pass()).map((o) => o.outcome), ["PARTIAL"]);
  const wake = w.db.prepare("SELECT * FROM wake_outbox").get();
  assert.equal(wake.state, "PARTIAL");
  assert.ok(wake.reconciled_at);
  assert.equal(fake.transcript().submits, 0, "a PARTIAL wake must never be resubmitted automatically");

  // And the conversation is left alone until a person says otherwise.
  const watch = w.db.prepare("SELECT * FROM session_watches").get();
  assert.equal(watch.state, "BLOCKED");
  w.setState(sessionId, "FAILED", "later");
  assert.deepEqual(w.watcher.pass(), [], "a blocked watch does not compound the ambiguity");

  // Clearing it is a claim that somebody read that transcript, so it names the wake they read.
  assert.throws(() => w.watcher.unblock(watch.id), /naming the PARTIAL wake/);
  assert.throws(() => w.watcher.unblock(watch.id, "wake_someone_elses"), /is held by/);
  w.watcher.unblock(watch.id, wakeId);
  assert.equal(w.watcher.pass().length, 1, "a person who named the ambiguity can re-arm it");
  // The wake stays PARTIAL for good: it is the record that this conversation was once ambiguous.
  assert.equal(w.db.prepare("SELECT state FROM wake_outbox WHERE id = ?").get(wakeId).state, "PARTIAL");
  const cleared = w.db.prepare(
    "SELECT payload_json FROM events WHERE kind = 'SESSION_WATCH_UNBLOCKED'",
  ).get();
  assert.equal(JSON.parse(cleared.payload_json).acknowledgedWake, wakeId);
});

test("another user turn before any answer is ambiguous, not delivered", async (t) => {
  // The failure that loses a wake in total silence: an unrelated later exchange in the same
  // conversation is not an answer to this marker, and must never be read as one.
  const w = world(t);
  const sessionId = w.session();
  registerWatch(w.db, sessionId, "hermes_ambiguous");
  w.setState(sessionId, "COMPLETED");
  w.watcher.pass();
  const wakeId = w.db.prepare("SELECT id FROM wake_outbox").get().id;
  const fake = fakeGateway(w, { capabilities: EXCLUSIVE });
  fake.append({ role: "user", text: wakeMarker(wakeId) });
  fake.append({ role: "user", text: "something I typed an hour later" });
  fake.append({ role: "assistant", text: "an answer to that, not to the wake" });
  w.db.prepare(`UPDATE wake_outbox SET state = 'SUBMITTED', submitted_at = ?, updated_at = ?,
                                       owner_pid = 5150, owner_started_at = 'gone' WHERE id = ?`)
    .run("2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z", wakeId);

  const outcomes = await deliverer(w, fake, { allowSubmit: true }).pass();
  assert.deepEqual(outcomes.map((o) => o.outcome), ["AMBIGUOUS"]);
  const wake = w.db.prepare("SELECT * FROM wake_outbox").get();
  // Handled exactly as PARTIAL -- no automatic retry -- while saying which ambiguity it was.
  assert.equal(wake.state, "PARTIAL");
  assert.match(wake.last_error, /another user turn/);
  assert.equal(fake.transcript().submits, 0);
  assert.equal(w.db.prepare("SELECT state FROM session_watches").get().state, "BLOCKED");
  const event = w.db.prepare("SELECT payload_json FROM events WHERE kind = 'WAKE_PARTIAL'").get();
  assert.equal(JSON.parse(event.payload_json).verdict, "AMBIGUOUS");
});

test("a blocked watch also stops the wakes already sitting in the queue", async (t) => {
  // A session asks a question and then finishes: two wakes into one conversation, the second
  // enqueued before anyone knew the first would go wrong. If the question's delivery ends ambiguous,
  // the completion is still PENDING and would walk straight into the conversation nobody can account
  // for -- which is the entire thing BLOCKED exists to prevent. The watcher not creating NEW wakes
  // was never the whole job.
  const w = world(t);
  const sessionId = w.session();
  registerWatch(w.db, sessionId, "hermes_queued");
  const question = w.ask(sessionId, "which export format did they mean?");
  assert.equal(w.watcher.pass().length, 1);
  w.answer(sessionId, question);
  w.setState(sessionId, "COMPLETED");
  assert.equal(w.watcher.pass().length, 1);
  const [first, second] = w.db.prepare("SELECT * FROM wake_outbox ORDER BY created_at").all();
  assert.equal(first.reason, "QUESTION");
  assert.equal(second.reason, "COMPLETED");

  // The question's delivery leaves the conversation ambiguous.
  const fake = fakeGateway(w, { capabilities: EXCLUSIVE });
  fake.append({ role: "user", text: first.marker });
  const liveness = fakeLiveness(DEAD);
  w.db.prepare(`UPDATE wake_outbox SET state = 'SUBMITTED', submitted_at = ?, updated_at = ?,
                                       owner_pid = 8100, owner_started_at = 'gone' WHERE id = ?`)
    .run("2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z", first.id);
  const sender = deliverer(w, fake, { allowSubmit: true, liveness });
  assert.deepEqual((await sender.pass()).map((o) => o.outcome), ["PARTIAL"]);
  assert.equal(w.db.prepare("SELECT state FROM session_watches").get().state, "BLOCKED");

  // The completion wake must not be delivered into it.
  assert.equal(await sender.claim(), null, "a queued wake is not exempt from the block");
  assert.deepEqual(await sender.pass(), []);
  assert.equal(w.db.prepare("SELECT state FROM wake_outbox WHERE id = ?").get(second.id).state, "PENDING");
  assert.equal(fake.transcript().submits, 0);

  // Only a person who names the ambiguity releases it.
  const watch = w.db.prepare("SELECT * FROM session_watches").get();
  w.watcher.unblock(watch.id, first.id);

  // AND THE WATCHER GETS A TURN BEFORE DELIVERY, AS IT WOULD IN THE RUNTIME.
  //
  // unblock() clears the notification marks on purpose, so a person who inspected an ambiguity can
  // authorise another attempt at it. But the completion wake is still sitting PENDING, and a watcher
  // that only consulted the watch would read "never announced" and write a second copy -- telling
  // the person twice about one thing. An open wake for the same event is adopted, not duplicated.
  assert.deepEqual(w.watcher.pass(), [], "a wake already on its way is not announced again");
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM wake_outbox").get().n, 2);

  assert.deepEqual((await sender.pass()).map((o) => o.outcome), ["DELIVERED"]);
  assert.equal(w.db.prepare("SELECT state FROM wake_outbox WHERE id = ?").get(second.id).state, "DELIVERED");
  assert.equal(fake.transcript().submits, 1, "the completion is delivered exactly once");
});

test("clearing a PARTIAL with no queued successor does allow the event to be announced again", async (t) => {
  // The other half of the same rule, and the reason unblock() clears the marks at all. When the
  // ambiguous wake is the ONLY copy of that event, a person who has read the transcript and decided
  // it never landed is entitled to have it said again. Adopting open wakes must not quietly take
  // that away.
  const w = world(t);
  const sessionId = w.session();
  registerWatch(w.db, sessionId, "hermes_rearm");
  w.setState(sessionId, "COMPLETED");
  assert.equal(w.watcher.pass().length, 1);
  const first = w.db.prepare("SELECT * FROM wake_outbox").get();

  const fake = fakeGateway(w, { capabilities: EXCLUSIVE });
  fake.append({ role: "user", text: first.marker });
  w.db.prepare(`UPDATE wake_outbox SET state = 'SUBMITTED', submitted_at = ?, updated_at = ?,
                                       owner_pid = 8200, owner_started_at = 'gone' WHERE id = ?`)
    .run("2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z", first.id);
  assert.deepEqual((await deliverer(w, fake, { allowSubmit: true, liveness: fakeLiveness(DEAD) }).pass())
    .map((o) => o.outcome), ["PARTIAL"]);

  const watch = w.db.prepare("SELECT * FROM session_watches").get();
  w.watcher.unblock(watch.id, first.id);
  // Nothing is queued for this event any more -- the only copy is the PARTIAL, which is not open.
  const again = w.watcher.pass();
  assert.equal(again.length, 1, "a person who cleared the ambiguity asked for another attempt");
  assert.notEqual(again[0], first.id);
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM wake_outbox").get().n, 2);
});

test("a completion wake is deliverable even though its watch closed on enqueue", async (t) => {
  // The other half of the same query. A terminal watch is CLOSED the instant it enqueues, so an
  // exclusion that caught CLOSED as well as BLOCKED would strand every completion wake ever written
  // -- the most common wake there is.
  const w = world(t);
  const sessionId = w.session();
  registerWatch(w.db, sessionId, "hermes_closed");
  w.setState(sessionId, "COMPLETED");
  w.watcher.pass();
  assert.equal(w.db.prepare("SELECT state FROM session_watches").get().state, "CLOSED");
  const fake = fakeGateway(w, { capabilities: EXCLUSIVE });
  assert.deepEqual((await deliverer(w, fake, { allowSubmit: true }).pass()).map((o) => o.outcome), ["DELIVERED"]);
});

test("a live owner keeps its wake no matter how old the row is", async (t) => {
  // THE RACE THE AGE RULE CREATED.
  //
  // A delivery whose gateway startup or model turn is genuinely slow looks, from a clock, exactly
  // like one whose owner died an hour ago. An age-based reclaim releases the first back to PENDING,
  // the original owner then submits its marker, and a second process submits it again -- two turns
  // into one conversation, which is the failure this entire subsystem exists to prevent.
  const w = world(t);
  const sessionId = w.session();
  registerWatch(w.db, sessionId, "hermes_live");
  w.setState(sessionId, "COMPLETED");
  w.watcher.pass();
  const wakeId = w.db.prepare("SELECT id FROM wake_outbox").get().id;
  const fake = fakeGateway(w, { capabilities: EXCLUSIVE });
  // Claimed a very long time ago by a process that is still perfectly alive.
  w.db.prepare(`UPDATE wake_outbox SET state = 'PREPARING', updated_at = ?,
                                       owner_pid = 7001, owner_started_at = 'still-here' WHERE id = ?`)
    .run("2020-01-01T00:00:00.000Z", wakeId);

  const liveness = fakeLiveness(ALIVE);
  const slow = deliverer(w, fake, { allowSubmit: true, liveness });
  assert.deepEqual(await slow.pass({ atMs: Date.now() + 365 * 24 * 3_600_000 }), [],
    "age is not evidence of death, however much of it there is");
  assert.equal(w.db.prepare("SELECT state FROM wake_outbox").get().state, "PREPARING");
  assert.equal(fake.transcript().submits, 0);

  // Nor does a probe that simply could not establish an answer.
  liveness.say(7001, UNKNOWN);
  assert.deepEqual(await slow.pass({ atMs: Date.now() + 365 * 24 * 3_600_000 }), [],
    "an unanswered question is not a positive death");
  assert.equal(w.db.prepare("SELECT state FROM wake_outbox").get().state, "PREPARING");

  // Only a proven death releases it, and then the transcript decides what happened.
  liveness.say(7001, DEAD);
  const outcomes = await slow.pass({ atMs: Date.now() + 365 * 24 * 3_600_000 });
  assert.deepEqual(outcomes.map((o) => o.outcome), ["PENDING", "DELIVERED"]);
});

test("an owner that died leaving its gateway alive does not free the wake", async (t) => {
  // The two processes die separately. A child still hosting a turn is still writing into a real
  // conversation, whatever happened to the runtime that spawned it.
  const w = world(t);
  const sessionId = w.session();
  registerWatch(w.db, sessionId, "hermes_orphan");
  w.setState(sessionId, "COMPLETED");
  w.watcher.pass();
  const wakeId = w.db.prepare("SELECT id FROM wake_outbox").get().id;
  const fake = fakeGateway(w, { capabilities: EXCLUSIVE });
  w.db.prepare(`UPDATE wake_outbox SET state = 'SUBMITTED', submitted_at = ?, updated_at = ?,
                                       owner_pid = 7002, owner_started_at = 'gone',
                                       gateway_pid = 7003, gateway_started_at = 'hosting'
                WHERE id = ?`).run("2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z", wakeId);

  const liveness = fakeLiveness(DEAD);
  liveness.say(7003, ALIVE);
  const orphaned = deliverer(w, fake, { allowSubmit: true, liveness });
  assert.deepEqual(await orphaned.pass(), [], "the child is still speaking; the wake is not free");
  assert.equal(w.db.prepare("SELECT state FROM wake_outbox").get().state, "SUBMITTED");
});

test("a wake claimed by an unnamed owner is never reclaimed automatically", async (t) => {
  // Rows written before schema 34 name nobody. Nothing can be proven about a process that was never
  // recorded, so a person looks -- which is slower and correct.
  const w = world(t);
  const sessionId = w.session();
  registerWatch(w.db, sessionId, "hermes_legacy");
  w.setState(sessionId, "COMPLETED");
  w.watcher.pass();
  const wakeId = w.db.prepare("SELECT id FROM wake_outbox").get().id;
  w.db.prepare("UPDATE wake_outbox SET state = 'SUBMITTED', submitted_at = ?, updated_at = ? WHERE id = ?")
    .run("2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z", wakeId);

  const stuck = deliverer(w, fakeGateway(w, { capabilities: EXCLUSIVE }), { allowSubmit: true });
  assert.deepEqual(await stuck.pass(), []);
  assert.equal(w.db.prepare("SELECT state FROM wake_outbox").get().state, "SUBMITTED");
});

test("a crash before anything became durable permits a retry", async (t) => {
  const w = world(t);
  const sessionId = w.session();
  registerWatch(w.db, sessionId, "hermes_crash");
  w.setState(sessionId, "COMPLETED");
  w.watcher.pass();
  const wakeId = w.db.prepare("SELECT id FROM wake_outbox").get().id;
  // Claimed by a process that then died -- PROVEN dead, not merely old. The transcript is empty, so
  // nothing was said, and this is the one branch where retrying is authorised by evidence.
  w.db.prepare(`UPDATE wake_outbox SET state = 'PREPARING', updated_at = ?,
                                       owner_pid = 5150, owner_started_at = 'gone' WHERE id = ?`)
    .run("2020-01-01T00:00:00.000Z", wakeId);

  const fake = fakeGateway(w, { capabilities: EXCLUSIVE });
  const outcomes = await deliverer(w, fake, { allowSubmit: true }).pass();
  // Reconciled back to PENDING, and then delivered by the claim in the very same pass.
  assert.deepEqual(outcomes.map((o) => o.outcome), ["PENDING", "DELIVERED"]);
  assert.equal(w.db.prepare("SELECT state FROM wake_outbox").get().state, "DELIVERED");
  assert.equal(fake.transcript().submits, 1);
});

test("a wake already durable from a previous life is never said twice", async (t) => {
  const w = world(t);
  const sessionId = w.session();
  registerWatch(w.db, sessionId, "hermes_dup");
  w.setState(sessionId, "COMPLETED");
  w.watcher.pass();
  const wakeId = w.db.prepare("SELECT id FROM wake_outbox").get().id;
  // A process delivered this and died before recording it. The row still says PENDING; the
  // transcript says otherwise, and the transcript is the authority.
  const fake = fakeGateway(w, { capabilities: EXCLUSIVE });
  fake.append({ role: "user", text: wakeMarker(wakeId) });
  fake.append({ role: "assistant", text: "already handled" });

  assert.deepEqual((await deliverer(w, fake, { allowSubmit: true }).pass()).map((o) => o.outcome), ["DELIVERED"]);
  assert.equal(fake.transcript().submits, 0, "the receiver has no idempotency; this side must supply it");
});

test("only one delivery is ever open into one conversation", async (t) => {
  const w = world(t);
  const first = w.session();
  const second = w.session();
  registerWatch(w.db, first, "hermes_same");
  registerWatch(w.db, second, "hermes_same");
  w.setState(first, "COMPLETED");
  w.setState(second, "FAILED", "no");
  assert.equal(w.watcher.pass().length, 2);

  const single = deliverer(w, fakeGateway(w));
  const claimed = await single.claim();
  assert.ok(claimed);
  assert.equal(await single.claim(), null, "the second wake into the same conversation must wait");
  // The claim names the process driving it, so a later runtime can ask whether it is still there.
  assert.equal(claimed.owner_pid, 4242);
  assert.equal(claimed.owner_started_at, "self-start");
  // The database enforces it too, not just the query that avoids it.
  assert.throws(
    () => w.db.prepare("UPDATE wake_outbox SET state = 'PREPARING' WHERE id != ?").run(claimed.id),
    /UNIQUE/,
  );
});

test("a gateway that dies mid-delivery is reconciled by its still-living owner", async (t) => {
  // THE ORDINARY FAILURE, and the one no earlier test expressed.
  //
  // The Hermes child dies; the delegate-wave runtime that spawned it keeps running. The
  // cross-process rule refuses -- correctly -- to touch a live owner's work, and the owner itself had
  // already returned from deliver(). Nothing was left to resolve the row, so it sat SUBMITTED until
  // this process happened to die. A wedged wake is a wake nobody is ever told about.
  const w = world(t);
  const sessionId = w.session();
  registerWatch(w.db, sessionId, "hermes_die");
  w.setState(sessionId, "COMPLETED");
  w.watcher.pass();
  const fake = fakeGateway(w, { dieAfterUserRow: true, capabilities: EXCLUSIVE });
  const errors = [];
  const liveness = fakeLiveness(DEAD);
  const dying = deliverer(w, fake, { allowSubmit: true, liveness, onError: (error) => errors.push(error) });

  const outcomes = await dying.pass();
  const wake = w.db.prepare("SELECT * FROM wake_outbox").get();
  // The user row IS durable, so returning this to the queue would duplicate it. It is settled from
  // the transcript instead -- in the SAME pass, by a fresh gateway, because the one hosting the turn
  // is gone.
  assert.deepEqual(outcomes.map((o) => o.outcome), ["SUBMITTED", "PARTIAL"]);
  assert.equal(wake.state, "PARTIAL");
  assert.ok(wake.reconciled_at, "the verdict must come from history, not from the child dying");
  assert.ok(fake.transcript().messages[0].text.includes(wake.marker));
  assert.equal(fake.transcript().submits, 1, "reconciliation reads; it must not resubmit");
  // The owner never had to die for this to resolve.
  assert.equal(await liveness.probe(SELF_PID), ALIVE);
});

test("a row this process stopped driving is resolvable without waiting for anything to die", async (t) => {
  // The same wedge reached the other way: a SUBMITTED row owned by THIS live process, which is not
  // driving it. No probe can establish that -- asking the operating system whether we are alive
  // answers the wrong question -- so it is knowledge this process has about itself.
  const w = world(t);
  const sessionId = w.session();
  registerWatch(w.db, sessionId, "hermes_wedged");
  w.setState(sessionId, "COMPLETED");
  w.watcher.pass();
  const wakeId = w.db.prepare("SELECT id FROM wake_outbox").get().id;
  const fake = fakeGateway(w, { capabilities: EXCLUSIVE });
  fake.append({ role: "user", text: wakeMarker(wakeId) });
  fake.append({ role: "assistant", text: "already handled, actually" });
  const liveness = fakeLiveness(ALIVE);
  const owner = deliverer(w, fake, { allowSubmit: true, liveness });
  // Left behind by an earlier pass of THIS process: owner alive, gateway gone.
  w.db.prepare(`UPDATE wake_outbox SET state = 'SUBMITTED', submitted_at = ?, updated_at = ?,
                                       owner_pid = ?, owner_started_at = 'self-start',
                                       gateway_pid = 9911, gateway_started_at = 'gone'
                WHERE id = ?`).run(new Date().toISOString(), new Date().toISOString(), SELF_PID, wakeId);

  const outcomes = await owner.pass();
  assert.deepEqual(outcomes.map((o) => o.outcome), ["DELIVERED"]);
  assert.equal(fake.transcript().submits, 0, "the transcript already proved it; nothing is resent");
});

test("an unreachable gateway leaves the wake exactly where it was", async (t) => {
  const w = world(t);
  const sessionId = w.session();
  registerWatch(w.db, sessionId, "hermes_gone");
  w.setState(sessionId, "COMPLETED");
  w.watcher.pass();
  const fake = fakeGateway(w, { crashOnStart: true });
  const errors = [];
  await deliverer(w, fake, { allowSubmit: true, onError: (error) => errors.push(error) }).pass();
  const wake = w.db.prepare("SELECT * FROM wake_outbox").get();
  assert.equal(wake.state, "PENDING");
  assert.equal(errors.length, 1);
  assert.match(wake.last_error, /exited/);
});

test("the outbox is evidence: it cannot be deleted", (t) => {
  const w = world(t);
  const sessionId = w.session();
  registerWatch(w.db, sessionId, "hermes_evidence");
  w.setState(sessionId, "COMPLETED");
  w.watcher.pass();
  assert.throws(() => w.db.prepare("DELETE FROM wake_outbox").run(), /immutable/);
});

test("a wake survives the process that enqueued it", async (t) => {
  const w = world(t);
  const sessionId = w.session();
  registerWatch(w.db, sessionId, "hermes_restart");
  w.setState(sessionId, "COMPLETED");
  w.watcher.pass();
  const before = w.db.prepare("SELECT * FROM wake_outbox").get();
  const file = w.db.prepare("PRAGMA database_list").all().find((row) => row.name === "main").file;
  w.db.close();

  // A different process, the same disk, no memory.
  const reopened = openDatabase(file);
  try {
    const after = reopened.prepare("SELECT * FROM wake_outbox").get();
    assert.equal(after.id, before.id);
    assert.equal(after.marker, before.marker, "the marker must never be regenerated");
    assert.equal(after.state, "PENDING");
    const revived = new WakeDeliverer({ db: reopened, gateway: () => { throw new Error("unused"); } });
    assert.equal((await revived.claim())?.id, before.id);
  } finally {
    // Closed here rather than in an after-hook: the hook that removes the directory was registered
    // first and would run first, and on Windows that is a locked file rather than a warning.
    reopened.close();
  }
});
