// The semantic loop, proved with an injected manager so no scarce quota is spent.
//
// The sentence this file exists to make mechanically true:
//
//   a human authorizes one managed objective against an exact repository state; the manager issues
//   an explicit brief, inspects the exact immutable validated candidate, may request bounded
//   revisions, and ACCEPTs one exact attempt; earlier candidates and crashes cannot silently change
//   which attempt that was; a human alone decides whether it becomes Git truth.
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
import { instructionDigest } from "../src/manager/contracts.js";
import { runProcess } from "../src/process.js";

async function command(name, args, cwd) {
  const result = await runProcess(name, args, { cwd });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

// A worker that records exactly what it was told, so a test can prove the brief reached it.
function recordingWorker(received) {
  return new FakeBackend(async ({ worktreePath, instruction, goal }) => {
    received.push({ instruction, goal });
    fs.writeFileSync(path.join(worktreePath, "out.txt"), `${received.length}\n`);
    return { exitCode: 0, stdout: "ok", stderr: "" };
  });
}

const BRIEF = (extra = {}) => ({
  diagnosis: "the totals file is missing",
  instructions: "create out.txt containing the totals",
  acceptance: ["out.txt exists", "it contains the totals"],
  relevant_evidence: [],
  uncertainties: [],
  worker_tier: "ordinary",
  ...extra,
});

async function fixture(t, script, { received = [] } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-loop-"));
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

  const dispatcher = new Dispatcher({ root, backend: recordingWorker(received) });
  const manager = new FakeManagerBackend(script);
  const service = new ManagerService({ dispatcher, backend: manager, workerModel: "opencode-go/deepseek-v4-flash" });

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

  const project = await dispatcher.addProject({ name: "Loop", repoPath: repo, validation: [] });
  const job = await dispatcher.createJob({
    projectId: project.id, goal: "add a totals file", strategy: "managed", maxAttempts: 3,
  });
  return { dispatcher, service, manager, project, job, repo, received };
}

test("PLAN to IMPLEMENT to REVIEW to ACCEPT reaches integration-ready, and only then", async (t) => {
  const received = [];
  const { dispatcher, service, job } = await fixture(t, [
    { action: "IMPLEMENT", reason: "the change is straightforward", brief: BRIEF() },
    { action: "ACCEPT", reason: "out.txt exists and contains the totals" },
  ], { received });

  const report = await service.advance(job.id);

  // 1. The worker received the manager's brief, not the human's objective.
  assert.equal(received.length, 1);
  assert.match(received[0].instruction, /the totals file is missing/);
  assert.match(received[0].instruction, /create out\.txt containing the totals/);
  // 2. The objective remains separately recoverable and unchanged.
  assert.equal(received[0].goal, "add a totals file");
  assert.equal(dispatcher.getJob(job.id).goal, "add a totals file");

  // 3. The attempt records the exact instruction and its digest.
  const attempt = dispatcher.status(job.id).attempts.at(-1);
  assert.equal(attempt.instruction_digest, instructionDigest(received[0].instruction));
  assert.equal(fs.readFileSync(attempt.instruction_artifact, "utf8"), received[0].instruction);

  // 4. The candidate is still captured independently from filesystem truth.
  assert.ok(attempt.result_commit);
  assert.equal(attempt.validation_state, "PASSED");

  // 5. The review was bound by foreign key to that exact attempt.
  const run = service.getRun(job.id);
  const review = service.turns(run.id).find((turn) => turn.phase === "REVIEW");
  assert.equal(review.subject_attempt_id, attempt.id);
  assert.equal(review.action, "ACCEPT");

  // 6. Only now is the root integration-ready, and it names the accepted attempt.
  assert.equal(run.status, "ACCEPTED");
  assert.equal(run.accepted_attempt_id, attempt.id);
  assert.equal(dispatcher.getJob(job.id).status, "READY_FOR_INTEGRATION");
  assert.equal(report.status, "ACCEPTED");

  // And ACCEPT is not integration: a human still has to approve.
  const proposal = await dispatcher.proposeIntegration({ jobId: job.id });
  assert.equal(proposal.attempt_id, attempt.id);
  assert.equal(dispatcher.listApprovals(proposal.id).length, 0);
});

test("a validated candidate is NOT integration-ready before review", async (t) => {
  // The trap: READY_FOR_INTEGRATION means "validation passed" for direct work. If a managed root
  // inherited that, the operator could integrate a candidate the manager was about to reject.
  const { dispatcher, service, job } = await fixture(t, async ({ phase }) => {
    if (phase === "PLAN") return { action: "IMPLEMENT", reason: "go", brief: BRIEF() };
    // Stall at review by refusing to answer.
    throw Object.assign(new Error("manager unavailable"), { uncertain: false });
  });

  await service.advance(job.id);

  const attempt = dispatcher.status(job.id).attempts.at(-1);
  assert.equal(attempt.validation_state, "PASSED", "the candidate really did pass");
  assert.notEqual(
    dispatcher.getJob(job.id).status, "READY_FOR_INTEGRATION",
    "a passing candidate must not be offered before semantic review",
  );
  await assert.rejects(
    dispatcher.proposeIntegration({ jobId: job.id }),
    /READY_FOR_INTEGRATION|no accepted candidate/,
  );
});

test("REVISE produces a second attempt from the first candidate, and only it is integrated", async (t) => {
  const received = [];
  const { dispatcher, service, job } = await fixture(t, [
    { action: "IMPLEMENT", reason: "first pass", brief: BRIEF() },
    {
      action: "REVISE",
      reason: "it writes the wrong totals",
      brief: BRIEF({ diagnosis: "the totals are computed before the filter", instructions: "compute totals after filtering" }),
    },
    { action: "ACCEPT", reason: "now correct" },
  ], { received });

  await service.advance(job.id);

  const attempts = dispatcher.status(job.id).attempts;
  assert.equal(attempts.length, 2);
  const [first, second] = attempts;

  // Both passed, so "the passed attempt" no longer identifies anything.
  assert.equal(first.validation_state, "PASSED");
  assert.equal(second.validation_state, "PASSED");
  // The earlier candidate survives as evidence rather than being rewritten.
  assert.ok(first.result_commit);

  // The revision started from the previous candidate...
  assert.equal(second.start_sha, first.result_commit);
  // ...while its candidate is still measured against the AUTHORIZED base.
  const job2 = dispatcher.getJob(job.id);
  const parent = await command("git", ["rev-parse", `${second.result_commit}^`], dispatcher.getProject(job2.project_id).repo_path);
  assert.equal(parent, job2.base_sha, "the candidate must be one net change from the authorized base");

  // The instruction genuinely differed.
  assert.notEqual(first.instruction_digest, second.instruction_digest);
  assert.match(received[1].instruction, /computed before the filter/);

  // Only the accepted attempt may be proposed.
  const run = service.getRun(job.id);
  assert.equal(run.accepted_attempt_id, second.id);
  const proposal = await dispatcher.proposeIntegration({ jobId: job.id });
  assert.equal(proposal.attempt_id, second.id);
  assert.notEqual(proposal.attempt_id, first.id);
});

test("a later PASSED attempt cannot displace the accepted one", async (t) => {
  // Sweep finding: replacing acceptedCandidate() with "the latest PASSED attempt" left every test
  // green, because in every existing scenario the accepted attempt IS the latest. The invariant is
  // that acceptance names one exact attempt, and that identity must survive another candidate
  // appearing afterwards -- a late-settling worker, a stale scheduler, a bug elsewhere. Without this
  // the operator could be handed a candidate no manager ever reviewed.
  const received = [];
  const { dispatcher, service, job } = await fixture(t, [
    { action: "IMPLEMENT", reason: "first pass", brief: BRIEF() },
    { action: "ACCEPT", reason: "this one solves it" },
  ], { received });

  await service.advance(job.id);
  const accepted = service.getRun(job.id).accepted_attempt_id;
  const first = dispatcher.status(job.id).attempts.at(-1);
  assert.equal(accepted, first.id);

  // A second attempt appears afterwards and also passes. Nothing reviewed it.
  const project = dispatcher.getProject(dispatcher.getJob(job.id).project_id);
  dispatcher.db.prepare(`INSERT INTO attempts(
    id, job_id, ordinal, scheduler_epoch, backend, model, started_at, finished_at,
    terminal_state, validation_state, result_commit, start_sha
  ) VALUES (?, ?, 2, ?, 'FakeBackend', 'm', ?, ?, 'SUCCEEDED', 'PASSED', ?, ?)`).run(
    `${job.id}.2`, job.id, dispatcher.schedulerGeneration(),
    new Date().toISOString(), new Date().toISOString(),
    first.result_commit, dispatcher.getJob(job.id).base_sha,
  );

  const later = dispatcher.db.prepare(
    "SELECT * FROM attempts WHERE job_id = ? AND validation_state = 'PASSED' ORDER BY ordinal DESC LIMIT 1",
  ).get(job.id);
  assert.equal(later.id, `${job.id}.2`, "the dangerous state is real: a newer PASSED attempt exists");
  assert.notEqual(later.id, accepted);

  // The proposal must still name the reviewed attempt, not the newest one.
  const proposal = await dispatcher.proposeIntegration({ jobId: job.id });
  assert.equal(proposal.attempt_id, accepted, "only the attempt a REVIEW turn accepted may be offered");
  assert.notEqual(proposal.attempt_id, later.id);
  assert.ok(project);
});

test("an accepted attempt that is not the run's own is refused", async (t) => {
  // The foreign key proves the subject is an attempt; it does not prove whose. A run pointed at
  // another job's attempt must not be able to offer it.
  const { dispatcher, service, project, job } = await fixture(t, [
    { action: "IMPLEMENT", reason: "go", brief: BRIEF() },
    { action: "ACCEPT", reason: "ok" },
  ]);
  await service.advance(job.id);

  const other = await dispatcher.createJob({ projectId: project.id, goal: "someone else's work" });
  await dispatcher.runJob(other.id, { model: "opencode-go/deepseek-v4-flash" });
  const foreign = dispatcher.status(other.id).attempts.at(-1);

  const run = service.getRun(job.id);
  dispatcher.db.prepare("UPDATE manager_runs SET accepted_attempt_id = ? WHERE id = ?").run(foreign.id, run.id);

  await assert.rejects(
    dispatcher.proposeIntegration({ jobId: job.id }),
    /no completed REVIEW turn accepted that attempt|belongs to job/,
  );
});

test("ACCEPT is refused when deterministic validation did not pass", async (t) => {
  // A failing worker, then a manager that accepts anyway. Semantic acceptance cannot substitute for
  // mechanical truth, so the run halts rather than promoting.
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-loopfail-"));
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

  const dispatcher = new Dispatcher({
    root,
    backend: new FakeBackend(async () => ({ exitCode: 1, stdout: "", stderr: "the worker failed" })),
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

  const service = new ManagerService({
    dispatcher,
    backend: new FakeManagerBackend([
      { action: "IMPLEMENT", reason: "go", brief: BRIEF() },
      { action: "ACCEPT", reason: "looks fine to me" },
    ]),
    workerModel: "opencode-go/deepseek-v4-flash",
  });

  const project = await dispatcher.addProject({ name: "Fail", repoPath: repo, validation: [] });
  const job = await dispatcher.createJob({
    projectId: project.id, goal: "add a totals file", strategy: "managed", maxAttempts: 1,
  });

  await service.advance(job.id);

  const run = service.getRun(job.id);
  assert.notEqual(run.status, "ACCEPTED", "a manager cannot accept work that never validated");
  assert.equal(run.accepted_attempt_id, null);
  assert.notEqual(dispatcher.getJob(job.id).status, "READY_FOR_INTEGRATION");
  await assert.rejects(dispatcher.proposeIntegration({ jobId: job.id }), /READY_FOR_INTEGRATION|no accepted candidate/);
});

test("an uncertain manager turn stops the run and is never replayed", async (t) => {
  let calls = 0;
  const { dispatcher, service, job } = await fixture(t, async ({ phase }) => {
    calls += 1;
    if (phase === "PLAN") return { action: "IMPLEMENT", reason: "go", brief: BRIEF() };
    // Accepted, then lost: the model may have run and the quota may be gone.
    throw Object.assign(new Error("app-server died after accepting the turn"), { uncertain: true });
  });

  await service.advance(job.id);
  const callsAfterFirst = calls;

  const run = service.getRun(job.id);
  assert.equal(run.status, "AWAITING_HUMAN");
  const review = service.turns(run.id).find((turn) => turn.phase === "REVIEW");
  assert.equal(review.state, "UNCERTAIN", "an accepted-then-lost call is uncertain, not failed");
  assert.equal(dispatcher.getJob(job.id).status, "NEEDS_ATTENTION");

  // Advancing again must not buy the same answer twice.
  await service.advance(job.id);
  assert.equal(calls, callsAfterFirst, "an uncertain turn is never automatically retried");
});

test("a turn interrupted before its result is reconciled to UNCERTAIN, not replayed", async (t) => {
  const { dispatcher, service, job } = await fixture(t, [
    { action: "IMPLEMENT", reason: "go", brief: BRIEF() },
    { action: "ACCEPT", reason: "fine" },
  ]);
  await service.advance(job.id);
  const run = service.getRun(job.id);

  // Simulate process death between recording the intent and recording the result.
  dispatcher.db.prepare("UPDATE manager_turns SET state = 'INTENDED', finished_at = NULL WHERE phase = 'REVIEW'").run();
  dispatcher.db.prepare("UPDATE manager_runs SET status = 'REVIEWING' WHERE id = ?").run(run.id);

  const seen = service.reconcile();
  assert.equal(seen.stranded.length, 1);
  assert.equal(seen.applied, false, "reporting is not repairing");

  service.reconcile({ apply: true });
  const repaired = service.getRun(job.id);
  assert.equal(repaired.status, "AWAITING_HUMAN");
  assert.match(repaired.escalation_question, /may already have run and consumed quota/);
  assert.equal(
    dispatcher.db.prepare("SELECT state FROM manager_turns WHERE phase = 'REVIEW'").get().state,
    "UNCERTAIN",
  );
});

test("malformed manager output is never interpreted optimistically", async (t) => {
  const { dispatcher, service, job } = await fixture(t, [
    { action: "IMPLEMENT", reason: "go", brief: BRIEF() },
    "I think this looks good, we should probably accept it.",
  ]);

  await service.advance(job.id);

  const run = service.getRun(job.id);
  assert.notEqual(run.status, "ACCEPTED", "prose that mentions accepting is not an ACCEPT");
  assert.equal(run.accepted_attempt_id, null);
  assert.equal(dispatcher.getJob(job.id).status, "NEEDS_ATTENTION");
  // The turn still happened and still cost something; it is recorded as completed with no action.
  const review = service.turns(run.id).find((turn) => turn.phase === "REVIEW");
  assert.equal(review.state, "COMPLETED");
  assert.equal(review.action, null);
});

test("revision rounds are bounded, and cannot exceed the job's authorized attempts", async (t) => {
  const received = [];
  const { dispatcher, service, job } = await fixture(t, async ({ phase, index }) => {
    if (phase === "PLAN") return { action: "IMPLEMENT", reason: "go", brief: BRIEF() };
    // Always ask for another revision, with a genuinely different brief each time.
    return {
      action: "REVISE",
      reason: `still wrong on round ${index}`,
      brief: BRIEF({ instructions: `attempt variation ${index}` }),
    };
  }, { received });

  await service.advance(job.id);

  const run = service.getRun(job.id);
  assert.equal(run.status, "AWAITING_HUMAN");
  // maxAttempts 3 permits 2 revisions; the third request is refused rather than attempted.
  assert.equal(run.revision_round, 2);
  assert.equal(dispatcher.status(job.id).attempts.length, 3);
  assert.match(run.escalation_question, /revision 3 but only 2 are permitted/);
});

test("a direct job is untouched by any of this", async (t) => {
  const received = [];
  const { dispatcher, project } = await fixture(t, [], { received });
  const direct = await dispatcher.createJob({ projectId: project.id, goal: "plain work" });
  const status = await dispatcher.runJob(direct.id, { model: "opencode-go/deepseek-v4-flash" });

  assert.equal(status.job.status, "READY_FOR_INTEGRATION", "direct work is ready as soon as it validates");
  assert.equal(received.at(-1).instruction, "plain work", "the objective is its own instruction");
  const proposal = await dispatcher.proposeIntegration({ jobId: direct.id });
  assert.ok(proposal.candidate_commit);
});
