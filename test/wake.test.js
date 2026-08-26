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
import { WakeDeliverer, classifyHistory, classifyRoutedWake, REQUIRED_CAPABILITY } from "../src/session/wake.js";
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

// The capability a real Hermes does not yet report. Granting it in a test is granting the PREMISE
// of the upstream lease, which is exactly what those tests are for.
const EXCLUSIVE = { [REQUIRED_CAPABILITY]: true };

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

// ── THE EXTERNAL-TURN ROUTE ────────────────────────────────────────────────────────────────────
//
// A different protocol with a different failure model, and the tests are written first because the
// dangerous mistakes here all LOOK correct. Reading a healthy in-progress turn as a partial
// delivery, falling back to direct submit when a capability is missing, replaying an event because
// a transcript looks empty after a forced close -- each is a reasonable-sounding inference that
// would put a second writer into somebody's conversation or say one thing twice.
//
// The receiver is a stub here, because what is under test is delegate-wave's reading of the
// receiver's answers. That the answers themselves are true of real Hermes is proved separately, by
// probes that race actual gateway processes.

// The capabilities the routed path demands. BOTH, always: the lease proves only that concurrent
// writers are fenced, and a build can enforce that while having no inbox at all -- in which case
// every enqueued event would sit forever with nothing to consume it.
const ROUTED = {
  per_session_exclusive_submit: true,
  session_external_turns_v1: true,
  session_canonical_history_v1: true,
};

// Canonical history, served from the SAME transcript file the fake gateway writes.
//
// So a test still says "the conversation contains this" with fake.append(...), and the routed path
// reads it the way production does -- through the evidence projection, without resuming anything.
function fakeCanonicalHistory(fake, { resolvedSessionId = "resolved_tip" } = {}) {
  return () => ({
    read: async () => ({
      sessionId: "stored",
      resolvedSessionId,
      messages: fake ? fake.transcript().messages : [],
    }),
  });
}

// A delivered routed wake, as it appears in canonical history: a hidden user row whose text is
// EXACTLY the wake body. Tests must build it this way, because that exactness is the contract --
// a compaction summary quoting the marker is not a delivery.
function deliveredRow(wake) {
  return { role: "user", display_kind: "hidden", text: wake.body };
}

// A stand-in for the Hermes inbox: rows, and a record of what was asked of it.
//
// `set` states a receiver observation as a PREMISE. That is the point of these cases -- delegate-wave
// cannot influence what the receiver says, and every branch below is about what it does with an
// answer it has to take at face value.
function fakeExternalTurns() {
  const rows = new Map();
  const calls = [];
  const adapter = {
    // Stores every field the producer verifies on readback. An earlier version dropped `source`,
    // and the verification correctly refused to adopt -- a stub that omits a field production
    // depends on does not make the test lenient, it makes it wrong.
    enqueue: async ({ eventId, sessionKey, body, source }) => {
      calls.push({ op: "enqueue", eventId });
      if (rows.has(eventId)) return false;
      rows.set(eventId, {
        event_id: eventId, target_session_key: sessionKey, body, source,
        state: "PENDING", owner_alive: false, owner_pid: null, outcome: null,
      });
      return true;
    },
    status: async (eventId) => {
      calls.push({ op: "status", eventId });
      return rows.get(eventId) ?? null;
    },
    reopen: async (eventId, reason) => {
      calls.push({ op: "reopen", eventId, reason });
      const row = rows.get(eventId);
      if (!row || row.state !== "STARTED" || row.owner_alive) return false;
      Object.assign(row, { state: "PENDING", owner_alive: false, owner_pid: null });
      return true;
    },
    present: async () => true,
  };
  return {
    factory: () => adapter,
    calls,
    set: (eventId, patch) => rows.set(eventId, { ...(rows.get(eventId) ?? { event_id: eventId }), ...patch }),
    get: (eventId) => rows.get(eventId) ?? null,
    count: () => rows.size,
    ops: (op) => calls.filter((call) => call.op === op),
  };
}

// A deliverer on the routed path. The kick is stubbed out by default: "make sure some owner exists"
// is a separate concern from "read what the receiver says", and mixing them makes a failure in
// either one look like a failure in the other.
function routedDeliverer(w, fake, ext, { allowEnqueue = true, kick = async () => {}, ...rest } = {}) {
  return new WakeDeliverer({
    db: w.db,
    gateway: fake ? fake.factory() : () => { throw new Error("the gateway must not be constructed here"); },
    externalTurns: ext.factory,
    canonicalHistory: fakeCanonicalHistory(fake),
    allowEnqueue,
    probe: fakeLiveness().probe,
    identity: fakeLiveness().identity,
    investigateAfterMs: 0,
    kick,
    ...rest,
  });
}

// One wake, already handed to the receiver.
function enqueuedWake(w, ext, { messages = [] } = {}) {
  const sessionId = w.session();
  registerWatch(w.db, sessionId, "hermes_routed");
  w.setState(sessionId, "COMPLETED");
  assert.equal(w.watcher.pass().length, 1);
  const wake = w.db.prepare("SELECT * FROM wake_outbox").get();
  w.db.prepare(
    `UPDATE wake_outbox SET state = 'ENQUEUED', enqueued_at = ?, owner_pid = NULL,
                            owner_started_at = NULL, gateway_pid = NULL, gateway_started_at = NULL,
                            updated_at = ? WHERE id = ?`,
  ).run(new Date().toISOString(), new Date().toISOString(), wake.id);
  ext.set(wake.id, {
    event_id: wake.id, target_session_key: wake.hermes_session_id, body: wake.body,
    source: "delegate-wave", state: "PENDING", owner_alive: false, outcome: null,
  });
  return { wake, sessionId, messages };
}

