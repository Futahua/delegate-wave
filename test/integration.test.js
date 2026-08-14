import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeDataRoot } from "../src/db.js";
import { FakeBackend } from "../src/backend.js";
import { Dispatcher } from "../src/service.js";
import { updateRefCas } from "../src/git.js";
import { runProcess } from "../src/process.js";

async function command(name, args, cwd) {
  const result = await runProcess(name, args, { cwd });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-integration-"));
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
  return { temp, root, repo, cleanup };
}

function writeCandidateBackend(content) {
  return new FakeBackend(async ({ worktreePath }) => {
    fs.writeFileSync(path.join(worktreePath, "output.txt"), content);
    return { exitCode: 0, stdout: "ok", stderr: "" };
  });
}

async function readyProposal(service, projectId, backend, goal = "create output") {
  const job = await service.createJob({ projectId, goal });
  const ready = await service.runJob(job.id);
  assert.equal(ready.job.status, "READY_FOR_INTEGRATION");
  const proposal = await service.proposeIntegration({ jobId: job.id });
  return { job, proposal };
}

test("approved integration cherry-picks the candidate and advances the branch", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: writeCandidateBackend("candidate\n") });
  t.after(async () => { service.close(); await cleanup(); });
  const project = await service.addProject({ name: "Fixture", repoPath: repo, branch: "integration", validation: [] });
  const { job, proposal } = await readyProposal(service, project.id, service.backend);
  assert.equal(proposal.state, "OPEN");
  assert.equal(proposal.integration_branch, "integration");
  assert.equal(proposal.expected_integration_head, proposal.base_sha);
  assert.equal(proposal.candidate_commit, service.status(job.id).attempts[0].result_commit);

  const repeated = await service.proposeIntegration({ jobId: job.id });
  assert.equal(repeated.id, proposal.id);

  const approval = service.grantApproval({ proposalId: proposal.id, principal: "human-1", origin: "terminal" });
  assert.equal(approval.granted_digest, proposal.action_digest);
  const repeatedApproval = service.grantApproval({ proposalId: proposal.id, principal: "human-1", origin: "terminal" });
  assert.equal(repeatedApproval.id, approval.id);

  const before = await command("git", ["-C", repo, "rev-parse", "integration"]);
  const result = await service.runIntegration(proposal.id);
  assert.equal(result.proposal.state, "INTEGRATED");
  assert.equal(result.operations.length, 1);
  assert.equal(result.operations[0].state, "SUCCEEDED");
  const after = await command("git", ["-C", repo, "rev-parse", "integration"]);
  assert.notEqual(after, before);
  assert.equal(after, result.operations[0].new_head);
  assert.equal(await command("git", ["-C", repo, "rev-parse", `${after}^`]), before);
  assert.equal(service.status(job.id).job.status, "SUCCEEDED");
  assert.ok(fs.existsSync(path.join(root, "integration", project.id, proposal.id)));
  assert.equal(fs.existsSync(path.join(repo, "output.txt")), false, "user checkout must remain untouched");
  assert.equal(result.approvals[0].expected_state_version, proposal.action_digest);
  assert.equal(result.approvals[0].granted_scope, "integration");
});

test("re-running a successful integration is idempotent and consumes nothing extra", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: writeCandidateBackend("candidate\n") });
  t.after(async () => { service.close(); await cleanup(); });
  const project = await service.addProject({ name: "Fixture", repoPath: repo, branch: "integration", validation: [] });
  const { proposal } = await readyProposal(service, project.id, service.backend);
  service.grantApproval({ proposalId: proposal.id, principal: "human-1", origin: "terminal" });
  const first = await service.runIntegration(proposal.id);
  const headAfterFirst = await command("git", ["-C", repo, "rev-parse", "integration"]);
  const second = await service.runIntegration(proposal.id);
  assert.equal(second.proposal.state, "INTEGRATED");
  assert.equal(second.operations.length, 1);
  assert.equal(second.operations[0].state, "SUCCEEDED");
  assert.equal(await command("git", ["-C", repo, "rev-parse", "integration"]), headAfterFirst);
  const receipts = service.integrationStatus(proposal.id).approvals;
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].consumed, 1);
});

