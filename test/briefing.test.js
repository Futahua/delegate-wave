// The everyday surface. If this needs scrolling or explaining, it has failed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeDataRoot } from "../src/db.js";
import { FakeBackend } from "../src/backend.js";
import { Dispatcher } from "../src/service.js";
import { summarizeStatus } from "../src/mcp/server.js";
import { runProcess } from "../src/process.js";

async function command(name, args, cwd) {
  const result = await runProcess(name, args, { cwd });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(t, { failWorker = false } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-briefing-"));
  const root = path.join(temp, "data");
  const repo = path.join(temp, "repo");
  fs.mkdirSync(repo);
  await command("git", ["init", "-b", "main"], repo);
  await command("git", ["config", "user.name", "Test"], repo);
  await command("git", ["config", "user.email", "test@example.invalid"], repo);
  fs.writeFileSync(path.join(repo, "input.txt"), "before\n");
  await command("git", ["add", "."], repo);
  await command("git", ["commit", "-m", "initial"], repo);
  await command("git", ["branch", "integration"], repo);
  initializeDataRoot(root);

  const backend = new FakeBackend(async ({ worktreePath, artifactDir }) => {
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, "opencode-events.jsonl"), JSON.stringify({
      type: "step_finish",
      part: { tokens: { input: 1000, output: 50, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.0001 },
    }));
    if (failWorker) return { exitCode: 1, stdout: "", stderr: "the worker could not find the file" };
    fs.writeFileSync(path.join(worktreePath, "output.txt"), "done\n");
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
  return { root, repo, service };
}

test("an idle system says so plainly", async (t) => {
  const { service } = await fixture(t);
  const status = service.briefing();
  assert.deepEqual(status.working, []);
  assert.deepEqual(status.needs_your_decision, []);
  assert.deepEqual(status.done, []);
  assert.equal(summarizeStatus(status), "Nothing running, nothing waiting on you.");
});

test("a pending proposal appears as a decision with its bound and goal", async (t) => {
  const { service, repo } = await fixture(t);
  const project = await service.addProject({ name: "Surface", repoPath: repo, branch: "integration", validation: [] });
  service.proposeWork({
    projectId: project.id, goal: "add a summary file to the report directory",
    maximumCost: 0.25, idempotencyKey: "k1", principal: "hermes-proposer", origin: "hermes-mcp-proposal",
  });

  const status = service.briefing();
  assert.equal(status.needs_your_decision.length, 1);
  const decision = status.needs_your_decision[0];
  assert.match(decision.decision, /authorize or reject/);
  assert.equal(decision.project, "Surface");
  assert.equal(decision.ceiling_usd, 0.25);
  assert.match(summarizeStatus(status), /Needs your decision: 1/);
});

test("a finished job reports what changed and what it cost", async (t) => {
  const { service, repo } = await fixture(t);
  const project = await service.addProject({ name: "Done", repoPath: repo, branch: "integration", validation: [] });
  const job = await service.createJob({ projectId: project.id, goal: "produce output.txt" });
  await service.runJob(job.id, { model: "opencode-go/deepseek-v4-flash" });
  const proposal = await service.proposeIntegration({ jobId: job.id });
  service.grantApproval({ proposalId: proposal.id, principal: "john", origin: "terminal" });
  await service.runIntegration(proposal.id);

  const status = service.briefing();
  assert.equal(status.done.length, 1);
  const finished = status.done[0];
  assert.equal(finished.project, "Done");
  assert.ok(finished.changed?.integrated_commit, "Done says what landed");
  assert.ok(finished.cost.reference_cost_usd > 0, "Done says what it cost");
  assert.equal(finished.cost.complete, true);
  assert.match(summarizeStatus(status), /Done recently: 1, about \$0\./);
});

test("a failure explains itself without a transcript", async (t) => {
  const { service, repo } = await fixture(t, { failWorker: true });
  const project = await service.addProject({ name: "Failed", repoPath: repo, branch: "integration", validation: [] });
  const job = await service.createJob({ projectId: project.id, goal: "will fail", maxAttempts: 1 });
  await service.runJob(job.id, { model: "opencode-go/deepseek-v4-flash" });

  const status = service.briefing();
  assert.equal(status.ready_to_check.length, 1);
  const item = status.ready_to_check[0];
  assert.match(item.why, /worker exited 1/, "the reason is stated in words");
  assert.ok(item.why.length <= 200, "the reason is a sentence, not a dump");
  assert.ok(item.cost.reference_cost_usd > 0, "failed work still reports its cost");
  assert.match(summarizeStatus(status), /Ready to check: 1/);
});

test("unmeasured cost is disclosed rather than reported as a confident number", async (t) => {
  const { service, repo } = await fixture(t);
  const silent = new FakeBackend(async ({ worktreePath }) => {
    fs.writeFileSync(path.join(worktreePath, "output.txt"), "done\n");
    return { exitCode: 0, stdout: "ok", stderr: "" };
  });
  service.backend = silent;

  const project = await service.addProject({ name: "Unmeasured", repoPath: repo, branch: "integration", validation: [] });
  const job = await service.createJob({ projectId: project.id, goal: "no usage reported" });
  await service.runJob(job.id);
  const proposal = await service.proposeIntegration({ jobId: job.id });
  service.grantApproval({ proposalId: proposal.id, principal: "john", origin: "terminal" });
  await service.runIntegration(proposal.id);

  const status = service.briefing();
  const finished = status.done[0];
  assert.equal(finished.cost.complete, false);
  assert.equal(finished.cost.unmeasured_attempts, 1);
  assert.match(summarizeStatus(status), /some cost unmeasured/);
});

test("the briefing carries no transcripts, worktree paths, or raw artifacts", async (t) => {
  const { service, repo } = await fixture(t);
  const project = await service.addProject({ name: "Clean", repoPath: repo, branch: "integration", validation: [] });
  const job = await service.createJob({ projectId: project.id, goal: "produce output.txt" });
  await service.runJob(job.id, { model: "opencode-go/deepseek-v4-flash" });

  const serialized = JSON.stringify(service.briefing());
  assert.doesNotMatch(serialized, /worktree|artifact|stdout|stderr|opencode-events|repo_path/,
    "the everyday surface must not leak execution internals");
  // It also has to stay small enough to read at a glance.
  assert.ok(Buffer.byteLength(serialized, "utf8") < 4096, "the status must fit on a screen");
});