test("an in-progress remote turn is left alone, and its history is not even consulted", async (t) => {
  // THE SINGLE MOST DANGEROUS MISREADING ON THIS PATH.
  //
  // Under direct submit, a durable marker with no assistant reply could only mean the turn had
  // stopped -- the submitting process's own life had already ended. Here the turn is hosted by
  // somebody else and marker-without-reply is the ORDINARY mid-turn state. Classifying it would
  // turn every healthy long turn into a PARTIAL, block the watch, and demand a person look at a
  // conversation where nothing has gone wrong.
  //
  // So the transcript is not read at all: the gateway factory throws if anything tries.
  const w = world(t);
  const ext = fakeExternalTurns();
  const { wake } = enqueuedWake(w, ext);
  ext.set(wake.id, { state: "STARTED", owner_alive: true, owner_pid: 9000 });

  const deliverer = routedDeliverer(w, null, ext);
  assert.deepEqual((await deliverer.pass()).map((o) => o.outcome), ["WAITING"]);

  const after = w.db.prepare("SELECT * FROM wake_outbox WHERE id = ?").get(wake.id);
  assert.equal(after.state, "ENQUEUED");
  assert.equal(after.reconciled_at, null, "nothing was concluded, so nothing may claim to have been");
  assert.equal(after.last_receiver_state, "STARTED");
  assert.equal(ext.ops("reopen").length, 0);
});

test("a receiver that has not started the event yet is simply waited on", async (t) => {
  const w = world(t);
  const ext = fakeExternalTurns();
  for (const state of ["PENDING", "CLAIMED"]) {
    const { wake } = enqueuedWake(w, ext);
    ext.set(wake.id, { state, owner_alive: state === "CLAIMED" });
    const deliverer = routedDeliverer(w, null, ext);
    const outcomes = await deliverer.pass();
    assert.deepEqual(outcomes.map((o) => o.outcome), ["WAITING"], `receiver ${state}`);
    assert.equal(w.db.prepare("SELECT state FROM wake_outbox WHERE id = ?").get(wake.id).state, "ENQUEUED");
  }
});

test("a dead owner that never wrote the marker is the one case that authorises a replay", async (t) => {
  // The measured window: Hermes writes STARTED as soon as the turn thread launches, and that thread
  // persists the user row afterwards. A process killed in between leaves a row claiming a turn began
  // and a transcript containing no evidence of one -- observed at kill delays up to 0.4s.
  //
  // Absence of the marker is the ONLY evidence that authorises saying it again, and this is the only
  // branch that acts on it.
  const w = world(t);
  const ext = fakeExternalTurns();
  const fake = fakeGateway(w, { capabilities: ROUTED });
  const { wake } = enqueuedWake(w, ext);
  ext.set(wake.id, { state: "STARTED", owner_alive: false, owner_pid: 9001 });

  const deliverer = routedDeliverer(w, fake, ext);
  assert.deepEqual((await deliverer.pass()).map((o) => o.outcome), ["REOPENED"]);

  assert.deepEqual(ext.ops("reopen").map((call) => call.eventId), [wake.id]);
  const after = w.db.prepare("SELECT * FROM wake_outbox WHERE id = ?").get(wake.id);
  assert.equal(after.state, "ENQUEUED", "still the same event, awaiting an owner that can run it");
  assert.equal(after.reconciled_at, null);
});

test("a dead owner that DID write the marker is judged on the transcript, never replayed", async (t) => {
  const w = world(t);
  const ext = fakeExternalTurns();
  const { wake } = enqueuedWake(w, ext);
  const fake = fakeGateway(w, { capabilities: ROUTED });
  fake.append(deliveredRow(wake));
  fake.append({ role: "assistant", text: "done - the exporter emits json now" });
  ext.set(wake.id, { state: "STARTED", owner_alive: false, owner_pid: 9002 });

  const deliverer = routedDeliverer(w, fake, ext);
  assert.deepEqual((await deliverer.pass()).map((o) => o.outcome), ["DELIVERED"]);

  assert.equal(ext.ops("reopen").length, 0, "a turn that spoke must never be said again");
  const after = w.db.prepare("SELECT * FROM wake_outbox WHERE id = ?").get(wake.id);
  assert.equal(after.state, "DELIVERED");
  assert.notEqual(after.reconciled_at, null);
});

test("a finished turn is judged on the transcript", async (t) => {
  const w = world(t);
  const ext = fakeExternalTurns();
  const { wake } = enqueuedWake(w, ext);
  const fake = fakeGateway(w, { capabilities: ROUTED });
  fake.append(deliveredRow(wake));
  fake.append({ role: "assistant", text: "got it" });
  ext.set(wake.id, { state: "FINISHED", owner_alive: false, outcome: "completed" });

  const deliverer = routedDeliverer(w, fake, ext);
  assert.deepEqual((await deliverer.pass()).map((o) => o.outcome), ["DELIVERED"]);
  assert.equal(w.db.prepare("SELECT state FROM wake_outbox WHERE id = ?").get(wake.id).state, "DELIVERED");
});

test("a finished turn whose marker never appeared is an invariant breach, not permission to retry", async (t) => {
  // FAIL-CLOSED, and deliberately not symmetric with the dead-STARTED case above.
  //
  // FINISHED/completed is the receiver asserting that a turn started AND ended normally. If the
  // marker is not in the transcript after that, something that was supposed to be true is not, and
  // the honest response is to stop. Treating it as "nothing happened, retry" would be inferring the
  // safest-sounding explanation for evidence that does not support any explanation.
  const w = world(t);
  const ext = fakeExternalTurns();
  const { wake } = enqueuedWake(w, ext);
  const fake = fakeGateway(w, { capabilities: ROUTED });
  ext.set(wake.id, { state: "FINISHED", owner_alive: false, outcome: "completed" });

  const deliverer = routedDeliverer(w, fake, ext);
  assert.deepEqual((await deliverer.pass()).map((o) => o.outcome), ["PARTIAL"]);

  assert.equal(ext.ops("reopen").length, 0);
  const after = w.db.prepare("SELECT * FROM wake_outbox WHERE id = ?").get(wake.id);
  assert.equal(after.state, "PARTIAL");
  assert.match(after.last_error, /ended normally/i, "and says which invariant broke, not merely that one did");
  assert.equal(
    w.db.prepare("SELECT state FROM session_watches WHERE id = ?").get(wake.watch_id).state,
    "BLOCKED",
    "a person decides what happened here",
  );
});