test("integration refuses without an unexpired approval and leaves the branch untouched", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: writeCandidateBackend("candidate\n") });
  t.after(async () => { service.close(); await cleanup(); });
  const project = await service.addProject({ name: "Fixture", repoPath: repo, branch: "integration", validation: [] });
  const { proposal } = await readyProposal(service, project.id, service.backend);
  const before = await command("git", ["-C", repo, "rev-parse", "integration"]);
  await assert.rejects(service.runIntegration(proposal.id), /No unexpired unconsumed approval/);
  assert.equal(await command("git", ["-C", repo, "rev-parse", "integration"]), before);
  assert.equal(service.getProposal(proposal.id).state, "OPEN");
  const operations = service.db.prepare("SELECT * FROM integration_operations WHERE proposal_id = ?").all(proposal.id);
  assert.equal(operations.length, 0);
});

test("integration refuses an expired approval", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: writeCandidateBackend("candidate\n") });
  t.after(async () => { service.close(); await cleanup(); });
  const project = await service.addProject({ name: "Fixture", repoPath: repo, branch: "integration", validation: [] });
  const { proposal } = await readyProposal(service, project.id, service.backend);
  service.db.prepare(`INSERT INTO approval_receipts(
    id, proposal_id, principal, origin, expires_at, idempotency_key, granted_digest,
    expected_state_version, granted_scope, maximum_cost, granted_at
  ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'integration', NULL, ?)`).run(
    "approval-expired", proposal.id, "human-1", "fixture",
    new Date(Date.now() - 1000).toISOString(), proposal.action_digest, proposal.action_digest,
    new Date(Date.now() - 2000).toISOString(),
  );
  const before = await command("git", ["-C", repo, "rev-parse", "integration"]);
  await assert.rejects(service.runIntegration(proposal.id), /No unexpired unconsumed approval/);
  assert.equal(await command("git", ["-C", repo, "rev-parse", "integration"]), before);
});

test("integration refuses when the expected head changed and recovers once it matches again", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: writeCandidateBackend("candidate\n") });
  t.after(async () => { service.close(); await cleanup(); });
  const project = await service.addProject({ name: "Fixture", repoPath: repo, branch: "integration", validation: [] });
  const { proposal } = await readyProposal(service, project.id, service.backend);
  service.grantApproval({ proposalId: proposal.id, principal: "human-1", origin: "terminal" });

  const tree = await command("git", ["-C", repo, "write-tree"]);
  const manual = await command("git", ["-C", repo, "commit-tree", tree, "-p", "integration", "-m", "manual advance"]);
  await command("git", ["-C", repo, "update-ref", "refs/heads/integration", manual]);
  await assert.rejects(service.runIntegration(proposal.id), /Integration head changed/);
  assert.equal(await command("git", ["-C", repo, "rev-parse", "integration"]), manual);

  await command("git", ["-C", repo, "update-ref", "refs/heads/integration", proposal.expected_integration_head]);
  service.grantApproval({ proposalId: proposal.id, principal: "human-1", origin: "terminal" });
  const result = await service.runIntegration(proposal.id);
  assert.equal(result.proposal.state, "INTEGRATED");
  assert.equal(result.operations[0].state, "FAILED");
  assert.equal(result.operations[1].state, "SUCCEEDED");
});

test("integration executes the snapshotted validation plan despite project mutation", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: writeCandidateBackend("candidate\n") });
  t.after(async () => { service.close(); await cleanup(); });
  const project = await service.addProject({ name: "Fixture", repoPath: repo, branch: "integration", validation: [] });
  const { proposal } = await readyProposal(service, project.id, service.backend);
  service.grantApproval({ proposalId: proposal.id, principal: "human-1", origin: "terminal" });
  service.db.prepare("UPDATE projects SET validation_json = ? WHERE id = ?")
    .run(JSON.stringify(["node -e \"process.exit(77)\""]), project.id);
  const before = await command("git", ["-C", repo, "rev-parse", "integration"]);
  const result = await service.runIntegration(proposal.id);
  assert.equal(result.proposal.state, "INTEGRATED");
  assert.notEqual(await command("git", ["-C", repo, "rev-parse", "integration"]), before);
});

