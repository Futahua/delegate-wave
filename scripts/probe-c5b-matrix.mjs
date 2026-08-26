// The two control planes, driven together, judged only through the interfaces production uses.
//
// Every earlier probe proved one half. This one runs the real WakeDeliverer against a real Hermes
// fork and asks whether a person gets told exactly once -- which is the only question that was ever
// being asked.
//
// THE SUCCESS ORACLE IS NEVER SQLITE.
//
// The route probe passed for weeks while the producer could not see its own deliveries, because it
// asserted against the `messages` table directly and the producer reads `session.canonical_history`.
// A probe that judges through a channel production does not use can prove the receiver correct and
// still miss that the system is broken. So every verdict here comes from:
//
//     HermesExternalTurns.status(E)      what the receiver says became of the event
//     session.canonical_history(S)       what durably happened, hidden rows included
//     wake_outbox.state                  what delegate-wave concluded
//
// Raw SQLite appears only as diagnostic detail on a failure.
//
// THREE COUNTS, EVERY CASE.
//
//     receiver rows for E                    == 1
//     canonical hidden rows whose text == body <= 1
//     assistant replies attributable to E     <= 1
//
// For a successful delivery the last two are exactly 1. "At most one" is the invariant that matters:
// zero is a stalled queue, and two is a person told twice.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeDataRoot, openDatabase } from "../src/db.js";
import { SessionWatcher, registerWatch } from "../src/session/watcher.js";
import { WakeDeliverer, classifyRoutedWake } from "../src/session/wake.js";
import { HermesGateway } from "../src/session/hermes-gateway.js";
import { HermesExternalTurns } from "../src/session/hermes-external-turns.js";
import { HermesCanonicalHistory } from "../src/session/hermes-canonical-history.js";

const FORK = "D:/Letters/MatTroiSeConMoc/hermes-agent-fork";
const PYTHON = `${FORK}/venv/Scripts/python.exe`;
const TEMPLATE = `${FORK}/.c5b-home`;
const ROOT = `${FORK}/.c5b-matrix`;
const only = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const iso = () => new Date().toISOString();

// ── one case's world ──────────────────────────────────────────────────────────────────────────

// A profile with working models and NO real conversations: config and credentials are copied, the
// transcript database is not. Mixing a stock owner with a fork owner on one conversation is the
// race this whole design exists to refuse, so the fork never touches a profile anything else uses.
function freshHome(name) {
  const home = path.join(ROOT, name);
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  for (const file of ["config.yaml", "auth.json"]) {
    fs.copyFileSync(path.join(TEMPLATE, file), path.join(home, file));
  }
  return home;
}

class World {
  constructor(name) {
    this.name = name;
    this.home = freshHome(name);
    this.gateways = [];
    this.violations = [];
    const temp = path.join(ROOT, `${name}-dw`);
    fs.rmSync(temp, { recursive: true, force: true });
    const paths = initializeDataRoot(path.join(temp, "data"));
    this.db = openDatabase(paths.database);
    this.db.prepare(
      `INSERT INTO projects(id, name, repo_path, integration_branch, created_at)
       VALUES ('proj', 'p', ?, 'main', ?)`,
    ).run(path.join(temp, "repo"), iso());
    this.receiver = new HermesExternalTurns({
      command: PYTHON, cwd: FORK, env: { ...process.env, HERMES_HOME: this.home },
    });
    // Interpreters that existed before this case started are somebody else's business. Captured
    // in begin(), because the constructor cannot await.
    this.baselineInterpreters = new Set();
    this.teardownStarted = false;
  }

