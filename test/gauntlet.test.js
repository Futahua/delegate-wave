// The release gauntlet: the failure modes a daily driver actually meets.
//
// Each scenario asserts that the system stays honest under a specific failure -- the candidate is
// refused, the evidence survives, and the operator is told something true. A green suite here is the
// claim that ordinary breakage is recoverable without hand-repairing SQLite or Git.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeDataRoot } from "../src/db.js";
import { FakeBackend } from "../src/backend.js";
import { Dispatcher } from "../src/service.js";
import { runProcess } from "../src/process.js";
import { AttemptFence, FenceViolation } from "../src/fence.js";

async function command(name, args, cwd) {
  const result = await runProcess(name, args, { cwd });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

const usage = (dir, input = 1000) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "opencode-events.jsonl"), JSON.stringify({
    type: "step_finish",
    part: { tokens: { input, output: 20, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.0001 },
  }));
};

async function fixture(t, handler) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-gauntlet-"));
  const root = path.join(temp, "data");
  const repo = path.join(temp, "repo");
  fs.mkdirSync(repo);
  await command("git", ["init", "-b", "main"], repo);
  await command("git", ["config", "user.name", "Test"], repo);
  await command("git", ["config", "user.email", "test@example.invalid"], repo);
  fs.writeFileSync(path.join(repo, "input.txt"), "before\n");
  fs.writeFileSync(path.join(repo, "protected.txt"), "do not touch\n");
  await command("git", ["add", "."], repo);
  await command("git", ["commit", "-m", "initial"], repo);
  await command("git", ["branch", "integration"], repo);
  initializeDataRoot(root);
  const service = new Dispatcher({ root, backend: new FakeBackend(handler) });
  t.after(async () => {
    try { service.close(); } catch { /* already closed */ }
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
  return { root, repo, service, temp };
}

const producer = (file = "output.txt", body = "done\n") => async ({ worktreePath, artifactDir }) => {
  usage(artifactDir);
  fs.writeFileSync(path.join(worktreePath, file), body);
  return { exitCode: 0, stdout: "ok", stderr: "" };
};

// 1. The ordinary case still works, so the gauntlet is measuring failure against a working baseline.
test("gauntlet 1: a normal task produces a validated candidate", async (t) => {
  const { repo, service } = await fixture(t, producer());
  const project = await service.addProject({
    name: "Normal", repoPath: repo, branch: "integration",
    validation: ["git ls-files --error-unmatch output.txt"],
  });
  const job = await service.createJob({ projectId: project.id, goal: "produce output.txt" });
  const result = await service.runJob(job.id, { model: "opencode-go/deepseek-v4-flash" });
  assert.equal(result.job.status, "READY_FOR_INTEGRATION");
  assert.equal(result.attempts.at(-1).validation_state, "PASSED");
});

// 2. A worker that changes nothing is a failure, not a silent success.
test("gauntlet 2: a worker that produces no patch fails and is quarantined", async (t) => {
  const { repo, service } = await fixture(t, async ({ artifactDir }) => {
    usage(artifactDir);
    return { exitCode: 0, stdout: "I had nothing to do", stderr: "" };
  });
  const project = await service.addProject({ name: "NoPatch", repoPath: repo, branch: "integration", validation: [] });
  const job = await service.createJob({ projectId: project.id, goal: "change something", maxAttempts: 1 });
  const result = await service.runJob(job.id, { model: "opencode-go/deepseek-v4-flash" });

  assert.equal(result.attempts.at(-1).terminal_state, "FAILED");
  assert.match(service.lastFailureReason(job.id), /without changing files/);
  assert.equal(result.attempts.at(-1).quarantined, 1);
  assert.ok(service.getAttemptUsage(result.attempts.at(-1).id), "the failed attempt still cost money");
});

// 3. A worker that exits nonzero cannot reach integration.
test("gauntlet 3: a bad patch run fails without producing a candidate", async (t) => {
  const { repo, service } = await fixture(t, async ({ worktreePath, artifactDir }) => {
    usage(artifactDir);
    fs.writeFileSync(path.join(worktreePath, "half-done.txt"), "partial\n");
    return { exitCode: 3, stdout: "", stderr: "the worker gave up" };
  });
  const project = await service.addProject({ name: "BadPatch", repoPath: repo, branch: "integration", validation: [] });
  const job = await service.createJob({ projectId: project.id, goal: "will fail", maxAttempts: 1 });
  const result = await service.runJob(job.id, { model: "opencode-go/deepseek-v4-flash" });

  assert.equal(result.attempts.at(-1).terminal_state, "FAILED");
  assert.equal(result.attempts.at(-1).result_commit, null, "no candidate commit exists");
  await assert.rejects(service.proposeIntegration({ jobId: job.id }), /not ready|no attempt|READY/i);
});

// 4. Executor success is not validation success.
test("gauntlet 4: a failed validation rejects an otherwise successful attempt", async (t) => {
  const { repo, service } = await fixture(t, producer());
  const project = await service.addProject({
    name: "ValidationFails", repoPath: repo, branch: "integration",
    validation: ["node -e \"process.exit(1)\""],
  });
  const job = await service.createJob({ projectId: project.id, goal: "produce output.txt", maxAttempts: 1 });
  const result = await service.runJob(job.id, { model: "opencode-go/deepseek-v4-flash" });

  assert.equal(result.attempts.at(-1).terminal_state, "SUCCEEDED", "the executor did finish");
  assert.equal(result.attempts.at(-1).validation_state, "FAILED", "but validation refused it");
  assert.notEqual(result.job.status, "READY_FOR_INTEGRATION");
});

// 5. A provider failure before any model call is UNKNOWN usage, never zero.
test("gauntlet 5: a provider failure records UNKNOWN usage rather than free work", async (t) => {
  const { repo, service } = await fixture(t, async () => {
    throw new Error("ProviderAuthError: API key is missing");
  });
  const project = await service.addProject({ name: "Provider", repoPath: repo, branch: "integration", validation: [] });
  const job = await service.createJob({ projectId: project.id, goal: "cannot start", maxAttempts: 1 });
  const result = await service.runJob(job.id, { model: "opencode-go/deepseek-v4-flash" });

  const receipt = service.getAttemptUsage(result.attempts.at(-1).id);
  assert.equal(receipt.status, "UNKNOWN");
  assert.equal(receipt.input_tokens, null, "absent usage is never recorded as zero");
  assert.match(service.lastFailureReason(job.id), /ProviderAuthError/);
});

// 6. Cancellation, covered in depth in cancel.test.js; here as part of the release sweep.
test("gauntlet 6: a live cancellation stops the job and keeps its evidence", async (t) => {
  let service;
  const { repo, service: created } = await fixture(t, async ({ artifactDir, onSpawn }) => {
    usage(artifactDir);
    const { spawn } = await import("node:child_process");
    const proc = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    onSpawn?.(proc.pid);
    await service.cancelJob({ jobId: service.pendingJobId, principal: "john", origin: "local-cli" });
    proc.kill();
    return { exitCode: 1, stdout: "", stderr: "killed" };
  });
  service = created;
  const project = await service.addProject({ name: "Cancelled", repoPath: repo, branch: "integration", validation: [] });
  const job = await service.createJob({ projectId: project.id, goal: "long", maxAttempts: 1 });
  service.pendingJobId = job.id;
  const result = await service.runJob(job.id, { model: "opencode-go/deepseek-v4-flash" });

  assert.equal(result.job.status, "CANCELLED");
  assert.equal(service.cancellationIntents(job.id)[0].outcome, "CANCELLED");
  assert.ok(service.getAttemptUsage(result.attempts.at(-1).id), "cancelled work still reports cost");
});

// 7. A restart mid-flight leaves a recoverable state, not a wedged one.
test("gauntlet 7: an interrupted attempt is reconciled rather than left running forever", async (t) => {
  const { root, repo, service } = await fixture(t, producer());
  const project = await service.addProject({ name: "Restart", repoPath: repo, branch: "integration", validation: [] });
  const job = await service.createJob({ projectId: project.id, goal: "interrupted", maxAttempts: 2 });

  // Simulate a crash mid-attempt: an attempt exists, its scheduler is gone, nothing is terminal.
  const epoch = Number(service.db.prepare("SELECT value FROM metadata WHERE key = 'scheduler_epoch'").get().value) + 1;
  service.db.prepare("UPDATE metadata SET value = ? WHERE key = 'scheduler_epoch'").run(String(epoch));
  service.db.prepare(`INSERT INTO attempts(
    id, job_id, ordinal, scheduler_epoch, backend, model, scheduler_pid, worktree_path, started_at
  ) VALUES (?, ?, 1, ?, 'FakeBackend', 'opencode-go/deepseek-v4-flash', 999999, NULL, ?)`)
    .run(`${job.id}.1`, job.id, epoch, new Date().toISOString());
  service.db.prepare("UPDATE jobs SET status = 'RUNNING' WHERE id = ?").run(job.id);

  const report = await service.reconcile({ apply: true });
  assert.ok(report, "reconcile produces a report");
  const attempt = service.status(job.id).attempts.at(-1);
  assert.ok(["ORPHANED", "INTERRUPTED", "FAILED"].includes(attempt.terminal_state),
    `an abandoned attempt must reach a terminal state, got ${attempt.terminal_state}`);
  assert.notEqual(service.getJob(job.id).status, "RUNNING", "the job is no longer wedged");
});

// 8. A callback from a stale epoch cannot mutate an attempt.
test("gauntlet 8: a stale callback is refused", async (t) => {
  const { repo, service } = await fixture(t, producer());
  const project = await service.addProject({ name: "Stale", repoPath: repo, branch: "integration", validation: [] });
  const job = await service.createJob({ projectId: project.id, goal: "produce output.txt" });
  const result = await service.runJob(job.id, { model: "opencode-go/deepseek-v4-flash" });
  const attempt = result.attempts.at(-1);

  assert.throws(
    () => service.recordExecutorPid(attempt.id, attempt.scheduler_epoch - 1, "whatever", 4242),
    /Stale or terminal attempt event rejected/,
  );
});

// 9. Integration refuses when the branch moved underneath the proposal.
test("gauntlet 9: an integration conflict is refused rather than forced", async (t) => {
  const { repo, service } = await fixture(t, producer());
  const project = await service.addProject({ name: "Conflict", repoPath: repo, branch: "integration", validation: [] });
  const job = await service.createJob({ projectId: project.id, goal: "produce output.txt" });
  await service.runJob(job.id, { model: "opencode-go/deepseek-v4-flash" });
  const proposal = await service.proposeIntegration({ jobId: job.id });
  service.grantApproval({ proposalId: proposal.id, principal: "john", origin: "terminal" });

  // Something else advances the branch after the proposal was made.
  fs.writeFileSync(path.join(repo, "other.txt"), "elsewhere\n");
  await command("git", ["-C", repo, "add", "."], repo);
  await command("git", ["-C", repo, "commit", "-m", "other work"], repo);
  await command("git", ["-C", repo, "branch", "-f", "integration", "HEAD"], repo);
  const moved = await command("git", ["-C", repo, "rev-parse", "integration"], repo);

  await assert.rejects(service.runIntegration(proposal.id), /head|expected|changed/i);
  assert.equal(await command("git", ["-C", repo, "rev-parse", "integration"], repo), moved,
    "the refusal left the branch untouched");
});

// 10. A protected path rejects the candidate.
test("gauntlet 10: a protected-path violation rejects the candidate", async (t) => {
  const { repo, service } = await fixture(t, async ({ worktreePath, artifactDir }) => {
    usage(artifactDir);
    fs.writeFileSync(path.join(worktreePath, "protected.txt"), "tampered\n");
    return { exitCode: 0, stdout: "ok", stderr: "" };
  });
  const project = await service.addProject({
    name: "Protected", repoPath: repo, branch: "integration",
    validation: [], protectedPaths: ["protected.txt"],
  });
  const job = await service.createJob({ projectId: project.id, goal: "touch a protected file", maxAttempts: 1 });
  const result = await service.runJob(job.id, { model: "opencode-go/deepseek-v4-flash" });

  assert.equal(result.attempts.at(-1).terminal_state, "FAILED");
  assert.match(service.lastFailureReason(job.id), /protected/i);
  assert.equal(await command("git", ["-C", repo, "show", "integration:protected.txt"], repo), "do not touch");
});

// 11. Escape attempts against the fence, as a Harness worker would make them.
test("gauntlet 11: filesystem escape attempts are denied", async (t) => {
  const { temp, repo } = await fixture(t, producer());
  const outside = path.join(temp, "trusted");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "verifier.js"), "acceptance criteria\n");
  const fence = new AttemptFence(repo);

  assert.throws(() => fence.readFile(path.join(outside, "verifier.js")), FenceViolation);
  assert.throws(() => fence.readFile("../trusted/verifier.js"), FenceViolation);
  assert.throws(() => fence.writeFile(path.join(outside, "planted.txt"), "x"), FenceViolation);
  assert.equal(fs.existsSync(path.join(outside, "planted.txt")), false);
});