test("failed integration validation records failure without moving the branch, then retries", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const marker = path.join(root, "validation-marker.txt");
  const checker = path.join(root, "checker.js");
  fs.writeFileSync(checker, "const fs = require('fs'); if (!fs.existsSync(process.argv[2])) process.exit(1);\n");
  const quoted = (value) => JSON.stringify(value.replaceAll("\\", "/"));
  const service = new Dispatcher({ root, backend: writeCandidateBackend("candidate\n") });
  t.after(async () => { service.close(); await cleanup(); });
  const project = await service.addProject({
    name: "Fixture", repoPath: repo, branch: "integration",
    validation: [`node ${quoted(checker)} ${quoted(marker)}`],
  });
  const job = await service.createJob({ projectId: project.id, goal: "gated candidate" });
  fs.writeFileSync(marker, "present\n");
  assert.equal((await service.runJob(job.id)).job.status, "READY_FOR_INTEGRATION");
  const proposal = await service.proposeIntegration({ jobId: job.id });
  service.grantApproval({ proposalId: proposal.id, principal: "human-1", origin: "terminal" });
  const before = await command("git", ["-C", repo, "rev-parse", "integration"]);

  fs.rmSync(marker, { force: true });
  await assert.rejects(service.runIntegration(proposal.id), /integration validation failed/);
  const after = await command("git", ["-C", repo, "rev-parse", "integration"]);
  assert.equal(after, before);
  const failed = service.integrationStatus(proposal.id);
  assert.equal(failed.proposal.state, "OPEN");
  assert.equal(failed.operations.length, 1);
  assert.equal(failed.operations[0].state, "FAILED");
  assert.equal(service.status(job.id).job.status, "READY_FOR_INTEGRATION");

  fs.writeFileSync(marker, "present\n");
  service.grantApproval({ proposalId: proposal.id, principal: "human-1", origin: "terminal" });
  const retry = await service.runIntegration(proposal.id);
  assert.equal(retry.proposal.state, "INTEGRATED");
  assert.equal(retry.operations.length, 2);
  assert.equal(retry.operations[1].state, "SUCCEEDED");
  assert.notEqual(await command("git", ["-C", repo, "rev-parse", "integration"]), before);
});

test("integration refuses when the branch is checked out in another worktree", async (t) => {
  const { temp, root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: writeCandidateBackend("candidate\n") });
  t.after(async () => { service.close(); await cleanup(); });
  const project = await service.addProject({ name: "Fixture", repoPath: repo, branch: "integration", validation: [] });
  const { proposal } = await readyProposal(service, project.id, service.backend);
  service.grantApproval({ proposalId: proposal.id, principal: "human-1", origin: "terminal" });
  const other = path.join(temp, "other-checkout");
  await command("git", ["-C", repo, "worktree", "add", other, "integration"]);
  const before = await command("git", ["-C", repo, "rev-parse", "integration"]);
  await assert.rejects(service.runIntegration(proposal.id), /checked out in another worktree/);
  assert.equal(await command("git", ["-C", repo, "rev-parse", "integration"]), before);

  await command("git", ["-C", repo, "worktree", "remove", "--force", other]);
  service.grantApproval({ proposalId: proposal.id, principal: "human-1", origin: "terminal" });
  const result = await service.runIntegration(proposal.id);
  assert.equal(result.proposal.state, "INTEGRATED");
});

test("a later valid approval is selected when an earlier receipt expired", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: writeCandidateBackend("candidate\n") });
  t.after(async () => { service.close(); await cleanup(); });
  const project = await service.addProject({ name: "Fixture", repoPath: repo, branch: "integration", validation: [] });
  const { proposal } = await readyProposal(service, project.id, service.backend);
  service.db.prepare(`INSERT INTO approval_receipts(
    id, proposal_id, principal, origin, expires_at, idempotency_key, granted_digest,
    expected_state_version, granted_scope, maximum_cost, granted_at
  ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'integration', NULL, ?)`).run(
    "approval-old", proposal.id, "human-1", "fixture",
    new Date(Date.now() - 1000).toISOString(), proposal.action_digest, proposal.action_digest,
    new Date(Date.now() - 2000).toISOString(),
  );
  const valid = service.grantApproval({
    proposalId: proposal.id, principal: "human-1", origin: "terminal", maximumCost: 0,
  });
  const result = await service.runIntegration(proposal.id);
  assert.equal(result.proposal.state, "INTEGRATED");
  assert.equal(result.operations[0].approval_receipt_id, valid.id);
  assert.equal(valid.maximum_cost, 0);
});

