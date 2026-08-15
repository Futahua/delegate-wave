// Three things a person could not previously do, each of which left the everyday surface filling up
// with work already mentally abandoned, and whose only remedy was editing SQLite by hand.
//
//   retire a project     a repository you no longer keep made the health check fail forever
//   close an open job    cancel reported NOTHING_RUNNING and changed nothing
//   decline a candidate  approve existed; the "no" half of the decision did not
//
// None of them destroy anything. Every attempt, cost receipt, validation record and integration
// record survives, because that history is the point of the database.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeDataRoot } from "../src/db.js";
import { Dispatcher } from "../src/service.js";
import { FakeBackend } from "../src/backend.js";
import { runProcess } from "../src/process.js";

async function command(name, args, cwd) {
  const result = await runProcess(name, args, { cwd });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

const writer = (name = "out.txt") => new FakeBackend(async ({ worktreePath, artifactDir }) => {
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, "opencode-events.jsonl"), JSON.stringify({
    type: "step_finish",
    part: { tokens: { input: 100, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.0001 },
  }));
  fs.writeFileSync(path.join(worktreePath, name), "done\n");
  return { exitCode: 0, stdout: "ok", stderr: "" };
});

async function fixture(t, backend = writer()) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-retire-"));
  const root = path.join(temp, "data");
  initializeDataRoot(root);
  let made = 0;
  const service = new Dispatcher({ root, backend });
  const repos = [];
  const newProject = async (name) => {
    const repo = path.join(temp, `repo-${made += 1}`);
    repos.push(repo);
    fs.mkdirSync(repo);
    await command("git", ["init", "-b", "main"], repo);
    await command("git", ["config", "user.name", "Test"], repo);
    await command("git", ["config", "user.email", "test@example.invalid"], repo);
    fs.writeFileSync(path.join(repo, "input.txt"), "before\n");
    await command("git", ["add", "."], repo);
    await command("git", ["commit", "-m", "initial"], repo);
    await command("git", ["branch", "integration"], repo);
    return service.addProject({ name, repoPath: repo, branch: "integration", validation: [] });
  };
  t.after(async () => {
    service.close();
    for (const repo of repos) {
      if (!fs.existsSync(repo)) continue;
      const listed = await runProcess("git", ["-C", repo, "worktree", "list", "--porcelain"]);
      for (const worktree of listed.stdout.split(/\r?\n/)
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length))
        .filter((w) => path.resolve(w) !== path.resolve(repo))) {
        await runProcess("git", ["-C", repo, "worktree", "unlock", worktree]);
        await runProcess("git", ["-C", repo, "worktree", "remove", "--force", worktree]);
      }
    }
    fs.rmSync(temp, { recursive: true, force: true });
  });
  return { service, newProject, root };
}

const actor = { principal: "john", origin: "local-cli" };

// --- retiring a project -------------------------------------------------------------------------

test("a retired project's missing repository stops failing the health check", async (t) => {
  const { service, newProject } = await fixture(t);
  const project = await newProject("abandoned");
  const job = await service.createJob({ projectId: project.id, goal: "some work" });
  await service.runJob(job.id);

  // The repository is deleted, as it would be if the operator moved on.
  fs.rmSync(project.repo_path, { recursive: true, force: true });
  assert.equal(service.doctor().missing_repositories.length, 1, "doctor is right to complain");
  assert.equal(service.doctor().healthy, false);

  service.retireProject({ projectId: project.id, ...actor });

  assert.equal(service.doctor().missing_repositories.length, 0,
    "retiring means the repository is allowed to be gone");
  assert.equal(service.doctor().healthy, true);
  // A health signal nobody believes is worse than none, so this must not be achievable by deleting
  // the record: the history is still there.
  assert.ok(service.getJob(job.id), "the job survives");
  assert.equal(service.db.prepare("SELECT COUNT(*) c FROM attempts WHERE job_id = ?").get(job.id).c, 1);
});

test("a retired project's work leaves the everyday surface", async (t) => {
  const { service, newProject } = await fixture(t);
  const project = await newProject("noisy");
  const job = await service.createJob({ projectId: project.id, goal: "clutter" });
  await service.runJob(job.id);
  await service.proposeIntegration({ jobId: job.id });

  assert.ok(service.briefing().needs_your_decision.some((entry) => entry.job === job.id));
  service.retireProject({ projectId: project.id, ...actor });

  const briefing = service.briefing();
  for (const bucket of ["working", "needs_your_decision", "ready_to_check", "done", "reverted"]) {
    assert.ok(!briefing[bucket].some((entry) => entry.job === job.id),
      `${bucket} no longer carries a retired project's work`);
  }
});

test("retiring refuses while a worker is running, and is reversible", async (t) => {
  const { service, newProject } = await fixture(t);
  const project = await newProject("busy");
  const job = await service.createJob({ projectId: project.id, goal: "produce a candidate" });
  await service.runJob(job.id);

  // A pending candidate does NOT block: nothing is executing, and restoring brings it back.
  const retired = service.retireProject({ projectId: project.id, ...actor });
  assert.equal(retired.retired, true);

  const restored = service.restoreProject({ projectId: project.id, ...actor });
  assert.equal(restored.restored, true, "retiring is not a one-way door");
  assert.equal(service.getProject(project.id).retired_at, null);

  // A genuinely running job does block, because retiring would hide live activity.
  service.db.prepare("UPDATE jobs SET status = 'RUNNING' WHERE id = ?").run(job.id);
  assert.throws(
    () => service.retireProject({ projectId: project.id, ...actor }),
    /still running/,
  );
});