test("a forced close with no marker halts rather than replaying", async (t) => {
  // A teardown is NOT the measured "killed before the marker persisted" case. Finalization runs
  // precisely because state may be unflushed, so an absent marker here does not prove nothing
  // happened -- tools may have run, and the transcript may simply be missing its tail.
  const w = world(t);
  const ext = fakeExternalTurns();
  const { wake } = enqueuedWake(w, ext);
  const fake = fakeGateway(w, { capabilities: ROUTED });
  ext.set(wake.id, { state: "FINISHED", owner_alive: false, outcome: "session_closed" });

  const deliverer = routedDeliverer(w, fake, ext);
  assert.deepEqual((await deliverer.pass()).map((o) => o.outcome), ["PARTIAL"]);

  assert.equal(ext.ops("reopen").length, 0, "absence after a forced close authorises nothing");
  const after = w.db.prepare("SELECT * FROM wake_outbox WHERE id = ?").get(wake.id);
  assert.equal(after.state, "PARTIAL");
  assert.match(after.last_error, /closed/i);
});

test("another user speaking first is unknowable here too", async (t) => {
  const w = world(t);
  const ext = fakeExternalTurns();
  const { wake } = enqueuedWake(w, ext);
  const fake = fakeGateway(w, { capabilities: ROUTED });
  fake.append(deliveredRow(wake));
  fake.append({ role: "user", text: "actually, do the other thing first" });
  fake.append({ role: "assistant", text: "sure" });
  ext.set(wake.id, { state: "FINISHED", owner_alive: false, outcome: "completed" });

  const deliverer = routedDeliverer(w, fake, ext);
  assert.deepEqual((await deliverer.pass()).map((o) => o.outcome), ["AMBIGUOUS"]);
  assert.equal(w.db.prepare("SELECT state FROM wake_outbox WHERE id = ?").get(wake.id).state, "PARTIAL");
});

test("either capability missing withholds the wake, and never falls back to submitting", async (t) => {
  // THE FALLBACK THAT MUST NOT EXIST.
  //
  // Falling back to the legacy transport when the new one is unavailable reads as robustness. It
  // would silently reinstate the concurrency architecture the lease exists to remove, triggered by
  // nothing more than a Hermes downgrade or a wrong interpreter path. A missing capability means
  // WAIT.
  for (const capabilities of [
    { per_session_exclusive_submit: true },
    { session_external_turns_v1: true },
    {},
  ]) {
    await t.test(`capabilities ${JSON.stringify(capabilities)}`, async (t2) => {
      const w = world(t2);
      const ext = fakeExternalTurns();
      const sessionId = w.session();
      registerWatch(w.db, sessionId, "hermes_gate");
      w.setState(sessionId, "COMPLETED");
      w.watcher.pass();
      const fake = fakeGateway(w, { capabilities });

      const deliverer = routedDeliverer(w, fake, ext);
      assert.deepEqual((await deliverer.pass()).map((o) => o.outcome), ["WITHHELD"]);

      const after = w.db.prepare("SELECT * FROM wake_outbox").get();
      assert.equal(after.state, "PENDING");
      assert.equal(after.enqueued_at, null);
      assert.equal(after.submitted_at, null, "the legacy transport must not have been used");
      assert.equal(ext.ops("enqueue").length, 0);
      assert.equal(fake.transcript().submits, 0);
    });
  }
});

test("the enqueue itself is idempotent, so one wake is one event", async (t) => {
  // The producer may not know whether its last attempt landed. Saying it again must not create a
  // second announcement -- which is why the event id is the wake id and not a fresh one per attempt.
  const w = world(t);
  const ext = fakeExternalTurns();
  const sessionId = w.session();
  registerWatch(w.db, sessionId, "hermes_dup");
  w.setState(sessionId, "COMPLETED");
  w.watcher.pass();
  const wake = w.db.prepare("SELECT * FROM wake_outbox").get();
  const fake = fakeGateway(w, { capabilities: ROUTED });

  const deliverer = routedDeliverer(w, fake, ext);
  assert.deepEqual((await deliverer.pass()).map((o) => o.outcome), ["ENQUEUED"]);

  // Hand it back to the queue as if this process had died before recording the handover, and run
  // ingress again.
  deliverer.release(w.db.prepare("SELECT * FROM wake_outbox WHERE id = ?").get(wake.id), "retrying");
  assert.deepEqual((await deliverer.pass()).map((o) => o.outcome), ["ADOPTED"],
    "the receiver is asked FIRST, so the existing event is adopted rather than offered again");

  assert.equal(ext.count(), 1, "one wake, one event in the receiver");
  assert.equal(ext.ops("enqueue").length, 1,
    "and asking first means the redundant enqueue never happens, rather than being absorbed");
  assert.equal(fake.transcript().submits, 0, "no direct submit on this path, ever");
  const after = w.db.prepare("SELECT * FROM wake_outbox WHERE id = ?").get(wake.id);
  assert.equal(after.state, "ENQUEUED");
  assert.notEqual(after.enqueued_at, null);
});