// 12. PARTIAL accounting is retained and disclosed, not rounded into confidence.
test("gauntlet 12: PARTIAL usage is retained and reported as incomplete", async (t) => {
  const { repo, service } = await fixture(t, async ({ worktreePath, artifactDir }) => {
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, "opencode-events.jsonl"), [
      JSON.stringify({ type: "step_finish", part: { tokens: { input: 500, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.00005 } }),
      '{"type":"step_finish","part":{"tokens":{"input":999',
    ].join("\n"));
    fs.writeFileSync(path.join(worktreePath, "output.txt"), "done\n");
    return { exitCode: 0, stdout: "ok", stderr: "" };
  });
  const project = await service.addProject({ name: "Partial", repoPath: repo, branch: "integration", validation: [] });
  const job = await service.createJob({ projectId: project.id, goal: "produce output.txt" });
  const result = await service.runJob(job.id, { model: "opencode-go/deepseek-v4-flash" });

  const receipt = service.getAttemptUsage(result.attempts.at(-1).id);
  assert.equal(receipt.status, "PARTIAL");
  assert.equal(receipt.input_tokens, 500, "what was observed is retained");
  assert.equal(service.usageCoverage({ jobIds: [job.id] }).healthy, false,
    "a PARTIAL receipt cannot support a defensible cost total");
});

