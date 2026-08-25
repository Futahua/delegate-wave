// Delivering a wake, and knowing honestly whether it was delivered.
//
// Everything hard about this file comes from one measured fact: the receiver has no idempotency and
// no receipt. `prompt.submit` returns `{"status": "streaming"}` before a single row is durable, and
// submitting the same wake twice produces two independent agent turns. So the acknowledgement is
// worth nothing as evidence, and this deliverer never treats it as evidence.
//
// CANONICAL HISTORY IS THE DELIVERY AUTHORITY.
//
// Every state transition here is decided by reading the durable Hermes transcript and looking for
// the wake's opaque marker. The measured crash boundaries are exactly three, and they are exactly
// the three branches below:
//
//   marker absent                 nothing durable happened      retry permitted
//   marker + an assistant reply   the wake landed and was read   suppress retry
//   marker + no assistant reply   PARTIAL                        automatic retry FORBIDDEN
//
// PARTIAL IS NOT A HARMLESS FAILURE.
//
// A durable user row with no assistant turn after it does not mean nothing happened. Tools may have
// run. A `session_answer` may already have come back into delegate-wave and moved the session on.
// Resubmitting on that evidence would be asserting a fact -- "nothing happened" -- that the
// evidence does not support, which is the one thing this system is not allowed to do. So PARTIAL
// stops the watch and says so, and a person decides.
//
// THE SUBMIT IS GATED, DELIBERATELY.
//
// Hermes has no cross-process per-session exclusivity today (research section 7): two gateways can
// resume the same durable session from independent snapshots and both append turns. Until the
// narrow upstream fix lands -- a per-session lease enforced AT `prompt.submit`, independent of
// `max_concurrent_sessions` -- the last step is withheld rather than attempted. Everything before
// it runs, is exercised, and is durable; `allowSubmit` is the single line that changes when the
// receiver can refuse safely.
//
// AND NOT ON A PREFLIGHT.
//
// There is deliberately no `ownership_state` computed before submitting. A preflight "is it idle?"
// observation is stale the instant it is taken -- the user can start a turn in the interval -- and
// check-then-submit would reintroduce the exact race it appears to close. The future typed BUSY at
// `prompt.submit` is the atomic gate; here, BUSY is an ordinary outcome that leaves the wake
// PENDING, not an error.
import { recordEvent, transaction } from "../db.js";
import { HermesGateway } from "./hermes-gateway.js";

const now = () => new Date().toISOString();

// How long a submitted wake is left alone before its silence is treated as evidence.
//
// A turn still running is not evidence of a lost one. Reconciling a SUBMITTED row the moment it
// appears would read a transcript mid-write, find the marker with nothing after it yet, and declare
// PARTIAL on a delivery that was going perfectly.
const DEFAULT_PARTIAL_GRACE_MS = 10 * 60_000;

// How long one delivery waits for the woken turn to finish before leaving it to reconciliation.
const DEFAULT_TURN_TIMEOUT_MS = 5 * 60_000;

// What the durable transcript says about one marker.
//
// Text-matched rather than id-matched because Hermes stores a conversation, not an event log: the
// marker IS the identity, and it is opaque precisely so that this comparison can be exact.
export function classifyHistory(messages, marker) {
  const rows = Array.isArray(messages) ? messages : [];
  let at = -1;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const text = rows[index]?.text;
    if (typeof text === "string" && text.includes(marker)) { at = index; break; }
  }
  if (at < 0) return "ABSENT";
  for (let index = at + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.role !== "assistant") continue;
    // An assistant turn that carries only reasoning still answered the wake: it was received and
    // acted on. Emptiness, not visibility, is what distinguishes PARTIAL.
    const spoke = (typeof row.text === "string" && row.text.trim())
      || row.reasoning || row.reasoning_content || row.reasoning_details || row.codex_reasoning_items;
    if (spoke) return "DELIVERED";
  }
  return "PARTIAL";
}

export class WakeDeliverer {
  constructor({
    db,
    // Injected so the deliverer can be driven against a stub that speaks the same framing. Defaults
    // to a real spawn, which is why nothing constructs one until there is a wake to deliver.
    gateway = () => new HermesGateway(),
    // The one line that changes when Hermes can refuse a second writer. Off by default, on purpose:
    // see the header.
    allowSubmit = false,
    partialGraceMs = DEFAULT_PARTIAL_GRACE_MS,
    turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS,
    onEvent = null,
    onError = null,
  } = {}) {
    if (!db) throw new Error("WakeDeliverer requires a database");
    this.db = db;
    this.gatewayFactory = gateway;
    this.allowSubmit = allowSubmit;
    this.partialGraceMs = partialGraceMs;
    this.turnTimeoutMs = turnTimeoutMs;
    this.onEvent = onEvent;
    this.onError = onError;
  }

