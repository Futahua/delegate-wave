import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeDataRoot } from "../src/db.js";
import { FakeBackend, OpenCodeBackend } from "../src/backend.js";
import { Dispatcher } from "../src/service.js";
import { runProcess } from "../src/process.js";

async function command(name, args, cwd) {
  const result = await runProcess(name, args, { cwd });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-test-"));
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
    const worktrees = listed.stdout.split(/\r?\n/)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length))
      .filter((worktree) => path.resolve(worktree) !== path.resolve(repo));
    for (const worktree of worktrees) {
      await runProcess("git", ["-C", repo, "worktree", "unlock", worktree]);
      await runProcess("git", ["-C", repo, "worktree", "remove", "--force", worktree]);
    }
    fs.rmSync(temp, { recursive: true, force: true });
  };
  return { root, repo, cleanup };
}

test("successful worker produces a validated candidate commit", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const backend = new FakeBackend(async ({ worktreePath }) => {
    fs.writeFileSync(path.join(worktreePath, "output.txt"), "done\n");
    return { exitCode: 0, stdout: "ok", stderr: "" };
  });
  const service = new Dispatcher({ root, backend });
  t.after(async () => { service.close(); await cleanup(); });
  const project = await service.addProject({ name: "Fixture", repoPath: repo, validation: [] });
  const job = await service.createJob({ projectId: project.id, goal: "create output" });
  const result = await service.runJob(job.id);
  assert.equal(result.job.status, "READY_FOR_INTEGRATION");
  assert.equal(result.attempts[0].terminal_state, "SUCCEEDED");
  assert.equal(result.attempts[0].validation_state, "PASSED");
  assert.match(result.attempts[0].result_commit, /^[a-f0-9]{40,64}$/);
});

test("failed workers stop after the bounded attempt count", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const backend = new FakeBackend(async () => ({ exitCode: 7, stdout: "", stderr: "same failure 123" }));
  const service = new Dispatcher({ root, backend });
  t.after(async () => { service.close(); await cleanup(); });
  const project = await service.addProject({ name: "Fixture", repoPath: repo });
  const job = await service.createJob({ projectId: project.id, goal: "fail", maxAttempts: 2 });
  assert.equal((await service.runJob(job.id)).job.status, "PENDING");
  const final = await service.runJob(job.id);
  assert.equal(final.job.status, "NEEDS_ATTENTION");
  assert.equal(final.attempts.length, 2);
  assert.equal(final.attempts[0].failure_signature, final.attempts[1].failure_signature);
});

test("stale epoch events cannot mutate an attempt", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: new FakeBackend() });
  t.after(async () => { service.close(); await cleanup(); });
  const project = await service.addProject({ name: "Fixture", repoPath: repo });
  const job = await service.createJob({ projectId: project.id, goal: "noop" });
  service.db.prepare(`INSERT INTO attempts(
    id, job_id, ordinal, scheduler_epoch, backend, started_at
  ) VALUES (?, ?, 1, 1, 'FakeBackend', ?)`).run("attempt-stale", job.id, new Date().toISOString());
  service.db.prepare("UPDATE metadata SET value = '2' WHERE key = 'scheduler_epoch'").run();
  assert.throws(() => service.acceptAttemptEvent("attempt-stale", 1, () => {}), /Stale/);
});

test("protected paths reject candidate changes", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const backend = new FakeBackend(async ({ worktreePath }) => {
    fs.mkdirSync(path.join(worktreePath, ".github"));
    fs.writeFileSync(path.join(worktreePath, ".github", "workflow.yml"), "bad\n");
    return { exitCode: 0, stdout: "ok", stderr: "" };
  });
  const service = new Dispatcher({ root, backend });
  t.after(async () => { service.close(); await cleanup(); });
  const project = await service.addProject({ name: "Fixture", repoPath: repo, protectedPaths: [".github/**"] });
  const job = await service.createJob({ projectId: project.id, goal: "touch protected", maxAttempts: 1 });
  const result = await service.runJob(job.id);
  assert.equal(result.job.status, "NEEDS_ATTENTION");
  assert.equal(result.attempts[0].quarantined, 1);
});

