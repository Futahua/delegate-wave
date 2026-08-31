// The interaction layer, proved against fakes before it is trusted with anything real.
//
// The claim under test is not "it works" but "the abstraction is not fake": that mode is a
// permission envelope rather than a workflow state, that a manager question genuinely reaches
// Hermes and its answer genuinely resumes the run, and that all of it survives the process dying
// mid-session because the truth was in SQLite rather than in a conversation.
//
// Fake manager, fake workers, disposable repository throughout. No real integration authority is
// touched: the session deliberately stops at SEMANTICALLY_ACCEPTED, because moving real branches
// automatically is the next boundary and deserves its own falsification work.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeDataRoot } from "../src/db.js";
import { FakeBackend } from "../src/backend.js";
import { Dispatcher } from "../src/service.js";
import { FakeManagerBackend } from "../src/manager/backend.js";
import { ManagerService } from "../src/manager/service.js";
import { AutonomousSessionService, modePolicy, SESSION_MODES } from "../src/session/service.js";
import { SafeIntegrator } from "../src/integration/safe.js";
import { SessionDriver } from "../src/session/driver.js";
import { SessionWatcher } from "../src/session/watcher.js";
import { runProcess } from "../src/process.js";
import { buildSessionTimeline, listSessionPresentations } from "../src/presentation/session-timeline.js";
import { HermesMcpAdapter } from "../src/mcp/server.js";
import { ControlClient } from "../src/control/client.js";
import { ControlService } from "../src/control/service.js";
import { createControlServer } from "../src/control/server.js";

const BRIEF = (extra = {}) => ({
  diagnosis: "the export layer is missing a flag",
  instructions: "add the flag",
  acceptance: ["flag exists"],
  relevant_evidence: [],
  uncertainties: [],
  worker_tier: "ordinary",
  ...extra,
});

// A repository and data root that outlive a Dispatcher, so a "process restart" can be simulated by
// closing everything and building it again over the same SQLite file.
async function world(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-sess-"));
  const root = path.join(temp, "data");
  const repo = path.join(temp, "repo");
  fs.mkdirSync(repo);
  await runProcess("git", ["init", "-b", "main", repo]);
  await runProcess("git", ["-C", repo, "config", "user.name", "Test"]);
  await runProcess("git", ["-C", repo, "config", "user.email", "t@example.invalid"]);
  fs.writeFileSync(path.join(repo, "parser.js"), "// do not touch\n");
  await runProcess("git", ["-C", repo, "add", "."]);
  await runProcess("git", ["-C", repo, "commit", "-m", "initial"]);
  initializeDataRoot(root);

  const open = new Set();
  t.after(async () => {
    for (const dispatcher of open) { try { dispatcher.close(); } catch { /* already closed */ } }
    const listed = await runProcess("git", ["-C", repo, "worktree", "list", "--porcelain"]);
    for (const worktree of listed.stdout.split(/\r?\n/)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length))
      .filter((worktree) => path.resolve(worktree) !== path.resolve(repo))) {
      await runProcess("git", ["-C", repo, "worktree", "unlock", worktree]);
      await runProcess("git", ["-C", repo, "worktree", "remove", "--force", worktree]);
    }
    fs.rmSync(temp, { recursive: true, force: true });
  });

  // Rebuilding this is what a process restart means here: same disk, new objects, no memory.
  const boot = (script) => {
    const dispatcher = new Dispatcher({
      root,
      backend: new FakeBackend(async ({ artifactDir, mode, worktreePath }) => {
        fs.mkdirSync(artifactDir, { recursive: true });
        const events = path.join(artifactDir, "opencode-events.jsonl");
        fs.writeFileSync(events, JSON.stringify({
          type: "step_finish",
          part: { reason: "stop", tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.0001 },
        }));
        if (mode !== "read") fs.writeFileSync(path.join(worktreePath, "export.js"), "--json\n");
        return { exitCode: 0, stdout: "ok", stderr: "", stdoutPath: events };
      }),
    });
    open.add(dispatcher);
    const manager = new ManagerService({
      dispatcher,
      backend: new FakeManagerBackend(script),
      workerModel: "opencode-go/deepseek-v4-flash",
    });
    return { dispatcher, manager, sessions: new AutonomousSessionService({ dispatcher, manager }) };
  };

  const first = boot([]);
  const project = await first.dispatcher.addProject({
    name: "Sess", repoPath: repo, validation: [], protectedPaths: ["parser.js"],
  });
  first.dispatcher.close();
  open.delete(first.dispatcher);
  return { boot, projectId: project.id, repo, root };
}