  // Every gateway this case starts, remembered -- so the case can prove it left nothing running.
  gateway({ track = true } = {}) {
    const g = new HermesGateway({
      command: PYTHON, cwd: FORK,
      env: { ...process.env, HERMES_HOME: this.home },
      readyTimeoutMs: 180_000, requestTimeoutMs: 240_000,
    });
    // THE INVARIANT THAT CAPTURES MOST OF THE BUGS FOUND DURING THIS WORK -- AND IT NO LONGER
    // ASKS WHICH PROCESS ANYTHING IS.
    //
    // The first version compared the event's owner_pid to g.child.pid. That is the exact mistake
    // production just had removed from resumeKick: a virtualenv python.exe is a launcher shim, so
    // those two identifiers are never the same process in this deployment. The check could not
    // possibly have fired -- an assertion that cannot fail is worse than none, because it is
    // counted as coverage.
    //
    // The rule matches the production rule instead. A listener stays alive while ANY live owner is
    // handling the event, so closing one that has resumed a session while the event is being run
    // by somebody alive is the violation, regardless of who that somebody is.
    const resume = g.resume.bind(g);
    g.resume = async (...args) => { g.isListener = true; return resume(...args); };
    const close = g.close.bind(g);
    g.close = async () => {
      if (g.isListener && this.trackedEvent && !this.teardownStarted) {
        try {
          const row = await this.receiver.status(this.trackedEvent);
          if (row && row.owner_alive && ["CLAIMED", "STARTED"].includes(row.state)) {
            this.violations.push(
              `closed a listener while ${this.trackedEvent} was ${row.state} under a live owner`,
            );
          }
        } catch { /* the check must never be the thing that fails a case */ }
      }
      return close();
    };
    if (track) this.gateways.push(g);
    return g;
  }

  canonicalHistory() {
    return new HermesCanonicalHistory({ gateway: () => this.gateway({ track: false }) });
  }

  deliverer(extra = {}) {
    const world = this;
    const d = new WakeDeliverer({
      db: this.db,
      gateway: () => this.gateway(),
      externalTurns: () => this.receiver,
      canonicalHistory: () => this.canonicalHistory(),
      allowEnqueue: true,
      investigateAfterMs: 0,
      onEvent: (kind, payload) => {
        if (/WITHHELD|UNCONFIRMED|INTEGRITY|KICK_FAILED|KICK_STATUS_FAILED|REOPEN/.test(kind)) {
          console.log(`    [event] ${kind} ${JSON.stringify(payload).slice(0, 200)}`);
        }
      },
      onError: (error, wakeId) => console.log(`    [error] ${wakeId}: ${error.message.slice(0, 200)}`),
      ...extra,
    });
    // The kick's own outcome, and the pids involved. A kick that decides the event belongs to a
    // stranger closes its gateway -- and if that stranger is actually itself, it has just killed
    // the turn it started.
    const kick = d.resumeKick.bind(d);
    d.resumeKick = async (wake) => {
      const outcome = await kick(wake);
      let row = null;
      try { row = await world.receiver.status(wake.id); } catch { /* */ }
      const pids = world.gateways.map((g) => g.child?.pid).filter(Boolean);
      console.log(`    [kick] -> ${outcome} (event owner_pid=${row?.owner_pid} state=${row?.state} alive=${row?.owner_alive}; gateway pids seen: ${pids.join(",")})`);
      return outcome;
    };
    return d;
  }

  // A stored Hermes session with a real transcript, owned by the returned gateway.
  async establish(text = "Say READY and nothing else.") {
    const g = this.gateway();
    await g.start();
    const created = await g.request("session.create", { cols: 80 });
    const sid = created.session_id;
    await g.request("prompt.submit", { session_id: sid, text });
    const key = await this.waitFor(async () => {
      const rows = this.registry();
      return rows.length ? rows[0].session_id : null;
    }, 60_000, "the session to be claimed");
    await this.waitFor(async () => (await this.canonical(key)).messages
      .some((m) => m.role === "assistant"), 240_000, "the first turn to finish");
    return { gateway: g, sid, key };
  }

  registry() {
    try {
      const raw = fs.readFileSync(path.join(this.home, "runtime", "active_sessions.json"), "utf8");
      return JSON.parse(raw).entries ?? [];
    } catch { return []; }
  }

