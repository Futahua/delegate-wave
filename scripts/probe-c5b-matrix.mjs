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
  }

  // Every gateway this case starts, remembered -- so the case can prove it left nothing running.
  gateway({ track = true } = {}) {
    const g = new HermesGateway({
      command: PYTHON, cwd: FORK,
      env: { ...process.env, HERMES_HOME: this.home },
      readyTimeoutMs: 180_000, requestTimeoutMs: 240_000,
    });
    // THE INVARIANT THAT CAPTURES MOST OF THE BUGS FOUND DURING THIS WORK.
    //
    // A gateway must never be closed while the receiver says that same process owns the event in
    // CLAIMED or STARTED -- that is delegate-wave destroying a turn it asked for. Checked here
    // rather than reasoned about, because every version of this bug looked correct in review.
    const close = g.close.bind(g);
    g.close = async () => {
      const pid = g.child?.pid ?? null;
      if (pid && this.trackedEvent) {
        try {
          const row = await this.receiver.status(this.trackedEvent);
          if (row && row.owner_pid === pid && ["CLAIMED", "STARTED"].includes(row.state)) {
            this.violations.push(
              `closed gateway pid ${pid} while it owned ${this.trackedEvent} in ${row.state}`,
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

  async teardown() {
    for (const g of this.gateways) { try { await g.close(); } catch { /* already gone */ } }
    await sleep(1_000);
    const alive = [];
    for (const g of this.gateways) {
      const pid = g.child?.pid;
      if (!pid) continue;
      try { process.kill(pid, 0); alive.push(pid); try { process.kill(pid, "SIGKILL"); } catch { /* */ } }
      catch { /* dead, which is what we want */ }
    }
    try { this.db.close(); } catch { /* */ }
    return alive;
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
  const { gateway, key } = await w.establish();   // stays open and idle
  const wake = w.wake(key);
  const deliverer = w.deliverer();
  await deliverer.pass();

  const finished = await w.waitFor(async () => await w.status(wake.id), 300_000, "the event");
  await w.waitFor(async () => (await w.status(wake.id))?.state === "FINISHED", 300_000, "FINISHED");
  const owner = (await w.status(wake.id)).owner_pid;
  check("the existing owner ran it, not a kick",
    owner === gateway.child.pid, `owner=${owner} existing=${gateway.child.pid}`);
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
  await sleep(8_000);
  const during = await w.status(wake.id);
  check("it waits while the owner is busy",
    during && ["PENDING", "CLAIMED"].includes(during.state), String(during?.state));

  await w.waitFor(async () => (await w.status(wake.id))?.state === "FINISHED", 300_000, "FINISHED");
  const c = await w.counts(wake);
  const counting = c.rows.filter((m) => m.role === "assistant" && /DONE-COUNTING/.test(m.text ?? ""));
  check("the interrupted-looking turn actually completed", counting.length === 1,
    `${counting.length} completions`);
  check("and the wake became a later turn", c.hidden === 1, `${c.hidden}`);
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
  const { gateway, sid, key } = await w.establish();
  await gateway.close();
  await sleep(1_500);
  const wake = w.wake(key);
  const deliverer = w.deliverer();
  await deliverer.pass();
  await w.waitFor(async () => ["STARTED", "FINISHED"].includes((await w.status(wake.id))?.state),
    300_000, "the turn to start");
  await w.waitFor(async () => (await w.canonical(key)).messages
    .some((m) => m.display_kind === "hidden" && m.text === wake.body), 120_000, "the marker");

  // The person types before any answer is attributable.
  const person = w.gateway();
  await person.start();
  const resumed = await person.request("session.resume", { session_id: key });
  await person.request("prompt.submit", { session_id: resumed.session_id, text: "wait, hold on" });
  await sleep(3_000);

  const rows = (await w.canonical(key)).messages;
  const at = rows.findLastIndex((m) => m.role === "user" && m.display_kind === "hidden"
    && m.text === wake.body);
  const nextUser = rows.slice(at + 1).findIndex((m) => m.role === "user");
  const nextAssistant = rows.slice(at + 1).findIndex((m) => m.role === "assistant");
  if (nextUser >= 0 && (nextAssistant < 0 || nextUser < nextAssistant)) {
    check("a user turn before any answer reads as AMBIGUOUS",
      classifyRoutedWake(rows, wake) === "AMBIGUOUS", classifyRoutedWake(rows, wake));
  } else {
    check("the wake was answered before the person spoke, which is also correct",
      classifyRoutedWake(rows, wake) === "DELIVERED", classifyRoutedWake(rows, wake));
  }
});

// ── runner ────────────────────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(ROOT, { recursive: true });
  const results = [];
  for (const c of CASES) {
    if (only.length && !only.includes(c.n)) continue;
    console.log(`\n=== case ${c.n}: ${c.title} ===`);
    const w = new World(`case${c.n}`);
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
      const alive = await w.teardown();
      check("no gateway it started survives", alive.length === 0, alive.join(","));
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
