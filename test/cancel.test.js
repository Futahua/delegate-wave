// Cancellation is a request against a running attempt, not a state a caller can assert.
//
// The properties that matter: the intent is durable before anything is killed, a worker that
// finished first is not retroactively unfinished, a cancelled attempt still carries its usage, and a
// stale callback from the killed worker cannot mutate the attempt afterwards.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeDataRoot } from "../src/db.js";
import { FakeBackend } from "../src/backend.js";
import { Dispatcher } from "../src/service.js";
import { runProcess } from "../src/process.js";

async function command(name, args, cwd) {
  const result = await runProcess(name, args, { cwd });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-cancel-"));
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
  const cleanup = async () => {
    const listed = await runProcess("git", ["-C", repo, "worktree", "list", "--porcelain"]);
    for (const worktree of listed.stdout.split(/\r?\n/)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length))
      .filter((worktree) => path.resolve(worktree) !== path.resolve(repo))) {
      await runProcess("git", ["-C", repo, "worktree", "unlock", worktree]);
      await runProcess("git", ["-C", repo, "worktree", "remove", "--force", worktree]);
    }
    fs.rmSync(temp, { recursive: true, force: true });
  };
  return { root, repo, cleanup };
}

const usageArtifact = (dir, input = 500) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "opencode-events.jsonl"), JSON.stringify({
    type: "step_finish",
    part: { tokens: { input, output: 20, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.00005 },
  }));
};

test("cancelling a running job kills the worker and records a durable intent and outcome", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  let dispatcher;
  // A worker that blocks until cancelled, so the cancel lands while it is genuinely running.
  const backend = new FakeBackend(async ({ artifactDir, onSpawn }) => {
    usageArtifact(artifactDir);
    const child = await import("node:child_process");
    const proc = child.spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    onSpawn?.(proc.pid);
    // Cancel from inside the run, once a PID exists to kill.
    await dispatcher.cancelJob({ jobId: dispatcher.pendingJobId, principal: "john", origin: "local-cli" });
    proc.kill();
    return { exitCode: 1, stdout: "", stderr: "killed" };
  });
  dispatcher = new Dispatcher({ root, backend });
  t.after(async () => { dispatcher.close(); await cleanup(); });

  const project = await dispatcher.addProject({ name: "Cancel", repoPath: repo, validation: [] });
  const job = await dispatcher.createJob({ projectId: project.id, goal: "long task", maxAttempts: 1 });
  dispatcher.pendingJobId = job.id;
  const result = await dispatcher.runJob(job.id);

  assert.equal(result.job.status, "CANCELLED");
  assert.equal(result.attempts.at(-1).terminal_state, "CANCELLED");
  assert.equal(result.attempts.at(-1).quarantined, 1, "a cancelled attempt is quarantined evidence");

  const intents = dispatcher.cancellationIntents(job.id);
  assert.equal(intents.length, 1);
  assert.equal(intents[0].outcome, "CANCELLED");
  assert.equal(intents[0].requested_by, "john");
  assert.ok(intents[0].killed_pid, "the killed PID is recorded");

  // Cancelled work still consumed tokens and must stay in the cost denominator.
  const usage = dispatcher.getAttemptUsage(result.attempts.at(-1).id);
  assert.ok(usage, "a cancelled attempt keeps its usage receipt");
  assert.equal(usage.status, "COMPLETE");
  assert.equal(usage.input_tokens, 500);
});

test("cancelling a finished job does not retroactively unfinish it", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const backend = new FakeBackend(async ({ worktreePath, artifactDir }) => {
    usageArtifact(artifactDir);
    fs.writeFileSync(path.join(worktreePath, "out.txt"), "done\n");
    return { exitCode: 0, stdout: "ok", stderr: "" };
  });
  const dispatcher = new Dispatcher({ root, backend });
  t.after(async () => { dispatcher.close(); await cleanup(); });

  const project = await dispatcher.addProject({ name: "Late", repoPath: repo, validation: [] });
  const job = await dispatcher.createJob({ projectId: project.id, goal: "quick task" });
  const done = await dispatcher.runJob(job.id);
  assert.equal(done.job.status, "READY_FOR_INTEGRATION");

  const outcome = await dispatcher.cancelJob({ jobId: job.id, principal: "john", origin: "local-cli" });
  assert.equal(outcome.outcome, "ALREADY_TERMINAL");
  // The completed work survives.
  assert.equal(dispatcher.getJob(job.id).status, "READY_FOR_INTEGRATION");
  assert.equal(dispatcher.status(job.id).attempts.at(-1).terminal_state, "SUCCEEDED");
  // The request is still recorded: asking is evidence even when it changed nothing.
  assert.equal(dispatcher.cancellationIntents(job.id).length, 1);
});