test("validation failure rejects but preserves a completed executor attempt", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const backend = new FakeBackend(async ({ worktreePath }) => {
    fs.writeFileSync(path.join(worktreePath, "output.txt"), "candidate\n");
    return { exitCode: 0, stdout: "ok", stderr: "" };
  });
  const service = new Dispatcher({ root, backend });
  t.after(async () => { service.close(); await cleanup(); });
  const project = await service.addProject({ name: "Fixture", repoPath: repo, validation: ["exit 9"] });
  const job = await service.createJob({ projectId: project.id, goal: "invalid candidate", maxAttempts: 1 });
  const result = await service.runJob(job.id);
  assert.equal(result.job.status, "NEEDS_ATTENTION");
  assert.equal(result.attempts[0].terminal_state, "SUCCEEDED");
  assert.equal(result.attempts[0].validation_state, "FAILED");
  assert.equal(result.attempts[0].quarantined, 1);
});

test("reconciliation orphans a dead fenced attempt without consulting a model", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: new FakeBackend() });
  t.after(async () => { service.close(); await cleanup(); });
  const project = await service.addProject({ name: "Fixture", repoPath: repo });
  const job = await service.createJob({ projectId: project.id, goal: "interrupted" });
  service.db.prepare("UPDATE jobs SET status = 'RUNNING' WHERE id = ?").run(job.id);
  service.db.prepare(`INSERT INTO attempts(
    id, job_id, ordinal, scheduler_epoch, backend, executor_pid, worktree_path, started_at
  ) VALUES (?, ?, 1, 1, 'FakeBackend', NULL, ?, ?)`).run(
    "attempt-dead", job.id, path.join(root, "missing-worktree"), new Date().toISOString(),
  );
  const preview = await service.reconcile();
  assert.equal(preview.applied, false);
  assert.equal(preview.observations[0].proposed, "ORPHAN");
  assert.equal(service.status(job.id).attempts[0].terminal_state, null);
  const result = await service.reconcile({ apply: true });
  assert.equal(result.results[0].action, "ORPHANED");
  assert.equal(service.status(job.id).attempts[0].terminal_state, "ORPHANED");
  assert.equal(service.status(job.id).job.status, "PENDING");
});

test("reconciliation refuses a live executor without advancing the epoch", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  let releaseWorker;
  let reportStarted;
  const workerStarted = new Promise((resolve) => { reportStarted = resolve; });
  const workerRelease = new Promise((resolve) => { releaseWorker = resolve; });
  const backend = new FakeBackend(async ({ worktreePath, onSpawn }) => {
    onSpawn(process.pid);
    reportStarted();
    await workerRelease;
    fs.writeFileSync(path.join(worktreePath, "live.txt"), "completed\n");
    return { exitCode: 0, stdout: "ok", stderr: "" };
  });
  const service = new Dispatcher({ root, backend });
  t.after(async () => { service.close(); await cleanup(); });
  const project = await service.addProject({ name: "Fixture", repoPath: repo });
  const job = await service.createJob({ projectId: project.id, goal: "finish while reconcile inspects" });
  const run = service.runJob(job.id);
  await workerStarted;
  const epochBefore = service.db.prepare("SELECT value FROM metadata WHERE key = 'scheduler_epoch'").get().value;
  const reconciliation = await service.reconcile({ apply: true });
  const epochAfter = service.db.prepare("SELECT value FROM metadata WHERE key = 'scheduler_epoch'").get().value;
  assert.equal(reconciliation.applied, false);
  assert.equal(reconciliation.refused, "LIVE_ATTEMPT_PROCESS");
  assert.equal(epochAfter, epochBefore);
  releaseWorker();
  const result = await run;
  assert.equal(result.job.status, "READY_FOR_INTEGRATION");
  assert.equal(result.attempts[0].terminal_state, "SUCCEEDED");
});