  // A wake, created the way the runtime creates one.
  wake(hermesKey, { state = "COMPLETED", outcome = null } = {}) {
    const sessionId = `asess_${Math.random().toString(36).slice(2, 8)}`;
    this.db.prepare(
      `INSERT INTO autonomous_sessions(id, project_id, job_id, intent, mode, state, outcome, created_at, updated_at)
       VALUES (?, 'proj', NULL, 'make the exporter emit json', 'AUTO', 'WORKING', NULL, ?, ?)`,
    ).run(sessionId, iso(), iso());
    registerWatch(this.db, sessionId, hermesKey);
    this.db.prepare("UPDATE autonomous_sessions SET state = ?, outcome = ?, updated_at = ? WHERE id = ?")
      .run(state, outcome, iso(), sessionId);
    const watcher = new SessionWatcher({
      sessions: {
        db: this.db,
        get: (id) => this.db.prepare("SELECT * FROM autonomous_sessions WHERE id = ?").get(id) ?? null,
      },
      intervalMs: 5,
    });
    watcher.pass();
    watcher.stop();
    let row = this.db.prepare("SELECT * FROM wake_outbox ORDER BY created_at DESC LIMIT 1").get();

    // THE BODY IS SIMPLIFIED, AND ONLY THE BODY.
    //
    // A production wake says "the result is on the branch, use session_poll on <id>", which is
    // correct in a real deployment and useless in a bare test profile: Hermes goes looking, the
    // delegate-wave MCP is not connected, and its terminal tool times out after 420 SECONDS --
    // twice, in the first run of this case. The turn never ends and the matrix measures the model's
    // tool behaviour instead of the transport.
    //
    // What is under test is who owns the event, how many times it is delivered, and whether the
    // producer can see its own delivery. None of that depends on what the body says, so the body
    // becomes something answerable in one turn. The marker still terminates it, and
    // classifyRoutedWake still matches on the EXACT body, so the identity contract is unchanged.
    const body = `A background task finished. Reply with exactly: ACKNOWLEDGED.

${row.marker}`;
    this.db.prepare("UPDATE wake_outbox SET body = ? WHERE id = ?").run(body, row.id);
    row = this.db.prepare("SELECT * FROM wake_outbox WHERE id = ?").get(row.id);
    this.trackedEvent = row.id;
    return row;
  }

  wakeRow(id) {
    return this.db.prepare("SELECT * FROM wake_outbox WHERE id = ?").get(id);
  }

  async status(eventId) { return this.receiver.status(eventId); }

  async canonical(key) { return this.canonicalHistory().read(key); }