// Cancelling a queued job closes it. Leaving it PENDING would mean it still runs later, which is
// the opposite of what was asked -- the old no-op meant a job could not be called off before it
// started. The outcome is CLOSED rather than CANCELLED because nothing was killed, and a receipt
// must not imply a kill that never happened.
test("cancelling a queued job closes it, and says nothing was killed", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const dispatcher = new Dispatcher({ root, backend: new FakeBackend() });
  t.after(async () => { dispatcher.close(); await cleanup(); });

  const project = await dispatcher.addProject({ name: "Idle", repoPath: repo, validation: [] });
  const job = await dispatcher.createJob({ projectId: project.id, goal: "never started" });

  const outcome = await dispatcher.cancelJob({ jobId: job.id, principal: "john", origin: "local-cli" });
  assert.equal(outcome.outcome, "CLOSED");
  assert.equal(outcome.killed_pid, null, "nothing was running, so nothing was killed");
  assert.equal(dispatcher.getJob(job.id).status, "CANCELLED", "and it will not run later");

  const intents = dispatcher.cancellationIntents(job.id);
  assert.equal(intents.length, 1, "asking is recorded even when no process was signalled");
  assert.equal(intents[0].outcome, "CLOSED");
});

// A job that is genuinely finished is left exactly as it was.
test("cancelling an already-cancelled job changes nothing", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const dispatcher = new Dispatcher({ root, backend: new FakeBackend() });
  t.after(async () => { dispatcher.close(); await cleanup(); });

  const project = await dispatcher.addProject({ name: "Twice", repoPath: repo, validation: [] });
  const job = await dispatcher.createJob({ projectId: project.id, goal: "closed twice" });
  await dispatcher.cancelJob({ jobId: job.id, principal: "john", origin: "local-cli" });

  const again = await dispatcher.cancelJob({ jobId: job.id, principal: "john", origin: "local-cli" });
  assert.equal(again.outcome, "ALREADY_TERMINAL");
  assert.equal(dispatcher.getJob(job.id).status, "CANCELLED");
});

test("a stale callback from a cancelled worker cannot mutate the attempt", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  let dispatcher;
  let capturedEpoch = null;
  let capturedAttempt = null;
  let capturedIntent = null;
  const backend = new FakeBackend(async ({ attemptId, artifactDir, onSpawn }) => {
    usageArtifact(artifactDir);
    capturedAttempt = attemptId;
    const row = dispatcher.db.prepare("SELECT scheduler_epoch, executor_intent_id FROM attempts WHERE id = ?").get(attemptId);
    capturedEpoch = row.scheduler_epoch;
    capturedIntent = row.executor_intent_id;
    // A real child, never this process: cancellation kills the recorded PID, and reporting the test
    // runner's own PID would have it kill itself.
    const { spawn } = await import("node:child_process");
    const proc = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    onSpawn?.(proc.pid);
    await dispatcher.cancelJob({ jobId: dispatcher.pendingJobId, principal: "john", origin: "local-cli" });
    proc.kill();
    return { exitCode: 1, stdout: "", stderr: "killed" };
  });
  dispatcher = new Dispatcher({ root, backend });
  t.after(async () => { dispatcher.close(); await cleanup(); });

  const project = await dispatcher.addProject({ name: "Stale", repoPath: repo, validation: [] });
  const job = await dispatcher.createJob({ projectId: project.id, goal: "will be cancelled", maxAttempts: 1 });
  dispatcher.pendingJobId = job.id;
  await dispatcher.runJob(job.id);

  assert.equal(dispatcher.status(job.id).attempts.at(-1).terminal_state, "CANCELLED");

  // The killed worker's late callback must be refused: the attempt is already terminal.
  assert.throws(
    () => dispatcher.recordExecutorPid(capturedAttempt, capturedEpoch, capturedIntent, 99999),
    /Stale or terminal attempt event rejected/,
  );
  assert.equal(dispatcher.status(job.id).attempts.at(-1).terminal_state, "CANCELLED",
    "the late callback changed nothing");
});

test("cancellation intents and results are immutable", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const dispatcher = new Dispatcher({ root, backend: new FakeBackend() });
  t.after(async () => { dispatcher.close(); await cleanup(); });

  const project = await dispatcher.addProject({ name: "Immutable", repoPath: repo, validation: [] });
  const job = await dispatcher.createJob({ projectId: project.id, goal: "x" });
  const outcome = await dispatcher.cancelJob({ jobId: job.id, principal: "john", origin: "local-cli" });

  assert.throws(() => dispatcher.db.prepare("UPDATE cancellation_intents SET reason = 'x' WHERE id = ?")
    .run(outcome.intent_id), /immutable/);
  assert.throws(() => dispatcher.db.prepare("DELETE FROM cancellation_results WHERE intent_id = ?")
    .run(outcome.intent_id), /immutable/);
});

