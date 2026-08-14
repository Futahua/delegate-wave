// A cost ceiling that is recorded but never checked is not a ceiling.
//
// The property that matters most: unaccounted spend must block rather than pass. If an earlier
// attempt's usage is UNKNOWN, the honest answer is that the budget cannot be shown to be intact --
// treating unknown as zero would let unmeasured work run indefinitely under any ceiling.
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
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-budget-"));
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

// A worker that reports a known number of input tokens, so spend is predictable.
const spender = (inputTokens) => new FakeBackend(async ({ worktreePath, artifactDir }) => {
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, "opencode-events.jsonl"), JSON.stringify({
    type: "step_finish",
    part: { tokens: { input: inputTokens, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.0001 },
  }));
  fs.writeFileSync(path.join(worktreePath, `out-${Date.now()}.txt`), "done\n");
  return { exitCode: 0, stdout: "ok", stderr: "" };
});

test("spend is summed from usage receipts and reported with what could not be priced", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: spender(1_000_000) });
  t.after(async () => { service.close(); await cleanup(); });

  const project = await service.addProject({ name: "Spend", repoPath: repo, validation: [] });
  const job = await service.createJob({ projectId: project.id, goal: "one attempt" });
  await service.runJob(job.id, { model: "opencode-go/deepseek-v4-flash" });

  const spend = service.jobSpend(job.id);
  // 1,000,000 input tokens at $0.14/M, plus 10 output at $0.28/M.
  assert.ok(Math.abs(spend.spent - (0.14 + 10 * 0.28 / 1e6)) < 1e-9, `unexpected spend ${spend.spent}`);
  assert.equal(spend.priced_attempts, 1);
  assert.equal(spend.unpriced_attempts, 0);
  assert.equal(spend.complete, true);
});

test("a job stops when its ceiling is exhausted", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: spender(1_000_000) });
  t.after(async () => { service.close(); await cleanup(); });

  const project = await service.addProject({ name: "Ceiling", repoPath: repo, validation: [] });
  // One attempt costs about $0.14, so a $0.10 ceiling admits the first attempt -- nothing is spent
  // yet when it starts -- and refuses the second once the receipt exists.
  const job = await service.createJob({
    projectId: project.id, goal: "expensive", maxAttempts: 3, maximumCost: 0.10,
  });

  await service.runJob(job.id, { model: "opencode-go/deepseek-v4-flash" });
  assert.ok(service.jobSpend(job.id).spent > 0.13);

  // Put the job back in a runnable state; the ceiling, not the lifecycle, must stop it.
  service.db.prepare("UPDATE jobs SET status = 'PENDING' WHERE id = ?").run(job.id);
  await assert.rejects(
    service.runJob(job.id, { model: "opencode-go/deepseek-v4-flash" }),
    /spent .* of its 0.1 ceiling/,
  );
});

test("unaccounted spend blocks rather than passes", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  // This worker produces no usage artifact at all, so its receipt is UNKNOWN.
  const silent = new FakeBackend(async ({ worktreePath }) => {
    fs.writeFileSync(path.join(worktreePath, `out-${Date.now()}.txt`), "done\n");
    return { exitCode: 0, stdout: "ok", stderr: "" };
  });
  const service = new Dispatcher({ root, backend: silent });
  t.after(async () => { service.close(); await cleanup(); });

  const project = await service.addProject({ name: "Unknown", repoPath: repo, validation: [] });
  const job = await service.createJob({
    projectId: project.id, goal: "unmeasured", maxAttempts: 3, maximumCost: 5.00,
  });
  await service.runJob(job.id);

  const spend = service.jobSpend(job.id);
  assert.equal(spend.spent, 0, "an UNKNOWN receipt contributes no cost");
  assert.equal(spend.unpriced_attempts, 1, "but the attempt is counted as unaccounted");
  assert.equal(spend.complete, false);

  // The ceiling is nowhere near exhausted by measured spend, and that is exactly the danger:
  // treating unknown as zero would let this run forever.
  service.db.prepare("UPDATE jobs SET status = 'PENDING' WHERE id = ?").run(job.id);
  await assert.rejects(
    service.runJob(job.id),
    /unpriced usage, so spend against the 5 ceiling cannot be established/,
  );
});

test("a job with no ceiling is unaffected", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: spender(1_000_000) });
  t.after(async () => { service.close(); await cleanup(); });

  const project = await service.addProject({ name: "NoCeiling", repoPath: repo, validation: [] });
  const job = await service.createJob({ projectId: project.id, goal: "unbounded", maxAttempts: 2 });
  await service.runJob(job.id, { model: "opencode-go/deepseek-v4-flash" });

  service.db.prepare("UPDATE jobs SET status = 'PENDING' WHERE id = ?").run(job.id);
  const second = await service.runJob(job.id, { model: "opencode-go/deepseek-v4-flash" });
  assert.equal(second.attempts.length, 2, "no ceiling means no budget refusal");
});

test("the attempt limit still stops a job independently of cost", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const failing = new FakeBackend(async ({ artifactDir }) => {
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, "opencode-events.jsonl"), JSON.stringify({
      type: "step_finish",
      part: { tokens: { input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.000001 },
    }));
    return { exitCode: 1, stdout: "", stderr: "no" };
  });
  const service = new Dispatcher({ root, backend: failing });
  t.after(async () => { service.close(); await cleanup(); });

  const project = await service.addProject({ name: "Attempts", repoPath: repo, validation: [] });
  const job = await service.createJob({ projectId: project.id, goal: "always fails", maxAttempts: 2 });
  await service.runJob(job.id, { model: "opencode-go/deepseek-v4-flash" });
  service.db.prepare("UPDATE jobs SET status = 'PENDING' WHERE id = ?").run(job.id);
  await service.runJob(job.id, { model: "opencode-go/deepseek-v4-flash" });

  assert.equal(service.getJob(job.id).status, "NEEDS_ATTENTION");
  service.db.prepare("UPDATE jobs SET status = 'PENDING' WHERE id = ?").run(job.id);
  await assert.rejects(service.runJob(job.id), /exhausted its 2 attempts/);
});
