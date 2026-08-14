// Product-path acceptance: the complete alpha loop, driven over the real Control API with three
// distinct credentials.
//
//   natural-language request -> bounded proposal -> human authorization -> cheap worker
//   -> deterministic validation -> integration approval -> integration -> Hermes reports completed
//
// The proposal credential never holds operator authority at any step; every transition that changes
// the world is performed with the operator credential.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeDataRoot } from "../src/db.js";
import { FakeBackend } from "../src/backend.js";
import { Dispatcher } from "../src/service.js";
import { ControlClient } from "../src/control/client.js";
import { ControlService } from "../src/control/service.js";
import { createControlServer } from "../src/control/server.js";
import { runProcess } from "../src/process.js";

const requestId = () => `req_${crypto.randomUUID()}`;

async function command(name, args, cwd) {
  const result = await runProcess(name, args, { cwd });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-acceptance-"));
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

  // A cheap worker that produces the requested file, then deterministic validation checks it.
  const backend = new FakeBackend(async ({ worktreePath }) => {
    fs.writeFileSync(path.join(worktreePath, "output.txt"), "worker-result\n");
    return { exitCode: 0, stdout: "ok", stderr: "" };
  });
  const dispatcher = new Dispatcher({ root, backend });
  const service = new ControlService({ dispatcher });

  const token = `operator-${crypto.randomUUID()}`;
  const observerToken = `observer-${crypto.randomUUID()}`;
  const proposerToken = `proposer-${crypto.randomUUID()}`;
  const server = createControlServer({
    service, token, principalId: "john", observerToken, proposerToken,
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
    dispatcher.close();
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
  });

  return {
    root,
    repo,
    dispatcher,
    url,
    operator: new ControlClient({ baseUrl: url, token }),
    observer: new ControlClient({ baseUrl: url, token: observerToken }),
    proposer: new ControlClient({ baseUrl: url, token: proposerToken }),
  };
}

test("full product path: Hermes proposal, human authorization, worker, validation, integration", async (t) => {
  const f = await fixture(t);

  const project = await f.operator.post("/v1/projects", {
    name: "Acceptance", repoPath: f.repo, branch: "integration",
    validation: ["git ls-files --error-unmatch output.txt"],
  }, requestId());

  // 1. Hermes turns a natural-language request into a bounded proposal. This is its entire authority.
  const proposal = await f.proposer.post("/v1/work/proposals", {
    projectId: project.id,
    goal: "create output.txt with the worker result",
    mode: "write",
    maximumCost: 0.05,
    idempotencyKey: `hermes-${crypto.randomUUID()}`,
  }, requestId());
  assert.equal(proposal.state, "PENDING");
  assert.equal(proposal.origin_principal, "hermes-proposer");
  assert.ok(proposal.action_digest && proposal.expires_at && proposal.expected_state_version);

  // Proposing created no job: a proposal is a request, not work.
  assert.deepEqual(await f.operator.get("/v1/jobs"), []);

  // 2. Hermes cannot authorize its own proposal.
  await assert.rejects(
    f.proposer.post(`/v1/work/proposals/${proposal.id}/authorize`, {}, requestId()),
    (error) => error.code === "INSUFFICIENT_SCOPE",
  );

  // 3. The human authorizes the exact proposal, which is what creates the job.
  const authorized = await f.operator.post(`/v1/work/proposals/${proposal.id}/authorize`, {}, requestId());
  assert.equal(authorized.state, "AUTHORIZED");
  assert.equal(authorized.decision.decided_by, "john");
  const jobId = authorized.decision.job_id;
  assert.ok(jobId);

  // 4. The cheap worker runs and deterministic validation gates the result.
  const ready = await f.operator.post(`/v1/jobs/${jobId}/run`, {}, requestId());
  assert.equal(ready.job.status, "READY_FOR_INTEGRATION");
  assert.equal(ready.attempts.at(-1).validation_state, "PASSED");

  // 5. Integration proposal and explicit human approval.
  const integration = await f.operator.post("/v1/integration/proposals", { jobId }, requestId());
  assert.equal(integration.state, "OPEN");
  await assert.rejects(
    f.proposer.post("/v1/approvals", { proposalId: integration.id }, requestId()),
    (error) => error.code === "INSUFFICIENT_SCOPE",
  );
  await f.operator.post("/v1/approvals", { proposalId: integration.id }, requestId());

  // 6. Integration advances the branch.
  const result = await f.operator.post(`/v1/integration/${integration.id}/run`, {}, requestId());
  assert.equal(result.proposal.state, "INTEGRATED");
  const branch = await command("git", ["-C", f.repo, "show", "integration:output.txt"], f.repo);
  assert.equal(branch.trim(), "worker-result");

  // 7. Hermes observes completion through its read-only credential.
  // Jobs terminate at SUCCEEDED; INTEGRATED is the integration proposal's state.
  const finalJob = await f.observer.get(`/v1/jobs/${jobId}`);
  assert.equal(finalJob.job.status, "SUCCEEDED");
  assert.equal((await f.observer.get(`/v1/proposals/${integration.id}`)).proposal.state, "INTEGRATED");
  const seen = await f.observer.get(`/v1/work/proposals/${proposal.id}`);
  assert.equal(seen.state, "AUTHORIZED");
  assert.equal(seen.decision.job_id, jobId);
});

