import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeDataRoot, openDatabase, SCHEMA_VERSION } from "../src/db.js";
import { managedPaths } from "../src/paths.js";
import { FakeBackend, OpenCodeBackend } from "../src/backend.js";
import {
  DEFAULT_WORKER_MODEL, Dispatcher, ESCALATION_MODEL, isProcessAlive, REVIEW_MODEL,
} from "../src/service.js";
import { CONTROL_AUTHORITY_NAMES, runProcess, runShell } from "../src/process.js";

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

test("overview is SQL-bounded, compact, and excludes detailed execution state", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-overview-"));
  const root = path.join(temp, "data");
  initializeDataRoot(root);
  const service = new Dispatcher({ root, backend: new FakeBackend() });
  t.after(() => { service.close(); fs.rmSync(temp, { recursive: true, force: true }); });
  const insertProject = service.db.prepare(`INSERT INTO projects(
    id, name, repo_path, integration_branch, validation_json, protected_json, created_at
  ) VALUES (?, ?, ?, 'main', '[]', '[]', ?)`);
  const insertJob = service.db.prepare(`INSERT INTO jobs(
    id, project_id, goal, mode, status, base_sha, max_attempts, created_at, updated_at
  ) VALUES (?, ?, ?, 'write', ?, ?, 1, ?, ?)`);
  for (let index = 0; index < 25; index += 1) {
    const timestamp = new Date(Date.UTC(2026, 7, 14, 0, index)).toISOString();
    insertProject.run(`project-${index}`, `Project ${index}`, path.join(temp, `repo-${index}`), timestamp);
    insertJob.run(
      `job-${index}`, `project-${index}`, `Goal ${index} ${"x".repeat(500)}`,
      index % 2 ? "NEEDS_ATTENTION" : "READY_FOR_INTEGRATION", "a".repeat(40), timestamp, timestamp,
    );
  }
  const overview = service.overview();
  const serialized = JSON.stringify(overview);
  assert.equal(overview.schema_version, 1);
  assert.deepEqual(overview.totals, {
    projects: 25, jobs_needing_attention: 12, jobs_ready_for_integration: 13, proposals_awaiting_decision: 0,
  });
  assert.ok(overview.projects.length <= 20);
  assert.ok(overview.attention.length <= 20);
  assert.equal(overview.truncated, true);
  assert.ok(overview.attention.every((item) => item.summary.length <= 160));
  assert.ok(Buffer.byteLength(serialized, "utf8") <= 3 * 1024);
  assert.doesNotMatch(serialized, /repo_path|worktree|validation|failure_signature|artifact/);
});

test("overview health cannot be greener than doctor when a repository is missing", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const movedRepo = `${repo}-missing`;
  const service = new Dispatcher({ root, backend: new FakeBackend() });
  t.after(async () => { service.close(); await cleanup(); });
  await service.addProject({ name: "Missing repository", repoPath: repo, validation: [] });
  fs.renameSync(repo, movedRepo);
  try {
    const doctor = service.doctor();
    const overview = service.overview();
    assert.equal(doctor.healthy, false);
    assert.equal(doctor.missing_repositories.length, 1);
    assert.equal(overview.health.healthy, false);
    assert.equal(overview.health.missing_repositories, 1);
    assert.doesNotMatch(JSON.stringify(overview), /repo_path|repo-missing/);
  } finally {
    fs.renameSync(movedRepo, repo);
  }
});

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

test("child processes exclude every Control API authority credential unless explicitly supplied", async (t) => {
  // Drives the full declared set rather than a hand-listed subset, so a newly declared credential
  // role cannot quietly remain inheritable (CTL-AUTH-005).
  const saved = new Map(CONTROL_AUTHORITY_NAMES.map((name) => [name, process.env[name]]));
  for (const name of CONTROL_AUTHORITY_NAMES) process.env[name] = `must-not-inherit-${name}`;
  t.after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  assert.ok(CONTROL_AUTHORITY_NAMES.includes("DELEGATE_WAVE_CONTROL_PROPOSER_TOKEN"));
  assert.ok(CONTROL_AUTHORITY_NAMES.includes("DELEGATE_WAVE_CONTROL_PROPOSER_PRINCIPAL"));

  const script = `process.stdout.write(${JSON.stringify(CONTROL_AUTHORITY_NAMES)}
    .map((name) => process.env[name]).filter(Boolean).join(',') || 'absent')`;

  // A generic child, as used for Git commands and Git hooks.
  const scrubbed = await runProcess(process.execPath, ["-e", script]);
  assert.equal(scrubbed.stdout, "absent");

  // A validation command, which runs repository-controlled content through the shell. Probe by
  // environment name rather than by embedding a script, so quoting cannot mask a leak.
  const validated = await runShell(
    "if ($env:DELEGATE_WAVE_CONTROL_PROPOSER_TOKEN -or $env:DELEGATE_WAVE_CONTROL_TOKEN)"
    + " { 'leaked' } else { 'absent' }",
  );
  assert.equal(validated.stdout.trim(), "absent");

  // An explicitly launched Control API client may still receive exactly the credential it requires.
  const explicit = await runProcess(process.execPath, ["-e", script], {
    env: { DELEGATE_WAVE_CONTROL_TOKEN: "explicit-test-token" },
  });
  assert.equal(explicit.stdout, "explicit-test-token");
});

test("the executor backend receives no Control authority credential", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const saved = new Map(CONTROL_AUTHORITY_NAMES.map((name) => [name, process.env[name]]));
  for (const name of CONTROL_AUTHORITY_NAMES) process.env[name] = `must-not-inherit-${name}`;

  let observed = null;
  const backend = new FakeBackend(async ({ worktreePath }) => {
    // Spawn through the same helper the real executor uses, and report what it inherited.
    const probe = await runProcess(process.execPath, ["-e",
      `process.stdout.write(${JSON.stringify(CONTROL_AUTHORITY_NAMES)}
        .map((name) => process.env[name]).filter(Boolean).join(',') || 'absent')`]);
    observed = probe.stdout;
    fs.writeFileSync(path.join(worktreePath, "out.txt"), "done\n");
    return { exitCode: 0, stdout: "ok", stderr: "" };
  });
  const service = new Dispatcher({ root, backend });
  t.after(async () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    service.close();
    await cleanup();
  });

  const project = await service.addProject({ name: "Scrub", repoPath: repo, validation: [] });
  const job = await service.createJob({ projectId: project.id, goal: "produce out.txt" });
  await service.runJob(job.id);
  assert.equal(observed, "absent", "an executor child must inherit no Control authority credential");
});