test("retiring requires an authorizing identity", async (t) => {
  const { service, newProject } = await fixture(t);
  const project = await newProject("unauthorized");
  assert.throws(() => service.retireProject({ projectId: project.id }), /authorizing identity/);
});

// --- closing an open job ------------------------------------------------------------------------

test("a job stuck needing attention can be closed", async (t) => {
  const { service, newProject } = await fixture(t);
  const project = await newProject("stuck");
  const job = await service.createJob({ projectId: project.id, goal: "unfixable", maxAttempts: 1 });
  service.db.prepare("UPDATE jobs SET status = 'NEEDS_ATTENTION' WHERE id = ?").run(job.id);
  assert.ok(service.briefing().ready_to_check.some((entry) => entry.job === job.id));

  const outcome = await service.cancelJob({ jobId: job.id, ...actor, reason: "not pursuing this" });
  assert.equal(outcome.outcome, "CLOSED");
  assert.equal(outcome.killed_pid, null, "nothing was running, so nothing was killed");
  assert.equal(service.getJob(job.id).status, "CANCELLED");
  assert.ok(!service.briefing().ready_to_check.some((entry) => entry.job === job.id));

  const closed = service.db.prepare(
    "SELECT payload_json FROM events WHERE kind = 'JOB_CLOSED' AND entity_id = ?",
  ).get(job.id);
  assert.ok(closed, "the decision is recorded, with who made it and why");
  assert.match(closed.payload_json, /not pursuing this/);
});

// --- declining a candidate ----------------------------------------------------------------------

test("a candidate can be declined, and nothing is destroyed", async (t) => {
  const { service, newProject } = await fixture(t);
  const project = await newProject("declined");
  const job = await service.createJob({ projectId: project.id, goal: "produce a candidate" });
  await service.runJob(job.id);
  const proposal = await service.proposeIntegration({ jobId: job.id });
  const before = await command("git", ["-C", project.repo_path, "rev-parse", "integration"], project.repo_path);

  const declined = service.declineIntegration({ proposalId: proposal.id, ...actor, reason: "changed my mind" });
  assert.equal(declined.declined, true);
  assert.equal(service.getJob(job.id).status, "CANCELLED");
  assert.ok(!service.briefing().needs_your_decision.some((entry) => entry.proposal === proposal.id));

  // Nothing was integrated, and every record survives.
  assert.equal(
    await command("git", ["-C", project.repo_path, "rev-parse", "integration"], project.repo_path),
    before, "the branch never moved",
  );
  const attempt = service.db.prepare("SELECT * FROM attempts WHERE job_id = ?").get(job.id);
  assert.equal(attempt.terminal_state, "SUCCEEDED", "the work still succeeded");
  assert.ok(attempt.result_commit, "and its candidate commit is still recorded");
  assert.ok(service.db.prepare(
    "SELECT 1 FROM attempt_usage_receipts WHERE attempt_id = ?",
  ).get(attempt.id), "and its cost receipt");
});

test("declining twice is not an error, and an integrated candidate cannot be declined", async (t) => {
  const { service, newProject } = await fixture(t);
  const project = await newProject("already");
  const job = await service.createJob({ projectId: project.id, goal: "produce a candidate" });
  await service.runJob(job.id);
  const proposal = await service.proposeIntegration({ jobId: job.id });

  service.declineIntegration({ proposalId: proposal.id, ...actor });
  const again = service.declineIntegration({ proposalId: proposal.id, ...actor });
  assert.equal(again.declined, false);
  assert.equal(again.reason, "already declined");

  // The proposal row itself is untouched: it is immutable, and the decision lives in the records.
  assert.equal(service.getProposal(proposal.id).state, "OPEN");
  assert.ok(service.latestDecline(proposal.id), "the decline is recorded where it can be read back");
});

test("an integrated candidate must be rolled back, not declined", async (t) => {
  const { service, newProject } = await fixture(t);
  const project = await newProject("integrated");
  const job = await service.createJob({ projectId: project.id, goal: "produce a candidate" });
  await service.runJob(job.id);
  const proposal = await service.proposeIntegration({ jobId: job.id });
  service.grantApproval({ proposalId: proposal.id, ...actor });
  await service.runIntegration(proposal.id);

  assert.throws(
    () => service.declineIntegration({ proposalId: proposal.id, ...actor }),
    /already integrated; roll it back/,
    "declining something that already landed would be a false claim about what happened",
  );
});

// A validated candidate must not be discarded by a mistyped cancel: declining is its own decision.
test("cancel does not silently discard a validated candidate", async (t) => {
  const { service, newProject } = await fixture(t);
  const project = await newProject("protected-candidate");
  const job = await service.createJob({ projectId: project.id, goal: "produce a candidate" });
  await service.runJob(job.id);
  assert.equal(service.getJob(job.id).status, "READY_FOR_INTEGRATION");

  const outcome = await service.cancelJob({ jobId: job.id, ...actor });
  assert.equal(outcome.outcome, "ALREADY_TERMINAL");
  assert.equal(service.getJob(job.id).status, "READY_FOR_INTEGRATION",
    "the candidate survives; declining it is a separate, explicit decision");
});
