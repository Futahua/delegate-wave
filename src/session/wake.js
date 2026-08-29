// Delivering a wake without becoming another writer in the Hermes conversation.
//
// New wakes use Hermes' durable external-turn inbox. enqueue is idempotent on wake.id, but its
// boolean result is not a receipt: false only says that id already exists. Delegate Wave reads the
// remote row back and verifies every field before recording ENQUEUED locally. The legacy
// prompt.submit path remains below solely to reconcile installations that have not switched; routed
// delivery never falls back to it.
//
// HERMES OWNS EXECUTION; CANONICAL HISTORY OWNS AMBIGUOUS OUTCOMES.
//
// PENDING/CLAIMED and live STARTED events are left to Hermes. Only FINISHED, or STARTED with a
// receiver-proven dead owner, permits canonical-history reconciliation. Routed evidence is a typed
// user timeline row (`display_kind=delegate_wave_wake`) containing this wake's opaque marker:
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
// LEGACY DIRECT SUBMIT IS ISOLATED.
//
// Existing SUBMITTED rows retain their old reconciliation path. New routed code never creates that
// state and never calls prompt.submit, even if the external-turn adapter is absent or incompatible.
//
// TIME IS NOT EVIDENCE OF DEATH.
//
// A claimed wake may only be taken from its owner when that owner is PROVEN dead -- pid and process
// start time, the same identity principle Hermes already uses for its own leases. An age-based rule
// looks reasonable and creates the exact race this subsystem exists to prevent: a slow-but-healthy
// delivery gets its wake reclaimed, and then two processes submit the same marker.
//
import { recordEvent, transaction } from "../db.js";
import { HermesCanonicalHistory } from "./hermes-canonical-history.js";
import { HermesExternalTurns, replaceLoneSurrogates } from "./hermes-external-turns.js";
import { HermesGateway } from "./hermes-gateway.js";
import { ALIVE, DEAD, probeProcess, selfIdentity } from "./liveness.js";

const now = () => new Date().toISOString();

// How long a claimed wake is left alone before anyone even ASKS whether its owner is alive.
//
// A debounce, not an authority. It exists so a pass does not spawn a liveness probe against a row
// another process wrote a second ago; it never permits reclaiming anything. Waiting longer changes
// only when the question is asked, never what the answer is allowed to be.
const DEFAULT_INVESTIGATE_AFTER_MS = 60_000;

// The capability Hermes must positively report before a single wake may be submitted.
//
// Named here rather than passed in, because the whole point is that delegate-wave cannot be
// configured into believing a receiver is safe. Today no Hermes reports it, so submission stays off
// even with the environment flag set -- which is the correct behaviour, not a gap.
export const REQUIRED_CAPABILITY = "per_session_exclusive_submit";

// What the durable transcript says about one marker.
//
// Text-matched rather than id-matched because Hermes stores a conversation, not an event log: the
// marker IS the identity, and it is opaque precisely so that this comparison can be exact.
//
// THE NEXT USER TURN CLOSES THE ATTRIBUTION WINDOW.
//
// Scanning forward for any later assistant row was wrong, and wrong in the direction that loses a
// wake silently. A transcript like
//
//   user:      [wake marker]        <- the wake process died here
//   user:      something the person typed an hour later
//   assistant: an answer to THAT
//
// has an assistant row after the marker, and none of it has anything to do with the wake. Reading
// that as DELIVERED means nobody is ever told, and nothing ever retries, and the evidence says it
// went fine. So attribution stops at the next user turn: only an assistant row reached before
// another user speaks can be claimed as an answer to this marker.
//
// AMBIGUOUS IS ITS OWN ANSWER.
//
// A user turn arriving before any assistant row does not prove the wake was ignored. Hermes queues a
// prompt submitted mid-turn and may answer several user rows in one assistant turn -- that is
// visible in the real research transcript, where two markers were answered by a single reply. So
// "another user spoke first" is neither delivered nor undelivered; it is unknowable from here, and
// it is handled exactly like PARTIAL because the rule is the same: no automatic retry on evidence
// that does not authorise one.
export function classifyHistory(messages, marker) {
  const rows = Array.isArray(messages) ? messages : [];
  let at = -1;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    // Anchored on a USER row specifically. A wake is submitted as a user turn, so that is the only
    // row that can BE the delivery; an assistant that quotes the marker back -- an entirely
    // reasonable thing to do when acknowledging one -- would otherwise be selected as the anchor,
    // leaving nothing after it and turning a successful wake into a PARTIAL.
    if (row?.role !== "user") continue;
    if (typeof row.text === "string" && row.text.includes(marker)) { at = index; break; }
  }
  if (at < 0) return "ABSENT";
  for (let index = at + 1; index < rows.length; index += 1) {
    const row = rows[index];
    // Tool and system rows sit between a prompt and its answer in the ordinary case. They are part
    // of the turn, not a boundary on it.
    if (row?.role === "user") return "AMBIGUOUS";
    if (row?.role !== "assistant") continue;
    // An assistant turn that carries only reasoning still answered the wake: it was received and
    // acted on. Emptiness, not visibility, is what distinguishes an answer from a lost one.
    const spoke = (typeof row.text === "string" && row.text.trim())
      || row.reasoning || row.reasoning_content || row.reasoning_details || row.codex_reasoning_items;
    if (spoke) return "DELIVERED";
  }
  return "PARTIAL";
}