// 13. A budget stops work, and unmeasured spend blocks.
test("gauntlet 13: a budget stop refuses further work", async (t) => {
  const { repo, service } = await fixture(t, async ({ worktreePath, artifactDir }) => {
    usage(artifactDir, 1_000_000);
    fs.writeFileSync(path.join(worktreePath, `out-${Date.now()}.txt`), "done\n");
    return { exitCode: 0, stdout: "ok", stderr: "" };
  });
  const project = await service.addProject({ name: "Budget", repoPath: repo, branch: "integration", validation: [] });
  const job = await service.createJob({
    projectId: project.id, goal: "expensive", maxAttempts: 3, maximumCost: 0.10,
  });
  await service.runJob(job.id, { model: "opencode-go/deepseek-v4-flash" });
  service.db.prepare("UPDATE jobs SET status = 'PENDING' WHERE id = ?").run(job.id);
  await assert.rejects(service.runJob(job.id, { model: "opencode-go/deepseek-v4-flash" }), /ceiling/);
});

// 14 and 15. Backup and restore recover lost state.
test("gauntlet 14: backup and restore recover a lost database", async (t) => {
  const { root, repo, service } = await fixture(t, producer());
  const project = await service.addProject({ name: "Recover", repoPath: repo, branch: "integration", validation: [] });
  const kept = await service.createJob({ projectId: project.id, goal: "before the backup" });
  const backup = await service.backup("gauntlet");
  await service.createJob({ projectId: project.id, goal: "after the backup" });
  assert.equal(service.listJobs().length, 2);
  service.close();

  const { restoreBackup } = await import("../src/recovery.js");
  const restored = await restoreBackup({ root, backupDirectory: backup.backup });
  assert.ok(restored.safety_backup, "the replaced database is preserved");

  // Closed here rather than in an after-hook: hooks run last-registered-first, so leaving this open
  // would hold the temp directory while the fixture tries to remove it.
  const reopened = new Dispatcher({ root, backend: new FakeBackend() });
  try {
    const jobs = reopened.listJobs();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].id, kept.id);
  } finally {
    reopened.close();
  }
});