test("the scheduler PID fences reconciliation before an executor PID is published", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  let releaseWorker;
  let reportEntered;
  const workerEntered = new Promise((resolve) => { reportEntered = resolve; });
  const workerRelease = new Promise((resolve) => { releaseWorker = resolve; });
  const backend = new FakeBackend(async ({ worktreePath }) => {
    reportEntered();
    await workerRelease;
    fs.writeFileSync(path.join(worktreePath, "scheduler-owned.txt"), "completed\n");
    return { exitCode: 0, stdout: "ok", stderr: "" };
  });
  const service = new Dispatcher({ root, backend });
  t.after(async () => { service.close(); await cleanup(); });
  const project = await service.addProject({ name: "Fixture", repoPath: repo });
  const job = await service.createJob({ projectId: project.id, goal: "scheduler ownership gap" });
  const run = service.runJob(job.id);
  await workerEntered;
  const attempt = service.status(job.id).attempts[0];
  assert.equal(attempt.scheduler_pid, process.pid);
  assert.equal(attempt.executor_pid, null);
  const epochBefore = service.db.prepare("SELECT value FROM metadata WHERE key = 'scheduler_epoch'").get().value;
  const reconciliation = await service.reconcile({ apply: true });
  assert.equal(reconciliation.applied, false);
  assert.equal(reconciliation.refused, "LIVE_ATTEMPT_PROCESS");
  assert.equal(reconciliation.observations[0].scheduler_alive, true);
  assert.equal(service.db.prepare("SELECT value FROM metadata WHERE key = 'scheduler_epoch'").get().value, epochBefore);
  releaseWorker();
  assert.equal((await run).job.status, "READY_FOR_INTEGRATION");
});

test("invalid job invocation does not consume a scheduler epoch", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: new FakeBackend() });
  t.after(async () => { service.close(); await cleanup(); });
  const project = await service.addProject({ name: "Fixture", repoPath: repo });
  const job = await service.createJob({ projectId: project.id, goal: "cancelled" });
  service.db.prepare("UPDATE jobs SET status = 'CANCELLED' WHERE id = ?").run(job.id);
  const before = service.db.prepare("SELECT value FROM metadata WHERE key = 'scheduler_epoch'").get().value;
  await assert.rejects(service.runJob(job.id), /CANCELLED/);
  const after = service.db.prepare("SELECT value FROM metadata WHERE key = 'scheduler_epoch'").get().value;
  assert.equal(after, before);
});

test("stale validation and failure callbacks leave authoritative state unchanged", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: new FakeBackend() });
  t.after(async () => { service.close(); await cleanup(); });
  const project = await service.addProject({ name: "Fixture", repoPath: repo });
  const job = await service.createJob({ projectId: project.id, goal: "stale callbacks" });
  const attemptId = "attempt-stale-callbacks";
  const artifactDir = path.join(root, "artifacts", attemptId);
  fs.mkdirSync(artifactDir, { recursive: true });
  service.db.prepare("UPDATE jobs SET status = 'RUNNING' WHERE id = ?").run(job.id);
  service.db.prepare(`INSERT INTO attempts(
    id, job_id, ordinal, scheduler_epoch, terminal_state, validation_state,
    backend, worktree_path, started_at
  ) VALUES (?, ?, 1, 1, 'SUCCEEDED', 'PENDING', 'FakeBackend', ?, ?)`).run(
    attemptId, job.id, repo, new Date().toISOString(),
  );
  service.db.prepare("UPDATE metadata SET value = '2' WHERE key = 'scheduler_epoch'").run();
  const staleValidator = path.join(root, "stale-validator.js");
  const staleSideEffect = path.join(root, "stale-validation-ran.txt");
  fs.writeFileSync(staleValidator, "require('fs').writeFileSync(process.argv[2], 'ran\\n');\n");
  const staleCommand = `node ${JSON.stringify(staleValidator.replaceAll("\\", "/"))} ${JSON.stringify(staleSideEffect.replaceAll("\\", "/"))}`;
  await assert.rejects(service.validate(attemptId, 1, repo, artifactDir, staleCommand), /Stale/);
  assert.equal(fs.existsSync(staleSideEffect), false);
  assert.equal(service.db.prepare("SELECT COUNT(*) AS count FROM validation_runs WHERE attempt_id = ?").get(attemptId).count, 0);
  const failureApplied = await service.failAttempt({
    attemptId,
    jobId: job.id,
    epoch: 1,
    project,
    worktreePath: repo,
    error: new Error("stale failure"),
  });
  assert.equal(failureApplied, false);
  const state = service.status(job.id);
  assert.equal(state.job.status, "RUNNING");
  assert.equal(state.attempts[0].validation_state, "PENDING");
  assert.equal(state.attempts[0].quarantined, 0);
});