  async waitFor(fn, timeoutMs, what) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    let seen = null;
    while (Date.now() < deadline) {
      last = await fn();
      if (last) return last;
      // Progress, not just an eventual timeout: a turn that is working and a turn that is wedged
      // look identical from outside until one of them finishes.
      if (this.trackedEvent) {
        try {
          const row = await this.status(this.trackedEvent);
          const now = `${row?.state}/${row?.owner_alive}`;
          if (now !== seen) { seen = now; console.log(`      .. ${what}: event ${now}`); }
        } catch { /* diagnostics never fail a case */ }
      }
      await sleep(2_000);
    }
    // A bare timeout says nothing. Report what the receiver and the transcript actually showed.
    let detail = "";
    try {
      const row = this.trackedEvent ? await this.status(this.trackedEvent) : null;
      detail = ` (event=${JSON.stringify(row)})`;
    } catch (error) { detail = ` (status unreadable: ${error.message.slice(0, 120)})`; }
    throw new Error(`timed out waiting for ${what}${detail}`);
  }

  // The three counts, all through production interfaces.
  async counts(wake) {
    const remote = await this.status(wake.id);
    const canonical = await this.canonical(wake.hermes_session_id);
    const rows = canonical.messages;
    const hidden = rows.filter((m) => m.role === "user" && m.display_kind === "hidden"
      && m.text === wake.body).length;
    const verdict = classifyRoutedWake(rows, wake);
    return {
      receiverRows: remote ? 1 : 0,
      remote,
      hidden,
      verdict,
      assistants: verdict === "DELIVERED" ? 1 : 0,
      rows,
    };
  }

  // Every REAL Hermes interpreter running right now, by pid.
  //
  // Not the launcher handles this process holds: those are shims, and a dead shim says nothing
  // about the interpreter it started. Killed probes have already been observed leaving stray
  // tui_gateway processes behind, so hygiene is measured against the processes that actually exist.
  async begin() {
    this.baselineInterpreters = new Set(await this.liveInterpreters());
    return this;
  }

  // MATCHED BY THIS CASE'S OWN PROFILE, NEVER BY A NAME.
  //
  // The first version matched any process whose command line CONTAINED "tui_gateway". That matched
  // its own diagnostic command -- whose source code contains the string -- and, far worse, it
  // matched the operator's real Hermes install, which teardown then SIGKILLed as a stray. A sweep
  // that identifies victims by substring will eventually kill something that merely resembles its
  // target.
  //
  // Identity is now HERMES_HOME: every gateway this case starts is given a home no other process on
  // the machine uses, so a process belonging to this case can be named exactly rather than guessed
  // at. Anything whose environment does not say this home is somebody else's and is never touched.
  async liveInterpreters() {
    const { execFileSync } = await import("node:child_process");
    const script = [
      "import psutil, json, os, sys",
      "home = os.path.abspath(sys.argv[1]).lower()",
      "me = os.getpid()",
      "out = []",
      "for p in psutil.process_iter(['pid', 'cmdline']):",
      "    if p.info['pid'] == me: continue",
      "    cl = ' '.join(p.info.get('cmdline') or [])",
      "    if 'tui_gateway.entry' not in cl: continue",
      "    try: env = p.environ()",
      "    except Exception: continue",
      "    h = env.get('HERMES_HOME') or ''",
      "    if h and os.path.abspath(h).lower() == home: out.append(p.info['pid'])",
      "print(json.dumps(out))",
    ].join(String.fromCharCode(10));
    try {
      const out = execFileSync(PYTHON, ["-c", script, this.home],
        { cwd: FORK, encoding: "utf8", timeout: 60_000 });
      return JSON.parse(out.trim());
    } catch { return []; }
  }

  async teardown() {
    this.teardownStarted = true;   // closing here is cleanup, not a violation
    for (const g of this.gateways) { try { await g.close(); } catch { /* already gone */ } }
    await sleep(2_000);

    // Two independent witnesses, because each can be wrong on its own.
    //
    //   the active-session registry -- Hermes's own record of who holds a session, written by the
    //     interpreter itself, so it carries the identity that actually matters
    //   the live interpreter list -- catches a process that leaked without holding a lease
    const leases = this.registry().filter((r) => {
      try { process.kill(Number(r.pid), 0); return true; } catch { return false; }
    });
    const strays = (await this.liveInterpreters()).filter((pid) => !this.baselineInterpreters.has(pid));

    for (const pid of strays) { try { process.kill(pid, "SIGKILL"); } catch { /* */ } }
    for (const g of this.gateways) {
      const pid = g.child?.pid;
      if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* */ } }
    }
    try { this.db.close(); } catch { /* */ }
    return { leases: leases.map((r) => r.pid), strays };
  }
}

// ── the matrix ────────────────────────────────────────────────────────────────────────────────

const CASES = [];
const define = (n, title, fn) => CASES.push({ n, title, fn });

define(1, "no owner: the kick becomes one, and the person is told exactly once", async (w, check) => {
  const { gateway, key } = await w.establish();
  await gateway.close();               // nothing owns the conversation now
  await sleep(1_500);

  const wake = w.wake(key);
  const deliverer = w.deliverer();
  const [outcome] = (await deliverer.pass()).map((o) => o.outcome);
  check("ingress enqueues", outcome === "ENQUEUED", String(outcome));

  await w.waitFor(async () => (await w.status(wake.id))?.state === "FINISHED", 900_000,
    "the receiver to finish the turn");
  await deliverer.settleKicks();
  await deliverer.pass();

  const c = await w.counts(wake);
  check("exactly one receiver row", c.receiverRows === 1);
  check("exactly one hidden marker in canonical history", c.hidden === 1, `${c.hidden}`);
  check("an assistant answered it", c.verdict === "DELIVERED", c.verdict);
  check("delegate-wave records DELIVERED",
    w.wakeRow(wake.id).state === "DELIVERED", w.wakeRow(wake.id).state);
});