test("project and job rows roll back when their event receipt fails", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: new FakeBackend() });
  t.after(async () => { service.close(); await cleanup(); });
  service.db.exec(`CREATE TRIGGER injected_event_failure BEFORE INSERT ON events
    BEGIN SELECT RAISE(ABORT, 'injected event failure'); END`);
  await assert.rejects(service.addProject({ name: "Rollback", repoPath: repo }), /injected event failure/);
  assert.equal(service.db.prepare("SELECT COUNT(*) AS count FROM projects").get().count, 0);
  service.db.exec("DROP TRIGGER injected_event_failure");
  const project = await service.addProject({ name: "Rollback", repoPath: repo });
  service.db.exec(`CREATE TRIGGER injected_event_failure BEFORE INSERT ON events
    BEGIN SELECT RAISE(ABORT, 'injected event failure'); END`);
  await assert.rejects(service.createJob({ projectId: project.id, goal: "must roll back" }), /injected event failure/);
  assert.equal(service.db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count, 0);
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
  // `exit 9` was a shell builtin, which only ever meant anything because validation went through an
  // interpreter. Validation now runs one program with an argument vector, so a failing check has to
  // be a program that fails -- which is also the only kind whose nonzero status says anything about
  // the candidate.
  const project = await service.addProject({
    name: "Fixture", repoPath: repo, validation: ['node -e "process.exit(9)"'],
  });
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
  let deadPid;
  await runProcess(process.execPath, ["-e", "process.exit(0)"], { onSpawn: (pid) => { deadPid = pid; } });
  assert.equal(isProcessAlive(deadPid), false);
  service.db.prepare("UPDATE jobs SET status = 'RUNNING' WHERE id = ?").run(job.id);
  service.db.prepare(`INSERT INTO attempts(
    id, job_id, ordinal, scheduler_epoch, backend, executor_pid, worktree_path, started_at
  ) VALUES (?, ?, 1, 1, 'FakeBackend', ?, ?, ?)`).run(
    "attempt-dead", job.id, deadPid, path.join(root, "missing-worktree"), new Date().toISOString(),
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

test("process liveness fails closed except for definite nonexistence", () => {
  assert.equal(isProcessAlive(42, () => {}), true);
  assert.equal(isProcessAlive(42, () => { const error = new Error("denied"); error.code = "EPERM"; throw error; }), true);
  assert.equal(isProcessAlive(42, () => { const error = new Error("unknown"); error.code = "EIO"; throw error; }), true);
  assert.equal(isProcessAlive(42, () => { const error = new Error("missing"); error.code = "ESRCH"; throw error; }), false);
  assert.equal(isProcessAlive(42, () => { const error = new Error("missing"); error.code = "ENOENT"; throw error; }), false);
});

test("durable executor intent fences reconciliation before an executor PID is published", async (t) => {
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
  assert.match(attempt.executor_intent_id, /^executor_/);
  assert.equal(attempt.executor_pid, null);
  assert.throws(
    () => service.recordExecutorPid(attempt.id, attempt.scheduler_epoch, "wrong-intent", process.pid),
    /Stale executor start/,
  );
  const epochBefore = service.db.prepare("SELECT value FROM metadata WHERE key = 'scheduler_epoch'").get().value;
  const reconciliation = await service.reconcile({ apply: true });
  assert.equal(reconciliation.applied, false);
  assert.equal(reconciliation.refused, "LIVE_ATTEMPT_PROCESS");
  assert.equal(reconciliation.observations[0].scheduler_alive, true);
  assert.equal(service.db.prepare("SELECT value FROM metadata WHERE key = 'scheduler_epoch'").get().value, epochBefore);

  service.db.prepare("UPDATE attempts SET scheduler_pid = NULL WHERE id = ?").run(attempt.id);
  const uncertain = await service.reconcile({ apply: true });
  assert.equal(uncertain.applied, false);
  assert.equal(uncertain.refused, "UNCERTAIN_EXECUTOR_START");
  assert.equal(uncertain.observations[0].executor_intent_id, attempt.executor_intent_id);
  assert.equal(uncertain.observations[0].executor_start_uncertain, true);
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
  // NOT_RUN, not FAILED: an interrupted validation reached no verdict, so recording FAILED would
  // assert the candidate was tested and rejected. The quarantine is what keeps it out of
  // integration; the verdict field only has to be true.
  assert.equal(state.attempts[0].validation_state, "NOT_RUN");
  assert.equal(state.attempts[0].quarantined, 1);
  assert.equal(state.attempts[0].worktree_locked, 1);
  const interrupted = service.db.prepare(
    "SELECT COUNT(*) AS count FROM events WHERE kind = 'VALIDATION_INTERRUPTED' AND entity_id = ?",
  ).get("attempt-interrupted").count;
  assert.equal(interrupted, 1);
});

test("reconciliation fails closed for durable validation intent without a PID receipt", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: new FakeBackend() });
  t.after(async () => { service.close(); await cleanup(); });
  const project = await service.addProject({ name: "Fixture", repoPath: repo });
  const job = await service.createJob({ projectId: project.id, goal: "uncertain validation start" });
  service.db.prepare("UPDATE jobs SET status = 'RUNNING' WHERE id = ?").run(job.id);
  service.db.prepare(`INSERT INTO attempts(
    id, job_id, ordinal, scheduler_epoch, terminal_state, validation_state,
    backend, validation_intent_id, worktree_path, started_at
  ) VALUES (?, ?, 1, 1, 'SUCCEEDED', 'PENDING', 'FakeBackend', ?, ?, ?)`).run(
    "attempt-uncertain-validation", job.id, "validation-intent-only", repo, new Date().toISOString(),
  );
  const epochBefore = service.db.prepare("SELECT value FROM metadata WHERE key = 'scheduler_epoch'").get().value;
  const preview = await service.reconcile();
  assert.equal(preview.observations[0].proposed, "REFUSE_UNCERTAIN_VALIDATION_START");
  const result = await service.reconcile({ apply: true });
  assert.equal(result.applied, false);
  assert.equal(result.refused, "UNCERTAIN_VALIDATION_START");
  assert.equal(service.db.prepare("SELECT value FROM metadata WHERE key = 'scheduler_epoch'").get().value, epochBefore);
  assert.equal(service.status(job.id).attempts[0].validation_state, "PENDING");
});

test("a legacy database migrates forward to the current schema with the work proposal objects", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-schema-9-"));
  const root = path.join(temp, "data");
  initializeDataRoot(root);
  const file = managedPaths(root).database;

  // Rewind to a pre-PR9 database: drop the new objects and re-stamp the old version.
  const seed = openDatabase(file);
  seed.exec(`
    DROP TRIGGER IF EXISTS trg_work_proposals_immutable_update;
    DROP TRIGGER IF EXISTS trg_work_proposals_immutable_delete;
    DROP TRIGGER IF EXISTS trg_work_decisions_immutable_update;
    DROP TRIGGER IF EXISTS trg_work_decisions_immutable_delete;
    DROP INDEX IF EXISTS idx_work_proposals_project;
    DROP INDEX IF EXISTS idx_work_decisions_job;
    DROP TABLE IF EXISTS work_proposal_decisions;
    DROP TABLE IF EXISTS work_proposals;
  `);
  seed.prepare("UPDATE metadata SET value = '9' WHERE key = 'schema_version'").run();
  assert.equal(seed.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get().value, "9");
  seed.close();

  const upgraded = openDatabase(file);
  t.after(() => { upgraded.close(); fs.rmSync(temp, { recursive: true, force: true }); });
  // Asserted against the constant so a later schema bump does not require editing this test.
  assert.equal(upgraded.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get().value, SCHEMA_VERSION);

  const names = (type) => upgraded.prepare("SELECT name FROM sqlite_master WHERE type = ?").all(type)
    .map((row) => row.name);
  assert.ok(names("table").includes("work_proposals"));
  assert.ok(names("table").includes("work_proposal_decisions"));
  for (const trigger of [
    "trg_work_proposals_immutable_update", "trg_work_proposals_immutable_delete",
    "trg_work_decisions_immutable_update", "trg_work_decisions_immutable_delete",
  ]) assert.ok(names("trigger").includes(trigger), `missing trigger ${trigger}`);
  for (const index of ["idx_work_proposals_project", "idx_work_decisions_job"]) {
    assert.ok(names("index").includes(index), `missing index ${index}`);
  }
});