test("an expired or superseded proposal cannot be authorized into work", async (t) => {
  const f = await fixture(t);
  const project = await f.operator.post("/v1/projects", {
    name: "Bounds", repoPath: f.repo, branch: "integration", validation: [],
  }, requestId());

  const expired = await f.proposer.post("/v1/work/proposals", {
    projectId: project.id, goal: "too late", idempotencyKey: `k-${crypto.randomUUID()}`,
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  }, requestId());
  await assert.rejects(
    f.operator.post(`/v1/work/proposals/${expired.id}/authorize`, {}, requestId()),
    (error) => /expired/.test(error.message),
  );

  // A proposal written against one world must not silently execute against a changed one.
  const stale = await f.proposer.post("/v1/work/proposals", {
    projectId: project.id, goal: "stale view", idempotencyKey: `k-${crypto.randomUUID()}`,
  }, requestId());
  await f.operator.post("/v1/jobs", {
    projectId: project.id, goal: "unrelated intervening work", mode: "write", maxAttempts: 1,
  }, requestId());
  await assert.rejects(
    f.operator.post(`/v1/work/proposals/${stale.id}/authorize`, {}, requestId()),
    (error) => /expected state version/.test(error.message),
  );
});

test("authorization is idempotent and a rejected proposal never becomes work", async (t) => {
  const f = await fixture(t);
  const project = await f.operator.post("/v1/projects", {
    name: "Decide", repoPath: f.repo, branch: "integration", validation: [],
  }, requestId());

  const once = await f.proposer.post("/v1/work/proposals", {
    projectId: project.id, goal: "one job only", idempotencyKey: `k-${crypto.randomUUID()}`,
  }, requestId());
  const first = await f.operator.post(`/v1/work/proposals/${once.id}/authorize`, {}, requestId());
  const again = await f.operator.post(`/v1/work/proposals/${once.id}/authorize`, {}, requestId());
  assert.equal(first.decision.job_id, again.decision.job_id, "re-authorizing must not create a second job");
  assert.equal((await f.operator.get("/v1/jobs")).length, 1);

  const refused = await f.proposer.post("/v1/work/proposals", {
    projectId: project.id, goal: "not this", idempotencyKey: `k-${crypto.randomUUID()}`,
  }, requestId());
  const rejected = await f.operator.post(`/v1/work/proposals/${refused.id}/reject`, {}, requestId());
  assert.equal(rejected.state, "REJECTED");
  await assert.rejects(
    f.operator.post(`/v1/work/proposals/${refused.id}/authorize`, {}, requestId()),
    (error) => /already rejected/.test(error.message),
  );
  assert.equal((await f.operator.get("/v1/jobs")).length, 1, "a rejected proposal must create no job");
});

test("the same idempotency key returns one proposal identity", async (t) => {
  const f = await fixture(t);
  const project = await f.operator.post("/v1/projects", {
    name: "Idem", repoPath: f.repo, branch: "integration", validation: [],
  }, requestId());
  const key = `hermes-${crypto.randomUUID()}`;
  const body = { projectId: project.id, goal: "same request twice", idempotencyKey: key };
  const first = await f.proposer.post("/v1/work/proposals", body, requestId());
  const second = await f.proposer.post("/v1/work/proposals", body, requestId());
  assert.equal(first.id, second.id);
  assert.equal((await f.operator.get("/v1/work/proposals")).length, 1);
});

test("a failed decision write leaves no job and the proposal stays authorizable", async (t) => {
  const f = await fixture(t);
  const project = await f.operator.post("/v1/projects", {
    name: "Atomic", repoPath: f.repo, branch: "integration", validation: [],
  }, requestId());
  const proposal = await f.proposer.post("/v1/work/proposals", {
    projectId: project.id, goal: "atomic work", idempotencyKey: `k-${crypto.randomUUID()}`,
  }, requestId());

  const realPrepare = f.dispatcher.db.prepare.bind(f.dispatcher.db);
  f.dispatcher.db.prepare = (sql) => (sql.includes("work_proposal_decisions") && sql.includes("INSERT"))
    ? { run: () => { throw new Error("injected decision failure"); } }
    : realPrepare(sql);
  await assert.rejects(
    f.operator.post(`/v1/work/proposals/${proposal.id}/authorize`, {}, requestId()),
    (error) => /injected decision failure/.test(error.message),
  );
  f.dispatcher.db.prepare = realPrepare;

  // The job must have rolled back with the decision, or the orphan would move the state version and
  // strand the proposal permanently.
  assert.deepEqual(await f.operator.get("/v1/jobs"), []);
  assert.equal((await f.operator.get(`/v1/work/proposals/${proposal.id}`)).state, "PENDING");

  const recovered = await f.operator.post(`/v1/work/proposals/${proposal.id}/authorize`, {}, requestId());
  assert.equal(recovered.state, "AUTHORIZED");
  assert.equal((await f.operator.get("/v1/jobs")).length, 1);
});