test("missing executables reject cleanly instead of crashing the process", async () => {
  await assert.rejects(
    runProcess("delegate-wave-executable-that-does-not-exist", []),
    /ENOENT/,
  );
});

const installedWindowsOpenCodeEntry = process.env.APPDATA
  ? path.join(process.env.APPDATA, "npm", "node_modules", "opencode-ai", "bin", "opencode")
  : null;

test("Windows OpenCode launch bypasses command shims", {
  skip: process.platform !== "win32" || !installedWindowsOpenCodeEntry || !fs.existsSync(installedWindowsOpenCodeEntry),
}, () => {
  const backend = new OpenCodeBackend();
  assert.equal(backend.executable, process.execPath);
  assert.match(backend.prefixArgs[0], /opencode-ai[\\/]bin[\\/]opencode$/);
  assert.equal(fs.existsSync(backend.prefixArgs[0]), true);
});

test("explicit OpenCode executable bypasses default launch resolution", () => {
  const backend = new OpenCodeBackend({
    executable: "custom-opencode",
    prefixArgs: ["custom-entry"],
    launchResolver: () => { throw new Error("default resolver must remain lazy"); },
  });
  assert.equal(backend.executable, "custom-opencode");
  assert.deepEqual(backend.prefixArgs, ["custom-entry"]);
});

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for condition");
}

test("a real blocked validator fences claims and reconciliation without epoch movement, then finishes normally", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const waiter = path.join(root, "waiter.js");
  const release = path.join(root, "release.marker");
  fs.writeFileSync(waiter, `
    const fs = require("fs");
    const target = process.argv[2];
    while (!fs.existsSync(target)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    process.exit(0);
  `);
  const quoted = (value) => JSON.stringify(value.replaceAll("\\", "/"));
  const backend = new FakeBackend(async ({ worktreePath }) => {
    fs.writeFileSync(path.join(worktreePath, "output.txt"), "candidate\n");
    return { exitCode: 0, stdout: "ok", stderr: "" };
  });
  const service = new Dispatcher({ root, backend });
  t.after(async () => { service.close(); await cleanup(); });
  const project = await service.addProject({
    name: "Fixture",
    repoPath: repo,
    validation: [`node ${quoted(waiter)} ${quoted(release)}`],
  });
  const first = await service.createJob({ projectId: project.id, goal: "long validation" });
  const second = await service.createJob({ projectId: project.id, goal: "must wait" });
  const run = service.runJob(first.id);
  const attemptId = `${first.id}.1`;
  await waitFor(() => {
    const attempt = service.db.prepare("SELECT * FROM attempts WHERE id = ?").get(attemptId);
    return attempt
      && attempt.terminal_state === "SUCCEEDED"
      && attempt.validation_state === "PENDING"
      && Number.isInteger(attempt.validation_pid);
  });
  const activeAttempt = service.db.prepare("SELECT * FROM attempts WHERE id = ?").get(attemptId);
  assert.equal(activeAttempt.scheduler_pid, process.pid);
  assert.notEqual(activeAttempt.validation_pid, process.pid);
  assert.doesNotThrow(() => process.kill(activeAttempt.validation_pid, 0));
  const epochBefore = service.db.prepare("SELECT value FROM metadata WHERE key = 'scheduler_epoch'").get().value;
  await assert.rejects(service.runJob(second.id), /running job|live attempt/);
  assert.equal(service.db.prepare("SELECT value FROM metadata WHERE key = 'scheduler_epoch'").get().value, epochBefore);
  assert.equal(service.getJob(second.id).status, "PENDING");

  // Isolate the validator receipt: even without the scheduler owner, the real spawned validator fences recovery.
  service.db.prepare("UPDATE attempts SET scheduler_pid = NULL WHERE id = ?").run(attemptId);
  const reconciliation = await service.reconcile({ apply: true });
  assert.equal(reconciliation.applied, false);
  assert.equal(reconciliation.refused, "LIVE_ATTEMPT_PROCESS");
  assert.equal(reconciliation.observations[0].phase, "VALIDATION");
  assert.equal(reconciliation.observations[0].validation_pid, activeAttempt.validation_pid);
  assert.equal(reconciliation.observations[0].validation_alive, true);
  assert.equal(service.db.prepare("SELECT value FROM metadata WHERE key = 'scheduler_epoch'").get().value, epochBefore);

  fs.writeFileSync(release, "go\n");
  const result = await run;
  assert.equal(result.job.status, "READY_FOR_INTEGRATION");
  assert.equal(result.attempts[0].terminal_state, "SUCCEEDED");
  assert.equal(result.attempts[0].validation_state, "PASSED");
});