test("a fresh database is created at the current schema version", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-schema-fresh-"));
  const root = path.join(temp, "data");
  initializeDataRoot(root);
  const db = openDatabase(managedPaths(root).database);
  t.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });
  assert.equal(db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get().value, SCHEMA_VERSION);
  assert.equal(Number(SCHEMA_VERSION) >= 11, true, "work proposals and usage receipts require schema 11+");
});

test("a job without --model resolves to DeepSeek Flash and persists the resolved model", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-default-model-"));
  const root = path.join(temp, "data");
  const repo = path.join(temp, "repo");
  fs.mkdirSync(repo);
  for (const args of [["init", "-b", "main"], ["config", "user.name", "T"], ["config", "user.email", "t@e.invalid"]]) {
    await runProcess("git", ["-C", repo, ...args]);
  }
  fs.writeFileSync(path.join(repo, "seed.txt"), "seed\n");
  await runProcess("git", ["-C", repo, "add", "."]);
  await runProcess("git", ["-C", repo, "commit", "-m", "initial"]);
  await runProcess("git", ["-C", repo, "branch", "integration"]);
  initializeDataRoot(root);

  const seen = [];
  const backend = new FakeBackend(async ({ worktreePath, model }) => {
    seen.push(model);
    fs.writeFileSync(path.join(worktreePath, "out.txt"), "done\n");
    return { exitCode: 0, stdout: "ok", stderr: "" };
  });
  const service = new Dispatcher({ root, backend });
  t.after(async () => {
    service.close();
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

  const project = await service.addProject({ name: "Routing", repoPath: repo, branch: "integration", validation: [] });
  const job = await service.createJob({ projectId: project.id, goal: "produce out.txt" });
  const result = await service.runJob(job.id);

  assert.deepEqual(seen, [DEFAULT_WORKER_MODEL]);
  assert.equal(DEFAULT_WORKER_MODEL, "opencode-go/deepseek-v4-flash");
  assert.equal(result.attempts.at(-1).model, DEFAULT_WORKER_MODEL, "the resolved model must be persisted");
});

test("the OpenCode backend refuses to run without an explicit model", async () => {
  const backend = new OpenCodeBackend({ executable: "opencode" });
  await assert.rejects(
    backend.run({
      attemptId: "a1", worktreePath: ".", goal: "g", model: null,
      artifactDir: path.join(os.tmpdir(), `dw-nomodel-${Date.now()}`), mode: "write",
    }),
    /requires an explicit --model/,
  );
});

test("explicit review and escalation lanes stay distinct from the default", () => {
  assert.equal(REVIEW_MODEL, "opencode-go/gpt-5.6-luna");
  assert.equal(ESCALATION_MODEL, "opencode-go/deepseek-v4-pro");
  assert.equal(new Set([DEFAULT_WORKER_MODEL, REVIEW_MODEL, ESCALATION_MODEL]).size, 3);
});

test("usage is persisted for a failed attempt and never affects acceptance", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  // A worker that burns tokens and then exits nonzero: the attempt fails, but the cost is real.
  const backend = new FakeBackend(async ({ artifactDir }) => {
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, "opencode-events.jsonl"), [
      JSON.stringify({ type: "step_finish", part: { tokens: { input: 900, output: 40, reasoning: 3, cache: { read: 2000, write: 0 } }, cost: 0.00009 } }),
      JSON.stringify({ type: "step_finish", part: { tokens: { input: 800, output: 30, reasoning: 2, cache: { read: 1500, write: 0 } }, cost: 0.00008 } }),
    ].join("\n"));
    return { exitCode: 3, stdout: "", stderr: "worker gave up" };
  });
  const service = new Dispatcher({ root, backend });
  t.after(async () => { service.close(); await cleanup(); });

  const project = await service.addProject({ name: "FailUsage", repoPath: repo, validation: [] });
  const job = await service.createJob({ projectId: project.id, goal: "will fail", maxAttempts: 1 });
  const result = await service.runJob(job.id);

  const attempt = result.attempts.at(-1);
  assert.equal(attempt.terminal_state, "FAILED");

  const usage = service.getAttemptUsage(attempt.id);
  assert.ok(usage, "a failed attempt must still carry its usage receipt");
  assert.equal(usage.status, "COMPLETE");
  assert.equal(usage.provider_steps, 2);
  assert.equal(usage.input_tokens, 1700);
  assert.ok(Math.abs(usage.reported_cost_usd - 0.00017) < 1e-12);
  // Evidence must not launder a failure into success.
  assert.notEqual(attempt.terminal_state, "SUCCEEDED");
  assert.equal(result.job.status, "NEEDS_ATTENTION");
});

test("usage is retained when validation fails after a successful executor", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const backend = new FakeBackend(async ({ worktreePath, artifactDir }) => {
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, "opencode-events.jsonl"),
      JSON.stringify({ type: "step_finish", part: { tokens: { input: 500, output: 25, reasoning: 0, cache: { read: 1000, write: 0 } }, cost: 0.00005 } }));
    fs.writeFileSync(path.join(worktreePath, "out.txt"), "produced\n");
    return { exitCode: 0, stdout: "ok", stderr: "" };
  });
  const service = new Dispatcher({ root, backend });
  t.after(async () => { service.close(); await cleanup(); });

  const project = await service.addProject({
    name: "ValFailUsage", repoPath: repo, validation: ["node -e \"process.exit(1)\""],
  });
  const job = await service.createJob({ projectId: project.id, goal: "fails validation", maxAttempts: 1 });
  const result = await service.runJob(job.id);

  const attempt = result.attempts.at(-1);
  assert.equal(attempt.validation_state, "FAILED");
  const usage = service.getAttemptUsage(attempt.id);
  assert.ok(usage, "validation failure must not discard the usage receipt");
  assert.equal(usage.input_tokens, 500);
  assert.equal(usage.status, "COMPLETE");
});

test("an attempt with no usage artifact records UNKNOWN rather than zero", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  // Mirrors the live ProviderAuthError failure: the executor died before any model call.
  const backend = new FakeBackend(async () => ({ exitCode: 1, stdout: "", stderr: "auth failed" }));
  const service = new Dispatcher({ root, backend });
  t.after(async () => { service.close(); await cleanup(); });

  const project = await service.addProject({ name: "NoUsage", repoPath: repo, validation: [] });
  const job = await service.createJob({ projectId: project.id, goal: "dies early", maxAttempts: 1 });
  const result = await service.runJob(job.id);

  const usage = service.getAttemptUsage(result.attempts.at(-1).id);
  assert.equal(usage.status, "UNKNOWN");
  assert.equal(usage.input_tokens, null, "absent usage must never be recorded as zero");
  assert.equal(usage.reported_cost_usd, null);
  assert.equal(usage.reference_cost_usd, null);
  assert.equal(usage.provider_steps, 0);
});

