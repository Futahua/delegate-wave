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
// THE SUBMIT IS GATED, DELIBERATELY, AND BY TWO SEPARATE THINGS.
//
// Hermes has no cross-process per-session exclusivity today (research section 7): two gateways can
// resume the same durable session from independent snapshots and both append turns. Until the
// narrow upstream fix lands -- a per-session lease enforced AT `prompt.submit`, independent of
// `max_concurrent_sessions` -- the last step is withheld rather than attempted.
//
// An operator setting `allowSubmit` is NOT sufficient. The receiver must also positively report
// that it enforces per-session exclusivity, and a receiver that says nothing is treated as one that
// does not. Otherwise the flag is a foot-gun that survives a Hermes downgrade, an unexpected PATH,
// or a copied config, and does its damage in a real conversation.
//
// TIME IS NOT EVIDENCE OF DEATH.
//
// A claimed wake may only be taken from its owner when that owner is PROVEN dead -- pid and process
// start time, the same identity principle Hermes already uses for its own leases. An age-based rule
// looks reasonable and creates the exact race this subsystem exists to prevent: a slow-but-healthy
// delivery gets its wake reclaimed, and then two processes submit the same marker.
//
// AND NOT ON A PREFLIGHT.
//
// There is deliberately no `ownership_state` computed before submitting. A preflight "is it idle?"
// observation is stale the instant it is taken -- the user can start a turn in the interval -- and
// check-then-submit would reintroduce the exact race it appears to close. The future typed BUSY at
// `prompt.submit` is the atomic gate; here, BUSY is an ordinary outcome that leaves the wake
// PENDING, not an error.
//
// TWO DELIVERY PROTOCOLS LIVE IN THIS FILE, AND ONLY ONE OF THEM RUNS.
//
// SUBMITTED is legacy direct-submit evidence. It means delegate-wave itself handed prompt.submit to
// a Hermes gateway it spawned, so the gateway-liveness recovery below applies to THAT protocol only.
// It is retained for A/B forensics and is not reachable from the routed path.
//
// ENQUEUED is the current protocol. It means wake.id exists as a row in Hermes'
// session_external_turns inbox; the session's own live owner runs the turn, in its own process, on
// its own schedule. No gateway of ours hosts it, so nothing about our child processes says anything
// about whether that turn is progressing. The receiver is asked instead.
//
// THERE IS NO FALLBACK FROM ENQUEUED TO SUBMITTED. Not on a missing capability, not on an adapter
// failure, not on a timeout. Falling back to a transport that works reads as robustness and would
// silently reinstate the concurrency architecture the per-session lease exists to remove -- set off
// by nothing more than a Hermes downgrade or a wrong interpreter path. Unavailable means WAIT.
//
// AND THE RECEIVER'S IN-PROGRESS STATE IS NOT A PARTIAL DELIVERY.
//
// Under direct submit, a durable marker with no assistant reply could only mean the turn had
// stopped: this process had submitted it and this process's own life had ended. On the routed path
// the turn belongs to somebody else, and marker-without-reply is the ordinary shape of a turn still
// being reasoned about. Classifying it would turn every healthy long turn into a PARTIAL and block
// the watch over a conversation where nothing has gone wrong. So STARTED with a live owner never
// reaches classifyHistory at all.
import { recordEvent, transaction } from "../db.js";
import { HermesExternalTurns } from "./hermes-external-turns.js";
import { HermesGateway } from "./hermes-gateway.js";
import { ALIVE, DEAD, probeProcess, selfIdentity } from "./liveness.js";

const now = () => new Date().toISOString();

// How long a claimed wake is left alone before anyone even ASKS whether its owner is alive.
//
// A debounce, not an authority. It exists so a pass does not spawn a liveness probe against a row
// another process wrote a second ago; it never permits reclaiming anything. Waiting longer changes
// only when the question is asked, never what the answer is allowed to be.
const DEFAULT_INVESTIGATE_AFTER_MS = 60_000;