test("real MCP control path binds answer/fail to owner and retries lost fail results safely", async (t) => {
  const { boot, projectId } = await world(t);
  const { dispatcher, sessions } = boot(Array.from({ length: 3 }, () => ({
    action: "ESCALATE", reason: "blocked", question: "Proceed?",
  })));
  const server = createControlServer({ service: new ControlService({ dispatcher, sessions }),
    token: "test-operator", principalId: "operator", proposerToken: "test-hermes" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections(); await closed;
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const client = new ControlClient({ baseUrl, token: "test-hermes" });
  const operator = new ControlClient({ baseUrl, token: "test-operator" });
  const requests = [];
  let loseResponse = false;
  const adapter = new HermesMcpAdapter({ client: {
    get: (...args) => client.get(...args),
    post: async (...args) => {
      requests.push(args);
      const result = await client.post(...args);
      if (loseResponse) { loseResponse = false; throw new Error("MCP result lost"); }
      return result;
    },
  } });
  const a = { "io.delegate-wave/hermes-session-id": "Hermes-A" };
  const b = { "io.delegate-wave/hermes-session-id": "Hermes-B" };
  const started = await adapter.callTool("session_start", { project_id: projectId, intent: "inspect" }, a);
  await sessions.tick(started.session_id);
  const args = { session_id: started.session_id, answer: "clarified", reason: "impossible" };
  const messagesBefore = sessions.messages(started.session_id).length;
  for (const name of ["session_answer", "session_fail"]) {
    await assert.rejects(adapter.callTool(name, args, b), /does not own/);
  }
  assert.equal(sessions.messages(started.session_id).length, messagesBefore);
  assert.equal(sessions.get(started.session_id).state, "WAITING_FOR_HERMES");
  await assert.rejects(client.post(`/v1/sessions/${started.session_id}/fail`,
    { reason: "spoof", scopes: ["operate"] }, "missing-owner"), /does not own/);
  assert.equal((await adapter.callTool("session_answer", args, a)).state, "WORKING");
  await sessions.tick(started.session_id);
  loseResponse = true;
  await assert.rejects(adapter.callTool("session_fail", args, a), /MCP result lost/);
  const firstRequest = requests.at(-1)[2];
  const evidence = () => ["events", "cancellation_intents", "cancellation_results"]
    .map((table) => dispatcher.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n);
  const beforeRetry = evidence();
  const retry = await adapter.callTool("session_fail", { ...args, reason: "retry wording" }, a);
  assert.notEqual(requests.at(-1)[2], firstRequest);
  assert.deepEqual(retry, { session_id: started.session_id, state: "FAILED", outcome: "impossible" });
  assert.deepEqual(evidence(), beforeRetry, "retry adds no domain events or cancellation receipts");
  await assert.rejects(adapter.callTool("session_fail", args, b), /does not own/);
  assert.deepEqual(evidence(), beforeRetry);
  const another = await adapter.callTool("session_start", { project_id: projectId, intent: "inspect again" }, a);
  await sessions.tick(another.session_id);
  assert.equal((await operator.post(`/v1/sessions/${another.session_id}/fail`,
    { reason: "operator stop" }, "operator-stop")).state, "FAILED");
});

test("session_fail preserves terminal child outcomes without historical cancellation receipts", async (t) => {
  const { boot, projectId } = await world(t);
  const { dispatcher, sessions } = boot([{ action: "ESCALATE", reason: "blocked", question: "Proceed?" }]);
  const started = await sessions.start({ projectId, intent: "inspect" });
  await sessions.tick(started.session_id);
  const children = [];
  for (const status of ["SUCCEEDED", "FAILED", "CANCELLED", "PENDING", "NEEDS_ATTENTION"]) {
    const child = await dispatcher.createJob({ projectId, goal: status, mode: "read",
      parentJobId: started.job_id, internalKind: "MANAGER_EXPLORATION" });
    if (status === "SUCCEEDED" || status === "FAILED") {
      dispatcher.backend = new FakeBackend(async () => ({ exitCode: status === "FAILED" ? 1 : 0, stdout: "", stderr: "" }));
      await dispatcher.runJob(child.id);
    }
    dispatcher.db.prepare("UPDATE jobs SET status = ? WHERE id = ?").run(status, child.id);
    children.push({ ...child, expected: ["PENDING", "NEEDS_ATTENTION"].includes(status) ? "CANCELLED" : status, queued: ["PENDING", "NEEDS_ATTENTION"].includes(status) });
  }
  const attempts = dispatcher.db.prepare("SELECT * FROM attempts ORDER BY id").all();
  await sessions.fail(started.session_id, "stop", { principal: "hermes", origin: "test" });
  assert.deepEqual(dispatcher.db.prepare("SELECT * FROM attempts ORDER BY id").all(), attempts);
  for (const child of children) {
    assert.equal(dispatcher.getJob(child.id).status, child.expected);
    assert.equal(dispatcher.db.prepare("SELECT COUNT(*) n FROM cancellation_intents WHERE job_id = ?").get(child.id).n,
      child.queued ? 1 : 0);
  }
});

test("manager bootstrap failure atomically closes session and root with evidence", async (t) => {
  const { boot, projectId } = await world(t);
  const { dispatcher, manager, sessions } = boot([]);
  manager.backend.startRun = async () => { throw new Error("invalid service_tier configuration"); };
  const result = await sessions.start({ projectId, intent: "inspect this repository" });
  assert.equal(result.state, "FAILED");
  assert.match(result.outcome, /MANAGER_BOOTSTRAP_FAILED.*invalid service_tier/);
  assert.equal(dispatcher.getJob(result.job_id).status, "FAILED");
  assert.equal(manager.getRun(result.job_id), null);
  await sessions.tick(result.session_id);
  assert.equal(dispatcher.db.prepare("SELECT COUNT(*) c FROM attempts").get().c, 0);
  assert.equal(dispatcher.db.prepare("SELECT COUNT(*) c FROM events WHERE kind = 'MANAGER_BOOTSTRAP_FAILED'").get().c, 1);
});

test("driver cannot advance a session while start is bootstrapping its manager", async (t) => {
  const { boot, projectId } = await world(t);
  const { manager, sessions } = boot([]);
  const original = manager.backend.startRun.bind(manager.backend);
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const ready = new Promise((resolve) => { entered = resolve; });
  let calls = 0;
  manager.backend.startRun = async () => { calls += 1; entered(); await gate; return original(); };
  const starting = sessions.start({ projectId, intent: "inspect" });
  await ready;
  try {
    const session = sessions.db.prepare("SELECT * FROM autonomous_sessions").get();
    await sessions.tick(session.id);
    assert.equal(calls, 1);
    assert.equal(sessions.db.prepare("SELECT COUNT(*) c FROM manager_turns").get().c, 0);
  } finally { release(); }
  assert.equal((await starting).state, "WORKING");
});

test("session_fail closes queued family and manager; later ticks and answers cannot resume", async (t) => {
  const { boot, projectId } = await world(t);
  const { dispatcher, manager, sessions } = boot([
    { action: "ESCALATE", reason: "prerequisites missing", question: "What now?" },
  ]);
  const started = await sessions.start({ projectId, intent: "inspect" });
  const authority = { principal: "hermes", origin: "mcp" };
  await assert.rejects(sessions.fail(started.session_id, "stop", authority), /WAITING_FOR_HERMES/);
  await sessions.tick(started.session_id);
  const children = [];
  for (const goal of ["A", "B"]) children.push(await dispatcher.createJob({
    projectId, goal, mode: "read", parentJobId: started.job_id, internalKind: "MANAGER_EXPLORATION",
  }));
  const run = manager.getRun(started.job_id);
  dispatcher.commissionWork({ jobId: started.job_id, managerRunId: run.id, action: "IMPLEMENT" });
  await assert.rejects(sessions.fail(started.session_id, " ", authority), /non-empty/);
  await assert.rejects(sessions.fail(started.session_id, "stop"), /identity/);
  const turns = manager.turns(run.id).length;
  assert.equal((await sessions.fail(started.session_id, "prerequisites impossible", authority)).state, "FAILED");
  assert.equal(dispatcher.getJob(started.job_id).status, "FAILED");
  for (const child of children) assert.equal(dispatcher.getJob(child.id).status, "CANCELLED");
  assert.equal(manager.getRun(started.job_id).status, "FAILED");
  assert.equal(dispatcher.openCommission(started.job_id), null);
  for (let tick = 0; tick < 3; tick += 1) await sessions.tick(started.session_id);
  assert.equal(manager.turns(run.id).length, turns);
  assert.equal(dispatcher.db.prepare("SELECT COUNT(*) c FROM attempts").get().c, 0);
  assert.throws(() => sessions.answer(started.session_id, "continue"), /not waiting/);
});

test("session_fail fences a live family attempt and blocks clarification during cancellation", async (t) => {
  const { boot, projectId } = await world(t);
  const { dispatcher, manager, sessions } = boot([
    { action: "ESCALATE", reason: "blocked", question: "Proceed?" },
  ]);
  const started = await sessions.start({ projectId, intent: "inspect" });
  await sessions.tick(started.session_id);
  const child = await dispatcher.createJob({ projectId, goal: "read", mode: "read",
    parentJobId: started.job_id, internalKind: "MANAGER_EXPLORATION" });
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const ready = new Promise((resolve) => { entered = resolve; });
  dispatcher.backend = new FakeBackend(async () => {
    entered(); await gate; return { exitCode: 0, stdout: "late result", stderr: "" };
  });
  const running = dispatcher.runJob(child.id);
  try {
    await ready;
    const failing = sessions.fail(started.session_id, "prerequisites impossible", { principal: "hermes", origin: "test" });
    assert.throws(() => sessions.answer(started.session_id, "resume"), /terminally closed/);
    await failing;
    assert.equal(dispatcher.familyHasLiveAttempt(started.job_id), false);
    assert.equal(dispatcher.getJob(child.id).status, "CANCELLED");
    release();
    await running;
    assert.equal(dispatcher.db.prepare("SELECT terminal_state FROM attempts WHERE job_id = ?").get(child.id).terminal_state, "CANCELLED");
    await sessions.tick(started.session_id);
    assert.equal(manager.turns(manager.getRun(started.job_id).id).length, 1);
    assert.equal(sessions.get(started.session_id).state, "FAILED");
  } finally { release(); await running; }
});

test("nonterminal autonomous sessions block retirement regardless of root job status", async (t) => {
  const { boot, projectId } = await world(t);
  const { dispatcher, sessions } = boot([]);
  const started = await sessions.start({ projectId, intent: "inspect" });
  const args = { projectId, principal: "operator", origin: "test" };
  assert.equal(dispatcher.getJob(started.job_id).status, "PENDING");
  for (const state of ["WORKING", "WAITING_FOR_HERMES", "SEMANTICALLY_ACCEPTED"]) {
    sessions.setState(started.session_id, { state });
    assert.throws(() => dispatcher.retireProject(args), /autonomous session.*nonterminal/);
  }
  sessions.setState(started.session_id, { state: "FAILED" });
  assert.equal(dispatcher.retireProject(args).retired, true);
});

test("registration reserves real repository identity including retired projects", async (t) => {
  const { boot, projectId, repo } = await world(t);
  const { dispatcher } = boot([]);
  const alias = path.join(path.dirname(repo), "repo-alias");
  fs.symlinkSync(repo, alias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(dispatcher.addProject({ name: "alias", repoPath: alias }), /already registered/);
  const args = { projectId, principal: "operator", origin: "test" };
  dispatcher.retireProject(args);
  await assert.rejects(dispatcher.addProject({ name: "clone", repoPath: repo }), /restore that retired project/);
  if (process.platform === "win32") {
    await assert.rejects(dispatcher.addProject({ name: "cased clone", repoPath: repo.toUpperCase() }), /restore that retired project/);
  }
  assert.equal(dispatcher.restoreProject(args).project.id, projectId);
  assert.equal(dispatcher.listProjects().length, 1);
});

test("a mode is a permission envelope, and every mode has one", () => {
  // If a mode ever gains a "which step comes next" field, this is where it will show up.
  // Every field must be a PERMISSION -- something the session may or may not do. The day one is
  // added that means "which step comes next", it will not be in this vocabulary and this fails.
  const permissions = ["mayWrite", "mayProceedUnattended", "mayPublish"];
  for (const mode of SESSION_MODES) {
    const policy = modePolicy(mode);
    for (const key of Object.keys(policy)) {
      assert.ok(permissions.includes(key), `${mode}.${key} is not a permission`);
      assert.equal(typeof policy[key], "boolean", `${mode}.${key} must be a yes/no`);
    }
    for (const key of permissions) assert.equal(typeof policy[key], "boolean", `${mode} lacks ${key}`);
  }
  assert.equal(modePolicy("PLAN").mayWrite, false);
  assert.equal(modePolicy("PLAN").mayPublish, false);
  // MANUAL has the same intelligence and delegation as AUTO; it simply does not land the result.
  assert.equal(modePolicy("MANUAL").mayWrite, true);
  assert.equal(modePolicy("MANUAL").mayPublish, false);
  assert.equal(modePolicy("AUTO").mayPublish, true);
  assert.equal(modePolicy("BYPASS").mayWrite, true);
  assert.throws(() => modePolicy("NONSENSE"), /Unknown autonomy mode/);
});

test("session_start returns immediately and does not wait for a worker", async (t) => {
  const { boot, projectId } = await world(t);
  const { sessions } = boot([]);

  const started = await sessions.start({ projectId, intent: "Add a --json flag", mode: "AUTO" });
  assert.match(started.session_id, /^asess_/);
  assert.equal(started.state, "WORKING");
  assert.equal(started.mode, "AUTO");
  // Nothing has run: no attempt exists yet, so no MCP call could have blocked on one.
  const attempts = sessions.db.prepare("SELECT COUNT(*) c FROM attempts WHERE job_id = ?")
    .get(started.job_id).c;
  assert.equal(attempts, 0);
});

test("PLAN cannot create a write attempt", async (t) => {
  // Enforced by commissioning a READ job, so the refusal is mechanical rather than a promise the
  // session layer makes and a later caller forgets.
  const { boot, projectId } = await world(t);
  const { dispatcher, sessions } = boot([
    { action: "IMPLEMENT", reason: "just build it", brief: BRIEF() },
  ]);

  const started = await sessions.start({ projectId, intent: "Investigate the bug", mode: "PLAN" });
  assert.equal(dispatcher.getJob(started.job_id).mode, "read");

  await sessions.tick(started.session_id);
  // What PLAN guarantees is that nothing was written -- not which way the run ended. Asserting a
  // particular end state here would pin an implementation detail; asserting the absence of a write
  // pins the property.
  const attempts = dispatcher.db.prepare("SELECT * FROM attempts WHERE job_id = ?").all(started.job_id);
  for (const attempt of attempts) assert.notEqual(attempt.mode, "write");
  // And the repository is untouched.
  assert.equal(fs.readFileSync(path.join(sessions.dispatcher.getProject(projectId).repo_path, "parser.js"), "utf8"),
    "// do not touch\n");
});

test("AUTO runs to a semantic result with no human ceremony", async (t) => {
  const { boot, projectId } = await world(t);
  const { sessions } = boot([
    { action: "IMPLEMENT", reason: "known", brief: BRIEF() },
    { action: "ACCEPT", reason: "the flag is there and validation is green" },
  ]);

  const started = await sessions.start({ projectId, intent: "Add a --json flag", mode: "AUTO" });
  const finished = await sessions.tick(started.session_id);

  assert.equal(finished.state, "semantically_accepted");
  assert.ok(finished.result.candidate_commit, "there is a candidate to integrate later");
  assert.equal(finished.result.validation, "PASSED");
  // No approval was granted, no proposal was created, and nothing was integrated.
  assert.equal(sessions.db.prepare("SELECT COUNT(*) c FROM integration_proposals").get().c, 0);
  assert.equal(sessions.messages(started.session_id).length, 0, "nothing needed asking");
});

test("a manager question reaches Hermes, and the answer durably resumes the run", async (t) => {
  // The exchange the whole layer exists for. The manager finds the obvious route blocked by a
  // constraint only the user's conversation contains, asks, and continues from the answer.
  const { boot, projectId } = await world(t);
  const { sessions } = boot([
    {
      action: "ESCALATE",
      reason: "The obvious fix requires changing parser.js, which the objective appears to forbid.",
      question: "The obvious route touches parser.js. Alternative Z through the export layer appears viable. Continue with Z?",
    },
    { action: "IMPLEMENT", reason: "taking the export-layer route", brief: BRIEF() },
    { action: "ACCEPT", reason: "done without touching the parser" },
  ]);

  const started = await sessions.start({
    projectId, intent: "Fix the export bug, but do not modify parser.js", mode: "AUTO",
  });
  const asked = await sessions.tick(started.session_id);

  assert.equal(asked.state, "waiting_for_hermes");
  assert.match(asked.question, /parser\.js/);
  assert.ok(asked.why_it_matters, "a question carries its own stakes");

  // Hermes answers from the original conversation, which delegate-wave never saw.
  sessions.answer(started.session_id, "Do not touch parser.js. Use the export-layer route Z.");
  assert.equal(sessions.poll(started.session_id).state, "working");

  const finished = await sessions.tick(started.session_id);
  assert.equal(finished.state, "semantically_accepted");

  // The answer is durable evidence, and it reached the manager as such.
  const clarifications = sessions.clarifications(started.session_id);
  assert.equal(clarifications.length, 1);
  assert.match(clarifications[0].answer, /export-layer route Z/);
  assert.match(clarifications[0].question, /parser\.js/);
});

test("an unanswered question cannot be answered twice, and a working session cannot be answered", async (t) => {
  const { boot, projectId } = await world(t);
  const { sessions } = boot([
    { action: "ESCALATE", reason: "needs judgment", question: "Which route?" },
    { action: "IMPLEMENT", reason: "go", brief: BRIEF() },
    { action: "ACCEPT", reason: "done" },
  ]);
  const started = await sessions.start({ projectId, intent: "Fix it", mode: "AUTO" });
  await sessions.tick(started.session_id);

  // An empty answer is not an answer -- checked while the session is genuinely waiting, since the
  // state guard below would otherwise mask it.
  assert.throws(() => sessions.answer(started.session_id, "   "), /non-empty/);

  sessions.answer(started.session_id, "Route Z");
  // And once answered, the question is closed: a second answer has nothing to attach to.
  assert.throws(() => sessions.answer(started.session_id, "Route Z again"), /not waiting for an answer/);
});

test("a session started from a conversation is watched from birth, and its question reaches it", async (t) => {
  // The wake layer's one dependency on this one: delegate-wave never sees the conversation a request
  // came from, so the id has to arrive with the request or the result has nowhere to go. Registered
  // inside the same transaction as the session, because a session that finished between the two
  // writes would be a finished session nobody was watching.
  const { boot, projectId } = await world(t);
  const { dispatcher, sessions } = boot([
    { action: "ESCALATE", reason: "needs judgment", question: "Which export format did they mean?" },
    { action: "IMPLEMENT", reason: "go", brief: BRIEF() },
    { action: "ACCEPT", reason: "done" },
  ]);
  const watcher = new SessionWatcher({ sessions, intervalMs: 5 });
  t.after(() => watcher.stop());

  const started = await sessions.start({
    projectId, intent: "Add a --json flag", mode: "AUTO", hermesSessionId: "20260824_233004_5d8271",
  });
  assert.equal(started.watched, true);
  const watch = sessions.db.prepare("SELECT * FROM session_watches WHERE session_id = ?").get(started.session_id);
  assert.equal(watch.hermes_session_id, "20260824_233004_5d8271");
  const indexed = listSessionPresentations(sessions.db).sessions.find((item) => item.id === started.session_id);
  assert.equal(indexed.origin_hermes_session_id, "20260824_233004_5d8271");
  assert.equal(indexed.intent, "Add a --json flag");
  // Nothing to say yet: the session is working, which is the ordinary case and costs nothing.
  assert.deepEqual(watcher.pass(), []);

  await sessions.tick(started.session_id);
  const timeline = buildSessionTimeline({ db: sessions.db, paths: dispatcher.paths, sessionId: started.session_id });
  assert.equal(timeline.session.id, started.session_id);
  assert.equal(timeline.spans.some((span) => span.actor === "manager"), true);
  assert.equal(sessions.get(started.session_id).state, "WAITING_FOR_HERMES");
  const enqueued = watcher.pass();
  assert.equal(enqueued.length, 1);
  const wake = sessions.db.prepare("SELECT * FROM wake_outbox WHERE id = ?").get(enqueued[0]);
  assert.equal(wake.reason, "QUESTION");
  assert.equal(wake.hermes_session_id, "20260824_233004_5d8271");
  // The words that arrive carry the question and the way back to it, not a session dump.
  assert.ok(wake.body.includes("Which export format did they mean?"));
  assert.ok(wake.body.includes(started.session_id));

  // Answered, the session goes back to work and nothing further is announced about the same thing.
  sessions.answer(started.session_id, "JSON lines");
  assert.deepEqual(watcher.pass(), []);
});

test("simultaneous session starts persist the correct per-conversation watches", async (t) => {
  const { boot, projectId } = await world(t);
  const { sessions } = boot([]);

  const [first, second] = await Promise.all([
    sessions.start({ projectId, intent: "first intent", hermesSessionId: "session_S1" }),
    sessions.start({ projectId, intent: "second intent", hermesSessionId: "session_S2" }),
  ]);

  const watches = sessions.db.prepare(
    `SELECT s.intent, w.hermes_session_id
       FROM autonomous_sessions s
       JOIN session_watches w ON w.session_id = s.id
      WHERE s.id IN (?, ?)`,
  ).all(first.session_id, second.session_id);
  assert.deepEqual(
    Object.fromEntries(watches.map((row) => [row.intent, row.hermes_session_id])),
    { "first intent": "session_S1", "second intent": "session_S2" },
  );
});

test("a session started without a conversation still runs, and nobody is waiting on it", async (t) => {
  // The honest degraded case, stated as a test so it cannot quietly become an exception thrown at a
  // CLI user who has no Hermes session to give.
  const { boot, projectId } = await world(t);
  const { sessions } = boot([{ action: "ESCALATE", reason: "judgment", question: "Which route?" }]);
  const started = await sessions.start({ projectId, intent: "Fix it", mode: "AUTO" });
  assert.equal(started.watched, false);
  await sessions.tick(started.session_id);
  assert.equal(sessions.get(started.session_id).state, "WAITING_FOR_HERMES");
  const watcher = new SessionWatcher({ sessions, intervalMs: 5 });
  t.after(() => watcher.stop());
  assert.deepEqual(watcher.pass(), []);
  assert.equal(sessions.db.prepare("SELECT COUNT(*) AS n FROM wake_outbox").get().n, 0);
});

test("an invalid explicit watch identity is rejected before creating a job", async (t) => {
  const { boot, projectId } = await world(t);
  const { dispatcher, sessions } = boot([]);
  const before = dispatcher.listJobs().length;

  await assert.rejects(
    sessions.start({ projectId, intent: "Fix it", hermesSessionId: "   " }),
    /must be null or a non-empty string/,
  );

  assert.equal(dispatcher.listJobs().length, before);
  assert.equal(sessions.db.prepare("SELECT COUNT(*) AS n FROM autonomous_sessions").get().n, 0);
  assert.equal(sessions.db.prepare("SELECT COUNT(*) AS n FROM session_watches").get().n, 0);
});

test("the session survives the process dying mid-run", async (t) => {
  // The property that makes polling honest rather than a workaround. Everything in memory is
  // discarded between the question and the answer: the Dispatcher, the ManagerService, the session
  // service, and the manager's own conversation thread.
  const { boot, projectId } = await world(t);
  const script = [
    { action: "ESCALATE", reason: "needs judgment", question: "Touch parser.js, or route through export?" },
    { action: "IMPLEMENT", reason: "export route", brief: BRIEF() },
    { action: "ACCEPT", reason: "done" },
  ];

  const before = boot(script);
  const started = await before.sessions.start({
    projectId, intent: "Fix the export bug, do not modify parser.js", mode: "AUTO",
  });
  const asked = await before.sessions.tick(started.session_id);
  assert.equal(asked.state, "waiting_for_hermes");

  // The process dies here, holding an unanswered question.
  before.dispatcher.close();

  const after = boot(script.slice(1));
  const resumed = after.sessions.poll(started.session_id);
  assert.equal(resumed.state, "waiting_for_hermes", "the question survived");
  assert.match(resumed.question, /parser\.js/);
  assert.equal(resumed.mode, "AUTO", "the permission envelope survived");
  assert.equal(resumed.intent, "Fix the export bug, do not modify parser.js", "the intent survived");

  after.sessions.answer(started.session_id, "Route through export. Leave parser.js alone.");
  const finished = await after.sessions.tick(started.session_id);
  assert.equal(finished.state, "semantically_accepted");

  // And the answer given to the dead process's question is what the new one reasoned from.
  const clarifications = after.sessions.clarifications(started.session_id);
  assert.equal(clarifications.length, 1);
  assert.match(clarifications[0].answer, /Leave parser\.js alone/);
});

test("poll returns a semantic state, not the ledger", async (t) => {
  const { boot, projectId } = await world(t);
  const { sessions } = boot([
    { action: "IMPLEMENT", reason: "known", brief: BRIEF() },
    { action: "ACCEPT", reason: "done" },
  ]);
  const started = await sessions.start({ projectId, intent: "Add a flag", mode: "AUTO" });
  const finished = await sessions.tick(started.session_id);

  // Hermes should never have to read manager turns, receipts or proposals to know what happened.
  assert.deepEqual(Object.keys(finished).sort(),
    ["integration", "intent", "mode", "result", "session_id", "state"]);
  for (const key of ["turns", "receipts", "attempts", "manager_run", "proposal"]) {
    assert.equal(finished[key], undefined, `poll must not leak ${key}`);
  }
});

test("BYPASS suppresses questions, never invariants", async (t) => {
  // The dangerous word. It must be true in the code, not just in the documentation, that no mode
  // can reach the mechanical protections.
  const { boot, projectId } = await world(t);
  const { dispatcher, sessions } = boot([
    { action: "IMPLEMENT", reason: "known", brief: BRIEF() },
    { action: "ACCEPT", reason: "done" },
  ]);

  const started = await sessions.start({ projectId, intent: "Change everything", mode: "BYPASS" });
  await sessions.tick(started.session_id);

  const project = dispatcher.getProject(projectId);
  // Protected paths are still protected, and the protection lives on the project, not the session.
  assert.deepEqual(JSON.parse(project.protected_json || "[]"), ["parser.js"]);
  // The session carries no field that could switch a protection off.
  const session = sessions.get(started.session_id);
  for (const key of Object.keys(session)) {
    assert.ok(!/protect|validate|cas|credential|isolation|sandbox/i.test(key),
      `a session must not carry ${key}: a mode is permission, not mechanism`);
  }
  // And validation still ran against the candidate.
  const attempt = dispatcher.db.prepare(
    "SELECT * FROM attempts WHERE job_id = ? ORDER BY ordinal DESC LIMIT 1",
  ).get(started.job_id);
  assert.ok(["PASSED", "FAILED"].includes(attempt.validation_state), "validation was not skipped");
});

test("a cost ceiling still binds a session", async (t) => {
  const { boot, projectId } = await world(t);
  const { dispatcher, sessions } = boot([]);
  const started = await sessions.start({
    projectId, intent: "Add a flag", mode: "AUTO", maximumCost: 0.25,
  });
  assert.equal(dispatcher.getJob(started.job_id).maximum_cost, 0.25);
  await assert.rejects(
    sessions.start({ projectId, intent: "bad", mode: "AUTO", maximumCost: 0 }),
    /maximum_cost|CHECK|greater/i,
  );
});

test("tick is safe to call from any state, which is what makes resume free", async (t) => {
  const { boot, projectId } = await world(t);
  const { sessions } = boot([
    { action: "IMPLEMENT", reason: "known", brief: BRIEF() },
    { action: "ACCEPT", reason: "done" },
  ]);
  const started = await sessions.start({ projectId, intent: "Add a flag", mode: "AUTO" });
  const finished = await sessions.tick(started.session_id);
  assert.equal(finished.state, "semantically_accepted");

  // Calling again must not re-run anything or spend another scarce turn.
  const again = await sessions.tick(started.session_id);
  assert.deepEqual(again, finished);
});

// --- C2 / C4: what a mode permits, and where a conflict goes -------------------------------------

// A session wired to a real integrator, on a repository whose target branch is publishable.
async function integrating(t, script, mode = "AUTO") {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-c2-"));
  const root = path.join(temp, "data");
  const repo = path.join(temp, "repo");
  fs.mkdirSync(repo);
  await runProcess("git", ["init", "-b", "main", repo]);
  await runProcess("git", ["-C", repo, "config", "user.name", "T"]);
  await runProcess("git", ["-C", repo, "config", "user.email", "t@e.invalid"]);
  fs.writeFileSync(path.join(repo, "parser.js"), "// do not touch\n");
  await runProcess("git", ["-C", repo, "add", "."]);
  await runProcess("git", ["-C", repo, "commit", "-m", "initial"]);
  await runProcess("git", ["-C", repo, "checkout", "--detach", "HEAD"]);
  initializeDataRoot(root);

  const dispatcher = new Dispatcher({
    root,
    backend: new FakeBackend(async ({ artifactDir, mode: jobMode, worktreePath }) => {
      fs.mkdirSync(artifactDir, { recursive: true });
      const events = path.join(artifactDir, "opencode-events.jsonl");
      fs.writeFileSync(events, JSON.stringify({
        type: "step_finish",
        part: { reason: "stop", tokens: { input: 5, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.0001 },
      }));
      if (jobMode !== "read") fs.writeFileSync(path.join(worktreePath, "export.js"), "--json\n");
      return { exitCode: 0, stdout: "ok", stderr: "", stdoutPath: events };
    }),
  });
  t.after(async () => {
    try { dispatcher.close(); } catch { /* closed */ }
    const listed = await runProcess("git", ["-C", repo, "worktree", "list", "--porcelain"]);
    for (const worktree of listed.stdout.split(/\r?\n/)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length))
      .filter((worktree) => path.resolve(worktree) !== path.resolve(repo))) {
      await runProcess("git", ["-C", repo, "worktree", "unlock", worktree]);
      await runProcess("git", ["-C", repo, "worktree", "remove", "--force", worktree]);
    }
    fs.rmSync(temp, { recursive: true, force: true });
  });

  const manager = new ManagerService({
    dispatcher, backend: new FakeManagerBackend(script),
    workerModel: "opencode-go/deepseek-v4-flash",
  });
  const sessions = new AutonomousSessionService({
    dispatcher, manager, integrator: new SafeIntegrator({ dispatcher }),
  });
  const project = await dispatcher.addProject({
    name: "C2", repoPath: repo, branch: "main", validation: [], protectedPaths: ["parser.js"],
  });
  const started = await sessions.start({ projectId: project.id, intent: "Add a --json flag", mode });
  return {
    dispatcher, sessions, started, repo,
    head: async () => (await runProcess("git", ["-C", repo, "rev-parse", "main"])).stdout.trim(),
    land: async (file, content) => {
      // Exit codes checked: a silently failed setup step would make a conflict test pass by never
      // creating the conflict it claims to test.
      const run = async (...args) => {
        const result = await runProcess("git", args);
        if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
        return result.stdout.trim();
      };
      const wt = path.join(temp, `other-${Math.floor(Math.random() * 1e6)}`);
      await run("-C", repo, "worktree", "add", "--detach", wt, "main");
      fs.writeFileSync(path.join(wt, file), content);
      await run("-C", wt, "add", ".");
      await run("-C", wt, "-c", "user.name=O", "-c", "user.email=o@e.invalid", "commit", "-m", "concurrent");
      const sha = await run("-C", wt, "rev-parse", "HEAD");
      await run("-C", repo, "update-ref", "refs/heads/main", sha);
      await runProcess("git", ["-C", repo, "worktree", "remove", "--force", wt]);
      return sha;
    },
  };
}

const ACCEPTING = [
  { action: "IMPLEMENT", reason: "known", brief: BRIEF() },
  { action: "ACCEPT", reason: "done" },
];

test("AUTO publishes the accepted result; the branch becomes the validated tree", async (t) => {
  const w = await integrating(t, ACCEPTING, "AUTO");
  const before = await w.head();
  const finished = await w.sessions.tick(w.started.session_id);

  assert.equal(finished.state, "completed");
  assert.ok(finished.integration, "the session reports what landed");
  assert.equal(finished.integration.from, before);
  assert.equal(await w.head(), finished.integration.to);

  // The ledger independently agrees that the published tree is the validated one.
  const staged = w.dispatcher.db.prepare(
    "SELECT * FROM staged_integrations WHERE session_id = ?",
  ).get(w.started.session_id);
  assert.equal(staged.publish_state, "PUBLISHED");
  assert.equal(staged.validation_state, "PASSED");
  assert.equal(finished.integration.validated_tree, staged.prepared_tree);
});

test("MANUAL does the same work and stops with the candidate ready", async (t) => {
  // Same intelligence, same delegation, same review. The mode governs only whether it lands.
  const w = await integrating(t, ACCEPTING, "MANUAL");
  const before = await w.head();
  const finished = await w.sessions.tick(w.started.session_id);

  assert.equal(finished.state, "semantically_accepted");
  assert.ok(finished.result.candidate_commit, "the work was done in full");
  assert.equal(finished.integration, null);
  assert.equal(await w.head(), before, "nothing landed");
  assert.equal(w.dispatcher.db.prepare("SELECT COUNT(*) c FROM staged_integrations").get().c, 0,
    "MANUAL did not even prepare a publication");
});

test("PLAN never publishes, even if the manager somehow accepts", async (t) => {
  const w = await integrating(t, ACCEPTING, "PLAN");
  const before = await w.head();
  await w.sessions.tick(w.started.session_id);
  assert.equal(await w.head(), before);
  assert.equal(w.dispatcher.db.prepare("SELECT COUNT(*) c FROM staged_integrations").get().c, 0);
});

// Drift that happens WHILE the work is happening -- which is the only moment it matters.
//
// Landing the concurrent commit before the session starts would trip the authorized-base guard
// instead, refusing to buy work against a base nobody approved. That guard is correct and is not
// what these tests are about, so the commit lands during preparation: after a candidate exists and
// was accepted, exactly as it would if someone pushed while a worker was building.
function driftingIntegrator(w, file, content) {
  return new (class extends SafeIntegrator {
    async prepare(options) {
      if (!this.drifted) { this.drifted = true; await w.land(file, content); }
      return super.prepare(options);
    }
  })({ dispatcher: w.dispatcher });
}

test("a merge conflict goes to the manager, not to Hermes", async (t) => {
  // A conflict is a fact about the repository, like a failing test. The machinery that reasons about
  // repository facts is the manager -- which already holds the intent, the settled clarifications
  // and the accepted candidate. Interrupting a person for it would be interrupting them for
  // something they cannot usefully answer.
  const w = await integrating(t, [
    { action: "IMPLEMENT", reason: "known", brief: BRIEF() },
    { action: "ACCEPT", reason: "done" },
    // Handed the conflict, the manager re-plans rather than the session asking anyone.
    { action: "IMPLEMENT", reason: "rebuilding against the branch as it now stands", brief: BRIEF({ diagnosis: "reconcile" }) },
    { action: "ACCEPT", reason: "applies to the new head and still does what was asked" },
  ], "AUTO");
  w.sessions.integrator = driftingIntegrator(w, "export.js", "SOMETHING ELSE ENTIRELY\n");

  const finished = await w.sessions.tick(w.started.session_id);

  // Whatever the outcome, nobody was asked about a merge conflict as such.
  for (const question of w.sessions.messages(w.started.session_id)
    .filter((message) => message.direction === "TO_HERMES")) {
    assert.doesNotMatch(question.body, /merge conflict|cherry-pick|could not apply/i,
      "a mechanical conflict is not a question for a person");
  }
  const handed = w.dispatcher.db.prepare(
    "SELECT * FROM events WHERE kind = 'INTEGRATION_CONFLICT_TO_MANAGER'",
  ).all();
  assert.ok(handed.length >= 1, "the conflict went to the manager");
  assert.ok(handed.length <= 2, "and handing it back is bounded rather than churning");
  // Handed the conflict, the manager rebuilt against the branch as it now stands and the result
  // landed -- without anyone being asked anything. That is the whole point of routing a mechanical
  // conflict to the machinery that reasons about repositories.
  assert.equal(finished.state, "completed");
  assert.ok(finished.integration, "it recovered and published");
  const rebased = w.dispatcher.db.prepare(
    "SELECT * FROM events WHERE kind = 'MANAGER_REBASED_AUTHORIZED_WORLD'",
  ).all();
  assert.equal(rebased.length, 1, "the job was re-authorised against the world that now exists");
});

test("a semantic dead end reaches Hermes as a choice, not as a merge conflict", async (t) => {
  const w = await integrating(t, [
    { action: "IMPLEMENT", reason: "known", brief: BRIEF() },
    { action: "ACCEPT", reason: "done" },
    // Handed the conflict, the manager concludes the two behaviours cannot both be preserved.
    {
      action: "ESCALATE",
      reason: "The branch now formats exports differently; preserving both is impossible.",
      question: "The target branch changed the same export behaviour while this task ran. Keep the "
        + "branch's new behaviour, or the behaviour you asked for?",
    },
  ], "AUTO");
  w.sessions.integrator = driftingIntegrator(w, "export.js", "INCOMPATIBLE\n");

  const finished = await w.sessions.tick(w.started.session_id);

  assert.equal(finished.state, "waiting_for_hermes");
  assert.match(finished.question, /Keep the branch's new behaviour, or the behaviour you asked for/);
  assert.doesNotMatch(finished.question, /merge conflict|cherry-pick/i);
  assert.match(finished.why_it_matters, /decision about what the change should mean/);
  assert.equal(w.dispatcher.db.prepare(
    "SELECT COUNT(*) c FROM staged_integrations WHERE publish_state = 'PUBLISHED'",
  ).get().c, 0, "the branch is untouched while the question is open");
});

// --- The autonomous runtime: nobody has to call a fourth operation ------------------------------

test("the driver moves a WORKING session to completion with no further calls", async (t) => {
  // Without this, session_start creates a session and nothing ever advances it: Hermes would poll
  // WORKING forever. The durable runtime owns progression.
  const w = await integrating(t, ACCEPTING, "AUTO");
  const driver = new SessionDriver({ sessions: w.sessions, intervalMs: 5 });
  t.after(() => driver.stop());

  assert.equal(w.sessions.poll(w.started.session_id).state, "working");
  await driver.drain();

  const finished = w.sessions.poll(w.started.session_id);
  assert.equal(finished.state, "completed");
  assert.ok(finished.integration, "and it published, unattended");
});

test("a session accepted but not yet published is resumed after a crash", async (t) => {
  // The window: AUTO records the acceptance durably, then publishes. A crash in between leaves work
  // that is finished except for its cheapest step, and treating the state alone as terminal would
  // strand it forever.
  const w = await integrating(t, ACCEPTING, "AUTO");
  const before = await w.head();

  // Reach acceptance without publishing, exactly as a crash there would leave it.
  const stalled = new AutonomousSessionService({
    dispatcher: w.dispatcher, manager: w.sessions.manager, integrator: null,
  });
  await stalled.tick(w.started.session_id);
  assert.equal(stalled.poll(w.started.session_id).state, "semantically_accepted");
  assert.equal(await w.head(), before, "nothing was published before the crash");

  // Restart: a new driver over the same database finds it and finishes the job.
  const driver = new SessionDriver({ sessions: w.sessions, intervalMs: 5 });
  t.after(() => driver.stop());
  await driver.drain();

  const finished = w.sessions.poll(w.started.session_id);
  assert.equal(finished.state, "completed");
  assert.equal(await w.head(), finished.integration.to);
});

test("a MANUAL session accepted before a crash stays put", async (t) => {
  // The same state, the opposite meaning, decided by the same permission question. MANUAL is
  // genuinely finished at acceptance and a restart must not turn its result into a publication.
  const w = await integrating(t, ACCEPTING, "MANUAL");
  const before = await w.head();
  await w.sessions.tick(w.started.session_id);
  assert.equal(w.sessions.poll(w.started.session_id).state, "semantically_accepted");

  const driver = new SessionDriver({ sessions: w.sessions, intervalMs: 5 });
  t.after(() => driver.stop());
  await driver.drain({ maxPasses: 10 });

  assert.equal(w.sessions.poll(w.started.session_id).state, "semantically_accepted");
  assert.equal(await w.head(), before, "a restart is not a licence to publish");
  assert.equal(w.dispatcher.db.prepare("SELECT COUNT(*) c FROM staged_integrations").get().c, 0);
});

test("an answered session continues without Hermes calling anything else", async (t) => {
  // answer() reopens the manager but does not advance it. If the driver did not exist, a session
  // would sit in WORKING immediately after being answered -- unblocked and going nowhere.
  const w = await integrating(t, [
    { action: "ESCALATE", reason: "needs judgment", question: "Which route?" },
    { action: "IMPLEMENT", reason: "the route Hermes chose", brief: BRIEF() },
    { action: "ACCEPT", reason: "done" },
  ], "AUTO");
  const driver = new SessionDriver({ sessions: w.sessions, intervalMs: 5 });
  t.after(() => driver.stop());

  await driver.drain({ maxPasses: 20 });
  assert.equal(w.sessions.poll(w.started.session_id).state, "waiting_for_hermes");

  // Hermes answers, and then does nothing further.
  w.sessions.answer(w.started.session_id, "Take the export-layer route.");
  await driver.drain();

  const finished = w.sessions.poll(w.started.session_id);
  assert.equal(finished.state, "completed");
  assert.ok(finished.integration);
});

test("a long session does not starve the others", async (t) => {
  // A pass that awaited its work would serialise every session behind the slowest one. Each is
  // claimed and driven independently instead, bounded by concurrency rather than by order.
  const w = await integrating(t, ACCEPTING, "AUTO");
  const order = [];
  const slowSessions = new AutonomousSessionService({
    dispatcher: w.dispatcher, manager: w.sessions.manager, integrator: w.sessions.integrator,
  });
  slowSessions.tick = async (sessionId) => {
    const slow = sessionId === w.started.session_id;
    await new Promise((resolve) => { setTimeout(resolve, slow ? 200 : 5); });
    order.push(slow ? "slow" : "fast");
    return AutonomousSessionService.prototype.tick.call(slowSessions, sessionId);
  };

  const second = await slowSessions.start({
    projectId: w.dispatcher.getProject(w.started.job_id ? w.sessions.get(w.started.session_id).project_id : null).id,
    intent: "something quick", mode: "MANUAL",
  });
  const driver = new SessionDriver({ sessions: slowSessions, intervalMs: 5, concurrency: 4 });
  t.after(() => driver.stop());

  driver.pass();
  await new Promise((resolve) => { setTimeout(resolve, 120); });
  assert.ok(order.includes("fast"),
    "the quick session ran while the slow one was still working");
  assert.ok(second.session_id);
});

test("no session starves behind sessions that cannot progress", async (t) => {
  // The failure this reproduces: with more pending sessions than concurrency, ordering by
  // updated_at claimed the same oldest few on every pass. Sessions that return immediately free
  // their slots instantly and are re-claimed two seconds later, forever, so anything behind them is
  // never reached. A freshly started session sat untouched behind four such sessions for minutes
  // and looked exactly like a driver that had never started.
  const w = await integrating(t, ACCEPTING, "MANUAL");
  const driven = [];
  const sessions = {
    db: w.dispatcher.db,
    tick: async (id) => { driven.push(id); },
  };
  const driver = new SessionDriver({ sessions, intervalMs: 5, concurrency: 2 });
  t.after(() => driver.stop());

  // Five pending sessions, room for two at a time.
  const ids = [w.started.session_id];
  for (let index = 0; index < 4; index += 1) {
    const extra = await w.sessions.start({
      projectId: w.sessions.get(w.started.session_id).project_id,
      intent: `filler ${index}`, mode: "MANUAL",
    });
    ids.push(extra.session_id);
  }

  // Enough passes that a fair scheduler must have reached everyone.
  for (let pass = 0; pass < 12; pass += 1) {
    driver.pass();
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }

  const reached = new Set(driven);
  for (const id of ids) {
    assert.ok(reached.has(id), `${id} never reached a slot: it starved behind the others`);
  }
});
