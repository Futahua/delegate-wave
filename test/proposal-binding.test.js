// A proposal is a statement about one world. Authorizing it against a different one substitutes work
// nobody proposed.
//
// Schema 19 added expected_base_sha and strategy to work_proposals with comments explaining exactly
// why the state version alone is insufficient -- and then the executable path used neither. The
// columns existed, the invariant did not, and the system reported that the proposal matched.
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
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-bind-"));
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
  const service = new Dispatcher({ root, backend: new FakeBackend() });
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
  return { service, repo, root };
}

const propose = (service, project, extra = {}) => service.proposeWork({
  projectId: project.id,
  goal: "add a totals file",
  idempotencyKey: `k-${Math.random()}`,
  principal: "hermes-proposer",
  origin: "hermes-mcp",
  ...extra,
});

test("a proposal records the repository head it was written against", async (t) => {
  const { service, repo } = await fixture(t);
  const project = await service.addProject({ name: "Bind", repoPath: repo, validation: [] });
  const head = await command("git", ["rev-parse", "HEAD"], repo);

  const proposal = await propose(service, project);
  assert.equal(proposal.expected_base_sha, head);
  assert.equal(proposal.strategy, "direct");
});

test("authorization refuses a proposal whose branch has moved", async (t) => {
  const { service, repo } = await fixture(t);
  const project = await service.addProject({ name: "Moved", repoPath: repo, validation: [] });
  const proposal = await propose(service, project);

  // The world changes between proposal and authorization. No delegate-wave job ran, so the state
  // version is untouched -- which is precisely why it cannot be the thing that detects this.
  fs.writeFileSync(path.join(repo, "input.txt"), "after\n");
  await command("git", ["add", "."], repo);
  await command("git", ["commit", "-m", "someone else committed"], repo);

  // The dangerous state, asserted rather than assumed: the branch really did move away from the head
  // this proposal was written against. Without this the test could pass on a rejection that came
  // from somewhere else entirely while the base check sat dead.
  const moved = await command("git", ["rev-parse", "HEAD"], repo);
  assert.notEqual(moved, proposal.expected_base_sha, "the branch must actually have moved");

  assert.equal(
    service.projectStateVersion(project.id),
    proposal.expected_state_version,
    "the state version is blind to this, which is the whole point",
  );

  await assert.rejects(
    service.authorizeWorkProposal({ proposalId: proposal.id, principal: "john", origin: "terminal" }),
    /was written against .* but the branch is now at/,
  );
});

test("a managed proposal produces a managed job", async (t) => {
  const { service, repo } = await fixture(t);
  const project = await service.addProject({ name: "Managed", repoPath: repo, validation: [] });
  const proposal = await propose(service, project, { strategy: "managed" });
  assert.equal(proposal.strategy, "managed");

  const decided = await service.authorizeWorkProposal({
    proposalId: proposal.id, principal: "john", origin: "terminal",
  });
  const job = service.getJob(decided.decision.job_id);
  // The operator authorized managed execution; anything else is a different piece of work.
  assert.equal(job.strategy, "managed");
});

test("a direct proposal still produces a direct job", async (t) => {
  const { service, repo } = await fixture(t);
  const project = await service.addProject({ name: "Direct", repoPath: repo, validation: [] });
  const proposal = await propose(service, project);
  const decided = await service.authorizeWorkProposal({
    proposalId: proposal.id, principal: "john", origin: "terminal",
  });
  assert.equal(service.getJob(decided.decision.job_id).strategy, "direct");
});

test("editing a stored proposal's strategy breaks its digest", async (t) => {
  const { service, repo } = await fixture(t);
  const project = await service.addProject({ name: "Tamper", repoPath: repo, validation: [] });
  const proposal = await propose(service, project);

  // Strategy is inside the action digest, so a row edited after the operator read the proposal
  // cannot authorize different execution than what was shown.
  service.db.exec("DROP TRIGGER IF EXISTS trg_work_proposals_immutable_update");
  service.db.prepare("UPDATE work_proposals SET strategy = 'managed' WHERE id = ?").run(proposal.id);

  await assert.rejects(
    service.authorizeWorkProposal({ proposalId: proposal.id, principal: "john", origin: "terminal" }),
    /action digest does not match its stored intent/,
  );
});

test("editing a stored proposal's expected base breaks its digest", async (t) => {
  const { service, repo } = await fixture(t);
  const project = await service.addProject({ name: "TamperBase", repoPath: repo, validation: [] });
  const proposal = await propose(service, project);

  service.db.exec("DROP TRIGGER IF EXISTS trg_work_proposals_immutable_update");
  service.db.prepare("UPDATE work_proposals SET expected_base_sha = ? WHERE id = ?")
    .run("0".repeat(40), proposal.id);

  await assert.rejects(
    service.authorizeWorkProposal({ proposalId: proposal.id, principal: "john", origin: "terminal" }),
    /action digest does not match its stored intent|was written against/,
  );
});

test("two identical proposals with one idempotency key resolve to the same proposal", async (t) => {
  const { service, repo } = await fixture(t);
  const project = await service.addProject({ name: "Idem", repoPath: repo, validation: [] });
  const first = await propose(service, project, { idempotencyKey: "same", strategy: "managed" });
  const second = await propose(service, project, { idempotencyKey: "same", strategy: "managed" });
  assert.equal(second.id, first.id);
});

test("the same key with a different strategy is refused, not silently reused", async (t) => {
  const { service, repo } = await fixture(t);
  const project = await service.addProject({ name: "IdemConflict", repoPath: repo, validation: [] });
  await propose(service, project, { idempotencyKey: "same", strategy: "direct" });
  await assert.rejects(
    propose(service, project, { idempotencyKey: "same", strategy: "managed" }),
    /was already used for a different proposal/,
  );
});
