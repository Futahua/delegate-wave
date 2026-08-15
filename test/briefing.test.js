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
  // Asked as a question rather than described in operator vocabulary.
  assert.equal(decision.decision, "Approve this work?");
  assert.equal(decision.project, "Surface");
  assert.equal(decision.ceiling_usd, 0.25);
  assert.match(summarizeStatus(status), /with a cheap worker under \$0\.25\. Approve\?/);
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

test("an already-integrated proposal stops asking for a decision", async (t) => {
  // The stored state column lags the integration records, so filtering on it alone would ask the
  // operator to approve work that already landed -- and asking for a decision that has been made is
  // exactly how a status surface loses trust.
  const { service, repo } = await fixture(t);
  const project = await service.addProject({ name: "Landed", repoPath: repo, branch: "integration", validation: [] });
  const job = await service.createJob({ projectId: project.id, goal: "produce output.txt" });
  await service.runJob(job.id, { model: "opencode-go/deepseek-v4-flash" });
  const proposal = await service.proposeIntegration({ jobId: job.id });

  assert.equal(service.briefing().needs_your_decision.length, 1, "before approval it needs a decision");

  service.grantApproval({ proposalId: proposal.id, principal: "john", origin: "terminal" });
  await service.runIntegration(proposal.id);

  const after = service.briefing();
  assert.deepEqual(after.needs_your_decision, [], "after integration it needs nothing");
  assert.equal(after.done.length, 1);
});

// Every briefing bucket must identify the job it is talking about.
//
// Candidate entries carried a proposal id but no job id, so a pending approval could not be
// correlated back to the work that produced it. Nothing false was stated, but Hermes could not
// answer "what happened to the thing I proposed", and the inconsistency misled a test written
// against the surface.
test("a pending candidate names the job it came from", async (t) => {
  const { service, repo } = await fixture(t);
  const project = await service.addProject({
    name: "candidate-identity", repoPath: repo, branch: "integration", validation: [],
  });
  const job = await service.createJob({ projectId: project.id, goal: "produce a candidate" });
  await service.runJob(job.id);
  await service.proposeIntegration({ jobId: job.id });

  const briefing = service.briefing();
  const candidate = briefing.needs_your_decision.find((entry) => String(entry.proposal).startsWith("proposal_"));
  assert.ok(candidate, "the candidate awaits a decision");
  assert.equal(candidate.job, job.id, "and says which job it belongs to");
  for (const bucket of ["working", "ready_to_check", "done"]) {
    for (const entry of briefing[bucket]) {
      assert.ok(entry.job, `${bucket} entries identify their job`);
    }
  }
});

// A rolled-back job must be accounted for, not merely removed.
//
// Rollback truth was already correct: the job leaves `done`, because its change is no longer
// present. But it then appeared in no bucket at all, so work the person watched succeed simply
// vanished from the everyday answer with no statement of what happened to it.
test("an integration that was rolled back is reported as reverted", async (t) => {
  const { service, repo } = await fixture(t);
  const project = await service.addProject({
    name: "reverted-bucket", repoPath: repo, branch: "integration", validation: [],
  });
  const before = await command("git", ["-C", repo, "rev-parse", "integration"], repo);

  const job = await service.createJob({ projectId: project.id, goal: "work that gets taken back" });
  await service.runJob(job.id);
  const proposal = await service.proposeIntegration({ jobId: job.id });
  service.grantApproval({ proposalId: proposal.id, principal: "john", origin: "terminal" });
  await service.runIntegration(proposal.id);

  const integrated = service.briefing();
  assert.ok(integrated.done.some((entry) => entry.job === job.id), "first it is done");
  assert.equal(integrated.reverted.length, 0, "and nothing is reverted yet");

  await service.rollbackIntegration({ proposalId: proposal.id, principal: "john", origin: "local-cli" });

  const after = service.briefing();
  assert.ok(!after.done.some((entry) => entry.job === job.id), "it is no longer done");
  const entry = after.reverted.find((row) => row.job === job.id);
  assert.ok(entry, "and it is reported as reverted rather than disappearing");
  assert.equal(entry.restored_to, before, "the account names what the branch went back to");
  assert.ok(entry.reverted_from && entry.reverted_from !== before, "and what it came from");
  assert.ok(entry.rolled_back_at, "and when");

  // Exactly one bucket: an item in two places is as confusing as an item in none.
  const buckets = ["working", "needs_your_decision", "ready_to_check", "done", "reverted"]
    .filter((name) => after[name].some((row) => row.job === job.id));
  assert.deepEqual(buckets, ["reverted"]);
});