test("tampered proposal validation data is rejected before authority is consumed", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: writeCandidateBackend("candidate\n") });
  t.after(async () => { service.close(); await cleanup(); });
  const project = await service.addProject({ name: "Fixture", repoPath: repo, branch: "integration", validation: [] });
  const { proposal } = await readyProposal(service, project.id, service.backend);
  service.grantApproval({ proposalId: proposal.id, principal: "human-1", origin: "terminal" });
  service.db.exec("DROP TRIGGER trg_proposals_immutable_update");
  service.db.prepare("UPDATE integration_proposals SET validation_plan_json = ? WHERE id = ?")
    .run(JSON.stringify(["node -e \"process.exit(9)\""]), proposal.id);
  await assert.rejects(service.runIntegration(proposal.id), /Stored validation plan digest mismatch/);
  assert.equal(service.integrationStatus(proposal.id).operations.length, 0);
});

test("malformed stored validation JSON never degrades to an empty plan", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: writeCandidateBackend("candidate\n") });
  t.after(async () => { service.close(); await cleanup(); });
  const project = await service.addProject({ name: "Fixture", repoPath: repo, branch: "integration", validation: [] });
  const { proposal } = await readyProposal(service, project.id, service.backend);
  service.grantApproval({ proposalId: proposal.id, principal: "human-1", origin: "terminal" });
  service.db.exec("DROP TRIGGER trg_proposals_immutable_update");
  service.db.prepare("UPDATE integration_proposals SET validation_plan_json = ? WHERE id = ?")
    .run("{", proposal.id);
  await assert.rejects(service.runIntegration(proposal.id), /Stored validation plan is not valid JSON/);
  assert.equal(service.integrationStatus(proposal.id).operations.length, 0);
});

test("the CAS primitive refuses a branch checked out after any scheduler precheck", async (t) => {
  const { temp, repo, cleanup } = await fixture(t);
  t.after(cleanup);
  const expected = await command("git", ["-C", repo, "rev-parse", "integration"]);
  const tree = await command("git", ["-C", repo, "write-tree"]);
  const next = await command("git", ["-C", repo, "commit-tree", tree, "-p", expected, "-m", "next"]);
  const other = path.join(temp, "late-checkout");
  await command("git", ["-C", repo, "worktree", "add", other, "integration"]);
  await command("git", ["-C", repo, "config", "receive.denyCurrentBranch", "ignore"]);
  await assert.rejects(
    updateRefCas(repo, "refs/heads/integration", next, expected),
    /refusing to update checked out branch/,
  );
  assert.equal(await command("git", ["-C", repo, "rev-parse", "integration"]), expected);
});

test("production CAS refuses a checkout created between the final precheck and ref transaction", async (t) => {
  const { temp, root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: writeCandidateBackend("candidate\n") });
  t.after(async () => { service.close(); await cleanup(); });
  const project = await service.addProject({ name: "Fixture", repoPath: repo, branch: "integration", validation: [] });
  const { proposal } = await readyProposal(service, project.id, service.backend);
  service.grantApproval({ proposalId: proposal.id, principal: "human-1", origin: "terminal" });
  await command("git", ["-C", repo, "config", "receive.denyCurrentBranch", "ignore"]);
  const other = path.join(temp, "racing-checkout");
  const originalCheck = service.assertIntegrationHeadUnchanged.bind(service);
  let checks = 0;
  service.assertIntegrationHeadUnchanged = async (...args) => {
    await originalCheck(...args);
    checks += 1;
    if (checks === 2) await command("git", ["-C", repo, "worktree", "add", other, "integration"]);
  };
  const before = await command("git", ["-C", repo, "rev-parse", "integration"]);
  await assert.rejects(service.runIntegration(proposal.id), /refusing to update checked out branch/);
  assert.equal(await command("git", ["-C", repo, "rev-parse", "integration"]), before);
  assert.equal(service.integrationStatus(proposal.id).operations[0].state, "FAILED");
});