test("cancellation refuses to signal the scheduler or the calling process", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const dispatcher = new Dispatcher({ root, backend: new FakeBackend() });
  t.after(async () => { dispatcher.close(); await cleanup(); });

  const project = await dispatcher.addProject({ name: "SelfKill", repoPath: repo, validation: [] });
  const job = await dispatcher.createJob({ projectId: project.id, goal: "x" });

  // A corrupt or misreported PID must not let a cancel take down the control plane.
  const epoch = Number(dispatcher.db.prepare("SELECT value FROM metadata WHERE key = 'scheduler_epoch'").get().value);
  dispatcher.db.prepare(`INSERT INTO attempts(
    id, job_id, ordinal, scheduler_epoch, backend, model, scheduler_pid, executor_pid, worktree_path, started_at
  ) VALUES (?, ?, 1, ?, 'FakeBackend', 'm', ?, ?, NULL, ?)`)
    .run("attempt-self", job.id, epoch, process.pid, process.pid, new Date().toISOString());
  dispatcher.db.prepare("UPDATE jobs SET status = 'RUNNING' WHERE id = ?").run(job.id);

  const outcome = await dispatcher.cancelJob({ jobId: job.id, principal: "john", origin: "local-cli" });
  assert.equal(outcome.outcome, "CANCELLED", "the attempt is still cancelled");
  assert.equal(outcome.killed_pid, null, "no signal was sent");
  const refused = dispatcher.db.prepare(
    "SELECT 1 FROM events WHERE kind = 'CANCELLATION_KILL_REFUSED' AND entity_id = 'attempt-self'",
  ).get();
  assert.ok(refused, "the refusal is recorded rather than silent");
});

test("cancel works during validation, not only during the executor phase", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  let dispatcher;
  const backend = new FakeBackend(async ({ worktreePath, artifactDir }) => {
    usageArtifact(artifactDir);
    fs.writeFileSync(path.join(worktreePath, "out.txt"), "done\n");
    return { exitCode: 0, stdout: "ok", stderr: "" };
  });
  dispatcher = new Dispatcher({ root, backend });
  t.after(async () => { dispatcher.close(); await cleanup(); });

  // A validation command that blocks. During it the executor is already SUCCEEDED and the job is
  // RUNNING, which is exactly the state the old cancel treated as "nothing running".
  const project = await dispatcher.addProject({
    name: "CancelValidation", repoPath: repo,
    validation: [`"${process.execPath}" -e "setTimeout(()=>{},60000)"`],
  });
  const job = await dispatcher.createJob({ projectId: project.id, goal: "blocked validation", maxAttempts: 1 });

  // Cancel once validation is genuinely in flight.
  const cancelling = (async () => {
    for (let i = 0; i < 200; i += 1) {
      const attempt = dispatcher.db.prepare(
        "SELECT * FROM attempts WHERE job_id = ? ORDER BY ordinal DESC LIMIT 1",
      ).get(job.id);
      if (attempt?.terminal_state === "SUCCEEDED" && attempt.validation_state === "PENDING" && attempt.validation_pid) {
        return dispatcher.cancelJob({ jobId: job.id, principal: "john", origin: "local-cli" });
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("validation never reached a cancellable state");
  })();

  const [, outcome] = await Promise.all([
    dispatcher.runJob(job.id).catch(() => null),
    cancelling,
  ]);

  assert.equal(outcome.outcome, "CANCELLED", "cancel must work during validation");
  assert.ok(outcome.killed_pid, "the validation process was killed");
  const attempt = dispatcher.status(job.id).attempts.at(-1);
  assert.equal(attempt.terminal_state, "SUCCEEDED", "the executor really did succeed");
  assert.notEqual(attempt.validation_state, "PASSED", "an interrupted validation never passed");
  assert.notEqual(attempt.validation_state, "FAILED",
    "and it was not tested and rejected either: cancelled is not failed");
  assert.equal(attempt.quarantined, 1, "an unvalidated candidate stays quarantined");
  assert.equal(dispatcher.getJob(job.id).status, "CANCELLED");
});

test("a stale validation callback cannot mutate a cancelled attempt", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const backend = new FakeBackend(async ({ worktreePath, artifactDir }) => {
    usageArtifact(artifactDir);
    fs.writeFileSync(path.join(worktreePath, "out.txt"), "done\n");
    return { exitCode: 0, stdout: "ok", stderr: "" };
  });
  const dispatcher = new Dispatcher({ root, backend });
  t.after(async () => { dispatcher.close(); await cleanup(); });

  const project = await dispatcher.addProject({ name: "StaleValidation", repoPath: repo, validation: [] });
  const job = await dispatcher.createJob({ projectId: project.id, goal: "produce out.txt" });
  const result = await dispatcher.runJob(job.id);
  const attempt = result.attempts.at(-1);

  // A validation callback arriving after the attempt is no longer awaiting validation is refused.
  assert.throws(
    () => dispatcher.recordValidationPid(attempt.id, attempt.scheduler_epoch, "stale-intent", 4242),
    /Stale or terminal attempt event rejected|Stale validation start rejected/,
  );
});
