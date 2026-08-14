import assert from "node:assert/strict";
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
  assert.deepEqual(overview.totals, { projects: 25, jobs_needing_attention: 12, jobs_ready_for_integration: 13 });
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
  assert.equal(state.attempts[0].validation_state, "FAILED");
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

test("a schema 9 database migrates to 10 with the work proposal objects", async (t) => {
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
  assert.equal(upgraded.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get().value, "10");

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
  assert.equal(SCHEMA_VERSION, "10");
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