test("releasing a routed wake leaves no evidence of a delivery it did not make", async (t) => {
  // The schema forbids a PENDING row carrying enqueued_at, and forbids any row claiming both
  // transports. A release that cleared only some of the fields would either be rejected outright or
  // -- worse, if a CHECK were ever relaxed -- leave a row that recovery reads under the wrong
  // protocol's rules.
  const w = world(t);
  const ext = fakeExternalTurns();
  const { wake } = enqueuedWake(w, ext);
  w.db.prepare(
    "UPDATE wake_outbox SET last_receiver_state = 'CLAIMED', last_receiver_observed_at = ? WHERE id = ?",
  ).run(new Date().toISOString(), wake.id);

  const deliverer = routedDeliverer(w, null, ext);
  deliverer.release(w.db.prepare("SELECT * FROM wake_outbox WHERE id = ?").get(wake.id), "adapter unreachable");

  const after = w.db.prepare("SELECT * FROM wake_outbox WHERE id = ?").get(wake.id);
  assert.equal(after.state, "PENDING");
  assert.equal(after.enqueued_at, null);
  assert.equal(after.submitted_at, null, "a release must never manufacture the other protocol's evidence");
  assert.equal(after.last_receiver_state, null);
  assert.equal(after.last_receiver_observed_at, null);
  assert.equal(after.last_error, "adapter unreachable");
});

// ── THE RESUME-ONLY KICK ───────────────────────────────────────────────────────────────────────
//
// Kept apart from the reconciliation cases above on purpose. "Read what the receiver says" and
// "make sure somebody is listening" fail for completely different reasons, and a test that mixed
// them would report either failure as the other during the live run.

test("a parked kick is not joined by another on every pass", async (t) => {
  // A kick parks until ownership is settled, so a pass that started a fresh one each time would
  // spawn an unbounded number of listeners for one conversation -- each individually reasonable,
  // collectively a fork bomb against a session nobody has open.
  const w = world(t);
  const ext = fakeExternalTurns();
  const { wake } = enqueuedWake(w, ext);
  ext.set(wake.id, { state: "PENDING", owner_alive: false });

  let started = 0;
  let release;
  const parked = new Promise((resolve) => { release = resolve; });
  const deliverer = routedDeliverer(w, null, ext, {
    kick: async () => { started += 1; await parked; },
  });

  await deliverer.pass();
  await deliverer.pass();
  await deliverer.pass();
  assert.equal(started, 1, "one listener for one event, however many passes");

  release();
  await deliverer.settleKicks();
  await deliverer.pass();
  assert.equal(started, 2, "and a new one only once the previous has finished");
  release();
  await deliverer.settleKicks();
});

test("the kick resumes and never writes", async (t) => {
  // The two forbidden moves, and each would undo a different half of the architecture: a submit is
  // this process becoming the second writer the lease exists to refuse, and a lazy resume produces
  // a live session with no agent and therefore no poller to drain anything.
  const w = world(t);
  const ext = fakeExternalTurns();
  const { wake } = enqueuedWake(w, ext);
  const fake = fakeGateway(w, { capabilities: ROUTED });
  // Finished before the listener's first look: a conclusive answer, so it ends immediately.
  ext.set(wake.id, { state: "FINISHED", owner_alive: false, outcome: "completed" });

  const deliverer = routedDeliverer(w, fake, ext, { kick: undefined });
  const outcome = await deliverer.resumeKick(wake);

  assert.equal(outcome, "FINISHED");
  assert.equal(fake.transcript().submits, 0, "a kick must never submit");
  assert.ok((fake.transcript().resumes ?? 0) >= 1, "but it must actually resume");
});

test("a kick keeps listening while nobody has taken the event", async (t) => {
  // THE STATE A CLOCK MUST NEVER END.
  //
  // The earlier version gave up after fifteen seconds and closed. Between its last look at PENDING
  // and that close there is no fence: its own poller can claim and start the event in the gap, and
  // closing then kills a turn nobody ever observed starting -- manufacturing the exact
  // dead-STARTED-with-no-marker boundary the rest of this file exists to avoid.
  const w = world(t);
  const ext = fakeExternalTurns();
  const { wake } = enqueuedWake(w, ext);
  const fake = fakeGateway(w, { capabilities: ROUTED });
  ext.set(wake.id, { state: "PENDING", owner_alive: false });

  const deliverer = routedDeliverer(w, fake, ext, { kick: undefined });
  const running = deliverer.resumeKick(wake);
  const parked = await Promise.race([
    running.then(() => "ENDED"),
    new Promise((resolve) => { setTimeout(() => resolve("STILL LISTENING"), 2_500); }),
  ]);
  assert.equal(parked, "STILL LISTENING", "a pending event must not be abandoned on a timer");

  // And it ends the moment the answer is conclusive.
  ext.set(wake.id, { state: "FINISHED", owner_alive: false, outcome: "completed" });
  assert.equal(await running, "FINISHED");
});