// 16. Rollback returns the branch, with compare-and-swap.
test("gauntlet 16: rollback returns an integrated branch to its previous commit", async (t) => {
  const { repo, service } = await fixture(t, producer("candidate.txt"));
  const project = await service.addProject({ name: "Rollback", repoPath: repo, branch: "integration", validation: [] });
  const before = await command("git", ["-C", repo, "rev-parse", "integration"], repo);
  const job = await service.createJob({ projectId: project.id, goal: "produce candidate.txt" });
  await service.runJob(job.id, { model: "opencode-go/deepseek-v4-flash" });
  const proposal = await service.proposeIntegration({ jobId: job.id });
  service.grantApproval({ proposalId: proposal.id, principal: "john", origin: "terminal" });
  await service.runIntegration(proposal.id);
  assert.notEqual(await command("git", ["-C", repo, "rev-parse", "integration"], repo), before);

  await service.rollbackIntegration({ proposalId: proposal.id, principal: "john", origin: "local-cli" });
  assert.equal(await command("git", ["-C", repo, "rev-parse", "integration"], repo), before);
});

// 17. doctor tells the truth about a damaged installation.
test("gauntlet 17: doctor reports a missing repository rather than claiming health", async (t) => {
  const { repo, service } = await fixture(t, producer());
  await service.addProject({ name: "Doctor", repoPath: repo, branch: "integration", validation: [] });
  assert.equal(service.doctor().healthy, true);

  const moved = `${repo}-gone`;
  fs.renameSync(repo, moved);
  try {
    const doctor = service.doctor();
    assert.equal(doctor.healthy, false);
    assert.equal(doctor.missing_repositories.length, 1);
    assert.equal(service.briefing().healthy, false, "the everyday surface says so too");
  } finally {
    fs.renameSync(moved, repo);
  }
});