// How often a kick asks who owns its event. There is deliberately no deadline.
//
// TIME MUST NOT AUTHORISE DESTROYING A GATEWAY THAT IS STILL ELIGIBLE TO TAKE THE EVENT.
//
// An earlier version gave up after fifteen seconds and closed. Between its last observation of
// PENDING and that close there is no fence, so its own poller could claim and start the event in
// the gap -- and closing then kills a turn nobody ever observed starting, manufacturing exactly the
// dead-STARTED-with-no-marker boundary this whole design exists to avoid.
//
// So a kick ends only on a conclusive answer about ownership. While the event is still PENDING it
// keeps listening, which can leave a fenced listener parked while a person's own chat is busy.
// Wakes are rare; a parked process is much cheaper than a deliberately created crash boundary.
const KICK_POLL_MS = 500;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// The capability Hermes must positively report before a single wake may be submitted.
//
// Named here rather than passed in, because the whole point is that delegate-wave cannot be
// configured into believing a receiver is safe. Today no Hermes reports it, so submission stays off
// even with the environment flag set -- which is the correct behaviour, not a gap.
export const REQUIRED_CAPABILITY = "per_session_exclusive_submit";

// What the ROUTED path demands, and it is both of them.
//
// The lease proves only that concurrent writers to one session are fenced. A build can enforce that
// and have no inbox at all -- in which case every enqueued event sits forever with nothing able to
// consume it, and the queue stalls silently rather than failing. Two guarantees, two names, and a
// receiver that does not report one of them is a receiver this path will not use.
export const REQUIRED_CAPABILITIES = ["per_session_exclusive_submit", "session_external_turns_v1"];

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
    // The routed path. Its own switch, deliberately not a repurposing of allowSubmit: the two
    // protocols have different safety arguments, and a flag that used to mean "you may write
    // directly into a session" must not silently come to mean something else.
    allowEnqueue = false,
    externalTurns = () => new HermesExternalTurns(),
    // "Make sure SOME owner exists for this session" -- a separate concern from reading what the
    // receiver says, and injected so a failure in one is never mistaken for a failure in the other.
    // Null disables it entirely, which is what the reconciliation tests use.
    kick = undefined,
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
    this.kick = kick === undefined ? (wake) => this.resumeKick(wake) : kick;
    // Kicks in flight, by wake. A kick parks until ownership is settled, so without this every pass
    // over a still-PENDING event would spawn another listener for the same conversation -- an
    // unbounded number of gateways, each one fenced, none of them wrong individually.
    this.kicks = new Map();
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
  // over (hermes_session_id) WHERE state IN ('PREPARING','SUBMITTED') is what actually enforces one
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
               SELECT hermes_session_id FROM wake_outbox WHERE state IN ('PREPARING', 'SUBMITTED')
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
  // Every trace of BOTH protocols is cleared, not just the one this runtime happened to use.
  //
  // The schema forbids a PENDING row carrying enqueued_at, and forbids any row claiming both
  // transports at once. Clearing only some of the fields would be rejected outright -- or, if a
  // CHECK were ever relaxed, would leave a row that recovery reads under the wrong protocol's rules.
  // A release must never manufacture the other protocol's evidence either: nothing here writes
  // submitted_at.
  release(wake, reason) {
    this.db.prepare(
      `UPDATE wake_outbox SET state = 'PENDING', last_error = ?,
                              submitted_at = NULL, enqueued_at = NULL,
                              last_receiver_state = NULL, last_receiver_observed_at = NULL,
                              owner_pid = NULL, owner_started_at = NULL,
                              gateway_pid = NULL, gateway_started_at = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(reason, now(), wake.id);
  }

  // Writes the verdict down. AMBIGUOUS is recorded as the PARTIAL STATE with its own explanation:
  // the handling is identical -- stop, and let a person look -- while the reason a person needs in
  // order to act is completely different. One means nothing answered; the other means somebody else
  // spoke first and attribution is no longer possible from this side.
  #settle(wake, verdict, { runtimeSessionId = null, detail: explicit = null } = {}) {
    const state = verdict === "AMBIGUOUS" ? "PARTIAL" : verdict;
    // An explicit reason wins. The routed path halts for causes the direct one cannot produce -- a
    // turn the receiver says finished normally without leaving a marker, a forced teardown whose
    // transcript may simply be missing its tail -- and "no assistant reply" would describe none of
    // them to the person who has to look.
    const detail = explicit ?? (verdict === "AMBIGUOUS"
      ? "ambiguous: another user turn arrived before any answer, so no reply can be attributed to this wake"
      : null);
    transaction(this.db, () => {
      this.db.prepare(
        `UPDATE wake_outbox SET state = ?, reconciled_at = ?, last_error = COALESCE(?, last_error),
                                runtime_session_id = COALESCE(?, runtime_session_id), updated_at = ?
         WHERE id = ?`,
      ).run(state, now(), detail, runtimeSessionId, now(), wake.id);
      if (HALTING.has(verdict)) {
        // The conversation's state is now unknown to us, so this watch stops -- whatever it said
        // before. BLOCKED rather than CLOSED even for a watch already closed by a terminal session,
        // because the two mean different things to whoever looks next: CLOSED is "there is nothing
        // more to say", BLOCKED is "something was said and nobody can tell what came of it".
        this.db.prepare("UPDATE session_watches SET state = 'BLOCKED', updated_at = ? WHERE id = ?")
          .run(now(), wake.watch_id);
      }
    });
    this.#event(verdict === "DELIVERED" ? "WAKE_DELIVERED" : "WAKE_PARTIAL", wake, {
      // The event carries the true verdict even where the column collapses two of them, so triage
      // reads what was actually observed rather than what the state machine needed to call it.
      verdict, runtimeSessionId,
    });
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
    if (this.allowEnqueue) {
      const capabilities = await gateway.capabilities();
      const missing = REQUIRED_CAPABILITIES.filter((name) => capabilities?.[name] !== true);
      if (!missing.length) return null;
      // Withheld, never downgraded. The wake stays queued and this runtime asks again later.
      return `Hermes does not report ${missing.join(" and ")}; the event would be queued with nothing able to consume it`;
    }
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

  // Starts a kick without waiting for it, and never starts a second one for the same event.
  //
  // Not awaited, because a kick now parks until ownership is conclusive: awaiting it would stall
  // every other delivery behind one conversation whose owner happens to be busy.
  #startKick(wake) {
    if (!this.kick || this.kicks.has(wake.id)) return;
    const running = Promise.resolve()
      .then(() => this.kick(wake))
      .catch((error) => { if (this.onError) this.onError(error, wake.id); })
      .finally(() => { this.kicks.delete(wake.id); });
    this.kicks.set(wake.id, running);
  }

  // Waits for every kick this deliverer started.
  //
  // NOT a shutdown barrier. A correct kick parks indefinitely while its event is still PENDING, so
  // awaiting this on the way out would hang a process that is behaving exactly as designed. It is
  // for tests, whose receiver eventually goes terminal. Wiring it into shutdown needs cancellation
  // first, which this does not have.
  async settleKicks() {
    await Promise.all([...this.kicks.values()]);
  }

  // MAKES SURE SOMEBODY IS LISTENING. IT NEVER DELIVERS ANYTHING.
  //
  // An event addressed to a session nobody has open would sit in the inbox forever: the poller that
  // drains it belongs to a live session, and if there is no live session there is no poller. So a
  // resumed gateway is started, purely to bring one into existence.
  //
  // WHAT IT MUST NOT DO, and why each would undo the architecture:
  //
  //   prompt.submit  would be this process writing into the conversation again -- the exact second
  //                  writer the lease exists to refuse, reintroduced through the back door of the
  //                  mechanism built to avoid it.
  //   lazy = true    defers the agent build, and the poller starts only when the agent does. The
  //                  session would be live, own nothing, and drain nothing.
  //
  // It resumes, and waits to see who ends up owning the event.
  //
  // THE KICK'S LIFETIME IS NOT EVIDENCE. If nobody has taken the event by the time it gives up,
  // nothing unsafe has happened and a later pass may kick again. But if OUR child is the one that
  // took it, closing would kill the turn it is hosting -- so it stays until that turn ends.
  async resumeKick(wake) {
    const gateway = this.gatewayFactory();
    try {
      await gateway.start();
      // IDENTITY BEFORE RESUME, and the order matters for the same reason as everything else here.
      //
      // Resuming starts a live session, and a live session's poller may claim the event. If this
      // process could not say who it is, it could never recognise its OWN claim -- it would read
      // "somebody has it" and close, killing the turn its own child had just begun. So identity is
      // established while nothing has been resumed and closing is still free.
      const child = await gateway.identity().catch(() => null);
      if (!child?.pid) return "FAILED";
      await gateway.resume(wake.hermes_session_id);
      const receiver = this.externalTurns();
      let hosted = false;
      for (;;) {
        // The listener itself died. Nothing is concluded from that: the event is untouched and a
        // later pass may kick again.
        if (gateway.exit) return hosted ? "HOSTED" : "GATEWAY_GONE";
        await sleep(KICK_POLL_MS);
        // FAILING TO ASK IS NOT AN ANSWER.
        //
        // The adapter distinguishes these deliberately: a resolved null means Hermes was asked and
        // has no such event, while a rejection means the question never got through -- a spawn that
        // failed, a locked database, a timeout. Collapsing them would make a transient hiccup mean
        // "the event is gone", and the cleanup below would then close a listener that is still
        // eligible to claim -- killing a turn this process never observed starting. That is the
        // clock bug again, arriving through a different door.
        let status;
        try {
          status = await receiver.status(wake.id);
        } catch (error) {
          this.#event("WAKE_KICK_STATUS_FAILED", wake, {
            error: String(error.message).slice(0, 200),
          });
          continue;
        }
        // An answer, and it says the event no longer exists.
        if (!status) return "GONE";
        const state = String(status.state ?? "");
        // The turn ended. Conclusive for everyone.
        if (state === "FINISHED") return hosted ? "HOSTED" : "FINISHED";
        // Still nobody's. KEEP LISTENING -- this is the state a clock must never end, because this
        // process is still eligible to become the owner and closing could kill a turn it had just
        // begun.
        if (state === "PENDING") continue;
        if (state !== "CLAIMED" && state !== "STARTED") continue;
        // Whose is it? A person's own open chat taking the event is the good outcome and needs
        // nothing from us. This child hosting it is the case where leaving kills the turn.
        const mine = Boolean(child?.pid) && status.owner_pid === child.pid;
        if (!mine) return hosted ? "HANDED_OVER" : "RELEASED";
        hosted = true;
      }
    } catch (error) {
      // A kick that cannot start is not a delivery failure. The event is still queued and still
      // correct; some later pass, or a person opening the chat, will provide an owner.
      this.#event("WAKE_KICK_FAILED", wake, { error: String(error.message).slice(0, 200) });
      return "FAILED";
    } finally {
      await gateway.close();
    }
  }

  // Opens a gateway ONLY to look, and closes it before anything can act on what it saw.
  //
  // A resumed gateway is a live session, and a live session runs the external-turn poller. So the
  // process opened merely to READ canonical history is itself eligible to become the OWNER of the
  // very event about to be enqueued -- and it would then be holding a turn when this function's own
  // cleanup killed it. That destroys a turn nobody observed starting, which is precisely the
  // dead-STARTED-with-no-marker state the rest of this file is built to avoid creating.
  //
  // Nothing that makes an event consumable -- enqueue, reopen -- may run while a gateway opened for
  // looking is still alive.
  async #inspect(wake, { capabilities = false } = {}) {
    const gateway = this.gatewayFactory();
    try {
      await gateway.start();
      const { verdict, runtimeSessionId } = await this.#reconcileThrough(gateway, wake);
      const withheld = capabilities && verdict === "ABSENT"
        ? await this.#withholdReason(gateway)
        : null;
      return { verdict, runtimeSessionId, withheld };
    } finally {
      await gateway.close();
    }
  }

  // Records what the receiver last said. DIAGNOSTIC ONLY.
  //
  // Named so it cannot be mistaken for delegate-wave's own lifecycle: these are observations of a
  // remote process, true when they were read and possibly false now. Every decision re-reads the
  // receiver rather than trusting this.
  #recordReceiver(wake, status) {
    this.db.prepare(
      `UPDATE wake_outbox SET last_receiver_state = ?, last_receiver_observed_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(status?.state ?? null, now(), now(), wake.id);
  }

  // What the receiver says has become of one enqueued event.
  //
  // Cheap by construction: the transcript is only opened for the states where it can decide
  // something. An event still queued, still claimed, or being reasoned about right now is answered
  // by the receiver alone.
  async #observe(wake) {
    const receiver = this.externalTurns();
    const status = await receiver.status(wake.id);
    this.#recordReceiver(wake, status);

    // We recorded handing this over, and the receiver has never heard of it. That is not "nothing
    // happened" -- it is two systems disagreeing about what was said, most often a HERMES_HOME
    // pointing somewhere other than the one that hosts the conversation. Stopping is the only
    // honest response; retrying would be acting on a disagreement as though it were evidence.
    if (!status) {
      this.#settle(wake, "PARTIAL", {
        detail: "the receiver has no record of this event, so what became of it cannot be established here",
      });
      return "PARTIAL";
    }

    const state = String(status.state ?? "");
    // Nobody has it, or whoever had it is gone. BOTH need a listener.
    //
    // Hermes recovers a dead claim itself, but only from inside a live session's poller -- and if
    // the process that claimed it died with no chat open, there is no poller anywhere to do the
    // recovering. The row would sit CLAIMED forever with nothing able to notice. A claim held by a
    // LIVE owner is the one that needs nothing from us.
    if (state === "PENDING" || state === "CLAIMED") {
      if (state === "PENDING" || !status.owner_alive) this.#startKick(wake);
      return "WAITING";
    }
    // A turn in progress, in somebody else's process. The transcript is deliberately not read.
    if (state === "STARTED" && status.owner_alive) return "WAITING";

    {
      const { verdict, runtimeSessionId } = await this.#inspect(wake);
      if (state === "STARTED") {
        // The owner is gone. Hermes writes STARTED as soon as the turn thread launches and that
        // thread persists the user row afterwards, so a process killed in between leaves exactly
        // this: a turn that began, and a transcript with no evidence of it. Absence of the marker
        // is the only evidence that authorises saying it again, and this is the only branch acting
        // on it.
        if (verdict === "ABSENT") {
          // The reading gateway is already closed by #inspect, so it cannot be the one that takes
          // the event this call is about to make consumable again.
          await receiver.reopen(wake.id, "owner died before the marker became durable");
          this.#startKick(wake);
          this.#event("WAKE_REOPENED", wake, {});
          return "REOPENED";
        }
        this.#settle(wake, verdict, { runtimeSessionId });
        return verdict;
      }
      // FINISHED. The turn ended, so canonical history is complete and may be judged -- with one
      // exception in each direction, both of which fail closed.
      if (verdict === "ABSENT") {
        const outcome = String(status.outcome ?? "");
        const detail = outcome === "session_closed"
          ? "the hosting session was closed mid-turn; a forced close may leave state unflushed, so an absent marker does not prove nothing happened"
          : "the receiver reports the turn started and ended normally, but its marker is not in canonical history";
        this.#settle(wake, "PARTIAL", { detail });
        return "PARTIAL";
      }
      this.#settle(wake, verdict, { runtimeSessionId });
      return verdict;
    }
  }

  // Hands the event to the receiver and stops. Nothing here delivers anything.
  async #enqueue(wake, runtimeSessionId) {
    await this.externalTurns().enqueue({
      eventId: wake.id,
      sessionKey: wake.hermes_session_id,
      body: wake.body,
      source: "delegate-wave",
    });
    // The owner columns are CLEARED on this transition, on purpose. They mean "this delegate-wave
    // process is driving the delivery", and from here on it is not: the receiver is. Leaving them
    // set would offer the direct-submit recovery model a row it must never reason about.
    this.db.prepare(
      `UPDATE wake_outbox SET state = 'ENQUEUED', enqueued_at = ?, runtime_session_id = ?,
                              owner_pid = NULL, owner_started_at = NULL,
                              gateway_pid = NULL, gateway_started_at = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(now(), runtimeSessionId, now(), wake.id);
    this.#event("WAKE_ENQUEUED_TO_RECEIVER", wake, { reason: wake.reason });
    this.#startKick(wake);
    return "ENQUEUED";
  }

  // One wake, start to finish, by whichever protocol this runtime is configured for.
  async deliver(wake) {
    if (this.allowEnqueue) return this.#deliverByEnqueue(wake);
    return this.#deliverBySubmit(wake);
  }

  async #deliverByEnqueue(wake) {
    this.driving.add(wake.id);
    try {
      // Reconcile first, exactly as the direct path does: whatever this process believed about its
      // own last attempt, the transcript is the authority. Read and capability check happen in one
      // CLOSED scope -- see #inspect for why nothing may be enqueued while that gateway is alive.
      const { verdict, runtimeSessionId, withheld } = await this.#inspect(wake, { capabilities: true });
      if (verdict !== "ABSENT") {
        this.#settle(wake, verdict, { runtimeSessionId });
        return verdict;
      }
      if (withheld) {
        this.release(wake, `submission withheld: ${withheld}`);
        this.#event("WAKE_SUBMISSION_WITHHELD", wake, { reason: wake.reason, withheld });
        return "WITHHELD";
      }
      return await this.#enqueue(wake, runtimeSessionId);
    } finally {
      this.driving.delete(wake.id);
    }
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
    // Events already with the receiver, first. They hold the single-flight slot for their
    // conversation, so resolving them is what unblocks delivery rather than competing with it --
    // the same reason reconciliation precedes claiming below.
    const enqueued = this.db.prepare(
      "SELECT * FROM wake_outbox WHERE state = 'ENQUEUED' ORDER BY updated_at",
    ).all();
    for (const wake of enqueued) {
      try {
        outcomes.push({ wakeId: wake.id, outcome: await this.#observe(wake) });
      } catch (error) {
        // An unreachable receiver says nothing about the event. The row stays ENQUEUED and the next
        // pass asks again; concluding anything from a failed question would be a guess.
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
        this.release(claimed, String(error.message).slice(0, 500));
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