test("recording usage twice for one attempt does not double-count", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const backend = new FakeBackend(async ({ worktreePath, artifactDir }) => {
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, "opencode-events.jsonl"),
      JSON.stringify({ type: "step_finish", part: { tokens: { input: 700, output: 20, reasoning: 0, cache: { read: 900, write: 0 } }, cost: 0.00007 } }));
    fs.writeFileSync(path.join(worktreePath, "out.txt"), "ok\n");
    return { exitCode: 0, stdout: "ok", stderr: "" };
  });
  const service = new Dispatcher({ root, backend });
  t.after(async () => { service.close(); await cleanup(); });

  const project = await service.addProject({ name: "Idem", repoPath: repo, validation: [] });
  const job = await service.createJob({ projectId: project.id, goal: "produce out.txt" });
  const result = await service.runJob(job.id);
  const attemptId = result.attempts.at(-1).id;
  const before = service.getAttemptUsage(attemptId);

  const artifactDir = path.join(root, "artifacts", project.id, attemptId);
  assert.equal(service.recordAttemptUsage({ attemptId, artifactDir, model: "opencode-go/deepseek-v4-flash" }), null);
  assert.deepEqual(service.getAttemptUsage(attemptId), before, "a second record must be a no-op");
  assert.equal(before.input_tokens, 700);
});

test("usage receipts are immutable once written", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const backend = new FakeBackend(async ({ worktreePath, artifactDir }) => {
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, "opencode-events.jsonl"),
      JSON.stringify({ type: "step_finish", part: { tokens: { input: 100, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.00001 } }));
    fs.writeFileSync(path.join(worktreePath, "out.txt"), "ok\n");
    return { exitCode: 0, stdout: "ok", stderr: "" };
  });
  const service = new Dispatcher({ root, backend });
  t.after(async () => { service.close(); await cleanup(); });

  const project = await service.addProject({ name: "Immutable", repoPath: repo, validation: [] });
  const job = await service.createJob({ projectId: project.id, goal: "produce out.txt" });
  const attemptId = (await service.runJob(job.id)).attempts.at(-1).id;

  assert.throws(
    () => service.db.prepare("UPDATE attempt_usage_receipts SET input_tokens = 999 WHERE attempt_id = ?").run(attemptId),
    /immutable/,
  );
  assert.throws(
    () => service.db.prepare("DELETE FROM attempt_usage_receipts WHERE attempt_id = ?").run(attemptId),
    /immutable/,
  );
});

test("a backend that throws after emitting usage still records its receipt", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  // Provider work happened, then the runtime failed: the tokens were still spent.
  const backend = new FakeBackend(async ({ artifactDir }) => {
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, "opencode-events.jsonl"), [
      JSON.stringify({ type: "step_finish", part: { tokens: { input: 600, output: 30, reasoning: 2, cache: { read: 1200, write: 0 } }, cost: 0.00006 } }),
      JSON.stringify({ type: "step_finish", part: { tokens: { input: 400, output: 20, reasoning: 1, cache: { read: 800, write: 0 } }, cost: 0.00004 } }),
    ].join("\n"));
    throw new Error("transport died after the model calls");
  });
  const service = new Dispatcher({ root, backend });
  t.after(async () => { service.close(); await cleanup(); });

  const project = await service.addProject({ name: "ThrowUsage", repoPath: repo, validation: [] });
  const job = await service.createJob({ projectId: project.id, goal: "throws late", maxAttempts: 1 });
  const result = await service.runJob(job.id);

  const attempt = result.attempts.at(-1);
  assert.equal(attempt.terminal_state, "FAILED");
  const usage = service.getAttemptUsage(attempt.id);
  assert.ok(usage, "a throwing backend must not lose its usage evidence");
  assert.equal(usage.status, "COMPLETE");
  assert.equal(usage.input_tokens, 1000);
  assert.equal(usage.provider_steps, 2);
  assert.equal(usage.reported_cost_source, "executor-computed");
});

test("a backend that throws before any model call records UNKNOWN", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const backend = new FakeBackend(async () => { throw new Error("spawn failed"); });
  const service = new Dispatcher({ root, backend });
  t.after(async () => { service.close(); await cleanup(); });

  const project = await service.addProject({ name: "ThrowEarly", repoPath: repo, validation: [] });
  const job = await service.createJob({ projectId: project.id, goal: "dies at spawn", maxAttempts: 1 });
  const result = await service.runJob(job.id);

  const usage = service.getAttemptUsage(result.attempts.at(-1).id);
  assert.equal(usage.status, "UNKNOWN");
  assert.equal(usage.input_tokens, null);
  assert.equal(usage.provider_steps, 0);
});

test("a backend may supply its own observation without computing the reference cost", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  // Models a non-OpenCode backend: it reports what its provider said and nothing more.
  const backend = new FakeBackend(async ({ worktreePath }) => {
    fs.writeFileSync(path.join(worktreePath, "out.txt"), "ok\n");
    return {
      exitCode: 0, stdout: "ok", stderr: "",
      usage: {
        status: "COMPLETE",
        input_tokens: 2000, output_tokens: 100, reasoning_tokens: 10,
        cache_read_tokens: 5000, cache_write_tokens: 0,
        provider_steps: 3, reported_cost_usd: null, reported_cost_source: null,
        malformed_events: 0, source_artifact: "harness-session.jsonl", source_format: "harness-events",
      },
    };
  });
  const service = new Dispatcher({ root, backend });
  t.after(async () => { service.close(); await cleanup(); });

  const project = await service.addProject({ name: "OwnUsage", repoPath: repo, validation: [] });
  const job = await service.createJob({ projectId: project.id, goal: "produce out.txt" });
  const usage = service.getAttemptUsage((await service.runJob(job.id)).attempts.at(-1).id);

  assert.equal(usage.source_format, "harness-events", "backend provenance must survive");
  assert.equal(usage.input_tokens, 2000);
  assert.equal(usage.reported_cost_usd, null);
  // Pricing is applied centrally, so a backend that reports no cost still gets a reference cost.
  assert.ok(usage.reference_cost_usd > 0, "delegate-wave prices the observation, not the backend");
  assert.equal(usage.pricing_basis_id, "deepseek-direct-2026-08-14-v2");
});

test("a usage capture failure is visible and breaks measurement health, not the attempt", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const backend = new FakeBackend(async ({ worktreePath }) => {
    fs.writeFileSync(path.join(worktreePath, "out.txt"), "ok\n");
    return { exitCode: 0, stdout: "ok", stderr: "" };
  });
  const service = new Dispatcher({ root, backend });
  t.after(async () => { service.close(); await cleanup(); });

  // Simulate a normalization/schema defect.
  const realFinalize = service.recordAttemptUsage.bind(service);
  service.recordAttemptUsage = (args) => realFinalize({
    ...args,
    backend: { constructor: { name: "Broken" }, observeUsage: () => { throw new Error("injected parser fault"); } },
  });

  const project = await service.addProject({ name: "Unhealthy", repoPath: repo, validation: [] });
  const job = await service.createJob({ projectId: project.id, goal: "produce out.txt" });
  const result = await service.runJob(job.id);
  const attemptId = result.attempts.at(-1).id;

  // The product task still succeeds.
  assert.equal(result.attempts.at(-1).terminal_state, "SUCCEEDED");
  assert.equal(service.getAttemptUsage(attemptId), null);

  // But the failure is durable and the dataset is not healthy-by-silence.
  const failure = service.db.prepare(
    "SELECT * FROM events WHERE kind = 'USAGE_RECEIPT_FAILED' AND entity_id = ?",
  ).get(attemptId);
  assert.ok(failure, "a capture failure must leave a durable record");

  // Accounted for, but NOT healthy: the attempt has no defensible cost, so a
  // cost-per-validated-candidate result computed over this dataset would be indefensible.
  const coverage = service.usageCoverage({ jobIds: [job.id] });
  assert.equal(coverage.accounted, true, "the failure is explained rather than silently missing");
  assert.equal(coverage.healthy, false, "a known capture failure must invalidate the dataset");
  assert.deepEqual(coverage.capture_failures, [attemptId]);
  assert.deepEqual(coverage.missing_evidence, []);
});