test("a kick holds while ANY live owner is running the event", async (t) => {
  // IT DOES NOT TRY TO RECOGNISE ITS OWN CLAIM, AND MUST NOT.
  //
  // The earlier version compared the event's owner_pid against the pid of the process it spawned,
  // and held only when they matched. Measured against real Hermes, that test can never pass: a
  // virtualenv python.exe is a launcher SHIM, so the pid we spawn is the shim and the process that
  // writes owner_pid is a different one (spawn handle 30124, process reported 55312). Every kick
  // therefore concluded a stranger owned the event and closed -- destroying the turn it had just
  // caused to start. A stub could never show this, because a stub's pid IS the direct child.
  //
  // So the pid here is deliberately one that belongs to NOBODY the test knows about. Holding is
  // still the required behaviour: leaving could kill a live turn, and an idle process is cheaper
  // than a lost answer.
  const w = world(t);
  const ext = fakeExternalTurns();
  const { wake } = enqueuedWake(w, ext);
  const fake = fakeGateway(w, { capabilities: ROUTED });
  ext.set(wake.id, { state: "PENDING", owner_alive: false });

  const deliverer = routedDeliverer(w, fake, ext, { kick: undefined });
  const running = deliverer.resumeKick(wake);
  await new Promise((resolve) => { setTimeout(resolve, 1_200); });
  ext.set(wake.id, { state: "STARTED", owner_alive: true, owner_pid: 999_001 });

  const held = await Promise.race([
    running.then(() => "ENDED"),
    new Promise((resolve) => { setTimeout(() => resolve("HOLDING"), 2_000); }),
  ]);
  assert.equal(held, "HOLDING", "a live turn is running; leaving could kill it");

  ext.set(wake.id, { state: "FINISHED", owner_alive: false, outcome: "completed" });
  assert.equal(await running, "HOSTED");
});

test("a kick gives up quietly when nothing can host the session", async (t) => {
  const w = world(t);
  const ext = fakeExternalTurns();
  const { wake } = enqueuedWake(w, ext);
  const fake = fakeGateway(w, { capabilities: ROUTED, resumeFails: true });

  const deliverer = routedDeliverer(w, fake, ext, { kick: undefined });
  const outcome = await deliverer.resumeKick(wake);

  assert.equal(outcome, "FAILED");
  // The event is untouched: a kick that could not start says nothing about it, and some later pass
  // -- or a person simply opening the chat -- will provide an owner.
  const after = w.db.prepare("SELECT * FROM wake_outbox WHERE id = ?").get(wake.id);
  assert.equal(after.state, "ENQUEUED");
  assert.equal(after.reconciled_at, null);
});

test("a finished event needs no kick at all", async (t) => {
  const w = world(t);
  const ext = fakeExternalTurns();
  const { wake } = enqueuedWake(w, ext);
  ext.set(wake.id, { state: "FINISHED", owner_alive: false, outcome: "completed" });
  const fake = fakeGateway(w, { capabilities: ROUTED });

  const deliverer = routedDeliverer(w, fake, ext, { kick: undefined });
  assert.equal(await deliverer.resumeKick(wake), "FINISHED");
});

test("delivery kicks once, and observation only kicks while nobody has taken it", async (t) => {
  // The kick exists to create an owner, so it belongs exactly where there is none. Kicking a
  // CLAIMED or STARTED event would spawn a gateway to be fenced by the owner already running it.
  const w = world(t);
  const ext = fakeExternalTurns();
  const kicked = [];
  const { wake } = enqueuedWake(w, ext);

  const deliverer = routedDeliverer(w, null, ext, { kick: async (row) => { kicked.push(row.id); } });
  ext.set(wake.id, { state: "PENDING", owner_alive: false });
  await deliverer.pass();
  assert.deepEqual(kicked, [wake.id], "queued with no owner: kick");

  kicked.length = 0;
  for (const [state, alive] of [["CLAIMED", true], ["STARTED", true]]) {
    ext.set(wake.id, { state, owner_alive: alive, owner_pid: 7000 });
    await deliverer.pass();
  }
  assert.deepEqual(kicked, [], "a LIVE owner already has it: no kick");

  // A CLAIM WHOSE HOLDER DIED STILL NEEDS A LISTENER.
  //
  // Hermes recovers a dead claim itself -- but only from inside a live session's poller. If the
  // process that claimed it died with no chat open, there is no poller anywhere to do the
  // recovering, and the row sits CLAIMED forever with nothing able to notice.
  ext.set(wake.id, { state: "CLAIMED", owner_alive: false, owner_pid: 7000 });
  await deliverer.pass();
  assert.deepEqual(kicked, [wake.id], "a dead claim with no listener would wedge");
});

test("routed ingress never resumes a session", async (t) => {
  // THE HAZARD THIS REPLACED, ASSERTED AS AN ABSENCE.
  //
  // Reconciliation used to resume a session just to read its transcript. A resumed session runs
  // the external-turn poller, is eligible to consume events addressed to that conversation, and
  // destroys whatever turn it began when its gateway closes -- so the act of LOOKING could take an
  // event and then kill it. Ordering the close around one enqueue never fixed that, because the
  // hazard was any OTHER event queued for the same conversation.
  //
  // canonical_history reads the durable record without creating a live session, so the property is
  // now simply: ingress resumes nothing. Counted at the stub, which records every resume it serves.
  const w = world(t);
  const ext = fakeExternalTurns();
  const sessionId = w.session();
  registerWatch(w.db, sessionId, "hermes_noresume");
  w.setState(sessionId, "COMPLETED");
  w.watcher.pass();
  const fake = fakeGateway(w, { capabilities: ROUTED });

  const deliverer = routedDeliverer(w, fake, ext, { kick: null });
  assert.deepEqual((await deliverer.pass()).map((o) => o.outcome), ["ENQUEUED"]);

  assert.equal(fake.transcript().resumes ?? 0, 0, "ingress must not resume a session");
  assert.equal(fake.transcript().submits, 0, "and must never submit");
  assert.equal(ext.ops("enqueue").length, 1);
});

