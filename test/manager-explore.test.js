// The information-gathering half of the manager: the mechanism the source result attributes most of
// its gain to, and the reason arm M is not just "a strong planner around one worker".
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
import { AutonomousSessionService } from "../src/session/service.js";
import { SessionDriver } from "../src/session/driver.js";
import { runProcess } from "../src/process.js";

async function command(name, args, cwd) {
  const result = await runProcess(name, args, { cwd });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

const BRIEF = (extra = {}) => ({
  diagnosis: "the totals file is missing",
  instructions: "create out.txt containing the totals",
  acceptance: ["out.txt exists"],
  relevant_evidence: [],
  uncertainties: [],
  worker_tier: "ordinary",
  ...extra,
});

// A worker that answers read jobs with a report and write jobs with a file. It writes the report
// through the Harness-shaped session log, so the report reaches the manager the same way a real
// worker's would -- read back off disk from the attempt's own artifact.
function worker(received, { readModifiesTree = false, writeReport = "ok" } = {}) {
  return new FakeBackend(async ({ worktreePath, artifactDir, instruction, mode }) => {
    received.push({ instruction, mode });
    if (mode === "read") {
      if (readModifiesTree) fs.writeFileSync(path.join(worktreePath, "sneaky.txt"), "edited\n");
      const sessions = path.join(artifactDir, "sessions", "ws", "s1");
      fs.mkdirSync(sessions, { recursive: true });
      fs.writeFileSync(path.join(sessions, "session.jsonl"), `${JSON.stringify({
        type: "assistant/message",
        data: { text: `findings for: ${instruction.split("\n").find((l) => l.startsWith("Question:")) ?? "?"}` },
      })}\n`);
      return { exitCode: 0, stdout: "ok", stderr: "" };
    }
    fs.writeFileSync(path.join(worktreePath, "out.txt"), `${received.length}\n`);
    if (writeReport !== "ok") {
      const sessions = path.join(artifactDir, "sessions", "ws", "s1");
      fs.mkdirSync(sessions, { recursive: true });
      fs.writeFileSync(path.join(sessions, "session.jsonl"), `${JSON.stringify({
        type: "assistant/message", data: { text: writeReport },
      })}\n`);
    }
    return { exitCode: 0, stdout: writeReport, stderr: "" };
  });
}

async function fixture(t, script, options = {}) {
  const { goal = "add a totals file", ...workerOptions } = options;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-explore-"));
  const root = path.join(temp, "data");
  const repo = path.join(temp, "repo");
  fs.mkdirSync(repo);
  await command("git", ["init", "-b", "main"], repo);
  await command("git", ["config", "user.name", "Test"], repo);
  await command("git", ["config", "user.email", "test@example.invalid"], repo);
  fs.writeFileSync(path.join(repo, "input.txt"), "before\n");
  await command("git", ["add", "."], repo);
  await command("git", ["commit", "-m", "initial"], repo);
  initializeDataRoot(root);

  const received = [];
  const dispatcher = new Dispatcher({ root, backend: worker(received, workerOptions) });
  const manager = new FakeManagerBackend(script);
  const service = new ManagerService({
    dispatcher, backend: manager, workerModel: "opencode-go/deepseek-v4-flash",
  });
  t.after(async () => {
    dispatcher.close();
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

  const project = await dispatcher.addProject({ name: "Explore", repoPath: repo, validation: [] });
  const job = await dispatcher.createJob({
    projectId: project.id, goal, strategy: "managed", maxAttempts: 3,
  });
  return { dispatcher, service, manager, project, job, repo, received };
}

test("authoritative review facts outrank a worker that denies the real workflow and candidate", async (t) => {
  let reviewPrompt = null;
  const { dispatcher, service, manager, job } = await fixture(t, async ({ phase, prompt }) => {
    if (phase === "PLAN") {
      return { action: "EXPLORE", reason: "two perspectives are required", explorations: [
        { question: "inspect inputs", deliver: ["files"] },
        { question: "inspect tests", deliver: ["coverage"] },
      ] };
    }
    if (phase === "SYNTHESIS") {
      return { action: "IMPLEMENT", reason: "the evidence agrees", brief: BRIEF() };
    }
    reviewPrompt = prompt;
    return { action: "ACCEPT", reason: "the real diff satisfies the intent" };
  }, {
    goal: "add a totals file and report manager turn IDs, exploration child and attempt IDs",
    writeReport: "PLAN/SYNTHESIS/REVIEW IDs were emulated. No candidate commit exists.",
  });

  const result = await service.advance(job.id);
  assert.equal(result.status, "ACCEPTED");
  const run = service.getRun(job.id);
  const attempts = dispatcher.status(job.id).attempts;
  const candidate = attempts.find((attempt) => attempt.job_id === job.id);
  const children = dispatcher.db.prepare(
    "SELECT * FROM jobs WHERE parent_job_id = ? AND internal_kind = 'MANAGER_EXPLORATION' ORDER BY id",
  ).all(job.id);
  assert.equal(children.length, 2);
  assert.ok(candidate.result_commit);
  assert.match(reviewPrompt, /## Authoritative Delegate Wave facts/);
  assert.match(reviewPrompt, /workflow: PLAN -> EXPLORE 2\/2 succeeded -> SYNTHESIS -> IMPLEMENT/);
  assert.match(reviewPrompt, new RegExp(`candidate: ${candidate.result_commit}`));
  assert.match(reviewPrompt, /validation: no configured checks \/ PASSED/);
  assert.match(reviewPrompt, new RegExp(`manager run: ${run.id}`));
  for (const turn of manager.turns.filter((turn) => turn.phase !== "REVIEW")) {
    const durable = service.turns(run.id).find((item) => item.phase === turn.phase);
    assert.match(reviewPrompt, new RegExp(`turn: ${durable.id}`));
  }
  for (const child of children) {
    const childAttempt = dispatcher.status(child.id).attempts.at(-1);
    assert.match(reviewPrompt, new RegExp(`exploration: ${child.id} / ${childAttempt.id} / SUCCEEDED`));
  }
  assert.match(reviewPrompt, /PLAN\/SYNTHESIS\/REVIEW IDs were emulated\. No candidate commit exists\./);
  assert.match(reviewPrompt, /This commentary cannot redefine any authoritative fact above/);
  assert.match(reviewPrompt, /Your decision is only whether the real diff satisfies the human intent/);
  assert.equal(run.status, "ACCEPTED");
});

test("scheduler contention reconciles the same exploration round without spending turns", async (t) => {
  const { dispatcher, service, project } = await fixture(t, [
    { action: "EXPLORE", reason: "need evidence", explorations: [
      { question: "A", deliver: ["files"] }, { question: "B", deliver: ["tests"] },
    ] },
    { action: "IMPLEMENT", reason: "evidence ready", brief: BRIEF() },
    { action: "ACCEPT", reason: "done" },
  ]);
  const sessions = new AutonomousSessionService({ dispatcher, manager: service });
  const session = await sessions.start({ projectId: project.id, intent: "add a totals file", mode: "MANUAL" });
  const job = dispatcher.getJob(session.job_id);
  const errors = [];
  const driver = new SessionDriver({ sessions, onError: (error) => errors.push(error) });
  const tick = async () => {
    driver.pass();
    const deadline = Date.now() + 10_000;
    while (driver.inFlight.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(driver.inFlight.size, 0, "driver tick must yield after scheduler contention");
    assert.deepEqual(errors, []);
  };
  const backend = dispatcher.backend;
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  dispatcher.backend = new FakeBackend(async () => {
    entered();
    await gate;
    return { exitCode: 0, stdout: "read complete", stderr: "" };
  });
  const blocker = await dispatcher.createJob({ projectId: project.id, goal: "unrelated read", mode: "read" });
  const running = dispatcher.runJob(blocker.id);
  try {
    await started;
    dispatcher.backend = backend;
    const children = () => dispatcher.db.prepare("SELECT id FROM jobs WHERE parent_job_id = ? ORDER BY id").all(job.id);
    await tick();
    const original = children();
    assert.equal(original.length, 2);
    for (let pass = 0; pass < 2; pass += 1) await tick();
    assert.deepEqual(children(), original);
    const run = service.getRun(job.id);
    assert.equal(run.status, "EXPLORING");
    assert.equal(run.exploration_round, 1);
    assert.equal(service.turns(run.id).length, 1);
    for (const child of original) {
      assert.equal(dispatcher.getJob(child.id).status, "PENDING");
      assert.equal(dispatcher.db.prepare("SELECT COUNT(*) c FROM attempts WHERE job_id = ?").get(child.id).c, 0);
      assert.throws(() => dispatcher.assertAdmissible(child.id), (error) => error.code === "SCHEDULER_BUSY" && error.retryable);
    }
    release();
    await running;
    await tick();
    assert.deepEqual(children(), original);
    assert.equal(service.getRun(job.id).status, "ACCEPTED");
    assert.deepEqual(service.turns(run.id).map((turn) => turn.phase), ["PLAN", "SYNTHESIS", "REVIEW"]);
    for (const child of original) assert.equal(dispatcher.getJob(child.id).status, "SUCCEEDED");
  } finally {
    release();
    await running;
  }
});

test("an exploration child inherits the root's authorized base, not the current branch", async (t) => {
  const { dispatcher, job, repo } = await fixture(t, []);
  const authorized = dispatcher.getJob(job.id).base_sha;

  // The world moves after authorization and before the investigation is commissioned.
  fs.writeFileSync(path.join(repo, "input.txt"), "moved\n");
  await command("git", ["add", "."], repo);
  await command("git", ["commit", "-m", "someone else"], repo);
  const moved = await command("git", ["rev-parse", "HEAD"], repo);
  assert.notEqual(moved, authorized);

  // Resolving the branch for the child would have it investigate a repository nobody is changing,
  // and the brief written from its findings would target the wrong world.
  const child = await dispatcher.createJob({
    projectId: dispatcher.getJob(job.id).project_id,
    goal: "where are totals computed?",
    mode: "read",
    maxAttempts: 1,
    parentJobId: job.id,
    internalKind: "MANAGER_EXPLORATION",
  });
  assert.equal(child.base_sha, authorized, "the child must inherit the authorized world");
  assert.notEqual(child.base_sha, moved);
});

test("a managed run refuses to buy exploration once its authorized base has moved", async (t) => {
  // The guard has to fire before ANY paid activity, not only before the root's own first attempt: a
  // managed run buys investigations first, and children skip the guard by design because they
  // inherit a base rather than being independently authorized.
  const { dispatcher, service, job, repo } = await fixture(t, [
    { action: "EXPLORE", reason: "look first", explorations: [{ question: "where are totals computed?", deliver: ["files"] }] },
  ]);

  fs.writeFileSync(path.join(repo, "input.txt"), "moved\n");
  await command("git", ["add", "."], repo);
  await command("git", ["commit", "-m", "someone else"], repo);

  await assert.rejects(service.advance(job.id), /refusing to start paid work against a different base/);

  assert.equal(
    dispatcher.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE parent_job_id = ?").get(job.id).count,
    0,
    "no investigation may be commissioned against a world the implementation cannot touch",
  );
});

test("PLAN to EXPLORE to SYNTHESIS to IMPLEMENT to REVIEW to ACCEPT", async (t) => {
  const { dispatcher, service, job, received } = await fixture(t, [
    {
      action: "EXPLORE",
      reason: "two things are unclear",
      explorations: [
        { question: "where are totals computed?", deliver: ["files", "functions"] },
        { question: "what tests cover totals?", deliver: ["test paths"] },
      ],
    },
    { action: "IMPLEMENT", reason: "the investigations answered it", brief: BRIEF() },
    { action: "ACCEPT", reason: "solves the objective" },
  ]);

  const report = await service.advance(job.id);
  const run = service.getRun(job.id);

  // Two read children ran, serially, as real jobs with real evidence.
  const children = dispatcher.db.prepare(
    "SELECT * FROM jobs WHERE parent_job_id = ? AND internal_kind = 'MANAGER_EXPLORATION' ORDER BY created_at",
  ).all(job.id);
  assert.equal(children.length, 2);
  for (const child of children) {
    assert.equal(child.mode, "read");
    assert.equal(child.status, "SUCCEEDED");
    assert.equal(child.maximum_cost, null, "a child carries no ceiling of its own");
  }

  // A read investigation never produces an integration candidate or a human decision.
  const proposals = dispatcher.db.prepare(
    `SELECT COUNT(*) AS count FROM integration_proposals WHERE job_id IN (${children.map(() => "?").join(",")})`,
  ).get(...children.map((c) => c.id)).count;
  assert.equal(proposals, 0);

  // The turn ledger distinguishes what the scarce budget bought.
  const phases = service.turns(run.id).map((turn) => turn.phase);
  assert.deepEqual(phases, ["PLAN", "SYNTHESIS", "REVIEW"]);

  // Synthesis saw the reports, read back from the child attempts' own artifacts.
  const synthesis = service.turns(run.id).find((turn) => turn.phase === "SYNTHESIS");
  const prompt = fs.readFileSync(synthesis.prompt_artifact, "utf8");
  assert.match(prompt, /where are totals computed\?/);
  assert.match(prompt, /what tests cover totals\?/);
  assert.match(prompt, /findings for:/);

  // The implementation worker got the brief; the investigations got questions.
  assert.equal(received.filter((r) => r.mode === "read").length, 2);
  assert.match(received.at(-1).instruction, /create out\.txt containing the totals/);

  assert.equal(run.status, "ACCEPTED");
  assert.equal(dispatcher.getJob(job.id).status, "READY_FOR_INTEGRATION");
  // Exploration is charged to the root family, not to nobody.
  assert.equal(report.cheap.jobs, 3, "root plus two investigations settle as one family");
});

test("an investigation that modifies the tree is a failed investigation", async (t) => {
  const { dispatcher, service, job } = await fixture(t, [
    { action: "EXPLORE", reason: "look", explorations: [{ question: "where are totals computed?", deliver: ["files"] }] },
    { action: "ESCALATE", reason: "the investigation is untrustworthy", question: "the reader edited the tree; proceed?" },
  ], { readModifiesTree: true });

  await service.advance(job.id);

  const child = dispatcher.db.prepare(
    "SELECT * FROM jobs WHERE parent_job_id = ? AND internal_kind = 'MANAGER_EXPLORATION'",
  ).get(job.id);
  assert.equal(child.status, "NEEDS_ATTENTION", "a read job that edited files did not succeed");

  // Synthesis was still reached, and was told the investigation failed rather than shown an empty
  // report -- "we could not find out" and "there is nothing there" lead to opposite conclusions.
  const run = service.getRun(job.id);
  const synthesis = service.turns(run.id).find((turn) => turn.phase === "SYNTHESIS");
  assert.ok(synthesis, "a failed child must not abandon the round");
  const prompt = fs.readFileSync(synthesis.prompt_artifact, "utf8");
  assert.match(prompt, /FAILED|UNKNOWN/);
});

test("RETHINK carries its investigations instead of paying to ask for them again", async (t) => {
  const { dispatcher, service, job } = await fixture(t, [
    { action: "IMPLEMENT", reason: "looks simple", brief: BRIEF() },
    {
      action: "RETHINK",
      reason: "the diagnosis was wrong: totals are computed elsewhere",
      explorations: [{ question: "which module owns totals?", deliver: ["files"] }],
    },
    { action: "IMPLEMENT", reason: "now correctly diagnosed", brief: BRIEF({ instructions: "create out.txt in the right module" }) },
    { action: "ACCEPT", reason: "correct now" },
  ]);

  await service.advance(job.id);
  const run = service.getRun(job.id);
  const phases = service.turns(run.id).map((turn) => turn.phase);

  // RETHINK went straight to its investigations. A second PLAN turn here would be the manager paying
  // scarce budget to repeat the questions it had just written down.
  assert.deepEqual(phases, ["PLAN", "REVIEW", "SYNTHESIS", "REVIEW"]);
  assert.equal(
    dispatcher.db.prepare(
      "SELECT COUNT(*) AS count FROM jobs WHERE parent_job_id = ? AND internal_kind = 'MANAGER_EXPLORATION'",
    ).get(job.id).count,
    1,
  );
  assert.equal(run.status, "ACCEPTED");
});

test("the full loop: explore, synthesize, implement, review, rethink, implement, accept", async (t) => {
  const { dispatcher, service, job } = await fixture(t, [
    {
      action: "EXPLORE", reason: "two unknowns",
      explorations: [
        { question: "where are totals computed?", deliver: ["files"] },
        { question: "what tests cover totals?", deliver: ["paths"] },
      ],
    },
    { action: "IMPLEMENT", reason: "understood", brief: BRIEF() },
    {
      action: "RETHINK", reason: "the plan targeted the wrong layer",
      explorations: [{ question: "which layer owns the filter?", deliver: ["files"] }],
    },
    { action: "IMPLEMENT", reason: "now targeting the right layer", brief: BRIEF({ instructions: "create out.txt in the filter layer" }) },
    { action: "ACCEPT", reason: "solves the objective" },
  ]);

  await service.advance(job.id);
  const run = service.getRun(job.id);

  assert.deepEqual(
    service.turns(run.id).map((turn) => turn.phase),
    ["PLAN", "SYNTHESIS", "REVIEW", "SYNTHESIS", "REVIEW"],
  );
  assert.equal(run.exploration_round, 2);
  assert.equal(
    dispatcher.db.prepare(
      "SELECT COUNT(*) AS count FROM jobs WHERE parent_job_id = ?",
    ).get(job.id).count,
    3,
    "two investigations in round one, one in round two",
  );

  // Two implementation attempts, both PASSED; only the accepted one may be proposed.
  const attempts = dispatcher.status(job.id).attempts;
  assert.equal(attempts.length, 2);
  assert.equal(run.accepted_attempt_id, attempts.at(-1).id);
  const proposal = await dispatcher.proposeIntegration({ jobId: job.id });
  assert.equal(proposal.attempt_id, attempts.at(-1).id);

  // Every candidate is still one net change from the authorized base.
  const jobRow = dispatcher.getJob(job.id);
  const repoPath = dispatcher.getProject(jobRow.project_id).repo_path;
  for (const attempt of attempts) {
    const parent = await command("git", ["rev-parse", `${attempt.result_commit}^`], repoPath);
    assert.equal(parent, jobRow.base_sha);
  }
});

test("an exploration round is durable before its work is bought", async (t) => {
  const { dispatcher, service, job } = await fixture(t, async ({ phase, index }) => {
    if (index === 0) {
      return {
        action: "EXPLORE", reason: "investigate",
        explorations: [{ question: "where are totals computed?", deliver: ["files"] }],
      };
    }
    // Die during synthesis, after the round and its child are already durable.
    throw Object.assign(new Error("app-server died"), { uncertain: true });
  });

  await service.advance(job.id);
  const run = service.getRun(job.id);

  // The round was recorded before the child ran, so a resume knows which round owns it and does not
  // commission the same investigation twice.
  assert.equal(run.exploration_round, 1);
  const children = dispatcher.db.prepare(
    "SELECT * FROM jobs WHERE parent_job_id = ? AND internal_kind = 'MANAGER_EXPLORATION'",
  ).all(job.id);
  assert.equal(children.length, 1);
  assert.equal(children[0].status, "SUCCEEDED");

  const before = dispatcher.db.prepare("SELECT COUNT(*) AS count FROM attempts WHERE job_id = ?")
    .get(children[0].id).count;
  await service.advance(job.id);
  const after = dispatcher.db.prepare("SELECT COUNT(*) AS count FROM attempts WHERE job_id = ?")
    .get(children[0].id).count;
  assert.equal(after, before, "a completed investigation is never re-run");
});

test("an OpenCode worker's report is captured, not silently discarded", async (t) => {
  // The defect that made a whole managed run useless. Harness writes
  // `assistant/message` with text under `data`; OpenCode writes `type: "text"`
  // with text under `part`. The reader recognised only the first, so eight
  // investigations succeeded, produced good answers with file:line citations,
  // and the manager saw UNKNOWN for every one -- then escalated asking for the
  // file contents it had already been told.
  //
  // A dropped report is indistinguishable from a worker that said nothing, which
  // is why this needs a test rather than vigilance.
  const { readFinalText } = await import("../src/manager/runtime.js");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-report-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

  const openCode = path.join(temp, "opencode-events.jsonl");
  fs.writeFileSync(openCode, [
    JSON.stringify({ type: "step_start", part: {} }),
    JSON.stringify({ type: "tool_use", part: { tool: "read" } }),
    JSON.stringify({ type: "text", part: { text: "Findings: totals are computed in src/export.js:42." } }),
    JSON.stringify({ type: "step_finish", part: { tokens: { input: 1, output: 1 } } }),
  ].join("\n"));
  assert.match(
    readFinalText({ stdoutPath: openCode }, temp),
    /totals are computed in src\/export\.js:42/,
  );

  // The Harness shape still reads, so the fix widened rather than replaced.
  const sessions = path.join(temp, "sessions", "ws", "s1");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, "session.jsonl"), `${JSON.stringify({
    type: "assistant/message", data: { text: "Harness findings here." },
  })}\n`);
  assert.match(readFinalText({}, temp), /Harness findings here/);
});

test("an OpenCode-shaped investigation reaches SYNTHESIS as a real report", async (t) => {
  // The whole seam, not the parser alone. The 77,613-token failure ran through
  //
  //   real worker result -> runJob -> readFinalText -> result_text_artifact
  //     -> collectReports -> evidence pack -> SYNTHESIS prompt
  //
  // and the unit test that shipped with the fix only covered the third arrow.
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-oc-"));
  const root = path.join(temp, "data");
  const repo = path.join(temp, "repo");
  fs.mkdirSync(repo);
  await command("git", ["init", "-b", "main"], repo);
  await command("git", ["config", "user.name", "Test"], repo);
  await command("git", ["config", "user.email", "test@example.invalid"], repo);
  fs.writeFileSync(path.join(repo, "input.txt"), "before\n");
  await command("git", ["add", "."], repo);
  await command("git", ["commit", "-m", "initial"], repo);
  initializeDataRoot(root);

  // Writes exactly what OpenCode writes: an events JSONL whose answer is a
  // `type: "text"` record with the payload under `part`, returned via stdoutPath.
  const openCodeWorker = new FakeBackend(async ({ artifactDir, mode, worktreePath }) => {
    fs.mkdirSync(artifactDir, { recursive: true });
    const events = path.join(artifactDir, "opencode-events.jsonl");
    fs.writeFileSync(events, [
      JSON.stringify({ type: "step_start", part: {} }),
      JSON.stringify({ type: "tool_use", part: { tool: "read" } }),
      JSON.stringify({ type: "text", part: { text: "TOTALS-LIVE-IN src/export.js:42 and are filtered afterwards." } }),
      JSON.stringify({ type: "step_finish", part: { tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.0001 } }),
    ].join("\n"));
    if (mode !== "read") fs.writeFileSync(path.join(worktreePath, "out.txt"), "done\n");
    return { exitCode: 0, stdout: "ok", stderr: "", stdoutPath: events };
  });

  const dispatcher = new Dispatcher({ root, backend: openCodeWorker });
  const service = new ManagerService({
    dispatcher,
    backend: new FakeManagerBackend([
      { action: "EXPLORE", reason: "need facts", explorations: [{ question: "where are totals computed?", deliver: ["files"] }] },
      { action: "IMPLEMENT", reason: "now informed", brief: BRIEF() },
      { action: "ACCEPT", reason: "done" },
    ]),
    workerModel: "opencode-go/deepseek-v4-flash",
  });
  t.after(async () => {
    dispatcher.close();
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

  const project = await dispatcher.addProject({ name: "OpenCodeReport", repoPath: repo, validation: [] });
  const job = await dispatcher.createJob({
    projectId: project.id, goal: "add a totals file", strategy: "managed", maxAttempts: 2,
  });
  await service.advance(job.id);

  // 1. The report became durable evidence attached to the child's own attempt.
  const child = dispatcher.db.prepare(
    "SELECT * FROM jobs WHERE parent_job_id = ? AND internal_kind = 'MANAGER_EXPLORATION'",
  ).get(job.id);
  assert.ok(child, "the investigation was commissioned");
  const attempt = dispatcher.db.prepare(
    "SELECT * FROM attempts WHERE job_id = ? ORDER BY ordinal DESC LIMIT 1",
  ).get(child.id);
  assert.equal(attempt.terminal_state, "SUCCEEDED");
  assert.ok(attempt.result_text_artifact, "result_text_artifact must be recorded, not left null");
  assert.match(fs.readFileSync(attempt.result_text_artifact, "utf8"), /TOTALS-LIVE-IN/);

  // 2. And it reached the manager as a PRESENT report rather than as UNKNOWN.
  const run = service.getRun(job.id);
  const synthesis = service.turns(run.id).find((turn) => turn.phase === "SYNTHESIS");
  assert.ok(synthesis, "synthesis ran");
  const prompt = fs.readFileSync(synthesis.prompt_artifact, "utf8");
  assert.match(prompt, /TOTALS-LIVE-IN src\/export\.js:42/);
  assert.doesNotMatch(prompt, /produced no usable report/);
  assert.doesNotMatch(prompt, /this question was not answered/);
});
