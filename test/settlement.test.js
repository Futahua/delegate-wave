// A ceiling that only gates the START of work is not a ceiling on what work costs.
//
// assertWithinBudget() can answer exactly one question: was the budget intact before this attempt?
// It cannot bound the attempt it admits, because nothing terminates a running worker on cost. So an
// attempt admitted with a cent of headroom may spend many times the limit and, until now, the job
// would still be presented as READY_FOR_INTEGRATION -- "I did what you asked" with no mention that
// it cost five times what was authorized.
//
// Settlement is where the ceiling acquires consequences -- but a cost overrun does not make correct
// code incorrect, so two independent truths are kept independent:
//
//   ENGINEERING OUTCOME   candidate captured? validation passed?
//   BUDGET OUTCOME        WITHIN / EXCEEDED / UNVERIFIED
//
// What EXCEEDED withholds is automatic progression, never the candidate. You cannot unspend money;
// you can decline to spend more of it, and decline to imply the work is cleared to proceed.
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

async function fixture() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-settle-"));
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

// A worker that changes a file and reports a known input-token count, so spend is predictable.
const spender = (inputTokens) => new FakeBackend(async ({ worktreePath, artifactDir }) => {
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, "opencode-events.jsonl"), JSON.stringify({
    type: "step_finish",
    part: { tokens: { input: inputTokens, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.0001 },
  }));
  fs.writeFileSync(path.join(worktreePath, "out.txt"), "done\n");
  return { exitCode: 0, stdout: "ok", stderr: "" };
});

test("an attempt that overshoots its ceiling is not offered for integration", async (t) => {
  const { root, repo, cleanup } = await fixture();
  // 1,000,000 input tokens is about $0.14 against a $0.10 ceiling. The start gate admits the attempt
  // -- nothing had been spent when it began -- and this is exactly the case the gate cannot catch.
  const service = new Dispatcher({ root, backend: spender(1_000_000) });
  t.after(async () => { service.close(); await cleanup(); });

  const project = await service.addProject({ name: "Overshoot", repoPath: repo, validation: [] });
  const job = await service.createJob({
    projectId: project.id, goal: "expensive", maximumCost: 0.10,
  });
  await service.runJob(job.id, { model: "opencode-go/deepseek-v4-flash" });

  const settlement = service.settleBudget(job.id);
  assert.equal(settlement.state, "EXCEEDED");
  assert.ok(settlement.spent > 0.13, `expected an overshoot, got ${settlement.spent}`);

  // The job does NOT claim to be ready.
  assert.equal(service.getJob(job.id).status, "NEEDS_ATTENTION");

  // But the attempt's own evidence is untouched: it really did succeed and really did validate.
  // Rewriting either to express a budget opinion would falsify the record.
  const attempt = service.status(job.id).attempts.at(-1);
  assert.equal(attempt.terminal_state, "SUCCEEDED");
  assert.equal(attempt.validation_state, "PASSED");
  assert.ok(attempt.result_commit, "the candidate commit survives the budget block");

  // And the work is recoverable rather than repurchased: raising the ceiling settles WITHIN against
  // the same receipts, with the same candidate still in place.
  service.db.prepare("UPDATE jobs SET maximum_cost = 1.00 WHERE id = ?").run(job.id);
  assert.equal(service.settleBudget(job.id).state, "WITHIN");
});

test("an exceeded budget is explained as finished work, not as a refusal to start", async (t) => {
  const { root, repo, cleanup } = await fixture();
  const service = new Dispatcher({ root, backend: spender(1_000_000) });
  t.after(async () => { service.close(); await cleanup(); });

  const project = await service.addProject({ name: "Wording", repoPath: repo, validation: [] });
  const job = await service.createJob({ projectId: project.id, goal: "expensive", maximumCost: 0.10 });
  await service.runJob(job.id, { model: "opencode-go/deepseek-v4-flash" });

  const outcome = service.jobOutcome(job.id);
  assert.equal(outcome.state, "budget-exceeded");
  assert.equal(outcome.needs_decision, true);
  // The distinction that matters to a person: nothing is waiting to be retried, something is waiting
  // to be decided. Saying "I stopped before another attempt" would send them hunting a failure that
  // never happened.
  assert.match(outcome.headline, /finished and passed its checks/);
  assert.doesNotMatch(outcome.headline, /before another attempt/);
  assert.match(outcome.detail, /candidate is intact/);
});