test("a status read that FAILS is not evidence that the event is gone", async (t) => {
  // THE CLOCK BUG ARRIVING THROUGH A DIFFERENT DOOR.
  //
  // The adapter distinguishes two things on purpose: a resolved null means Hermes was asked and has
  // no such event, and a rejection means the question never got through -- a spawn that failed, a
  // locked database, a timeout. An earlier version collapsed both with `.catch(() => null)`, so a
  // transient hiccup meant "the event is gone" and the listener was closed. That listener is still
  // ELIGIBLE to claim, and may have claimed and started the event in the same moment -- so closing
  // it kills a turn this process never observed starting.
  const w = world(t);
  const ext = fakeExternalTurns();
  const { wake } = enqueuedWake(w, ext);
  const fake = fakeGateway(w, { capabilities: ROUTED });
  ext.set(wake.id, { state: "PENDING", owner_alive: false });

  let closed = false;
  const watched = () => {
    const gateway = fake.factory()();
    const close = gateway.close.bind(gateway);
    gateway.close = async () => { closed = true; return close(); };
    return gateway;
  };

  let failing = true;
  const inner = ext.factory();
  const flaky = {
    ...inner,
    status: async (eventId) => {
      if (failing) throw new Error("could not reach Hermes: database is locked");
      return inner.status(eventId);
    },
  };

  const deliverer = new WakeDeliverer({
    db: w.db,
    gateway: watched,
    externalTurns: () => flaky,
    allowEnqueue: true,
    probe: fakeLiveness().probe,
    identity: fakeLiveness().identity,
    investigateAfterMs: 0,
    kick: null,
  });

  const running = deliverer.resumeKick(wake);
  await new Promise((resolve) => { setTimeout(resolve, 2_500); });
  assert.equal(closed, false, "a question that failed must not close an eligible listener");

  // The question starts working again, and the answer is that this listener owns the turn.
  const listenerPid = fake.transcript().lastResumePid ?? null;
  assert.ok(listenerPid, "the kick resumed a session");
  ext.set(wake.id, { state: "STARTED", owner_alive: true, owner_pid: listenerPid });
  failing = false;

  const held = await Promise.race([
    running.then(() => "ENDED"),
    new Promise((resolve) => { setTimeout(() => resolve("HOLDING"), 1_500); }),
  ]);
  assert.equal(held, "HOLDING", "and it hosts that turn to the end");

  ext.set(wake.id, { state: "FINISHED", owner_alive: false, outcome: "completed" });
  assert.equal(await running, "HOSTED");
});

test("a listener works even when it cannot say who it is", async (t) => {
  // The inverse of a guard that used to live here.
  //
  // The kick once needed its own identity, to compare against the event's owner_pid, and refused to
  // resume without it. That comparison is gone -- it could never succeed against a real virtualenv,
  // whose python.exe is a launcher shim spawning the actual process under a different pid -- so the
  // identity is not needed either. This asserts the dependency is genuinely absent rather than
  // merely unused: a gateway that cannot report a pid still listens and still hands off correctly.
  const w = world(t);
  const ext = fakeExternalTurns();
  const { wake } = enqueuedWake(w, ext);
  const fake = fakeGateway(w, { capabilities: ROUTED });
  ext.set(wake.id, { state: "PENDING", owner_alive: false });

  const anonymous = () => {
    const gateway = fake.factory()();
    gateway.identity = async () => { throw new Error("cannot read process start time"); };
    return gateway;
  };

  const deliverer = new WakeDeliverer({
    db: w.db,
    gateway: anonymous,
    externalTurns: ext.factory,
    canonicalHistory: fakeCanonicalHistory(fake),
    allowEnqueue: true,
    probe: fakeLiveness().probe,
    identity: fakeLiveness().identity,
    investigateAfterMs: 0,
    kick: null,
  });

  const running = deliverer.resumeKick(wake);
  await new Promise((resolve) => { setTimeout(resolve, 1_200); });
  assert.ok((fake.transcript().resumes ?? 0) >= 1, "it resumed without needing to identify itself");
  ext.set(wake.id, { state: "FINISHED", owner_alive: false, outcome: "completed" });
  assert.equal(await running, "FINISHED");
});
test("a compaction row quoting the marker is not the delivery", async (t) => {
  // THE HAZARD CANONICAL HISTORY INTRODUCED, AND WHY THE CLASSIFIER CHANGED.
  //
  // Canonical history spans the whole compression lineage, which is exactly what makes it correct
  // evidence -- and it means far more rows are in scope. Hermes's compressor deliberately pins its
  // summaries to role="user" (summary_role = "user" in context_compressor.py), so a summary of a
  // conversation that once contained a wake can itself be a user row carrying that marker.
  //
  // The old classifier anchors on the newest user row CONTAINING the marker. It would select the
  // summary, find no assistant turn after it, and call a delivered wake PARTIAL -- blocking the
  // watch over a conversation where the answer is sitting right there, earlier in the transcript.
  const w = world(t);
  const ext = fakeExternalTurns();
  const { wake } = enqueuedWake(w, ext);
  const fake = fakeGateway(w, { capabilities: ROUTED });

  fake.append(deliveredRow(wake));
  fake.append({ role: "assistant", text: "done - added the client-side run filter" });
  // ...later, compaction. A user-role summary that quotes the wake, and a hidden compaction
  // reference: both plausible impostors, neither byte-identical to what was sent.
  fake.append({ role: "user", text: `[Summary] earlier the assistant was asked: ${wake.marker}` });
  fake.append({ role: "user", display_kind: "hidden", text: `[compaction ref] ${wake.marker} rolled up` });
  ext.set(wake.id, { state: "FINISHED", owner_alive: false, outcome: "completed" });

  const deliverer = routedDeliverer(w, fake, ext);
  assert.deepEqual((await deliverer.pass()).map((o) => o.outcome), ["DELIVERED"],
    "the real hidden row is the anchor; a summary that mentions it is not");
  assert.equal(w.db.prepare("SELECT state FROM wake_outbox WHERE id = ?").get(wake.id).state, "DELIVERED");
});