test("usage coverage reports an attempt with neither a receipt nor a failure record", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const backend = new FakeBackend(async ({ worktreePath, artifactDir }) => {
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, "opencode-events.jsonl"), JSON.stringify({
      type: "step_finish",
      part: { tokens: { input: 300, output: 15, reasoning: 0, cache: { read: 600, write: 0 } }, cost: 0.00003 },
    }));
    fs.writeFileSync(path.join(worktreePath, "out.txt"), "ok\n");
    return { exitCode: 0, stdout: "ok", stderr: "" };
  });
  const service = new Dispatcher({ root, backend });
  t.after(async () => { service.close(); await cleanup(); });

  const project = await service.addProject({ name: "Coverage", repoPath: repo, validation: [] });
  const job = await service.createJob({ projectId: project.id, goal: "produce out.txt" });
  const attemptId = (await service.runJob(job.id)).attempts.at(-1).id;
  assert.equal(service.usageCoverage({ jobIds: [job.id] }).healthy, true);

  // An attempt with no evidence at all must be reported, or a cost result would silently omit it.
  service.db.exec("DROP TRIGGER trg_usage_receipts_immutable_delete");
  service.db.prepare("DELETE FROM attempt_usage_receipts WHERE attempt_id = ?").run(attemptId);
  const coverage = service.usageCoverage({ jobIds: [job.id] });
  assert.equal(coverage.healthy, false);
  assert.equal(coverage.accounted, false, "an unexplained gap is worse than a recorded failure");
  assert.deepEqual(coverage.missing_evidence, [attemptId]);
  assert.deepEqual(coverage.capture_failures, []);
});

test("coverage excludes attempts that never reached executor intent", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const backend = new FakeBackend(async ({ worktreePath, artifactDir }) => {
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, "opencode-events.jsonl"), JSON.stringify({
      type: "step_finish",
      part: { tokens: { input: 400, output: 20, reasoning: 0, cache: { read: 800, write: 0 } }, cost: 0.00004 },
    }));
    fs.writeFileSync(path.join(worktreePath, "out.txt"), "ok\n");
    return { exitCode: 0, stdout: "ok", stderr: "" };
  });
  const service = new Dispatcher({ root, backend });
  t.after(async () => { service.close(); await cleanup(); });

  const project = await service.addProject({ name: "Eligibility", repoPath: repo, validation: [] });
  const job = await service.createJob({ projectId: project.id, goal: "produce out.txt" });
  const attemptId = (await service.runJob(job.id)).attempts.at(-1).id;
  assert.equal(service.usageCoverage({ jobIds: [job.id] }).attempts, 1);

  // An attempt that failed during worktree setup never invoked a backend and consumed no provider
  // usage, so it must not be reported as missing evidence.
  service.db.prepare(`INSERT INTO attempts(
    id, job_id, ordinal, scheduler_epoch, backend, model, worktree_path, started_at, terminal_state
  ) VALUES (?, ?, 99, 1, 'FakeBackend', 'opencode-go/deepseek-v4-flash', NULL, ?, 'FAILED')`)
    .run("attempt-never-started", job.id, new Date().toISOString());

  const coverage = service.usageCoverage({ jobIds: [job.id] });
  assert.equal(coverage.attempts, 1, "only attempts reaching EXECUTOR_INTENDED are eligible");
  assert.deepEqual(coverage.missing_evidence, []);
  assert.equal(coverage.healthy, true);
  assert.deepEqual(coverage.receipts, 1);
  assert.equal(service.getAttemptUsage(attemptId).status, "COMPLETE");
});

test("an invalid backend observation becomes visible missing evidence, not a corrupt receipt", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  // A backend reporting a cost with no provenance: SQLite would accept it, the finalizer must not.
  const backend = new FakeBackend(async ({ worktreePath }) => {
    fs.writeFileSync(path.join(worktreePath, "out.txt"), "ok\n");
    return {
      exitCode: 0, stdout: "ok", stderr: "",
      usage: {
        status: "COMPLETE",
        input_tokens: 100, output_tokens: 10, reasoning_tokens: 0,
        cache_read_tokens: 0, cache_write_tokens: 0,
        provider_steps: 1,
        reported_cost_usd: 0.001, reported_cost_source: null,
        malformed_events: 0, source_artifact: "x", source_format: "harness-events",
      },
    };
  });
  const service = new Dispatcher({ root, backend });
  t.after(async () => { service.close(); await cleanup(); });

  const project = await service.addProject({ name: "BadObs", repoPath: repo, validation: [] });
  const job = await service.createJob({ projectId: project.id, goal: "produce out.txt" });
  const result = await service.runJob(job.id);
  const attemptId = result.attempts.at(-1).id;

  assert.equal(result.attempts.at(-1).terminal_state, "SUCCEEDED", "measurement must not fail the task");
  assert.equal(service.getAttemptUsage(attemptId), null, "a corrupt receipt must not be stored");
  const coverage = service.usageCoverage({ jobIds: [job.id] });
  assert.equal(coverage.healthy, false);
  assert.deepEqual(coverage.capture_failures, [attemptId]);
});