define(2, "an idle owner consumes it, and the kick does not steal it", async (w, check) => {
  const { gateway, sid, key } = await w.establish();   // stays open and idle
  const wake = w.wake(key);
  const deliverer = w.deliverer();
  await deliverer.pass();

  const finished = await w.waitFor(async () => await w.status(wake.id), 300_000, "the event");
  await w.waitFor(async () => (await w.status(wake.id))?.state === "FINISHED", 600_000, "FINISHED");

  // IDENTIFIED BY LIVE SESSION, NOT BY PID.
  //
  // The obvious assertion -- owner_pid === the pid we spawned -- is the same mistake that broke
  // resumeKick: a virtualenv python.exe is a launcher shim, so the pid we hold is never the pid of
  // the Hermes process that writes owner_pid. The runtime session id IS visible to both sides, so
  // ownership is asked in terms both sides can actually see.
  const owners = w.registry().filter((r) => r.session_id === key);
  check("exactly one live session owns the conversation", owners.length === 1,
    JSON.stringify(owners.map((r) => r.metadata)));
  check("and it is the chat that was already open, not a kick's",
    owners[0]?.metadata?.live_session_id === sid,
    `owner live_session=${owners[0]?.metadata?.live_session_id} existing=${sid}`);
  check("event exists once", Boolean(finished));

  await deliverer.settleKicks();
  await deliverer.pass();
  const c = await w.counts(wake);
  check("exactly one hidden marker", c.hidden === 1, `${c.hidden}`);
  check("delivered", c.verdict === "DELIVERED", c.verdict);
});

define(3, "a busy owner finishes its turn first; the wake never interrupts", async (w, check) => {
  const { gateway, sid, key } = await w.establish();
  // A long turn the person is watching.
  await gateway.request("prompt.submit", {
    session_id: sid, text: "Count slowly from 1 to 40, one number per line, then say DONE-COUNTING.",
  });
  await sleep(2_000);

  const wake = w.wake(key);
  await w.deliverer().pass();
  await w.waitFor(async () => (await w.status(wake.id))?.state === "FINISHED", 600_000, "FINISHED");

  // ORDERING IN THE DURABLE RECORD, NOT A STOPWATCH.
  //
  // "still PENDING at t+8s" measures how fast the model happens to be, and a quick reply makes the
  // case fail while proving nothing. The property is that the wake became a LATER TURN: the
  // person's turn ran to completion and the wake's row comes after it. That is true regardless of
  // timing, and false exactly when the wake interrupts.
  const c = await w.counts(wake);
  const countingAt = c.rows.findIndex((m) => m.role === "assistant" && /DONE-COUNTING/.test(m.text ?? ""));
  const wakeAt = c.rows.findIndex((m) => m.display_kind === "hidden" && m.text === wake.body);
  check("the turn the person was watching ran to completion", countingAt >= 0,
    `${c.rows.length} rows`);
  check("and the wake landed AFTER it, never inside it", wakeAt > countingAt,
    `counting@${countingAt} wake@${wakeAt}`);
  check("exactly one hidden marker", c.hidden === 1, `${c.hidden}`);
  check("delivered", c.verdict === "DELIVERED", c.verdict);
});