test("the legacy classifier is still what the legacy transport uses", (t) => {
  // The two protocols keep their own readers. classifyHistory anchors on the marker because the
  // direct-submit path wrote an ordinary visible user row; classifyRoutedWake demands an exact
  // hidden body because that is what the routed path writes. Feeding either transcript to the
  // other reader is a category error, and keeping both named makes that visible.
  const wake = { body: "wake body <<MARKER-1>>", marker: "<<MARKER-1>>" };
  const legacyRows = [
    { role: "user", text: "wake body <<MARKER-1>>" },
    { role: "assistant", text: "on it" },
  ];
  // The legacy transport wrote a VISIBLE user row, and its own reader finds it.
  assert.equal(classifyHistory(legacyRows, wake.marker), "DELIVERED");
  // The routed reader does not, even though the text is byte-identical: a visible row is not
  // something the routed transport can have written, so treating it as one would mean claiming a
  // delivery this protocol never made.
  assert.equal(classifyRoutedWake(legacyRows, wake), "ABSENT",
    "byte-equality alone is not enough; the row must be a hidden one");
  // And the routed reader finds its own.
  assert.equal(
    classifyRoutedWake([{ role: "user", display_kind: "hidden", text: wake.body },
                        { role: "assistant", text: "on it" }], wake),
    "DELIVERED",
  );
  // Resemblance never counts, in either direction.
  assert.equal(
    classifyRoutedWake([{ role: "user", display_kind: "hidden", text: `about ${wake.marker}` }], wake),
    "ABSENT",
  );
});

// ── RECEIPT BY READBACK ────────────────────────────────────────────────────────────────────────

test("an enqueue is not believed until the receiver is read back", async (t) => {
  // enqueue() returning false means "something occupies this id", not "your event is there".
  // Recording ENQUEUED on the strength of the call alone lets the local record describe a handover
  // that never happened -- and the producer would then wait forever for a turn nobody was asked to
  // run.
  const w = world(t);
  const ext = fakeExternalTurns();
  const sessionId = w.session();
  registerWatch(w.db, sessionId, "hermes_readback");
  w.setState(sessionId, "COMPLETED");
  w.watcher.pass();
  const fake = fakeGateway(w, { capabilities: ROUTED });

  // A receiver that accepts the write and then has no record of it.
  const inner = ext.factory();
  const amnesiac = { ...inner, status: async () => null };

  const deliverer = routedDeliverer(w, fake, ext, { externalTurns: () => amnesiac });
  assert.deepEqual((await deliverer.pass()).map((o) => o.outcome), ["UNCONFIRMED"]);

  const after = w.db.prepare("SELECT * FROM wake_outbox").get();
  assert.equal(after.state, "PENDING", "still recoverable, not recorded as handed over");
  assert.equal(after.enqueued_at, null);
  assert.match(after.last_error, /not confirmed/i);
});

test("a remote event under our id that is not our event is an integrity failure", async (t) => {
  // The id matches and nothing else does. Never overwritten, never re-enqueued, and never read as
  // absence -- absence is what authorises enqueueing, and this is the opposite of absence.
  const w = world(t);
  const ext = fakeExternalTurns();
  const sessionId = w.session();
  registerWatch(w.db, sessionId, "hermes_integrity");
  w.setState(sessionId, "COMPLETED");
  w.watcher.pass();
  const wake = w.db.prepare("SELECT * FROM wake_outbox").get();
  const fake = fakeGateway(w, { capabilities: ROUTED });

  ext.set(wake.id, {
    event_id: wake.id, target_session_key: wake.hermes_session_id,
    body: "something nobody here ever sent", source: "delegate-wave",
    state: "PENDING", owner_alive: false,
  });

  const deliverer = routedDeliverer(w, fake, ext);
  assert.deepEqual((await deliverer.pass()).map((o) => o.outcome), ["INTEGRITY_FAILURE"]);

  const after = w.db.prepare("SELECT * FROM wake_outbox WHERE id = ?").get(wake.id);
  assert.equal(after.state, "PARTIAL");
  assert.match(after.last_error, /integrity/i);
  assert.equal(ext.ops("enqueue").length, 0, "and nothing was written over it");
  assert.equal(
    w.db.prepare("SELECT state FROM session_watches WHERE id = ?").get(wake.watch_id).state,
    "BLOCKED",
  );
});

test("a crash between the remote enqueue and the local record is recoverable", async (t) => {
  // THE DUAL-WRITE BOUNDARY, direction A.
  //
  // Two databases, no shared transaction. The enqueue commits in Hermes and this process dies
  // before its own row says so. Asking the receiver FIRST is what makes that survivable: the event
  // is found, verified field by field, and adopted -- rather than a second event being created, or
  // the transcript being consulted about a turn the owner has not run yet and read as "nothing
  // happened".
  const w = world(t);
  const ext = fakeExternalTurns();
  const sessionId = w.session();
  registerWatch(w.db, sessionId, "hermes_dualwrite");
  w.setState(sessionId, "COMPLETED");
  w.watcher.pass();
  const wake = w.db.prepare("SELECT * FROM wake_outbox").get();
  const fake = fakeGateway(w, { capabilities: ROUTED });

  // The remote side of a handover this database never learned about.
  await ext.factory().enqueue({
    eventId: wake.id, sessionKey: wake.hermes_session_id, body: wake.body, source: "delegate-wave",
  });
  assert.equal(ext.count(), 1);
  // Counted AFTER the setup, which is itself an enqueue call on this stub -- measuring from zero
  // would have been measuring the test's own arrangement.
  const enqueuesBefore = ext.ops("enqueue").length;

  const deliverer = routedDeliverer(w, fake, ext);
  assert.deepEqual((await deliverer.pass()).map((o) => o.outcome), ["ADOPTED"]);

  assert.equal(ext.count(), 1, "no second event was created");
  assert.equal(ext.ops("enqueue").length, enqueuesBefore,
    "and none was even attempted: the receiver was asked before anything was written");
  const after = w.db.prepare("SELECT * FROM wake_outbox WHERE id = ?").get(wake.id);
  assert.equal(after.state, "ENQUEUED");
  assert.equal(after.submitted_at, null, "and the legacy transport was not involved");
});