test("an UNKNOWN, PARTIAL, or unpriced receipt is accounted for but not healthy", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  // Each case is a durable receipt that cannot support a defensible cost total.
  const cases = [
    ["unknown", null, "opencode-go/deepseek-v4-flash", "unknown_receipts"],
    ["partial", [
      JSON.stringify({ type: "step_finish", part: { tokens: { input: 100, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.00001 } }),
      '{"type":"step_finish","part":{"tokens":{"input":99',
    ].join("\n"), "opencode-go/deepseek-v4-flash", "partial_receipts"],
    // A model the pinned basis cannot price: COMPLETE usage, no reference cost.
    ["unpriced", JSON.stringify({ type: "step_finish", part: { tokens: { input: 100, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.00001 } }),
      "opencode-go/some-unpriced-model", "unpriced_receipts"],
  ];

  for (const [name, artifact, model, bucket] of cases) {
    const backend = new FakeBackend(async ({ worktreePath, artifactDir }) => {
      if (artifact !== null) {
        fs.mkdirSync(artifactDir, { recursive: true });
        fs.writeFileSync(path.join(artifactDir, "opencode-events.jsonl"), artifact);
      }
      fs.writeFileSync(path.join(worktreePath, `${name}.txt`), "ok\n");
      return { exitCode: 0, stdout: "ok", stderr: "" };
    });
    const service = new Dispatcher({ root: path.join(root, name), backend });
    const project = await service.addProject({ name, repoPath: repo, validation: [] });
    const job = await service.createJob({ projectId: project.id, goal: `produce ${name}.txt` });
    const attemptId = (await service.runJob(job.id, { model })).attempts.at(-1).id;

    const coverage = service.usageCoverage({ jobIds: [job.id] });
    assert.equal(coverage.accounted, true, `${name}: the attempt is explained`);
    assert.equal(coverage.healthy, false, `${name}: must not support a cost total`);
    assert.deepEqual(coverage[bucket], [attemptId], `${name}: reported in the right bucket`);
    assert.deepEqual(coverage.missing_evidence, []);
    service.close();
  }
  await cleanup();
});

// Per-attempt routing, end to end through the dispatcher.
//
// The attempt row must name the executor that actually ran, and a fallback attempt must get its own
// fresh worktree -- never the interrupted one, which may hold a half-finished edit.
test("each attempt records the executor that actually ran it and gets its own worktree", async (t) => {
  const { root, repo, cleanup } = await fixture(t);

  // Stands in for a Harness attempt that fails on a configuration problem, and an OpenCode attempt
  // that succeeds -- the exact fresh-attempt fallback sequence.
  class FailingHarness extends FakeBackend {
    async run() { throw new Error("the fenced filesystem is not in the composed Harness profile"); }
  }
  class WorkingOpenCode extends FakeBackend {}

  const worktrees = [];
  const router = {
    failed: false,
    select() {
      const backend = this.failed ? new WorkingOpenCode(async ({ worktreePath }) => {
        worktrees.push(worktreePath);
        fs.writeFileSync(path.join(worktreePath, "input.txt"), "after\n");
        return { exitCode: 0, stdout: "ok", stderr: "" };
      }) : new FailingHarness();
      return { backend, selected: this.failed ? "opencode" : "harness" };
    },
    disableHarness() { this.failed = true; },
  };

  const service = new Dispatcher({ root, router });
  try {
  const project = await service.addProject({ name: "routing", repoPath: repo, validation: [] });
  const job = await service.createJob({ projectId: project.id, goal: "change input", mode: "write", maxAttempts: 2 });

  // The Harness attempt fails honestly and terminates; it is never rescued by switching executor
  // partway through, which would put two executors behind one attempt identity.
  await service.runJob(job.id);
  const first = service.db.prepare("SELECT * FROM attempts WHERE job_id = ? ORDER BY ordinal").all(job.id);
  assert.equal(first.length, 1);
  assert.equal(first[0].backend, "FailingHarness", "the attempt names the executor that really ran");
  assert.equal(first[0].terminal_state, "FAILED");
  assert.equal(first[0].quarantined, 1, "and its worktree is quarantined");

  await service.runJob(job.id);
  const all = service.db.prepare("SELECT * FROM attempts WHERE job_id = ? ORDER BY ordinal").all(job.id);
  assert.equal(all.length, 2);
  assert.equal(all[1].backend, "WorkingOpenCode", "the fresh attempt used the fallback executor");
  assert.notEqual(all[1].worktree_path, all[0].worktree_path,
    "an interrupted attempt's worktree is never reused");
  assert.equal(all[1].terminal_state, "SUCCEEDED");
  } finally {
    // Closed before the worktrees are removed: t.after runs LIFO, so a registered cleanup would
    // otherwise fire while SQLite still holds the files open and fail with EPERM on Windows.
    service.close();
    await cleanup();
  }
});

// Candidate capture must be base-relative, because a trusted worker may use Git normally.
//
// Reading `git status` would see nothing from a worker that committed its work, and only the
// uncommitted remainder from one that committed part of it -- which would also hide the committed
// part from the protected-path check. Worker history is workspace activity; the candidate is the
// net tree the attempt produced.
const gitIn = async (cwd, ...args) => {
  const result = await runProcess("git", ["-C", cwd, ...args]);
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
};

// A worker that behaves exactly as the trusted prompt now invites: it uses local Git.
const committingWorker = (plan) => new FakeBackend(async ({ worktreePath, artifactDir }) => {
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, "opencode-events.jsonl"), JSON.stringify({
    type: "step_finish",
    part: { tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.00001 },
  }));
  await gitIn(worktreePath, "config", "user.name", "Worker");
  await gitIn(worktreePath, "config", "user.email", "worker@example.invalid");
  await plan({ worktreePath, write: (name, body) => fs.writeFileSync(path.join(worktreePath, name), body) });
  return { exitCode: 0, stdout: "ok", stderr: "" };
});

test("a worker that commits all of its work still produces a candidate", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: committingWorker(async ({ worktreePath, write }) => {
    write("ADDED.md", "committed by the worker\n");
    await gitIn(worktreePath, "add", "--all");
    await gitIn(worktreePath, "commit", "-m", "worker's own commit");
  }) });
  try {
    const project = await service.addProject({ name: "committed", repoPath: repo, validation: [] });
    const job = await service.createJob({ projectId: project.id, goal: "add a file", maxAttempts: 1 });
    await service.runJob(job.id);

    const attempt = service.db.prepare("SELECT * FROM attempts WHERE job_id = ?").get(job.id);
    assert.equal(attempt.terminal_state, "SUCCEEDED",
      "a clean worktree after a worker commit is not 'changed nothing'");
    assert.ok(attempt.result_commit, "and a candidate commit exists");
    const listed = await gitIn(repo, "show", "--name-only", "--format=", attempt.result_commit);
    assert.match(listed, /ADDED\.md/);
  } finally {
    service.close();
    await cleanup();
  }
});

// The mixed case, and the dangerous one: status would show only B, so A would be invisible to both
// the protected-path check and the candidate.
test("a worker that commits A and leaves B uncommitted yields a candidate containing both", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: committingWorker(async ({ worktreePath, write }) => {
    write("A.md", "committed\n");
    await gitIn(worktreePath, "add", "--all");
    await gitIn(worktreePath, "commit", "-m", "worker committed A");
    write("B.md", "left uncommitted\n");
  }) });
  try {
    const project = await service.addProject({ name: "mixed", repoPath: repo, validation: [] });
    const job = await service.createJob({ projectId: project.id, goal: "add two files", maxAttempts: 1 });
    await service.runJob(job.id);

    const attempt = service.db.prepare("SELECT * FROM attempts WHERE job_id = ?").get(job.id);
    assert.equal(attempt.terminal_state, "SUCCEEDED");
    const listed = await gitIn(repo, "show", "--name-only", "--format=", attempt.result_commit);
    assert.match(listed, /A\.md/, "the worker's committed change is in the candidate");
    assert.match(listed, /B\.md/, "and so is the uncommitted one");
  } finally {
    service.close();
    await cleanup();
  }
});

// The security-relevant half of the same bug: a protected path hidden inside a worker commit.
test("a protected-path change inside a worker commit is still rejected", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: committingWorker(async ({ worktreePath, write }) => {
    fs.mkdirSync(path.join(worktreePath, "secrets"), { recursive: true });
    write("secrets/keys.txt", "should never be accepted\n");
    await gitIn(worktreePath, "add", "--all");
    await gitIn(worktreePath, "commit", "-m", "worker committed a protected change");
    write("ALLOWED.md", "an ordinary change\n");
  }) });
  try {
    const project = await service.addProject({
      name: "protected", repoPath: repo, validation: [], protectedPaths: ["secrets/"],
    });
    const job = await service.createJob({ projectId: project.id, goal: "touch a protected path", maxAttempts: 1 });
    await service.runJob(job.id);

    const attempt = service.db.prepare("SELECT * FROM attempts WHERE job_id = ?").get(job.id);
    assert.equal(attempt.terminal_state, "FAILED",
      "the check must see the committed change, not only the uncommitted remainder");
    assert.equal(attempt.result_commit, null, "and no candidate is produced");
  } finally {
    service.close();
    await cleanup();
  }
});

