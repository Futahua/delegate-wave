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
import { runProcess } from "../src/process.js";

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

test("a mode is a permission envelope, and every mode has one", () => {
  // If a mode ever gains a "which step comes next" field, this is where it will show up.
  for (const mode of SESSION_MODES) {
    const policy = modePolicy(mode);
    assert.equal(typeof policy.mayWrite, "boolean");
    assert.equal(typeof policy.mayProceedUnattended, "boolean");
    assert.deepEqual(Object.keys(policy).sort(), ["mayProceedUnattended", "mayWrite"]);
  }
  assert.equal(modePolicy("PLAN").mayWrite, false);
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
    ["intent", "mode", "result", "session_id", "state"]);
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