test("an event that appears between the status read and the enqueue is still verified", async (t) => {
  // THE DUAL-WRITE BOUNDARY, direction B.
  //
  // status() says absent, another recovery path creates the event, and this one's enqueue returns
  // its idempotent false. That false is indistinguishable from "already ours" without looking, so
  // the readback looks -- and adoption still requires every field to match.
  const w = world(t);
  const ext = fakeExternalTurns();
  const sessionId = w.session();
  registerWatch(w.db, sessionId, "hermes_interleaved");
  w.setState(sessionId, "COMPLETED");
  w.watcher.pass();
  const wake = w.db.prepare("SELECT * FROM wake_outbox").get();
  const fake = fakeGateway(w, { capabilities: ROUTED });

  const inner = ext.factory();
  let asked = 0;
  const racy = {
    ...inner,
    status: async (eventId) => {
      asked += 1;
      // Absent on the first look; by the enqueue, somebody else has created it.
      if (asked === 1) return null;
      return inner.status(eventId);
    },
    enqueue: async (args) => {
      await inner.enqueue({ ...args, source: "delegate-wave" });
      return inner.enqueue(args); // the second returns false, as a real racing retry would
    },
  };

  const deliverer = routedDeliverer(w, fake, ext, { externalTurns: () => racy });
  assert.deepEqual((await deliverer.pass()).map((o) => o.outcome), ["ENQUEUED"]);

  assert.equal(ext.count(), 1, "exactly one event exists");
  const after = w.db.prepare("SELECT * FROM wake_outbox WHERE id = ?").get(wake.id);
  assert.equal(after.state, "ENQUEUED");
});

test("adoption is a compare-and-swap, so two recoveries cannot both drive one wake", async (t) => {
  // Discovering a remote event is something two processes can do at the same moment. Both would
  // otherwise adopt it and carry on driving the same wake. The single-flight index would eventually
  // refuse one, but borrowing the invariant from another layer is how a state machine ends up
  // depending on a constraint nobody remembers is load-bearing.
  const w = world(t);
  const ext = fakeExternalTurns();
  const { wake } = enqueuedWake(w, ext);
  // Already ENQUEUED -- so a second adopter arrives to find the row no longer PREPARING.
  const deliverer = routedDeliverer(w, null, ext);
  const current = w.db.prepare("SELECT * FROM wake_outbox WHERE id = ?").get(wake.id);
  assert.equal(current.state, "ENQUEUED");
  assert.equal(
    w.db.prepare(
      `UPDATE wake_outbox SET state = 'ENQUEUED', updated_at = ? WHERE id = ? AND state = 'PREPARING'`,
    ).run(new Date().toISOString(), wake.id).changes,
    0,
    "the CAS matches only the state this process left the row in",
  );
  assert.ok(deliverer);
});

test("a routed wake stranded in PREPARING goes back to the queue, never to the legacy path", async (t) => {
  // reconcile() resumes a session and classifies with the legacy marker scan. Both are wrong here,
  // and wrong in the direction that hides the failure: resuming creates a live owner eligible to
  // consume events, and the display projection it reads can never contain a hidden row -- so every
  // routed wake would come back ABSENT and be said again.
  const w = world(t);
  const ext = fakeExternalTurns();
  const sessionId = w.session();
  registerWatch(w.db, sessionId, "hermes_stranded");
  w.setState(sessionId, "COMPLETED");
  w.watcher.pass();
  const wake = w.db.prepare("SELECT * FROM wake_outbox").get();
  w.db.prepare(
    `UPDATE wake_outbox SET state = 'PREPARING', owner_pid = 999999, owner_started_at = 'gone',
                            updated_at = ? WHERE id = ?`,
  ).run("2020-01-01T00:00:00.000Z", wake.id);

  const fake = fakeGateway(w, { capabilities: ROUTED });
  const deliverer = routedDeliverer(w, fake, ext, {
    liveness: fakeLiveness(DEAD), kick: null,
  });
  const stranded = w.db.prepare("SELECT * FROM wake_outbox WHERE id = ?").get(wake.id);
  assert.equal(await deliverer.reconcile(stranded), "PENDING");

  assert.equal(fake.transcript().resumes ?? 0, 0, "no session was resumed to recover it");
  assert.equal(w.db.prepare("SELECT state FROM wake_outbox WHERE id = ?").get(wake.id).state, "PENDING");
});

test("the watcher treats an enqueued wake as already open", async (t) => {
  // Schema 35 added ENQUEUED, and the watcher's adoption query still listed only the older
  // in-flight states. A watch re-armed while its completion wake was already with Hermes would
  // fail to see that wake and try to create another -- the unique index would refuse, so the
  // symptom is a throw rather than a duplicate, but the query should be right on its own terms.
  const w = world(t);
  const ext = fakeExternalTurns();
  const { wake } = enqueuedWake(w, ext);
  assert.equal(w.db.prepare("SELECT state FROM wake_outbox WHERE id = ?").get(wake.id).state, "ENQUEUED");

  // Clear the notification marks the way unblock() does, then let the watcher look again.
  const watch = w.db.prepare("SELECT * FROM session_watches").get();
  w.db.prepare(
    "UPDATE session_watches SET state = 'ACTIVE', notified_state = NULL, notified_message_id = NULL WHERE id = ?",
  ).run(watch.id);

  assert.deepEqual(w.watcher.pass(), [], "the enqueued wake is adopted, not duplicated");
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM wake_outbox").get().n, 1);
});
