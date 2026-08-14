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