  get(wakeId) {
    return this.db.prepare("SELECT * FROM wake_outbox WHERE id = ?").get(wakeId) ?? null;
  }

  #event(kind, wake, payload = {}) {
    recordEvent(this.db, {
      kind, entityType: "job", entityId: wake.session_id,
      payload: { wakeId: wake.id, hermesSessionId: wake.hermes_session_id, ...payload },
    });
    if (this.onEvent) this.onEvent(kind, { wakeId: wake.id, ...payload });
  }

  // Takes the oldest deliverable wake, or nothing.
  //
  // The claim is the same INSERT-shaped bet the rest of this system makes: the partial unique index
  // over (hermes_session_id) WHERE state IN ('PREPARING','SUBMITTED') is what actually enforces one
  // delivery per conversation, so two racing processes do not both take the same conversation --
  // one of them simply fails to claim and moves on.
  claim() {
    try {
      return transaction(this.db, () => {
        const row = this.db.prepare(
          `SELECT * FROM wake_outbox WHERE state = 'PENDING'
             AND hermes_session_id NOT IN (
               SELECT hermes_session_id FROM wake_outbox WHERE state IN ('PREPARING', 'SUBMITTED')
             )
           ORDER BY created_at LIMIT 1`,
        ).get();
        if (!row) return null;
        this.db.prepare(
          "UPDATE wake_outbox SET state = 'PREPARING', attempts = attempts + 1, updated_at = ? WHERE id = ?",
        ).run(now(), row.id);
        return this.get(row.id);
      });
    } catch (error) {
      // Losing the race is not an error. The SELECT above avoids conversations that are already
      // being delivered to, but between it and the UPDATE another runtime may have claimed the same
      // one -- duplicate supervised runtimes are a condition this system has actually seen. The
      // index refuses, this process claims nothing, and the wake is still there next pass.
      if (/UNIQUE|constraint/i.test(String(error.message))) return null;
      throw error;
    }
  }

  // Back to the queue, with why. Not a failure state: BUSY, an unreachable gateway and a withheld
  // submission are all ordinary conditions on this path, and all of them mean the same thing --
  // nothing was delivered, and the same wake is still the right thing to say.
  release(wake, reason) {
    this.db.prepare(
      `UPDATE wake_outbox SET state = 'PENDING', last_error = ?, submitted_at = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(reason, now(), wake.id);
  }

  #settle(wake, verdict, { runtimeSessionId = null } = {}) {
    transaction(this.db, () => {
      this.db.prepare(
        `UPDATE wake_outbox SET state = ?, reconciled_at = ?,
                                runtime_session_id = COALESCE(?, runtime_session_id), updated_at = ?
         WHERE id = ?`,
      ).run(verdict, now(), runtimeSessionId, now(), wake.id);
      if (verdict === "PARTIAL") {
        // The conversation's state is now unknown to us, so this watch stops -- whatever it said
        // before. BLOCKED rather than CLOSED even for a watch already closed by a terminal session,
        // because the two mean different things to whoever looks next: CLOSED is "there is nothing
        // more to say", BLOCKED is "something was said and nobody can tell what came of it".
        this.db.prepare("UPDATE session_watches SET state = 'BLOCKED', updated_at = ? WHERE id = ?")
          .run(now(), wake.watch_id);
      }
    });
    this.#event(verdict === "DELIVERED" ? "WAKE_DELIVERED" : "WAKE_PARTIAL", wake, { runtimeSessionId });
  }

  // Reads canonical history for one wake and records what it proves.
  //
  // Used both after submitting and on recovery, because they are the same question: this is what the
  // process that crashed would have asked had it lived. Returns the verdict.
  async #reconcileThrough(gateway, wake) {
    const runtime = await gateway.resume(wake.hermes_session_id);
    const messages = await gateway.history(runtime.runtimeSessionId);
    const verdict = classifyHistory(messages, wake.marker);
    return { verdict, runtimeSessionId: runtime.runtimeSessionId, messages };
  }

  // One wake, start to finish.
  async deliver(wake) {
    const gateway = this.gatewayFactory();
    try {
      await gateway.start();
      const { verdict, runtimeSessionId } = await this.#reconcileThrough(gateway, wake);
      // Already durable. Whatever this process believed about its own last attempt, the transcript
      // is the authority and it says this was said.
      if (verdict !== "ABSENT") {
        this.#settle(wake, verdict, { runtimeSessionId });
        return verdict;
      }

      if (!this.allowSubmit) {
        // Withheld, not failed. Recorded loudly enough that a queue standing still is legible as a
        // decision rather than as a broken watcher.
        this.release(wake, "submission withheld: Hermes has no per-session exclusivity yet");
        this.#event("WAKE_SUBMISSION_WITHHELD", wake, { reason: wake.reason });
        return "WITHHELD";
      }

      // Recorded as SUBMITTED BEFORE the write reaches the pipe, so the row never understates what
      // this process may have done. Overstating is recoverable -- reconciliation reads history and
      // finds the marker absent -- while understating means a durable delivery this system does not
      // know it made.
      this.db.prepare(
        `UPDATE wake_outbox SET state = 'SUBMITTED', runtime_session_id = ?, submitted_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(runtimeSessionId, now(), now(), wake.id);

      try {
        await gateway.submit(runtimeSessionId, wake.body);
      } catch (error) {
        if (error.busy) {
          // The atomic gate refused, which is the mechanism working. A typed BUSY means no turn
          // started and no durable rows, so this wake is untouched and still the right thing to say.
          this.release(wake, `busy: ${error.message}`);
          this.#event("WAKE_REFUSED_BUSY", wake, {});
          return "BUSY";
        }
        // Anything else leaves the row SUBMITTED on purpose: a dropped pipe says nothing about
        // whether the write landed, and reconciliation -- not a guess -- decides that later.
        this.db.prepare("UPDATE wake_outbox SET last_error = ?, updated_at = ? WHERE id = ?")
          .run(String(error.message).slice(0, 500), now(), wake.id);
        throw error;
      }

      // Bounded. A timeout is not a failure: it means history has not settled, and the row stays
      // SUBMITTED for a later pass to judge on evidence rather than on impatience.
      try {
        await gateway.waitForTurn({ timeoutMs: this.turnTimeoutMs });
      } catch {
        return "SUBMITTED";
      }
      const after = classifyHistory(await gateway.history(runtimeSessionId), wake.marker);
      if (after === "ABSENT") {
        // The turn completed and the marker is not there. Nothing durable happened, so the wake
        // returns to the queue -- the one branch where retrying is authorised by evidence.
        this.release(wake, "turn completed without a durable marker");
        return "PENDING";
      }
      this.#settle(wake, after, { runtimeSessionId });
      return after;
    } finally {
      await gateway.close();
    }
  }

  // Wakes whose fate this process cannot know from its own memory.
  //
  // Both PREPARING and SUBMITTED qualify: a process that died between claiming and writing left a
  // PREPARING row that may or may not have reached the pipe, and "which state was I in" is exactly
  // the thing that did not survive. Only the grace window keeps a live turn from being mistaken for
  // a lost one.
  stale({ atMs = Date.now() } = {}) {
    const cutoff = new Date(atMs - this.partialGraceMs).toISOString();
    return this.db.prepare(
      `SELECT * FROM wake_outbox WHERE state IN ('PREPARING', 'SUBMITTED') AND updated_at < ?
       ORDER BY updated_at`,
    ).all(cutoff);
  }

  async reconcile(wake) {
    const gateway = this.gatewayFactory();
    try {
      await gateway.start();
      const { verdict, runtimeSessionId } = await this.#reconcileThrough(gateway, wake);
      if (verdict === "ABSENT") {
        this.release(wake, "reconciled: no durable marker, retry permitted");
        return "PENDING";
      }
      this.#settle(wake, verdict, { runtimeSessionId });
      return verdict;
    } finally {
      await gateway.close();
    }
  }

  // One pass: settle what is unknown, then deliver one thing.
  //
  // Reconciliation first, always. A stale row holds the single-flight slot for its conversation, so
  // resolving it is what unblocks delivery rather than competing with it.
  async pass({ atMs = Date.now() } = {}) {
    const outcomes = [];
    for (const wake of this.stale({ atMs })) {
      try {
        outcomes.push({ wakeId: wake.id, outcome: await this.reconcile(wake) });
      } catch (error) {
        if (this.onError) this.onError(error, wake.id);
      }
    }
    const claimed = this.claim();
    if (!claimed) return outcomes;
    try {
      outcomes.push({ wakeId: claimed.id, outcome: await this.deliver(claimed) });
    } catch (error) {
      if (this.onError) this.onError(error, claimed.id);
      // Only a row this process left PREPARING is safe to hand back on an exception. A SUBMITTED row
      // may have reached the wire, and returning it to the queue would authorise a retry that no
      // evidence supports.
      const current = this.get(claimed.id);
      if (current?.state === "PREPARING") this.release(claimed, String(error.message).slice(0, 500));
    }
    return outcomes;
  }
}