test("candidate ancestry failure is terminal and consumes only its exact approval", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: writeCandidateBackend("candidate\n") });
  t.after(async () => { service.close(); await cleanup(); });
  const project = await service.addProject({ name: "Fixture", repoPath: repo, branch: "integration", validation: [] });
  const { proposal } = await readyProposal(service, project.id, service.backend);
  const tree = await command("git", ["-C", repo, "rev-parse", `${proposal.base_sha}^{tree}`]);
  const unrelated = await command("git", ["-C", repo, "commit-tree", tree, "-m", "unrelated root"]);
  const actionDigest = service.actionDigest({
    projectId: proposal.project_id, jobId: proposal.job_id, attemptId: proposal.attempt_id,
    baseSha: unrelated, candidateCommit: proposal.candidate_commit,
    integrationBranch: proposal.integration_branch, expectedHead: proposal.expected_integration_head,
    planDigest: proposal.validation_plan_digest,
  });
  service.db.exec("DROP TRIGGER trg_proposals_immutable_update");
  service.db.prepare("UPDATE integration_proposals SET base_sha = ?, action_digest = ? WHERE id = ?")
    .run(unrelated, actionDigest, proposal.id);
  service.grantApproval({ proposalId: proposal.id, principal: "human-1", origin: "terminal" });
  await assert.rejects(service.runIntegration(proposal.id), /does not descend from base/);
  const status = service.integrationStatus(proposal.id);
  assert.equal(status.operations[0].state, "FAILED");
  assert.equal(status.approvals[0].consumed, 1);
});

test("integration authority rows and receipts are immutable", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: writeCandidateBackend("candidate\n") });
  t.after(async () => { service.close(); await cleanup(); });
  const project = await service.addProject({ name: "Fixture", repoPath: repo, branch: "integration", validation: [] });
  const { proposal } = await readyProposal(service, project.id, service.backend);
  service.grantApproval({ proposalId: proposal.id, principal: "human-1", origin: "terminal" });
  const status = await service.runIntegration(proposal.id);
  for (const [table, idColumn, value, timestampColumn] of [
    ["integration_proposals", "id", proposal.id, "created_at"],
    ["approval_receipts", "id", status.approvals[0].id, "granted_at"],
    ["integration_operations", "id", status.operations[0].id, "created_at"],
    ["integration_records", "sequence", status.records[0].sequence, "created_at"],
  ]) {
    assert.throws(() => service.db.prepare(`UPDATE ${table} SET ${timestampColumn} = ${timestampColumn} WHERE ${idColumn} = ?`).run(value), /immutable/);
    assert.throws(() => service.db.prepare(`DELETE FROM ${table} WHERE ${idColumn} = ?`).run(value), /immutable/);
  }
});

test("an operation intent without a terminal record fails closed", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: writeCandidateBackend("candidate\n") });
  t.after(async () => { service.close(); await cleanup(); });
  const project = await service.addProject({ name: "Fixture", repoPath: repo, branch: "integration", validation: [] });
  const { proposal } = await readyProposal(service, project.id, service.backend);
  const approval = service.grantApproval({ proposalId: proposal.id, principal: "human-1", origin: "terminal" });
  service.db.prepare(`INSERT INTO integration_operations(
    id, proposal_id, approval_receipt_id, action_digest, base_sha, candidate_commit,
    integration_branch, expected_integration_head, validation_plan_digest, state, worktree_path, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'INTENDED', ?, ?)`).run(
    "operation-stuck", proposal.id, approval.id, proposal.action_digest, proposal.base_sha,
    proposal.candidate_commit, proposal.integration_branch, proposal.expected_integration_head,
    proposal.validation_plan_digest, path.join(root, "integration", project.id, proposal.id),
    new Date().toISOString(),
  );
  await assert.rejects(service.runIntegration(proposal.id), /stuck without a terminal outcome/);
  assert.equal(service.integrationStatus(proposal.id).operations[0].state, "INTENDED");
});

