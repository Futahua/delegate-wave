// What actually makes an autonomous session autonomous.
//
// Without this, start() creates a session, poll() observes it and answer() unblocks it -- and
// nothing ever moves it forward, because the work happens in tick(). A session would sit in WORKING
// for as long as anyone cared to keep asking. The durable runtime owns progression: Hermes observes
// and answers, and is never expected to call a fourth operation to make the system run.
//
// ONE SESSION MUST NOT STARVE THE OTHERS.
//
// tick() awaits manager.advance(), which commissions workers and can take minutes. Driving sessions
// one after another inside a single pass would mean a long managed run blocks every other session
// behind it, including ones that only needed a moment. So each session is claimed and driven
// independently, with a bounded number in flight at once -- the same shape job execution already
// uses.
//
// Claims are in memory on purpose. They exist to stop THIS process driving one session twice
// concurrently, not to record anything: after a crash the truth is in SQLite, every unfinished
// session is rediscovered by its state, and tick() is safe to call from any state. Persisting a
// claim would create a second problem -- a stale lock held by a process that no longer exists.
const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_CONCURRENCY = 4;

export class SessionDriver {
  constructor({ sessions, intervalMs = DEFAULT_INTERVAL_MS, concurrency = DEFAULT_CONCURRENCY, onError = null, onEvent = null }) {
    if (!sessions) throw new Error("SessionDriver requires a session service");
    this.sessions = sessions;
    this.db = sessions.db;
    this.intervalMs = intervalMs;
    this.concurrency = concurrency;
    this.onError = onError;
    // Bounded lifecycle evidence. "No error recorded" and "never ran" look identical from the
    // outside, and distinguishing them took a session of guessing.
    this.onEvent = onEvent;
    this.passes = 0;
    // When each session was last given a slot. Ordering by this rather than by updated_at is what
    // stops a session that cannot progress from permanently starving one that can.
    this.lastDriven = new Map();
    this.inFlight = new Set();
    this.timer = null;
    this.stopped = false;
  }

  // Sessions that still have somewhere to go.
  //
  // WORKING is obvious. SEMANTICALLY_ACCEPTED is included only for a session PERMITTED TO PUBLISH:
  // for those it is not a resting state, because acceptance is recorded before publication and a
  // crash in that window leaves work finished except for its cheapest step.
  //
  // For MANUAL and PLAN it IS the resting state -- the result is meant to wait for a person. Claiming
  // them anyway meant five finished probe sessions were re-driven every two seconds forever, doing
  // nothing but occupying the slots that starved a live one. Terminal-for-this-mode is a fact worth
  // asking the query, rather than discovering after the work is claimed.
  pending() {
    const rows = this.db.prepare(
      `SELECT id, state, mode FROM autonomous_sessions
       WHERE state = 'WORKING'
          OR (state = 'SEMANTICALLY_ACCEPTED' AND mode IN ('AUTO', 'ACCEPT_EDITS', 'BYPASS'))
       ORDER BY updated_at`,
    ).all();
    // Least-recently-driven first, so every session reaches a slot.
    //
    // Ordering by updated_at alone starves: with more pending sessions than concurrency, the same
    // oldest few are claimed on every pass, and any session behind them is never reached. Sessions
    // that return immediately -- because their work is already in flight, or because they are stuck
    // -- free their slots instantly and are simply re-claimed two seconds later, forever. A newly
    // started session sat untouched behind four such sessions and looked like a dead driver.
    return rows.sort((a, b) => (this.lastDriven.get(a.id) ?? 0) - (this.lastDriven.get(b.id) ?? 0));
  }

  // One pass: claim what there is room for, and return without waiting for any of it.
  pass() {
    this.passes += 1;
    const pending = this.pending();
    const before = this.inFlight.size;
    // Reported only when there is something to say, so a quiet driver stays quiet.
    if (pending.length && this.onEvent) {
      this.onEvent("SESSION_DRIVER_PASS", { pass: this.passes, workingFound: pending.length, inFlight: before });
    }
    const live = new Set(pending.map((session) => session.id));
    for (const known of [...this.lastDriven.keys()]) if (!live.has(known)) this.lastDriven.delete(known);

    for (const session of pending) {
      if (this.inFlight.size >= this.concurrency) break;
      if (this.inFlight.has(session.id)) continue;
      this.inFlight.add(session.id);
      this.lastDriven.set(session.id, this.passes);
      // Deliberately not awaited. A pass that awaited its work would serialise every session behind
      // the slowest one, which is the starvation this design exists to avoid.
      Promise.resolve()
        .then(() => this.sessions.tick(session.id))
        .catch((error) => { if (this.onError) this.onError(error, session.id); })
        .finally(() => this.inFlight.delete(session.id));
    }
    return this.inFlight.size;
  }

  start() {
    if (this.timer) return this;
    this.stopped = false;
    if (this.onEvent) this.onEvent("SESSION_DRIVER_STARTED", { intervalMs: this.intervalMs, concurrency: this.concurrency });
    this.timer = setInterval(() => {
      if (this.stopped) return;
      // A throw here would otherwise surface as an uncaught exception in a timer, which is both
      // fatal and unattributable. The driver reports and keeps going.
      try { this.pass(); } catch (error) { if (this.onError) this.onError(error, null); }
    }, this.intervalMs);
    // Never hold the process open on the driver's account: the served runtime decides its own
    // lifetime, and a timer that kept it alive would turn a clean shutdown into a hang.
    if (typeof this.timer.unref === "function") this.timer.unref();
    return this;
  }

  stop() {
    this.stopped = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    return this;
  }

  // Drives everything to a standstill. For tests and for a shutdown that wants to finish what it
  // started, never on the serving path.
  async drain({ maxPasses = 50 } = {}) {
    for (let pass = 0; pass < maxPasses; pass += 1) {
      this.pass();
      if (this.inFlight.size === 0 && this.pending().length === 0) return true;
      await new Promise((resolve) => { setTimeout(resolve, 25); });
    }
    return this.pending().length === 0;
  }
}
