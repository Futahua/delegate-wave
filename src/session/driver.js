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
  constructor({ sessions, intervalMs = DEFAULT_INTERVAL_MS, concurrency = DEFAULT_CONCURRENCY, onError = null }) {
    if (!sessions) throw new Error("SessionDriver requires a session service");
    this.sessions = sessions;
    this.db = sessions.db;
    this.intervalMs = intervalMs;
    this.concurrency = concurrency;
    this.onError = onError;
    this.inFlight = new Set();
    this.timer = null;
    this.stopped = false;
  }

  // Sessions that still have somewhere to go.
  //
  // WORKING is obvious. SEMANTICALLY_ACCEPTED is included because for a session permitted to
  // publish it is not a resting state: the acceptance is recorded before publication, so a crash in
  // that window leaves work that is finished except for its cheapest step. Whether it may proceed is
  // then the ordinary permission question, asked by tick() rather than decided here.
  pending() {
    return this.db.prepare(
      `SELECT id, state, mode FROM autonomous_sessions
       WHERE state IN ('WORKING', 'SEMANTICALLY_ACCEPTED') ORDER BY updated_at`,
    ).all();
  }

  // One pass: claim what there is room for, and return without waiting for any of it.
  pass() {
    for (const session of this.pending()) {
      if (this.inFlight.size >= this.concurrency) break;
      if (this.inFlight.has(session.id)) continue;
      this.inFlight.add(session.id);
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
    this.timer = setInterval(() => { if (!this.stopped) this.pass(); }, this.intervalMs);
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