test("concurrent authorizations of one proposal create exactly one job", async (t) => {
  const f = await fixture(t);
  const project = await f.operator.post("/v1/projects", {
    name: "Race", repoPath: f.repo, branch: "integration", validation: [],
  }, requestId());
  const proposal = await f.proposer.post("/v1/work/proposals", {
    projectId: project.id, goal: "only once", idempotencyKey: `k-${crypto.randomUUID()}`,
  }, requestId());

  // Distinct request IDs, so Control API request idempotency cannot be what saves this.
  const settled = await Promise.allSettled([
    f.operator.post(`/v1/work/proposals/${proposal.id}/authorize`, {}, requestId()),
    f.operator.post(`/v1/work/proposals/${proposal.id}/authorize`, {}, requestId()),
  ]);
  const won = settled.filter((outcome) => outcome.status === "fulfilled");
  assert.ok(won.length >= 1, "at least one authorization must succeed");
  const jobs = await f.operator.get("/v1/jobs");
  assert.equal(jobs.length, 1, "a concurrent authorization must not create a second job");
  const decisions = f.dispatcher.db.prepare(
    "SELECT COUNT(*) AS count FROM work_proposal_decisions WHERE proposal_id = ?",
  ).get(proposal.id).count;
  assert.equal(decisions, 1);
  for (const outcome of won) assert.equal(outcome.value.decision.job_id, jobs[0].id);
});

test("concurrent identical proposals return one proposal identity", async (t) => {
  const f = await fixture(t);
  const project = await f.operator.post("/v1/projects", {
    name: "IdemRace", repoPath: f.repo, branch: "integration", validation: [],
  }, requestId());
  const body = { projectId: project.id, goal: "same", idempotencyKey: `k-${crypto.randomUUID()}` };
  const settled = await Promise.allSettled([
    f.proposer.post("/v1/work/proposals", body, requestId()),
    f.proposer.post("/v1/work/proposals", body, requestId()),
  ]);
  assert.deepEqual(settled.map((outcome) => outcome.status), ["fulfilled", "fulfilled"]);
  assert.equal(settled[0].value.id, settled[1].value.id);
  assert.equal((await f.operator.get("/v1/work/proposals")).length, 1);
});

test("a pending proposal surfaces in overview and attention without an explicit list call", async (t) => {
  const f = await fixture(t);
  const project = await f.operator.post("/v1/projects", {
    name: "Surface", repoPath: f.repo, branch: "integration", validation: [],
  }, requestId());

  assert.equal((await f.operator.get("/v1/overview")).totals.proposals_awaiting_decision, 0);

  const proposal = await f.proposer.post("/v1/work/proposals", {
    projectId: project.id, goal: "needs a human decision", idempotencyKey: `k-${crypto.randomUUID()}`,
  }, requestId());

  const overview = await f.observer.get("/v1/overview");
  assert.equal(overview.totals.proposals_awaiting_decision, 1);
  const surfaced = overview.attention.find((item) => item.kind === "work_proposal");
  assert.ok(surfaced, "a pending proposal must appear in the bounded overview");
  assert.equal(surfaced.id, proposal.id);
  assert.equal(surfaced.status, "AWAITING_DECISION");

  const attention = await f.operator.get("/v1/attention");
  assert.equal(attention.work_proposals_awaiting_decision.length, 1);
  assert.equal(attention.work_proposals_awaiting_decision[0].id, proposal.id);

  // Once decided it stops competing for attention.
  await f.operator.post(`/v1/work/proposals/${proposal.id}/authorize`, {}, requestId());
  assert.equal((await f.operator.get("/v1/overview")).totals.proposals_awaiting_decision, 0);
  assert.equal((await f.operator.get("/v1/attention")).work_proposals_awaiting_decision.length, 0);
});

test("an expired proposal stops competing for operator attention", async (t) => {
  const f = await fixture(t);
  const project = await f.operator.post("/v1/projects", {
    name: "Expiry", repoPath: f.repo, branch: "integration", validation: [],
  }, requestId());
  await f.proposer.post("/v1/work/proposals", {
    projectId: project.id, goal: "too late to act on", idempotencyKey: `k-${crypto.randomUUID()}`,
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  }, requestId());

  // It can no longer be authorized, so surfacing it would be permanent noise.
  assert.equal((await f.operator.get("/v1/overview")).totals.proposals_awaiting_decision, 0);
  assert.equal((await f.operator.get("/v1/attention")).work_proposals_awaiting_decision.length, 0);
});
