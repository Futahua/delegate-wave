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
import { WakeDeliverer, classifyHistory } from "../src/session/wake.js";
import { HermesGateway, isBusyRefusal } from "../src/session/hermes-gateway.js";

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
  // An assistant turn with only reasoning still answered it.
  assert.equal(
    classifyHistory([{ role: "user", text: marker }, { role: "assistant", text: "", reasoning: "..." }], marker),
    "DELIVERED",
  );
});

test("a typed BUSY refusal is recognised however it is phrased", () => {
  assert.ok(isBusyRefusal({ code: 4030, message: "session is busy" }));
  assert.ok(isBusyRefusal({ code: 5000, data: { reason: "SESSION_BUSY" } }));
  assert.ok(isBusyRefusal({ code: 5000, message: "another process owns this session" }));
  assert.ok(!isBusyRefusal({ code: 4007, message: "session not found" }));
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
  const deliverer = new WakeDeliverer({ db: w.db, gateway: fake.factory(), allowSubmit: false });

  assert.deepEqual((await deliverer.pass()).map((o) => o.outcome), ["WITHHELD"]);
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

test("an accepted submission is DELIVERED only once history proves it", async (t) => {
  const w = world(t);
  const sessionId = w.session();
  registerWatch(w.db, sessionId, "hermes_ok");
  w.setState(sessionId, "COMPLETED");
  w.watcher.pass();
  const fake = fakeGateway(w, { reply: "thanks, I'll tell them" });
  const deliverer = new WakeDeliverer({ db: w.db, gateway: fake.factory(), allowSubmit: true });

  assert.deepEqual((await deliverer.pass()).map((o) => o.outcome), ["DELIVERED"]);
  const wake = w.db.prepare("SELECT * FROM wake_outbox").get();
  assert.equal(wake.state, "DELIVERED");
  assert.ok(wake.reconciled_at, "DELIVERED is not claimable without having read the history");
  assert.ok(wake.submitted_at);
  assert.equal(wake.runtime_session_id, "runtime_1");
  const transcript = fake.transcript();
  assert.equal(transcript.submits, 1);
  assert.ok(transcript.messages[0].text.includes(wake.marker));

  // And it stays said. A second pass must not deliver it again.
  assert.deepEqual(await deliverer.pass(), []);
  assert.equal(fake.transcript().submits, 1);
});

test("BUSY leaves the wake pending and writes nothing", async (t) => {
  const w = world(t);
  const sessionId = w.session();
  registerWatch(w.db, sessionId, "hermes_busy");
  w.setState(sessionId, "FAILED", "no");
  w.watcher.pass();
  const fake = fakeGateway(w, { busy: true });
  const deliverer = new WakeDeliverer({ db: w.db, gateway: fake.factory(), allowSubmit: true });

  assert.deepEqual((await deliverer.pass()).map((o) => o.outcome), ["BUSY"]);
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
  const fake = fakeGateway(w);
  fake.append({ role: "user", text: `wake\n${wakeMarker(wakeId)}` });
  w.db.prepare("UPDATE wake_outbox SET state = 'SUBMITTED', submitted_at = ?, updated_at = ? WHERE id = ?")
    .run("2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z", wakeId);

  const deliverer = new WakeDeliverer({ db: w.db, gateway: fake.factory(), allowSubmit: true });
  assert.deepEqual((await deliverer.pass()).map((o) => o.outcome), ["PARTIAL"]);
  const wake = w.db.prepare("SELECT * FROM wake_outbox").get();
  assert.equal(wake.state, "PARTIAL");
  assert.ok(wake.reconciled_at);
  assert.equal(fake.transcript().submits, 0, "a PARTIAL wake must never be resubmitted automatically");

  // And the conversation is left alone until a person says otherwise.
  const watch = w.db.prepare("SELECT * FROM session_watches").get();
  assert.equal(watch.state, "BLOCKED");
  w.setState(sessionId, "FAILED", "later");
  assert.deepEqual(w.watcher.pass(), [], "a blocked watch does not compound the ambiguity");
  w.watcher.unblock(watch.id);
  assert.equal(w.watcher.pass().length, 1, "a person can re-arm it");
});

test("a submitted wake still mid-turn is left alone until the grace window passes", async (t) => {
  const w = world(t);
  const sessionId = w.session();
  registerWatch(w.db, sessionId, "hermes_grace");
  w.setState(sessionId, "COMPLETED");
  w.watcher.pass();
  const wakeId = w.db.prepare("SELECT id FROM wake_outbox").get().id;
  const fake = fakeGateway(w);
  fake.append({ role: "user", text: wakeMarker(wakeId) });
  w.db.prepare("UPDATE wake_outbox SET state = 'SUBMITTED', submitted_at = ?, updated_at = ? WHERE id = ?")
    .run(new Date().toISOString(), new Date().toISOString(), wakeId);

  const deliverer = new WakeDeliverer({ db: w.db, gateway: fake.factory(), allowSubmit: true, partialGraceMs: 60_000 });
  assert.deepEqual(await deliverer.pass(), [], "a turn still running is not evidence of a lost one");
  assert.equal(w.db.prepare("SELECT state FROM wake_outbox").get().state, "SUBMITTED");
  // The assistant answers, and the same evidence now reads as delivered.
  fake.append({ role: "assistant", text: "got it" });
  const outcomes = await deliverer.pass({ atMs: Date.now() + 120_000 });
  assert.deepEqual(outcomes.map((o) => o.outcome), ["DELIVERED"]);
});

test("a crash before anything became durable permits a retry", async (t) => {
  const w = world(t);
  const sessionId = w.session();
  registerWatch(w.db, sessionId, "hermes_crash");
  w.setState(sessionId, "COMPLETED");
  w.watcher.pass();
  const wakeId = w.db.prepare("SELECT id FROM wake_outbox").get().id;
  // Claimed, then the process died. The transcript is empty, so nothing was said.
  w.db.prepare("UPDATE wake_outbox SET state = 'PREPARING', updated_at = ? WHERE id = ?")
    .run("2020-01-01T00:00:00.000Z", wakeId);

  const fake = fakeGateway(w);
  const deliverer = new WakeDeliverer({ db: w.db, gateway: fake.factory(), allowSubmit: true });
  const outcomes = await deliverer.pass();
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
  const fake = fakeGateway(w);
  fake.append({ role: "user", text: wakeMarker(wakeId) });
  fake.append({ role: "assistant", text: "already handled" });

  const deliverer = new WakeDeliverer({ db: w.db, gateway: fake.factory(), allowSubmit: true });
  assert.deepEqual((await deliverer.pass()).map((o) => o.outcome), ["DELIVERED"]);
  assert.equal(fake.transcript().submits, 0, "the receiver has no idempotency; this side must supply it");
});

test("only one delivery is ever open into one conversation", (t) => {
  const w = world(t);
  const first = w.session();
  const second = w.session();
  registerWatch(w.db, first, "hermes_same");
  registerWatch(w.db, second, "hermes_same");
  w.setState(first, "COMPLETED");
  w.setState(second, "FAILED", "no");
  assert.equal(w.watcher.pass().length, 2);

  const deliverer = new WakeDeliverer({ db: w.db, gateway: fakeGateway(w).factory() });
  const claimed = deliverer.claim();
  assert.ok(claimed);
  assert.equal(deliverer.claim(), null, "the second wake into the same conversation must wait");
  // The database enforces it too, not just the query that avoids it.
  assert.throws(
    () => w.db.prepare("UPDATE wake_outbox SET state = 'PREPARING' WHERE id != ?").run(claimed.id),
    /UNIQUE/,
  );
});

test("a gateway that dies mid-delivery does not authorise a retry it cannot justify", async (t) => {
  const w = world(t);
  const sessionId = w.session();
  registerWatch(w.db, sessionId, "hermes_die");
  w.setState(sessionId, "COMPLETED");
  w.watcher.pass();
  const fake = fakeGateway(w, { dieAfterUserRow: true });
  const errors = [];
  const deliverer = new WakeDeliverer({
    db: w.db, gateway: fake.factory(), allowSubmit: true, turnTimeoutMs: 2_000,
    onError: (error) => errors.push(error),
  });

  await deliverer.pass();
  const wake = w.db.prepare("SELECT * FROM wake_outbox").get();
  // The user row IS durable. Handing this back to the queue would duplicate it.
  assert.equal(wake.state, "SUBMITTED");
  assert.ok(fake.transcript().messages[0].text.includes(wake.marker));
  // And the next pass, once the grace window has passed, calls it what it is.
  const outcomes = await deliverer.pass({ atMs: Date.now() + 3_600_000 });
  assert.deepEqual(outcomes.map((o) => o.outcome), ["PARTIAL"]);
});

test("an unreachable gateway leaves the wake exactly where it was", async (t) => {
  const w = world(t);
  const sessionId = w.session();
  registerWatch(w.db, sessionId, "hermes_gone");
  w.setState(sessionId, "COMPLETED");
  w.watcher.pass();
  const fake = fakeGateway(w, { crashOnStart: true });
  const errors = [];
  const deliverer = new WakeDeliverer({
    db: w.db, gateway: fake.factory(), allowSubmit: true, onError: (error) => errors.push(error),
  });
  await deliverer.pass();
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

test("a wake survives the process that enqueued it", (t) => {
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
    const deliverer = new WakeDeliverer({ db: reopened, gateway: () => { throw new Error("unused"); } });
    assert.equal(deliverer.claim()?.id, before.id);
  } finally {
    // Closed here rather than in an after-hook: the hook that removes the directory was registered
    // first and would run first, and on Windows that is a locked file rather than a warning.
    reopened.close();
  }
});