// The candidate must be a single commit on the recorded base, whatever history the worker built,
// because integration cherry-picks exactly that one commit.
test("the candidate is one commit parented on the recorded base", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: committingWorker(async ({ worktreePath, write }) => {
    // Three commits and a branch: none of it may shape the candidate.
    await gitIn(worktreePath, "checkout", "-b", "worker-scratch");
    for (const name of ["one.md", "two.md"]) {
      write(name, `${name}\n`);
      await gitIn(worktreePath, "add", "--all");
      await gitIn(worktreePath, "commit", "-m", `worker commit for ${name}`);
    }
    write("three.md", "three\n");
  }) });
  try {
    const project = await service.addProject({ name: "canonical", repoPath: repo, validation: [] });
    const job = await service.createJob({ projectId: project.id, goal: "several changes", maxAttempts: 1 });
    const before = service.getJob(job.id).base_sha;
    await service.runJob(job.id);

    const attempt = service.db.prepare("SELECT * FROM attempts WHERE job_id = ?").get(job.id);
    const parents = (await gitIn(repo, "rev-list", "--parents", "-n", "1", attempt.result_commit)).split(" ");
    assert.equal(parents.length, 2, "exactly one parent");
    assert.equal(parents[1], before, "and it is the recorded base, not the worker's HEAD");

    const listed = await gitIn(repo, "show", "--name-only", "--format=", attempt.result_commit);
    for (const name of ["one.md", "two.md", "three.md"]) {
      assert.match(listed, new RegExp(name.replace(".", "\.")), `${name} is in the candidate`);
    }
  } finally {
    service.close();
    await cleanup();
  }
});

// Rename detection must never reach a policy decision.
//
// `git diff --find-renames --name-only` reports `protected/locked.txt -> allowed.txt` as a single
// entry and prints only the DESTINATION. The protected source then never reaches the check, so a
// worker could move a protected file out of its protected directory and have it accepted. Policy
// needs every path the tree touched, not Git's semantic interpretation of what the change meant.
const policyWorker = (plan) => new FakeBackend(async ({ worktreePath, artifactDir }) => {
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, "opencode-events.jsonl"), JSON.stringify({
    type: "step_finish",
    part: { tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.00001 },
  }));
  await plan({ worktreePath, run: (...args) => gitIn(worktreePath, ...args) });
  return { exitCode: 0, stdout: "ok", stderr: "" };
});

async function policyFixture(t, plan) {
  const { root, repo, cleanup } = await fixture(t);
  fs.mkdirSync(path.join(repo, "protected"), { recursive: true });
  fs.writeFileSync(path.join(repo, "protected", "locked.txt"), "must not move\n");
  fs.writeFileSync(path.join(repo, "allowed-a.txt"), "ordinary\n");
  await command("git", ["add", "."], repo);
  await command("git", ["commit", "-m", "add protected and allowed files"], repo);

  const service = new Dispatcher({ root, backend: policyWorker(plan) });
  const project = await service.addProject({
    name: `policy-${crypto.randomUUID().slice(0, 8)}`, repoPath: repo, validation: [],
    protectedPaths: ["protected/"],
  });
  const job = await service.createJob({ projectId: project.id, goal: "policy probe", maxAttempts: 1 });
  await service.runJob(job.id);
  const attempt = service.db.prepare("SELECT * FROM attempts WHERE job_id = ?").get(job.id);
  return { service, repo, attempt, cleanup };
}

test("renaming a protected file to an allowed path is rejected", async (t) => {
  const { service, attempt, cleanup } = await policyFixture(t, async ({ run }) => {
    await run("mv", "protected/locked.txt", "allowed.txt");
  });
  try {
    assert.equal(attempt.terminal_state, "FAILED",
      "rename detection must not hide the protected source from the policy check");
    assert.equal(attempt.result_commit, null, "and no candidate is produced");
  } finally {
    service.close();
    await cleanup();
  }
});

// The counterpart: legitimate renames must still work, or the fix would be a blunt instrument.
test("renaming one allowed file to another allowed path succeeds", async (t) => {
  const { service, repo, attempt, cleanup } = await policyFixture(t, async ({ run }) => {
    await run("mv", "allowed-a.txt", "allowed-b.txt");
  });
  try {
    assert.equal(attempt.terminal_state, "SUCCEEDED");
    // Asserted on the candidate's TREE, not on `git show`, which applies its own rename detection
    // when formatting and would report one path either way.
    const tree = await gitIn(repo, "ls-tree", "-r", "--name-only", attempt.result_commit);
    const names = tree.split("\n").map((line) => line.trim());
    assert.ok(names.includes("allowed-b.txt"), "the destination exists in the candidate tree");
    assert.ok(!names.includes("allowed-a.txt"), "and the source is gone from it");
    assert.ok(names.includes("protected/locked.txt"), "the untouched protected file is still there");
  } finally {
    service.close();
    await cleanup();
  }
});

test("deleting a protected file is caught", async (t) => {
  const { service, attempt, cleanup } = await policyFixture(t, async ({ run }) => {
    await run("rm", "protected/locked.txt");
  });
  try {
    assert.equal(attempt.terminal_state, "FAILED", "a deletion is a change to a protected path");
    assert.equal(attempt.result_commit, null);
  } finally {
    service.close();
    await cleanup();
  }
});

// The combination that would most plausibly slip past: a protected move buried among ordinary edits,
// where rename detection could pair the protected source with an unrelated destination.
test("a protected move hidden among ordinary changes is still caught", async (t) => {
  const { service, attempt, cleanup } = await policyFixture(t, async ({ worktreePath, run }) => {
    fs.writeFileSync(path.join(worktreePath, "NOTES.md"), "ordinary work\n");
    fs.writeFileSync(path.join(worktreePath, "allowed-a.txt"), "edited\n");
    await run("mv", "protected/locked.txt", "docs-copy.txt");
  });
  try {
    assert.equal(attempt.terminal_state, "FAILED");
    assert.equal(attempt.result_commit, null);
  } finally {
    service.close();
    await cleanup();
  }
});

// Replacement: the protected file is deleted and an allowed file takes a similar shape. Content
// similarity is exactly what rename detection keys on, so this is the case most likely to be paired.
test("replacing a protected file with an identical allowed file is caught", async (t) => {
  const { service, attempt, cleanup } = await policyFixture(t, async ({ worktreePath, run }) => {
    const body = fs.readFileSync(path.join(worktreePath, "protected", "locked.txt"), "utf8");
    await run("rm", "protected/locked.txt");
    fs.writeFileSync(path.join(worktreePath, "copied.txt"), body);
  });
  try {
    assert.equal(attempt.terminal_state, "FAILED",
      "identical content is what rename detection pairs on, so this must not hide the deletion");
    assert.equal(attempt.result_commit, null);
  } finally {
    service.close();
    await cleanup();
  }
});