// Routed delivery evidence is a typed timeline event, never marker-shaped human prose. The next
// user row closes attribution exactly as it does for the legacy classifier.
export function classifyRoutedWake(messages, wake) {
  const rows = Array.isArray(messages) ? messages : [];
  let at = -1;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.role !== "user") continue;
    if (row?.display_kind !== "delegate_wave_wake") continue;
    if (typeof row.text === "string" && row.text.includes(wake.marker)) { at = index; break; }
  }
  if (at < 0) return "ABSENT";
  for (let index = at + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.role === "user") return "AMBIGUOUS";
    if (row?.role !== "assistant") continue;
    const spoke = (typeof row.text === "string" && row.text.trim())
      || row.reasoning || row.reasoning_content || row.reasoning_details || row.codex_reasoning_items;
    if (spoke) return "DELIVERED";
  }
  return "PARTIAL";
}

// The verdicts that mean "stop, and let a person look".
//
// Kept as a set rather than a comparison so that adding a fourth unknowable outcome cannot silently
// acquire retry permission by being spelled differently.
const HALTING = new Set(["PARTIAL", "AMBIGUOUS"]);

export class WakeDeliverer {
  constructor({
    db,
    // Injected so the deliverer can be driven against a stub that speaks the same framing. Defaults
    // to a real spawn, which is why nothing constructs one until there is a wake to deliver.
    gateway = () => new HermesGateway(),
    // The one line that changes when Hermes can refuse a second writer. Off by default, on purpose:
    // see the header.
    allowSubmit = false,
    allowEnqueue = false,
    externalTurns = () => new HermesExternalTurns(),
    canonicalHistory = () => new HermesCanonicalHistory(),
    investigateAfterMs = DEFAULT_INVESTIGATE_AFTER_MS,
    // A HARD CANCELLATION POLICY, off by default, and not a timeout in any softer sense.
    //
    // Closing the gateway kills the turn it hosts -- the research measured exactly that, and it is
    // how the PARTIAL boundary was produced in the first place. So a deadline here does not mean
    // "stop waiting", it means "interrupt a wake that is still being answered". Wake turns are rare
    // and short; keeping one child alive while it works is not the resident daemon this design
    // avoids, and is much cheaper than a wake destroyed at five minutes for being thorough.
    turnDeadlineMs = null,
    probe = probeProcess,
    identity = selfIdentity,
    onEvent = null,
    onError = null,
  } = {}) {
    if (!db) throw new Error("WakeDeliverer requires a database");
    this.db = db;
    this.gatewayFactory = gateway;
    this.allowSubmit = allowSubmit;
    this.allowEnqueue = allowEnqueue;
    this.externalTurns = externalTurns;
    this.canonicalHistory = canonicalHistory;
    this.investigateAfterMs = investigateAfterMs;
    this.turnDeadlineMs = turnDeadlineMs;
    this.probe = probe;
    this.identity = identity;
    this.onEvent = onEvent;
    this.onError = onError;
    // When each row was last asked about. Purely a cost control: probing a process means spawning
    // one, and a row whose owner is alive would otherwise be re-probed on every pass forever. In
    // memory rather than durable because losing it costs one extra probe, and a durable "last
    // checked" would be a timestamp that looks like it means something about ownership.
    this.lastProbed = new Map();
    // The rows this process is driving RIGHT NOW.
    //
    // In memory on purpose, and sound precisely because it is: it answers a question only this
    // process can answer about itself, and after a crash it is not needed at all -- the owner pid is
    // then dead and the cross-process rule takes over. It exists because a row owned by a LIVE
    // process that is no longer driving it would otherwise be unreachable by both rules: the
    // cross-process rule refuses to touch a live owner's work, and the owner had already moved on.
    this.driving = new Set();
    // A thrown adapter call is ambiguous only after enqueue was invoked: the Python process may
    // have committed before its stdout or exit status reached Node. The pass-level recovery rule
    // consults this set to preserve PREPARING in exactly that case.
    this.enqueueAttempted = new Set();
    // Established once. It is the same answer every time within a process, and it costs a spawn.
    this.self = null;
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
  // over (hermes_session_id) WHERE state IN ('PREPARING','SUBMITTED','ENQUEUED') is what enforces one
  // delivery per conversation, so two racing processes do not both take the same conversation --
  // one of them simply fails to claim and moves on.
  async #whoAmI() {
    if (!this.self) this.self = await this.identity();
    return this.self;
  }