test("Hermes says a reverted change is no longer present", async (t) => {
  const { service, repo } = await fixture(t);
  const { summarizeStatus } = await import("../src/mcp/server.js");
  const project = await service.addProject({
    name: "reverted-wording", repoPath: repo, branch: "integration", validation: [],
  });
  const job = await service.createJob({ projectId: project.id, goal: "add a totals file" });
  await service.runJob(job.id);
  const proposal = await service.proposeIntegration({ jobId: job.id });
  service.grantApproval({ proposalId: proposal.id, principal: "john", origin: "terminal" });
  await service.runIntegration(proposal.id);
  await service.rollbackIntegration({ proposalId: proposal.id, principal: "john", origin: "local-cli" });

  const sentence = summarizeStatus(service.briefing());
  assert.match(sentence, /Reverted/, "the state is named");
  assert.match(sentence, /no longer present/, "and its consequence stated plainly");
  assert.match(sentence, /had succeeded/, "without implying the work itself failed");
});

// The two decisions are the only moments a person is needed. They should read as questions, not as
// queue depth with identifiers attached.
test("a proposal asks to approve work, without operator vocabulary", async () => {
  const { summarizeStatus } = await import("../src/mcp/server.js");
  const sentence = summarizeStatus({
    healthy: true, working: [], ready_to_check: [], done: [], reverted: [],
    needs_your_decision: [{ goal: "add a totals file to the report project.", ceiling_usd: 0.05 }],
  });
  assert.match(sentence, /I can do "add a totals file to the report project" with a cheap worker/);
  assert.match(sentence, /under \$0\.05\b/, "a ceiling reads as money, without trailing zeros");
  assert.match(sentence, /Approve\?/);
  assert.ok(!/\?\./.test(sentence), "a question is not also a statement");
});

test("a ready candidate reports what the checks found, not how to operate it", async () => {
  const { summarizeStatus } = await import("../src/mcp/server.js");
  const sentence = summarizeStatus({
    healthy: true, working: [], ready_to_check: [], done: [], reverted: [],
    needs_your_decision: [{
      goal: "add a totals file.", validation: "passed", files_changed: 3,
      cost: { reference_cost_usd: 0.0014, complete: true },
      proposal: "proposal_deadbeef", job: "job_deadbeef",
    }],
  });
  assert.match(sentence, /Validation passed, 3 files changed, about \$0\.0014/);
  assert.match(sentence, /Integrate it\?/);
  for (const leak of ["proposal_", "job_", "digest", "HarnessBackend", "OpenCodeBackend", "cherry-pick"]) {
    assert.ok(!sentence.includes(leak), `${leak} does not belong in the question`);
  }
});

test("one file is not 1 files", async () => {
  const { summarizeStatus } = await import("../src/mcp/server.js");
  const sentence = summarizeStatus({
    healthy: true, working: [], ready_to_check: [], done: [], reverted: [],
    needs_your_decision: [{ goal: "x", validation: "passed", files_changed: 1, cost: { reference_cost_usd: 0.001, complete: true } }],
  });
  assert.match(sentence, /1 file changed/);
});

// Cost that is not fully measured must not be stated as though it were final.
test("an incomplete cost is qualified rather than presented as the total", async () => {
  const { summarizeStatus } = await import("../src/mcp/server.js");
  const sentence = summarizeStatus({
    healthy: true, working: [], ready_to_check: [], done: [], reverted: [],
    needs_your_decision: [{
      goal: "x", validation: "passed", files_changed: 2,
      cost: { reference_cost_usd: 0.002, complete: false, unmeasured_attempts: 1 },
    }],
  });
  assert.match(sentence, /so far/, "an unmeasured attempt means this is not the whole bill");
});

// The identifiers must remain in the payload, because acting on a decision needs them.
test("the decision payload still carries what is needed to act", async (t) => {
  const { service, repo } = await fixture(t);
  const project = await service.addProject({
    name: "decision-payload", repoPath: repo, branch: "integration", validation: [],
  });
  const job = await service.createJob({ projectId: project.id, goal: "produce a candidate" });
  await service.runJob(job.id);
  await service.proposeIntegration({ jobId: job.id });

  const candidate = service.briefing().needs_your_decision
    .find((entry) => String(entry.proposal).startsWith("proposal_"));
  assert.ok(candidate.proposal, "the id an operator acts on is still present");
  assert.equal(candidate.job, job.id);
  assert.equal(candidate.decision, "Integrate this?");
  assert.equal(candidate.validation, "passed");
  assert.equal(candidate.files_changed, 1, "and the fact the sentence is built from");
});