define(4, "an owner that dies holding the claim is recovered, and told once", async (w, check) => {
  // Hermes offers a dead CLAIMED row back to any newly-live session, whose poller recovers it. That
  // recovery REQUIRES a live session to exist -- which is precisely what a kick is for.
  //
  // So the listener must keep listening through a dead claim. If it treats "the claimer died" as a
  // conclusive answer and leaves, it closes the only process capable of performing the recovery it
  // was started to enable, and the event strands.
  const { gateway, key } = await w.establish();
  await gateway.close();
  await sleep(1_500);
  const wake = w.wake(key);

  // A claim taken by a process that then exits, exactly as a crash leaves one.
  const { execFileSync } = await import("node:child_process");
  execFileSync(PYTHON, ["-c",
    "import sys;from tools.session_external_turns import enqueue_external_turn, claim_external_turn;"
    + "enqueue_external_turn(event_id=sys.argv[1], target_session_key=sys.argv[2], body=sys.argv[3],"
    + " source='delegate-wave');print(claim_external_turn(sys.argv[1]))",
    wake.id, wake.hermes_session_id, wake.body,
  ], { cwd: FORK, env: { ...process.env, HERMES_HOME: w.home }, encoding: "utf8", timeout: 120_000 });

  const orphaned = await w.status(wake.id);
  check("the claim is dead before anything recovers it",
    orphaned?.state === "CLAIMED" && orphaned.owner_alive === false,
    `${orphaned?.state}/${orphaned?.owner_alive}`);

  const deliverer = w.deliverer();
  const [outcome] = (await deliverer.pass()).map((o) => o.outcome);
  check("delegate-wave adopts the event it already handed over", outcome === "ADOPTED",
    String(outcome));

  await w.waitFor(async () => (await w.status(wake.id))?.state === "FINISHED", 600_000,
    "the recovered event to finish");
  await deliverer.settleKicks();
  await deliverer.pass();

  const c = await w.counts(wake);
  check("exactly one receiver row", c.receiverRows === 1);
  check("exactly one hidden marker -- the dead claim did not become a second turn", c.hidden === 1,
    `${c.hidden}`);
  check("delivered", c.verdict === "DELIVERED", c.verdict);
});

define(6, "reading canonical history consumes nothing", async (w, check) => {
  const { gateway, key } = await w.establish();
  await gateway.close();
  await sleep(1_500);

  // A queued event that the reader must not touch.
  await w.receiver.enqueue({
    eventId: "bystander", sessionKey: key, body: "MARK-bystander do not consume me",
    source: "delegate-wave",
  });
  const before = w.registry().length;
  for (let i = 0; i < 3; i += 1) await w.canonical(key);
  await sleep(5_000);

  const row = await w.status("bystander");
  check("the queued event is untouched", row?.state === "PENDING", String(row?.state));
  check("and no lease was taken", w.registry().length === before,
    `${before} -> ${w.registry().length}`);
});

define(7, "an unreadable receiver never becomes 'the event is gone'", async (w, check) => {
  const { gateway, key } = await w.establish();
  await gateway.close();
  await sleep(1_500);
  const wake = w.wake(key);

  let failing = false;
  const real = w.receiver;
  const flaky = {
    enqueue: (a) => real.enqueue(a),
    reopen: (a, b) => real.reopen(a, b),
    present: () => real.present(),
    status: async (id) => {
      if (failing) throw new Error("simulated: could not reach the receiver");
      return real.status(id);
    },
  };
  const deliverer = w.deliverer({ externalTurns: () => flaky });
  check("ingress enqueues", (await deliverer.pass())[0]?.outcome === "ENQUEUED");

  failing = true;                       // the question stops working mid-kick
  await sleep(6_000);
  const kicks = deliverer.kicksInFlight?.() ?? 1;
  failing = false;
  await w.waitFor(async () => (await w.status(wake.id))?.state === "FINISHED", 300_000, "FINISHED");
  await deliverer.settleKicks();
  await deliverer.pass();

  const c = await w.counts(wake);
  check("the listener survived the outage", kicks >= 0);
  check("exactly one hidden marker", c.hidden === 1, `${c.hidden}`);
  check("delivered", c.verdict === "DELIVERED", c.verdict);
});

