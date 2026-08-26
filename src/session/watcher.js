// The half of autonomy that nobody notices until it is missing: being told.
//
// A session that finishes at three in the morning is not finished in any sense that matters if the
// only way to learn it finished is to ask. Everything below this file already works unattended --
// the manager decides, workers build, validation proves, integration publishes -- and then the
// result sits in SQLite waiting for somebody to poll for it. This is the watcher that notices, and
// it is deliberately the cheapest thing in the system.
//
// IT COSTS NOTHING TO WATCH.
//
// Not "very little": nothing. A pass is one indexed SELECT and, when something actually changed,
// one INSERT. No model is consulted to decide whether a state is worth mentioning, because that
// decision is not a judgment -- it is a fact about a column. A watcher that reasoned about
// significance would spend scarce tokens every two seconds to conclude "still working", which is
// the exact substitution this architecture exists to prevent.
//
// WORKING IS NOT AN EVENT.
//
// The only states worth waking for are the ones where the session has stopped being able to help
// itself: it needs an answer, it is done, or it failed. WORKING is the ordinary case and produces
// nothing at all -- no row, no spawn, no cost.
//
// ANNOUNCED ONCE, BUT A SECOND QUESTION IS A SECOND EVENT.
//
// Deduplicating on the state alone would be wrong in a way that only shows up in the sessions that
// need this most. A session may ask, be answered, work, and ask again; three observations of
// WAITING_FOR_HERMES of which two are genuinely different questions. So the watch records WHICH
// question it announced, and a new question is a new wake while the same one waiting for an hour is
// not.
import crypto from "node:crypto";
import { recordEvent, transaction } from "../db.js";

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${crypto.randomUUID()}`;

const DEFAULT_INTERVAL_MS = 2_000;

// The opaque identity a delivery is later searched for in canonical Hermes history.
//
// Deliberately not the session id, the question, or anything else with meaning: it exists to be
// matched exactly, and anything a person or a model might reasonably paraphrase, translate or
// truncate would stop matching. Generated once, when the wake is enqueued, and never regenerated --
// a fresh marker on retry would make an already-durable delivery invisible and duplicate it.
export function wakeMarker(wakeId) {
  return `[delegate-wave-wake:${wakeId}]`;
}

// Modes for which SEMANTICALLY_ACCEPTED is the end of the road rather than a step before publishing.
//
// This is the driver's own rule, read the same way it reads it: a session that may not publish has
// finished when its candidate is accepted. Without this a MANUAL session -- whose entire purpose is
// to stop with a finished result for a person -- would be the one kind of session that never tells
// anyone it is ready.
const RESTS_AT_ACCEPTED = new Set(["MANUAL", "PLAN"]);

// What a session in this state is waiting to have said about it, or null for the ordinary case.
export function wakeReason(session) {
  if (session.state === "WAITING_FOR_HERMES") return "QUESTION";
  if (session.state === "COMPLETED") return "COMPLETED";
  if (session.state === "FAILED") return "FAILED";
  if (session.state === "SEMANTICALLY_ACCEPTED" && RESTS_AT_ACCEPTED.has(session.mode)) return "READY";
  return null;
}

// The words that arrive in the conversation the request came from.
//
// Written for a reader who has not been polling and does not hold the session id in their head: it
// says what was asked for, what happened, and -- when something is needed -- exactly what is
// needed. The marker rides along at the end because it must be durable in the transcript for
// reconciliation to work at all; it is machine identity, so it goes where it does not interrupt the
// sentence.
export function wakeBody({ reason, intent, sessionId, question, whyItMatters, outcome, marker }) {
  const task = `"${String(intent).replace(/[\s]+/g, " ").trim().slice(0, 200)}"`;
  const lines = [];
  if (reason === "QUESTION") {
    lines.push(`The delegate-wave session working on ${task} needs an answer before it can continue.`);
    lines.push("");
    lines.push(question || "The manager stopped and needs a decision.");
    if (whyItMatters) lines.push("", `Why it matters: ${whyItMatters}`);
    lines.push("", `Answer it with session_answer on session ${sessionId}.`);
  } else if (reason === "COMPLETED") {
    lines.push(`The delegate-wave session working on ${task} finished and its result is on the branch.`);
    lines.push("", `Use session_poll on ${sessionId} for what changed.`);
  } else if (reason === "READY") {
    lines.push(`The delegate-wave session working on ${task} has a finished, validated candidate `
      + "waiting for a person -- it was started in a mode that does not publish on its own.");
    lines.push("", `Use session_poll on ${sessionId} for the candidate and its validation.`);
  } else {
    lines.push(`The delegate-wave session working on ${task} failed.`);
    if (outcome) lines.push("", outcome);
    lines.push("", `Use session_poll on ${sessionId} for the detail.`);
  }
  lines.push("", marker);
  return lines.join("\n");
}

// Registers a conversation's interest in a session.
//
// Idempotent by (session, conversation): asking twice is the same interest, not two. Returns the
// existing watch rather than refusing, because a caller that asks twice is almost always a retry and
// failing it would lose the wake entirely -- which is the one outcome this whole layer exists to
// prevent.
//
// A free function rather than a method so a session can be born already watched, inside the same
// transaction that creates it. A watch registered a moment later is a window in which a fast session
// finishes unobserved.
export function registerWatch(db, sessionId, hermesSessionId) {
  if (typeof hermesSessionId !== "string" || !hermesSessionId.trim()) {
    throw new Error("a watch requires a Hermes session id");
  }
  const key = hermesSessionId.trim();
  const existing = db.prepare(
    "SELECT * FROM session_watches WHERE session_id = ? AND hermes_session_id = ?",
  ).get(sessionId, key);
  if (existing) return existing;
  const watchId = id("wtch");
  db.prepare(`INSERT INTO session_watches(
    id, session_id, hermes_session_id, state, created_at, updated_at
  ) VALUES (?, ?, ?, 'ACTIVE', ?, ?)`).run(watchId, sessionId, key, now(), now());
  return db.prepare("SELECT * FROM session_watches WHERE id = ?").get(watchId);
}

export class SessionWatcher {
  constructor({ sessions, intervalMs = DEFAULT_INTERVAL_MS, onError = null, onEvent = null }) {
    if (!sessions) throw new Error("SessionWatcher requires a session service");
    this.sessions = sessions;
    this.db = sessions.db;
    this.intervalMs = intervalMs;
    this.onError = onError;
    this.onEvent = onEvent;
    this.passes = 0;
    this.timer = null;
    this.stopped = false;
  }

  watch(sessionId, hermesSessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    return registerWatch(this.db, sessionId, hermesSessionId);
  }

  // Re-arms a watch that a PARTIAL delivery stopped. A PERSON does this, never a timer.
  //
  // BOUND TO THE AMBIGUITY THEY ACTUALLY LOOKED AT.
  //
  // Naming the wake is not ceremony. The blocked state means a specific delivery left a specific
  // conversation in an unknown condition, and clearing it is a claim that SOMEBODY READ THAT
  // TRANSCRIPT and knows what happened. A bare unblock(watchId) accepts that claim from someone who
  // may be clearing a different ambiguity than the one they inspected -- or one that appeared while
  // they were reading. So the caller names the wake, and this refuses if that is not still the row
  // holding the watch shut: a compare-and-swap on a human decision, for the same reason every other
  // mutation in this system compare-and-swaps on the world it was decided against.
  unblock(watchId, partialWakeId) {
    const watch = this.db.prepare("SELECT * FROM session_watches WHERE id = ?").get(watchId);
    if (!watch) throw new Error(`Unknown watch: ${watchId}`);
    if (watch.state !== "BLOCKED") return watch;
    if (typeof partialWakeId !== "string" || !partialWakeId.trim()) {
      throw new Error("unblocking a watch requires naming the PARTIAL wake being cleared");
    }
    // The row that is actually holding it shut, decided here rather than trusted from the caller.
    const blocker = this.db.prepare(
      `SELECT * FROM wake_outbox WHERE watch_id = ? AND state = 'PARTIAL'
       ORDER BY updated_at DESC LIMIT 1`,
    ).get(watchId);
    if (!blocker) throw new Error(`Watch ${watchId} is blocked but no PARTIAL wake explains it`);
    if (blocker.id !== partialWakeId) {
      throw new Error(
        `Watch ${watchId} is held by ${blocker.id}, not ${partialWakeId}. `
        + "Inspect the conversation for that wake before clearing it.",
      );
    }
    transaction(this.db, () => {
      // Cleared along with the state: the point of re-arming is that the last announcement is no
      // longer trusted to have arrived, so the next pass must be free to say it again.
      this.db.prepare(
        `UPDATE session_watches SET state = 'ACTIVE', notified_state = NULL, notified_message_id = NULL,
                                    updated_at = ? WHERE id = ?`,
      ).run(now(), watchId);
      // The wake itself is left PARTIAL for good. It is evidence of what happened, not a task, and
      // rewriting it would erase the only record that this conversation was once ambiguous.
      recordEvent(this.db, {
        kind: "SESSION_WATCH_UNBLOCKED", entityType: "job", entityId: watch.session_id,
        payload: { watchId, hermesSessionId: watch.hermes_session_id, acknowledgedWake: partialWakeId },
      });
    });
    return this.db.prepare("SELECT * FROM session_watches WHERE id = ?").get(watchId);
  }

  // Every watch whose session has stopped being able to help itself.
  //
  // BLOCKED watches are excluded by the query rather than skipped afterwards, because a blocked
  // watch is not a thing to reconsider on every pass -- a delivery reached PARTIAL and what already
  // happened in that conversation is unknown. More wakes into it would compound the ambiguity.
  due() {
    return this.db.prepare(
      `SELECT w.id AS watch_id, w.session_id, w.hermes_session_id,
              w.notified_state, w.notified_message_id,
              s.state, s.mode, s.outcome, s.intent
       FROM session_watches w
       JOIN autonomous_sessions s ON s.id = w.session_id
       WHERE w.state = 'ACTIVE'
         AND s.state IN ('WAITING_FOR_HERMES', 'SEMANTICALLY_ACCEPTED', 'COMPLETED', 'FAILED')
       ORDER BY s.updated_at`,
    ).all();
  }

  openQuestion(sessionId) {
    return this.db.prepare(
      `SELECT * FROM autonomous_session_messages
       WHERE session_id = ? AND direction = 'TO_HERMES' AND answered_by IS NULL
       ORDER BY ordinal DESC LIMIT 1`,
    ).get(sessionId) ?? null;
  }

  // Records that this exact event has been announced.
  //
  // A terminal session will not change again, so the watch has nothing left to notice. The outbox
  // row is independent and durable: closing the watch does not abandon the delivery.
  #markNotified(row, messageId) {
    const watchState = ["COMPLETED", "FAILED"].includes(row.state) ? "CLOSED" : "ACTIVE";
    this.db.prepare(
      `UPDATE session_watches SET notified_state = ?, notified_message_id = ?, state = ?,
                                  updated_at = ? WHERE id = ?`,
    ).run(row.state, messageId, watchState, now(), row.watch_id);
  }

  // One pass. Returns the wakes enqueued by it, which is empty on almost every pass and is meant to
  // be.
  pass() {
    this.passes += 1;
    const enqueued = [];
    for (const row of this.due()) {
      const reason = wakeReason(row);
      // SEMANTICALLY_ACCEPTED under a publishing mode is mid-flight, not an event.
      if (!reason) continue;
      const question = reason === "QUESTION" ? this.openQuestion(row.session_id) : null;
      // WAITING_FOR_HERMES with nothing unanswered is a state in the middle of changing. Saying
      // nothing and looking again in two seconds is correct; announcing a question that is not there
      // is not.
      if (reason === "QUESTION" && !question) continue;
      const messageId = question?.id ?? null;
      if (row.notified_state === row.state && (row.notified_message_id ?? null) === messageId) continue;

      // A WAKE FOR THIS EVENT MAY ALREADY BE QUEUED, EVEN THOUGH THE WATCH SAYS OTHERWISE.
      //
      // unblock() deliberately clears notified_state so a person who inspected an ambiguity can
      // authorise another attempt at it. But the watch is one row and the outbox is many, and a
      // session that asked a question and then finished has TWO wakes: the question, which went
      // PARTIAL, and the completion, still sitting PENDING behind it. Clearing the notification marks
      // makes the still-queued completion look unannounced, and the next pass writes a second copy of
      // it -- so the person gets told twice about one thing.
      //
      // An open wake for the same logical event is therefore adopted rather than duplicated. Open
      // means PENDING, PREPARING or SUBMITTED: still on its way. DELIVERED and PARTIAL are
      // deliberately NOT open -- once a person has cleared a PARTIAL and no queued copy survives,
      // re-announcing that event is exactly what they asked for.
      const alreadyQueued = this.db.prepare(
        `SELECT id FROM wake_outbox
         WHERE watch_id = ? AND reason = ? AND message_id IS ?
           AND state IN ('PENDING', 'PREPARING', 'SUBMITTED', 'ENQUEUED')
         ORDER BY created_at LIMIT 1`,
      ).get(row.watch_id, reason, messageId);
      if (alreadyQueued) {
        // Recorded as announced, because it is: the row exists and will be delivered. Without this
        // the same duplicate would be reconsidered on every pass forever.
        this.#markNotified(row, messageId);
        continue;
      }

      const wakeId = id("wake");
      const marker = wakeMarker(wakeId);
      const body = wakeBody({
        reason,
        intent: row.intent,
        sessionId: row.session_id,
        question: question?.body ?? null,
        whyItMatters: question?.why_it_matters ?? null,
        outcome: row.outcome,
        marker,
      });
      transaction(this.db, () => {
        this.db.prepare(`INSERT INTO wake_outbox(
          id, watch_id, session_id, hermes_session_id, reason, message_id, marker, body,
          state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`).run(
          wakeId, row.watch_id, row.session_id, row.hermes_session_id, reason, messageId,
          marker, body, now(), now(),
        );
        this.#markNotified(row, messageId);
        recordEvent(this.db, {
          kind: "WAKE_ENQUEUED", entityType: "job", entityId: row.session_id,
          payload: { wakeId, reason, hermesSessionId: row.hermes_session_id },
        });
      });
      enqueued.push(wakeId);
    }
    if (enqueued.length && this.onEvent) {
      this.onEvent("SESSION_WATCHER_PASS", { pass: this.passes, enqueued: enqueued.length });
    }
    return enqueued;
  }

  start() {
    if (this.timer) return this;
    this.stopped = false;
    this.timer = setInterval(() => {
      if (this.stopped) return;
      // A throw in a timer is both fatal and unattributable. Recorded and stepped past: the next
      // pass reads the same durable state and reaches the same conclusion.
      try { this.pass(); } catch (error) { if (this.onError) this.onError(error); }
    }, this.intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
    return this;
  }

  stop() {
    this.stopped = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    return this;
  }
}