test("spend that cannot be measured does not block a validated candidate", async (t) => {
  const { root, repo, cleanup } = await fixture();
  // No usage artifact at all, so the receipt is UNKNOWN and spend cannot be established.
  const silent = new FakeBackend(async ({ worktreePath }) => {
    fs.writeFileSync(path.join(worktreePath, "out.txt"), "done\n");
    return { exitCode: 0, stdout: "ok", stderr: "" };
  });
  const service = new Dispatcher({ root, backend: silent });
  t.after(async () => { service.close(); await cleanup(); });

  const project = await service.addProject({ name: "Unverified", repoPath: repo, validation: [] });
  const job = await service.createJob({ projectId: project.id, goal: "unmeasured", maximumCost: 0.10 });
  await service.runJob(job.id);

  const settlement = service.settleBudget(job.id);
  assert.equal(settlement.state, "UNVERIFIED");

  // A reporting gap is not evidence of overspending, and destroying a validated candidate over one
  // would throw away work already paid for. The start gate already refuses to spend anything further
  // under an unestablished total, so the exposure is bounded at one attempt.
  assert.equal(service.getJob(job.id).status, "READY_FOR_INTEGRATION");

  // What is NOT claimed is that the limit held. The event says so durably.
  const recorded = service.db.prepare(
    "SELECT COUNT(*) AS count FROM events WHERE kind = 'BUDGET_UNVERIFIED' AND entity_id = ?",
  ).get(job.id).count;
  assert.equal(recorded, 1);
});

test("a job with no ceiling settles WITHIN and is never blocked", async (t) => {
  const { root, repo, cleanup } = await fixture();
  const service = new Dispatcher({ root, backend: spender(5_000_000) });
  t.after(async () => { service.close(); await cleanup(); });

  const project = await service.addProject({ name: "NoCeiling", repoPath: repo, validation: [] });
  const job = await service.createJob({ projectId: project.id, goal: "unbounded" });
  await service.runJob(job.id, { model: "opencode-go/deepseek-v4-flash" });

  assert.equal(service.settleBudget(job.id).state, "WITHIN");
  assert.equal(service.getJob(job.id).status, "READY_FOR_INTEGRATION");
});

test("children settle against their parent's ceiling, not their own", async (t) => {
  const { root, repo, cleanup } = await fixture();
  // Each run costs about $0.056. One is comfortably inside a $0.10 ceiling; three are not.
  const service = new Dispatcher({ root, backend: spender(400_000) });
  t.after(async () => { service.close(); await cleanup(); });

  const project = await service.addProject({ name: "Family", repoPath: repo, validation: [] });
  const parent = await service.createJob({
    projectId: project.id, goal: "managed objective", maximumCost: 0.10, strategy: "managed",
  });
  const child = await service.createJob({
    projectId: project.id, goal: "investigate one question", mode: "read",
    parentJobId: parent.id, internalKind: "MANAGER_EXPLORATION",
  });

  // The child carries no ceiling of its own. Without family authority it would therefore be
  // unbounded, and five explorations would authorize five times what the operator allowed.
  assert.equal(service.getJob(child.id).maximum_cost, null);
  assert.equal(service.budgetAuthority(child.id).ceiling, 0.10);
  assert.equal(service.budgetAuthority(child.id).rootJobId, parent.id);

  await service.runJob(child.id, { model: "opencode-go/deepseek-v4-flash" });
  await service.runJob(parent.id, { model: "opencode-go/deepseek-v4-flash" });

  // Neither run alone breaches the limit; together they do, and the family is what settles.
  const family = service.familySpend(parent.id);
  assert.equal(family.jobs, 2);
  assert.ok(family.spent > 0.10, `family spend ${family.spent} should exceed the ceiling`);
  assert.ok(service.jobSpend(parent.id).spent < 0.10, "the parent alone stayed under it");

  assert.equal(service.settleBudget(parent.id).state, "EXCEEDED");
  assert.equal(service.getJob(parent.id).status, "NEEDS_ATTENTION");
});

test("the start gate refuses a child once the family has exhausted the ceiling", async (t) => {
  const { root, repo, cleanup } = await fixture();
  const service = new Dispatcher({ root, backend: spender(1_000_000) });
  t.after(async () => { service.close(); await cleanup(); });

  const project = await service.addProject({ name: "FamilyGate", repoPath: repo, validation: [] });
  const parent = await service.createJob({
    projectId: project.id, goal: "managed objective", maximumCost: 0.10, strategy: "managed",
  });
  const first = await service.createJob({
    projectId: project.id, goal: "first investigation", mode: "read",
    parentJobId: parent.id, internalKind: "MANAGER_EXPLORATION",
  });
  await service.runJob(first.id, { model: "opencode-go/deepseek-v4-flash" });

  // A second child is refused by the ceiling its sibling already spent -- the failure the
  // per-job-ceiling implementation would have missed entirely.
  const second = await service.createJob({
    projectId: project.id, goal: "second investigation", mode: "read",
    parentJobId: parent.id, internalKind: "MANAGER_EXPLORATION",
  });
  await assert.rejects(
    service.runJob(second.id, { model: "opencode-go/deepseek-v4-flash" }),
    /of its 0.1 ceiling/,
  );
});