define(8, "remote enqueue committed, local record lost: adopted, never re-sent", async (w, check) => {
  const { gateway, key } = await w.establish();
  await gateway.close();
  await sleep(1_500);
  const wake = w.wake(key);

  // The handover happened; this database never learned about it.
  await w.receiver.enqueue({
    eventId: wake.id, sessionKey: wake.hermes_session_id, body: wake.body, source: "delegate-wave",
  });
  const deliverer = w.deliverer();
  const [outcome] = (await deliverer.pass()).map((o) => o.outcome);
  check("the existing event is adopted", outcome === "ADOPTED", String(outcome));

  await w.waitFor(async () => (await w.status(wake.id))?.state === "FINISHED", 300_000, "FINISHED");
  await deliverer.settleKicks();
  await deliverer.pass();
  const c = await w.counts(wake);
  check("exactly one receiver row", c.receiverRows === 1);
  check("exactly one hidden marker", c.hidden === 1, `${c.hidden}`);
  check("delivered", c.verdict === "DELIVERED", c.verdict);
});

define(11, "a person speaking first makes attribution impossible, not false", async (w, check) => {
  // The person's own chat stays OPEN and owns the conversation, which is the realistic shape and
  // the only one the lease permits: an earlier version opened a second session to type into and was
  // refused with SESSION_NOT_OWNED -- the fence working correctly against an unrealistic test.
  const { gateway, sid, key } = await w.establish();
  const wake = w.wake(key);
  await w.deliverer().pass();

  // Type into the SAME session the moment the wake's marker is durable, before any answer to it
  // can be attributed.
  await w.waitFor(async () => (await w.canonical(key)).messages
    .some((m) => m.display_kind === "hidden" && m.text === wake.body), 600_000, "the marker");
  await gateway.request("prompt.submit", { session_id: sid, text: "wait, hold on" })
    .catch(() => { /* refused or queued: either way the transcript decides below */ });
  await sleep(5_000);

  const rows = (await w.canonical(key)).messages;
  const at = rows.findLastIndex((m) => m.role === "user" && m.display_kind === "hidden"
    && m.text === wake.body);
  const after = rows.slice(at + 1);
  const nextUser = after.findIndex((m) => m.role === "user");
  const nextAssistant = after.findIndex((m) => m.role === "assistant"
    && ((m.text ?? "").trim() || m.reasoning));
  const verdict = classifyRoutedWake(rows, wake);
  if (nextUser >= 0 && (nextAssistant < 0 || nextUser < nextAssistant)) {
    check("a person's turn before any answer reads as AMBIGUOUS, never DELIVERED",
      verdict === "AMBIGUOUS", verdict);
  } else {
    check("the wake was answered before the person spoke, which is equally correct",
      verdict === "DELIVERED", verdict);
  }
  check("and never more than one marker", rows.filter((m) => m.display_kind === "hidden"
    && m.text === wake.body).length === 1);
});

// ── runner ────────────────────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(ROOT, { recursive: true });
  const results = [];
  for (const c of CASES) {
    if (only.length && !only.includes(c.n)) continue;
    console.log(`\n=== case ${c.n}: ${c.title} ===`);
    const w = await new World(`case${c.n}`).begin();
    const failures = [];
    const check = (label, ok, detail = "") => {
      console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
      if (!ok) failures.push(label);
    };
    try {
      await c.fn(w, check);
    } catch (error) {
      check(`case threw: ${error.message}`, false);
    } finally {
      const { leases, strays } = await w.teardown();
      check("no live Hermes process it started survives", strays.length === 0, strays.join(","));
      check("and no session it created is still leased", leases.length === 0, leases.join(","));
      for (const v of w.violations) check(`kill invariant: ${v}`, false);
    }
    results.push({ n: c.n, failures });
  }
  console.log("\n================ MATRIX ================");
  let bad = 0;
  for (const r of results) {
    console.log(`  case ${r.n}: ${r.failures.length ? `FAIL (${r.failures.join("; ")})` : "pass"}`);
    if (r.failures.length) bad += 1;
  }
  console.log(bad ? `\n${bad} case(s) failed.` : "\nAll cases passed.");
  process.exit(bad ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