test("the lifecycle-active attempt predicate independently fences a claim", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: new FakeBackend() });
  t.after(async () => { service.close(); await cleanup(); });
  const project = await service.addProject({ name: "Fixture", repoPath: repo });
  const first = await service.createJob({ projectId: project.id, goal: "inconsistent validation state" });
  const second = await service.createJob({ projectId: project.id, goal: "must remain fenced" });
  service.db.prepare(`INSERT INTO attempts(
    id, job_id, ordinal, scheduler_epoch, terminal_state, validation_state,
    backend, worktree_path, started_at
  ) VALUES (?, ?, 1, 1, 'SUCCEEDED', 'PENDING', 'FakeBackend', ?, ?)`).run(
    "attempt-defense-in-depth", first.id, repo, new Date().toISOString(),
  );
  const epochBefore = service.db.prepare("SELECT value FROM metadata WHERE key = 'scheduler_epoch'").get().value;
  await assert.rejects(service.runJob(second.id), /live attempt/);
  const epochAfter = service.db.prepare("SELECT value FROM metadata WHERE key = 'scheduler_epoch'").get().value;
  assert.equal(epochAfter, epochBefore);
  assert.equal(service.getJob(second.id).status, "PENDING");
});

test("reconciliation detects and classifies an interrupted SUCCEEDED/PENDING validation attempt", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: new FakeBackend() });
  t.after(async () => { service.close(); await cleanup(); });
  const project = await service.addProject({ name: "Fixture", repoPath: repo });
  const job = await service.createJob({ projectId: project.id, goal: "interrupted validation", maxAttempts: 2 });
  service.db.prepare("UPDATE jobs SET status = 'RUNNING' WHERE id = ?").run(job.id);
  service.db.prepare(`INSERT INTO attempts(
    id, job_id, ordinal, scheduler_epoch, terminal_state, validation_state,
    backend, worktree_path, started_at
  ) VALUES (?, ?, 1, 1, 'SUCCEEDED', 'PENDING', 'FakeBackend', ?, ?)`).run(
    "attempt-interrupted", job.id, path.join(root, "interrupted-worktree"), new Date().toISOString(),
  );
  const preview = await service.reconcile();
  assert.equal(preview.applied, false);
  assert.equal(preview.observations[0].phase, "VALIDATION");
  assert.equal(preview.observations[0].proposed, "VALIDATION_INTERRUPTED");
  assert.equal(service.status(job.id).attempts[0].validation_state, "PENDING");
  const epochBefore = Number(service.db.prepare("SELECT value FROM metadata WHERE key = 'scheduler_epoch'").get().value);
  const result = await service.reconcile({ apply: true });
  assert.equal(result.applied, true);
  assert.equal(result.scheduler_epoch, epochBefore + 1);
  assert.equal(result.results[0].action, "VALIDATION_INTERRUPTED");
  const state = service.status(job.id);
  assert.equal(state.job.status, "PENDING");
  assert.equal(state.attempts[0].terminal_state, "SUCCEEDED");
  assert.equal(state.attempts[0].validation_state, "FAILED");
  assert.equal(state.attempts[0].quarantined, 1);
  assert.equal(state.attempts[0].worktree_locked, 1);
  const interrupted = service.db.prepare(
    "SELECT COUNT(*) AS count FROM events WHERE kind = 'VALIDATION_INTERRUPTED' AND entity_id = ?",
  ).get("attempt-interrupted").count;
  assert.equal(interrupted, 1);
});