test("a receipt failure after CAS remains uncertain instead of being mislabeled failed", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: writeCandidateBackend("candidate\n") });
  t.after(async () => { service.close(); await cleanup(); });
  const project = await service.addProject({ name: "Fixture", repoPath: repo, branch: "integration", validation: [] });
  const { proposal } = await readyProposal(service, project.id, service.backend);
  service.grantApproval({ proposalId: proposal.id, principal: "human-1", origin: "terminal" });
  const before = await command("git", ["-C", repo, "rev-parse", "integration"]);
  const originalRecord = service.recordIntegrationRecord.bind(service);
  service.recordIntegrationRecord = (operationId, proposalId, kind, detail) => {
    if (kind === "BRANCH_ADVANCED") throw new Error("injected receipt failure");
    return originalRecord(operationId, proposalId, kind, detail);
  };
  await assert.rejects(service.runIntegration(proposal.id), /reconciliation required/);
  const after = await command("git", ["-C", repo, "rev-parse", "integration"]);
  assert.notEqual(after, before);
  const status = service.integrationStatus(proposal.id);
  assert.equal(status.operations[0].state, "INTENDED");
  assert.equal(status.records.some((record) => record.kind === "INTEGRATION_FAILED"), false);
  assert.equal(status.records.some((record) => record.kind === "BRANCH_ADVANCE_INTENDED"), true);
  await assert.rejects(service.runIntegration(proposal.id), /stuck without a terminal outcome/);
});

test("an ambiguous CAS error is reconciled from the ref instead of recording false failure", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({
    root,
    backend: writeCandidateBackend("candidate\n"),
    updateRef: async (...args) => {
      await updateRefCas(...args);
      throw new Error("injected lost receive-pack acknowledgement");
    },
  });
  t.after(async () => { service.close(); await cleanup(); });
  const project = await service.addProject({ name: "Fixture", repoPath: repo, branch: "integration", validation: [] });
  const { proposal } = await readyProposal(service, project.id, service.backend);
  service.grantApproval({ proposalId: proposal.id, principal: "human-1", origin: "terminal" });
  const before = await command("git", ["-C", repo, "rev-parse", "integration"]);
  await assert.rejects(service.runIntegration(proposal.id), /outcome is uncertain/);
  assert.notEqual(await command("git", ["-C", repo, "rev-parse", "integration"]), before);
  const status = service.integrationStatus(proposal.id);
  assert.equal(status.operations[0].state, "INTENDED");
  assert.equal(status.records.some((record) => record.kind === "INTEGRATION_FAILED"), false);
});

test("proposal creation refuses a non-ready or non-write job", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: writeCandidateBackend("candidate\n") });
  t.after(async () => { service.close(); await cleanup(); });
  const project = await service.addProject({ name: "Fixture", repoPath: repo, branch: "integration", validation: [] });
  const pending = await service.createJob({ projectId: project.id, goal: "still pending" });
  await assert.rejects(service.proposeIntegration({ jobId: pending.id }), /expected READY_FOR_INTEGRATION/);
  const read = await service.createJob({ projectId: project.id, goal: "read only", mode: "read" });
  await assert.rejects(service.proposeIntegration({ jobId: read.id }), /only write jobs/);
});

test("malformed project validation config is rejected before worker claim", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: writeCandidateBackend("candidate\n") });
  t.after(async () => { service.close(); await cleanup(); });
  const project = await service.addProject({ name: "Fixture", repoPath: repo, branch: "integration", validation: [] });
  const job = await service.createJob({ projectId: project.id, goal: "must not run" });
  service.db.prepare("UPDATE projects SET validation_json = ? WHERE id = ?").run("{", project.id);
  const epochBefore = service.db.prepare("SELECT value FROM metadata WHERE key = 'scheduler_epoch'").get().value;
  await assert.rejects(service.runJob(job.id), /Stored validation plan is not valid JSON/);
  assert.equal(service.status(job.id).attempts.length, 0);
  assert.equal(service.db.prepare("SELECT value FROM metadata WHERE key = 'scheduler_epoch'").get().value, epochBefore);
});