  #isMine(wake) {
    return Boolean(this.self)
      && wake.owner_pid === this.self.pid
      && (wake.owner_started_at ?? null) === (this.self.startedAt ?? null);
  }

  async claim() {
    // Asked BEFORE the transaction: establishing our own identity means asking the operating system,
    // and holding a write lock across a subprocess spawn would stall every other writer.
    const self = await this.#whoAmI();
    try {
      return transaction(this.db, () => {
        const row = this.db.prepare(
          `SELECT * FROM wake_outbox WHERE state = 'PENDING'
             AND hermes_session_id NOT IN (
               SELECT hermes_session_id FROM wake_outbox
               WHERE state IN ('PREPARING', 'SUBMITTED', 'ENQUEUED')
             )
             -- A BLOCKED watch blocks what is ALREADY QUEUED, not merely what would be enqueued next.
             --
             -- The watcher stops CREATING wakes for a blocked watch, but a wake enqueued before the
             -- ambiguity is still sitting in the outbox, and delivering it walks straight into the
             -- conversation nobody can account for. A session that asked a question and then finished
             -- produces exactly that pair: the question goes PARTIAL and the completion is right
             -- behind it. CLOSED stays deliverable on purpose -- a terminal watch closes the instant
             -- it enqueues, so excluding it would strand every completion wake ever written.
             AND EXISTS (
               SELECT 1 FROM session_watches w
               WHERE w.id = wake_outbox.watch_id AND w.state != 'BLOCKED'
             )
           ORDER BY created_at LIMIT 1`,
        ).get();
        if (!row) return null;
        this.db.prepare(
          `UPDATE wake_outbox SET state = 'PREPARING', attempts = attempts + 1,
                                  owner_pid = ?, owner_started_at = ?,
                                  gateway_pid = NULL, gateway_started_at = NULL, updated_at = ?
           WHERE id = ?`,
        ).run(self.pid, self.startedAt, now(), row.id);
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
  release(wake, reason, expectedState = null) {
    this.db.prepare(
      `UPDATE wake_outbox SET state = 'PENDING', last_error = ?, submitted_at = NULL,
                              owner_pid = NULL, owner_started_at = NULL,
                              gateway_pid = NULL, gateway_started_at = NULL, updated_at = ?
       WHERE id = ? AND (? IS NULL OR state = ?)`,
    ).run(reason, now(), wake.id, expectedState, expectedState);
  }

  // Writes the verdict down. AMBIGUOUS is recorded as the PARTIAL STATE with its own explanation:
  // the handling is identical -- stop, and let a person look -- while the reason a person needs in
  // order to act is completely different. One means nothing answered; the other means somebody else
  // spoke first and attribution is no longer possible from this side.
  #settle(wake, verdict, { runtimeSessionId = null, detail = null, expectedState = null } = {}) {
    const state = verdict === "AMBIGUOUS" ? "PARTIAL" : verdict;
    const recordedDetail = detail ?? (verdict === "AMBIGUOUS"
      ? "ambiguous: another user turn arrived before any answer, so no reply can be attributed to this wake"
      : null);
    const changed = transaction(this.db, () => {
      const result = this.db.prepare(
        `UPDATE wake_outbox SET state = ?, reconciled_at = ?, last_error = COALESCE(?, last_error),
                                runtime_session_id = COALESCE(?, runtime_session_id), updated_at = ?
         WHERE id = ? AND (? IS NULL OR state = ?)`,
      ).run(state, now(), recordedDetail, runtimeSessionId, now(), wake.id, expectedState, expectedState);
      if (result.changes === 1 && HALTING.has(verdict)) {
        // The conversation's state is now unknown to us, so this watch stops -- whatever it said
        // before. BLOCKED rather than CLOSED even for a watch already closed by a terminal session,
        // because the two mean different things to whoever looks next: CLOSED is "there is nothing
        // more to say", BLOCKED is "something was said and nobody can tell what came of it".
        this.db.prepare("UPDATE session_watches SET state = 'BLOCKED', updated_at = ? WHERE id = ?")
          .run(now(), wake.watch_id);
      }
      return result.changes === 1;
    });
    if (!changed) return false;
    this.#event(verdict === "DELIVERED" ? "WAKE_DELIVERED" : "WAKE_PARTIAL", wake, {
      // The event carries the true verdict even where the column collapses two of them, so triage
      // reads what was actually observed rather than what the state machine needed to call it.
      verdict, runtimeSessionId,
    });
    return true;
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

  // Why submission may not proceed, or null when it may.
  //
  // Two independent refusals, reported separately so the operator sees which one is speaking.
  async #withholdReason(gateway) {
    if (!this.allowSubmit) return "submission is not enabled for this runtime";
    const capabilities = await gateway.capabilities();
    if (capabilities?.[REQUIRED_CAPABILITY] === true) return null;
    return `Hermes does not report ${REQUIRED_CAPABILITY}; two processes could still write to one session`;
  }

  async #recordGateway(wake, gateway) {
    const child = await gateway.identity();
    if (!child?.pid) return;
    this.db.prepare(
      "UPDATE wake_outbox SET gateway_pid = ?, gateway_started_at = ?, updated_at = ? WHERE id = ?",
    ).run(child.pid, child.startedAt ?? null, now(), wake.id);
  }

  #recordReceiver(wake, status) {
    this.db.prepare(
      `UPDATE wake_outbox SET last_receiver_state = ?, last_receiver_observed_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(status?.state ?? null, now(), now(), wake.id);
  }

  #remoteMatches(remote, wake) {
    return Boolean(remote)
      && remote.event_id === wake.id
      && remote.target_session_key === wake.hermes_session_id
      && remote.source === "delegate-wave"
      && remote.body === replaceLoneSurrogates(wake.body);
  }

  async #adopt(wake, runtimeSessionId = null) {
    const self = await this.#whoAmI();
    const changed = this.db.prepare(
      `UPDATE wake_outbox SET state = 'ENQUEUED', enqueued_at = COALESCE(enqueued_at, ?),
                              runtime_session_id = COALESCE(?, runtime_session_id),
                              owner_pid = ?, owner_started_at = ?,
                              gateway_pid = NULL, gateway_started_at = NULL, updated_at = ?
       WHERE id = ? AND state = 'PREPARING'`,
    ).run(now(), runtimeSessionId, self.pid, self.startedAt, now(), wake.id).changes;
    return changed === 1;
  }

  async #enqueue(wake, runtimeSessionId = null) {
    const receiver = this.externalTurns();
    this.enqueueAttempted.add(wake.id);
    await receiver.enqueue({
      eventId: wake.id,
      sessionKey: wake.hermes_session_id,
      body: wake.body,
      source: "delegate-wave",
    });
    const remote = await receiver.get(wake.id);
    this.#recordReceiver(wake, remote);
    if (!remote) {
      // Enqueue was invoked, so absence is not enough to assert that nothing committed. Keep the
      // ambiguity explicit; the same owner (or a proven successor) asks again on recovery.
      this.enqueueAttempted.delete(wake.id);
      this.#event("WAKE_ENQUEUE_UNCONFIRMED", wake, { detail: "remote event absent" });
      return "UNCONFIRMED";
    }
    if (!this.#remoteMatches(remote, wake)) {
      this.#settle(wake, "PARTIAL", {
        detail: "integrity failure: the receiver holds a different event under this wake id",
        expectedState: "PREPARING",
      });
      this.enqueueAttempted.delete(wake.id);
      this.#event("WAKE_REMOTE_INTEGRITY_FAILURE", wake, {});
      return "INTEGRITY_FAILURE";
    }
    const adopted = await this.#adopt(wake, runtimeSessionId);
    this.enqueueAttempted.delete(wake.id);
    if (!adopted) return "LOST_CLAIM";
    this.#event("WAKE_ENQUEUED_TO_RECEIVER", wake, { reason: wake.reason });
    return "ENQUEUED";
  }

  async #deliverByEnqueue(wake) {
    this.driving.add(wake.id);
    try {
      const receiver = this.externalTurns();
      const remote = await receiver.get(wake.id);
      this.#recordReceiver(wake, remote);
      if (remote) {
        if (!this.#remoteMatches(remote, wake)) {
          this.#settle(wake, "PARTIAL", {
            detail: "integrity failure: the receiver holds a different event under this wake id",
            expectedState: "PREPARING",
          });
          this.#event("WAKE_REMOTE_INTEGRITY_FAILURE", wake, {});
          return "INTEGRITY_FAILURE";
        }
        if (!await this.#adopt(wake)) return "LOST_CLAIM";
        this.#event("WAKE_REMOTE_ADOPTED", wake, { reason: wake.reason });
        return "ADOPTED";
      }

      return this.#enqueue(wake);
    } finally {
      this.driving.delete(wake.id);
    }
  }

  async #observe(wake) {
    const receiver = this.externalTurns();
    const status = await receiver.get(wake.id);
    this.#recordReceiver(wake, status);
    if (!status) {
      this.#settle(wake, "PARTIAL", {
        detail: "receiver has no record of an event recorded locally as ENQUEUED",
        expectedState: "ENQUEUED",
      });
      return "PARTIAL";
    }
    if (!this.#remoteMatches(status, wake)) {
      this.#settle(wake, "PARTIAL", {
        detail: "integrity failure: the receiver event no longer matches this wake",
        expectedState: "ENQUEUED",
      });
      return "PARTIAL";
    }

    const state = String(status.state ?? "");
    if (state === "PENDING" || state === "CLAIMED") return "WAITING";
    if (state === "STARTED" && status.owner_alive === true) return "WAITING";
    if (state === "STARTED" && status.owner_alive !== false) {
      this.#settle(wake, "PARTIAL", {
        detail: "receiver STARTED state did not report a definite owner-liveness verdict",
        expectedState: "ENQUEUED",
      });
      return "PARTIAL";
    }
    if (state !== "STARTED" && state !== "FINISHED") {
      this.#settle(wake, "PARTIAL", {
        detail: `unknown receiver state: ${state || "missing"}`,
        expectedState: "ENQUEUED",
      });
      return "PARTIAL";
    }

    const canonical = await this.canonicalHistory().read(wake.hermes_session_id);
    const verdict = classifyRoutedWake(canonical.messages, wake);
    const runtimeSessionId = canonical.resolvedSessionId;
    if (state === "STARTED") {
      if (verdict === "ABSENT") {
        const reopened = await receiver.reopen(wake.id, "owner died before the typed wake became durable");
        if (!reopened) {
          // The receiver owns this CAS. A refusal means its state changed after our read; that is
          // evidence to observe again, never permission to replay or classify from a stale row.
          this.#event("WAKE_REOPEN_REFUSED", wake, {});
          return "WAITING";
        }
        this.#event("WAKE_REOPENED", wake, {});
        return "REOPENED";
      }
      this.#settle(wake, verdict, { runtimeSessionId, expectedState: "ENQUEUED" });
      return verdict;
    }
    if (verdict === "ABSENT") {
      this.#settle(wake, "PARTIAL", {
        runtimeSessionId,
        detail: "receiver reports FINISHED but canonical history has no typed wake marker",
        expectedState: "ENQUEUED",
      });
      return "PARTIAL";
    }
    this.#settle(wake, verdict, { runtimeSessionId, expectedState: "ENQUEUED" });
    return verdict;
  }

  // Acquire the producer-side observer lease for an already-routed wake. Hermes serializes its own
  // consumers; this lease independently serializes the producers that may inspect history, reopen,
  // and (in Stage 4) maintain a dormant-session kick. It is intentionally durable across passes.
  // Only a matching live owner or a successor that proves that owner dead may act.
  async #claimEnqueued(wake) {
    const self = await this.#whoAmI();
    const current = this.get(wake.id);
    if (!current || current.state !== "ENQUEUED") return null;
    if (this.#isMine(current)) return current;

    if (current.owner_pid == null) {
      const changed = this.db.prepare(
        `UPDATE wake_outbox SET owner_pid = ?, owner_started_at = ?, updated_at = ?
         WHERE id = ? AND state = 'ENQUEUED' AND owner_pid IS NULL`,
      ).run(self.pid, self.startedAt, now(), current.id).changes;
      return changed === 1 ? this.get(current.id) : null;
    }

    // A pid without its process birth identity cannot be safely reclaimed. This can only be legacy
    // or corrupt evidence; time passing does not improve it.
    if (current.owner_started_at == null) return null;
    const verdict = await this.probe(current.owner_pid, current.owner_started_at);
    if (verdict !== DEAD) return null;
    const changed = this.db.prepare(
      `UPDATE wake_outbox SET owner_pid = ?, owner_started_at = ?, updated_at = ?
       WHERE id = ? AND state = 'ENQUEUED' AND owner_pid = ? AND owner_started_at IS ?`,
    ).run(
      self.pid, self.startedAt, now(), current.id, current.owner_pid, current.owner_started_at,
    ).changes;
    return changed === 1 ? this.get(current.id) : null;
  }

  // One wake, start to finish, using one protocol only. Routed delivery never falls back to direct
  // submit when its adapter is unavailable or incompatible.
  async deliver(wake) {
    if (this.allowEnqueue) return this.#deliverByEnqueue(wake);
    return this.#deliverBySubmit(wake);
  }

  async #deliverBySubmit(wake) {
    const gateway = this.gatewayFactory();
    this.driving.add(wake.id);
    try {
      await gateway.start();
      const { verdict, runtimeSessionId } = await this.#reconcileThrough(gateway, wake);
      // Already durable. Whatever this process believed about its own last attempt, the transcript
      // is the authority and it says this was said.
      if (verdict !== "ABSENT") {
        this.#settle(wake, verdict, { runtimeSessionId });
        return verdict;
      }

      // BOTH gates, and the receiver's answer is the one that cannot be configured away.
      //
      // An operator who sets the flag against a Hermes that does not enforce per-session exclusivity
      // has not authorised anything; they have made a mistake that would show up as a duplicated or
      // interleaved turn in somebody's real conversation. A receiver that does not answer the
      // question counts as one that answers no.
      const withheld = await this.#withholdReason(gateway);
      if (withheld) {
        // Withheld, not failed. Recorded loudly enough that a queue standing still is legible as a
        // decision rather than as a broken watcher.
        this.release(wake, `submission withheld: ${withheld}`);
        this.#event("WAKE_SUBMISSION_WITHHELD", wake, { reason: wake.reason, withheld });
        return "WITHHELD";
      }

      // The child's identity, recorded before anything is written through it. An owner can die and
      // leave this process mid-turn; without its pid and start time here, the next runtime has no
      // way to tell "still speaking" from "gone", and would have to choose between stalling forever
      // and reclaiming a live conversation.
      await this.#recordGateway(wake, gateway);

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

      // Waits for the turn to END, not for a clock to run out.
      //
      // The close() in the finally below kills the gateway, and killing the gateway kills the turn
      // it is hosting -- that is how the PARTIAL boundary was produced during the research. So a
      // timer here would not be a timeout, it would be delegate-wave destroying its own wake for
      // taking too long and then recording the wreckage as evidence. The wait ends when the turn
      // completes or when the child dies; either way the row is judged on what the transcript says.
      try {
        await gateway.waitForTurn({ timeoutMs: this.turnDeadlineMs });
      } catch {
        // The child died, or an explicit hard-cancellation deadline elapsed. Nothing may be
        // concluded from that here: the row stays SUBMITTED, and reconciliation reads the transcript
        // once the process is provably gone.
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
      // Dropped BEFORE the close, so a row this process has stopped driving is immediately visible
      // to its own next pass as work nothing is driving.
      this.driving.delete(wake.id);
      await gateway.close();
    }
  }

  // Rows nothing is driving any more, by either of the two ways that can be known.
  //
  // For ANOTHER process's row the only acceptable answer is a positive DEAD. Not "old". Not
  // "unresponsive". Not "we could not establish anything". A slow delivery and an abandoned one are
  // indistinguishable by age, and guessing wrong means two processes submit the same marker into one
  // conversation -- the precise failure this subsystem exists to make impossible.
  //
  // For OUR OWN row the question is not about liveness at all, and asking the operating system about
  // ourselves would answer the wrong question: this process is obviously alive, and that says
  // nothing about whether it is still driving that delivery.
  //
  // The gateway child is checked as well as the owning runtime, because they can die separately.
  // An owner that crashed leaving its child mid-turn has left something still writing to a real
  // conversation, and that row is not free.
  async reclaimable({ atMs = Date.now() } = {}) {
    const cutoff = new Date(atMs - this.investigateAfterMs).toISOString();
    const candidates = this.db.prepare(
      `SELECT * FROM wake_outbox WHERE state IN ('PREPARING', 'SUBMITTED') AND updated_at < ?
       ORDER BY updated_at`,
    ).all(cutoff);
    await this.#whoAmI();
    const dead = [];
    for (const wake of candidates) {
      // OUR OWN ABANDONED WORK NEEDS NO PROBE.
      //
      // A gateway can die while this runtime keeps running -- the ordinary failure, not an exotic
      // one. deliver() then leaves the row SUBMITTED and returns, and from that moment nothing is
      // driving it: the cross-process rule below refuses to touch a live owner's work, and the owner
      // has already moved on. The row would sit SUBMITTED until this process happened to die.
      //
      // So a row this process owns and is not currently driving is reconcilable immediately. That is
      // knowledge, not inference: no other process could tell us this, and no probe is needed to
      // establish it.
      if (this.#isMine(wake)) {
        if (!this.driving.has(wake.id)) dead.push(wake);
        continue;
      }
      const asked = this.lastProbed.get(wake.id);
      if (asked !== undefined && atMs - asked < this.investigateAfterMs) continue;
      this.lastProbed.set(wake.id, atMs);
      // A row with no recorded owner predates schema 34. Never reclaimed automatically: nothing can
      // be proven about a process that was never named, and the conservative outcome is the correct
      // one even though it means a person has to look.
      if (!wake.owner_pid) continue;
      const owner = await this.probe(wake.owner_pid, wake.owner_started_at);
      if (owner !== DEAD) continue;
      if (wake.gateway_pid) {
        const gateway = await this.probe(wake.gateway_pid, wake.gateway_started_at);
        // Owner dead, child alive: something is still speaking into that conversation. Leaving it
        // costs a stalled queue; taking it costs a duplicated wake.
        if (gateway !== DEAD) continue;
      }
      dead.push(wake);
      this.lastProbed.delete(wake.id);
    }
    // Rows that have left these states cannot be asked about again, so their entries are dropped
    // rather than accumulating for the life of the process.
    const live = new Set(candidates.map((wake) => wake.id));
    for (const known of [...this.lastProbed.keys()]) if (!live.has(known)) this.lastProbed.delete(known);
    return dead;
  }

  async reconcile(wake) {
    if (this.allowEnqueue && wake.state === "PREPARING") {
      // The remote event may have committed immediately before the local process died. Re-running
      // routed ingress asks Hermes first and adopts the same wake.id; it never submits a prompt.
      return this.#deliverByEnqueue(wake);
    }
    const gateway = this.gatewayFactory();
    try {
      await gateway.start();
      const { verdict, runtimeSessionId } = await this.#reconcileThrough(gateway, wake);
      if (verdict === "ABSENT") {
        this.release(wake, "reconciled: owner is gone and no durable marker exists, retry permitted");
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
  // Reconciliation first, always. An abandoned row holds the single-flight slot for its
  // conversation, so resolving it is what unblocks delivery rather than competing with it.
  async pass({ atMs = Date.now() } = {}) {
    const outcomes = [];
    // Receiver-owned events hold the single-flight slot. Acquire their producer observer lease and
    // inspect them before claiming anything else; PENDING/CLAIMED simply remain waiting until
    // Stage 4 supplies a listener. Another live Delegate Wave runtime owns the rows it leased.
    const enqueued = this.db.prepare(
      "SELECT * FROM wake_outbox WHERE state = 'ENQUEUED' ORDER BY updated_at",
    ).all();
    for (const wake of enqueued) {
      try {
        const owned = await this.#claimEnqueued(wake);
        if (owned) outcomes.push({ wakeId: wake.id, outcome: await this.#observe(owned) });
      } catch (error) {
        // Failure to ask the receiver is not evidence about what it did. Keep ENQUEUED and retry
        // observation later; never fall back to direct submit.
        if (this.onError) this.onError(error, wake.id);
      }
    }
    for (const wake of await this.reclaimable({ atMs })) {
      try {
        outcomes.push({ wakeId: wake.id, outcome: await this.reconcile(wake) });
      } catch (error) {
        if (this.onError) this.onError(error, wake.id);
      }
    }
    const claimed = await this.claim();
    if (!claimed) return outcomes;
    try {
      const outcome = await this.deliver(claimed);
      outcomes.push({ wakeId: claimed.id, outcome });
      // The child died mid-turn, or a deadline cut it off. The gateway that was hosting it is closed
      // by now, so a FRESH one reads canonical history and settles the row here rather than leaving
      // it SUBMITTED for a recovery path that -- correctly -- will not touch a live owner's work.
      if (outcome === "SUBMITTED") {
        outcomes.push({ wakeId: claimed.id, outcome: await this.reconcile(this.get(claimed.id)) });
      }
    } catch (error) {
      if (this.onError) this.onError(error, claimed.id);
      // Only a row this process left PREPARING is safe to hand back on an exception. A SUBMITTED row
      // may have reached the wire, and returning it to the queue would authorise a retry that no
      // evidence supports -- so it is RECONCILED instead, on this process's own knowledge that it is
      // no longer driving it.
      const current = this.get(claimed.id);
      if (current?.state === "PREPARING") {
        if (this.allowEnqueue && this.enqueueAttempted.delete(claimed.id)) {
          // The receiver may have committed. PREPARING is the durable statement that readback is
          // still owed; a later pass asks by the stable wake id and adopts rather than guessing.
          this.db.prepare("UPDATE wake_outbox SET last_error = ?, updated_at = ? WHERE id = ? AND state = 'PREPARING'")
            .run(`enqueue outcome uncertain: ${String(error.message).slice(0, 450)}`, now(), claimed.id);
        } else {
          this.release(claimed, String(error.message).slice(0, 500));
        }
      } else if (current?.state === "SUBMITTED") {
        try {
          outcomes.push({ wakeId: current.id, outcome: await this.reconcile(current) });
        } catch (failure) {
          // Still unresolved, and that is survivable: the row stays SUBMITTED and this process's own
          // next pass sees it as work it is not driving, without waiting for anything to die.
          if (this.onError) this.onError(failure, current.id);
        }
      }
    }
    return outcomes;
  }
}