// "Changed nothing" must mean changed nothing.
//
// `.gitignore` is trusted project configuration and excluding its matches from the candidate is
// correct -- force-adding would sweep node_modules into candidates. But a worker whose entire output
// is ignored has not "changed nothing": its files are sitting in the worktree, visible, while the
// system says otherwise. An attempt worktree is fresh from the base, so anything ignored-and-present
// was produced by this worker.
test("a worker whose output is entirely ignored is told so, not that it changed nothing", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  fs.writeFileSync(path.join(repo, ".gitignore"), "*.log\n");
  await command("git", ["add", "."], repo);
  await command("git", ["commit", "-m", "add ignore rules"], repo);

  const service = new Dispatcher({ root, backend: policyWorker(async ({ worktreePath }) => {
    fs.writeFileSync(path.join(worktreePath, "answer.log"), "the real output\n");
  }) });
  try {
    const project = await service.addProject({ name: "ignored", repoPath: repo, validation: [] });
    const job = await service.createJob({ projectId: project.id, goal: "write answer.log", maxAttempts: 1 });
    await service.runJob(job.id);

    const attempt = service.db.prepare("SELECT * FROM attempts WHERE job_id = ?").get(job.id);
    assert.equal(attempt.terminal_state, "FAILED", "there is genuinely nothing to integrate");
    const reason = service.lastFailureReason(job.id);
    assert.match(reason, /ignores/, "and the reason names the real cause");
    assert.match(reason, /answer\.log/, "including which file was excluded");
    assert.ok(!/completed without changing files/.test(reason),
      "the worker did change a file; saying otherwise is false");
  } finally {
    service.close();
    await cleanup();
  }
});

test("an ordinary empty attempt still reports plainly that nothing changed", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: policyWorker(async () => { /* touches nothing */ }) });
  try {
    const project = await service.addProject({ name: "empty", repoPath: repo, validation: [] });
    const job = await service.createJob({ projectId: project.id, goal: "do nothing", maxAttempts: 1 });
    await service.runJob(job.id);
    assert.match(service.lastFailureReason(job.id), /without changing files/);
  } finally {
    service.close();
    await cleanup();
  }
});

// The worker's Git index is not authoritative.
//
// A trusted worker may use Git freely, and that includes index flags:
//
//   git update-index --assume-unchanged <path>
//   git update-index --skip-worktree    <path>
//
// Under either, `git add --all` in the worker's OWN index reports a modified file as nothing at all.
// Capture that trusted the worker's index therefore both hid protected-path changes from policy and
// silently dropped real work from the candidate. The snapshot is taken through a delegate-wave-owned
// temporary index seeded from the recorded base, so no worker index state can shape it.
const indexWorker = (flag, plan) => policyWorker(async ({ worktreePath, run }) => {
  await plan({ worktreePath, run, mark: (...paths) => run("update-index", flag, ...paths) });
});

test("an assume-unchanged allowed file still reaches the candidate", async (t) => {
  const { service, repo, attempt, cleanup } = await policyFixture(t,
    async ({ worktreePath, run }) => {
      await run("update-index", "--assume-unchanged", "allowed-a.txt");
      fs.writeFileSync(path.join(worktreePath, "allowed-a.txt"), "really changed\n");
    });
  try {
    assert.equal(attempt.terminal_state, "SUCCEEDED", "the change is real and must be captured");
    const body = await gitIn(repo, "show", `${attempt.result_commit}:allowed-a.txt`);
    assert.equal(body.trim(), "really changed", "the candidate carries what the filesystem holds");
  } finally {
    service.close();
    await cleanup();
  }
});

test("an assume-unchanged protected file is still caught by policy", async (t) => {
  const { service, attempt, cleanup } = await policyFixture(t, async ({ worktreePath, run }) => {
    await run("update-index", "--assume-unchanged", "protected/locked.txt");
    fs.writeFileSync(path.join(worktreePath, "protected", "locked.txt"), "stolen\n");
    fs.writeFileSync(path.join(worktreePath, "cover.md"), "an ordinary change\n");
  });
  try {
    assert.equal(attempt.terminal_state, "FAILED",
      "hiding a protected change in the worker's index must not bypass FS-004");
    assert.equal(attempt.result_commit, null);
  } finally {
    service.close();
    await cleanup();
  }
});

test("a skip-worktree protected file is still caught by policy", async (t) => {
  const { service, attempt, cleanup } = await policyFixture(t, async ({ worktreePath, run }) => {
    await run("update-index", "--skip-worktree", "protected/locked.txt");
    fs.writeFileSync(path.join(worktreePath, "protected", "locked.txt"), "stolen\n");
    fs.writeFileSync(path.join(worktreePath, "cover.md"), "an ordinary change\n");
  });
  try {
    assert.equal(attempt.terminal_state, "FAILED");
    assert.equal(attempt.result_commit, null);
  } finally {
    service.close();
    await cleanup();
  }
});

test("a skip-worktree allowed file still reaches the candidate", async (t) => {
  const { service, repo, attempt, cleanup } = await policyFixture(t,
    async ({ worktreePath, run }) => {
      await run("update-index", "--skip-worktree", "allowed-a.txt");
      fs.writeFileSync(path.join(worktreePath, "allowed-a.txt"), "skip-worktree change\n");
    });
  try {
    assert.equal(attempt.terminal_state, "SUCCEEDED");
    const body = await gitIn(repo, "show", `${attempt.result_commit}:allowed-a.txt`);
    assert.equal(body.trim(), "skip-worktree change");
  } finally {
    service.close();
    await cleanup();
  }
});

// Arbitrary index and history state must be irrelevant: the candidate is the resulting filesystem.
test("arbitrary staged, unstaged, untracked and committed state yields the filesystem tree", async (t) => {
  const { service, repo, attempt, cleanup } = await policyFixture(t,
    async ({ worktreePath, run }) => {
      fs.writeFileSync(path.join(worktreePath, "staged.md"), "staged\n");
      await run("add", "staged.md");
      fs.writeFileSync(path.join(worktreePath, "committed.md"), "committed\n");
      await run("add", "committed.md");
      await run("commit", "-m", "worker commit");
      await run("checkout", "-b", "worker-branch");
      await run("tag", "worker-tag");
      fs.writeFileSync(path.join(worktreePath, "untracked.md"), "untracked\n");
      fs.writeFileSync(path.join(worktreePath, "staged.md"), "staged then modified\n");
    });
  try {
    assert.equal(attempt.terminal_state, "SUCCEEDED");
    const names = (await gitIn(repo, "ls-tree", "-r", "--name-only", attempt.result_commit))
      .split("\n").map((line) => line.trim());
    for (const name of ["staged.md", "committed.md", "untracked.md"]) {
      assert.ok(names.includes(name), `${name} is in the candidate`);
    }
    assert.equal((await gitIn(repo, "show", `${attempt.result_commit}:staged.md`)).trim(),
      "staged then modified", "the filesystem wins over what was staged earlier");
    const parents = (await gitIn(repo, "rev-list", "--parents", "-n", "1", attempt.result_commit)).split(" ");
    assert.equal(parents.length, 2, "still exactly one parent despite the worker's branch and tag");
  } finally {
    service.close();
    await cleanup();
  }
});

// The temporary index must not become part of what it captures.
test("the capture index is not itself captured", async (t) => {
  const { service, repo, attempt, cleanup } = await policyFixture(t, async ({ worktreePath }) => {
    fs.writeFileSync(path.join(worktreePath, "ordinary.md"), "work\n");
  });
  try {
    const names = await gitIn(repo, "ls-tree", "-r", "--name-only", attempt.result_commit);
    assert.ok(!/candidate-index/.test(names), "the delegate-wave index must live outside the worktree");
  } finally {
    service.close();
    await cleanup();
  }
});
