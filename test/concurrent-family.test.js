// Can two sibling workers be alive at once without stealing each other's authority, fencing
// identity, cancellation semantics, or budget headroom?
//
// Three separate mechanisms had to change before that question could even be asked, and each was
// individually invisible: an epoch that meant "newest attempt wins", an admission check that summed
// only settled receipts, and a cancellation that searched one job instead of a family.
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

const spender = (inputTokens) => new FakeBackend(async ({ worktreePath, artifactDir, mode }) => {
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, "opencode-events.jsonl"), JSON.stringify({
    type: "step_finish",
    part: { tokens: { input: inputTokens, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.0001 },
  }));
  if (mode !== "read") fs.writeFileSync(path.join(worktreePath, "out.txt"), "done\n");
  return { exitCode: 0, stdout: "ok", stderr: "" };
});

async function fixture(t, backend = spender(100_000)) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-conc-"));
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
  const service = new Dispatcher({ root, backend });
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
    // Two connections in one test make Windows' lazy handle release visible; retry briefly rather
    // than fail a passing test on a directory removal.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { fs.rmSync(temp, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 50)); }
    }
  });
  const project = await service.addProject({ name: "Conc", repoPath: repo, validation: [] });
  return { service, project, repo, root, temp };
}

test("a sibling attempt does not invalidate the first one's callbacks", async (t) => {
  // The blocker that would have made perfect reservations useless. The epoch advanced on every
  // claim and every callback required the attempt to hold the CURRENT value, so starting B made A's
  // executor result, usage receipt and terminal transition all fail as stale.
  const { service, project } = await fixture(t);
  const root = await service.createJob({
    projectId: project.id, goal: "objective", strategy: "managed", maxAttempts: 2,
  });
  const childA = await service.createJob({
    projectId: project.id, goal: "question A", mode: "read", maxAttempts: 1,
    parentJobId: root.id, internalKind: "MANAGER_EXPLORATION",
  });
  await service.runJob(childA.id, { model: "opencode-go/deepseek-v4-flash", instruction: "A" });
  const attemptA = service.db.prepare("SELECT * FROM attempts WHERE job_id = ?").get(childA.id);

  const childB = await service.createJob({
    projectId: project.id, goal: "question B", mode: "read", maxAttempts: 1,
    parentJobId: root.id, internalKind: "MANAGER_EXPLORATION",
  });
  await service.runJob(childB.id, { model: "opencode-go/deepseek-v4-flash", instruction: "B" });
  const attemptB = service.db.prepare("SELECT * FROM attempts WHERE job_id = ?").get(childB.id);

  // Both attempts belong to the same scheduler generation rather than to a per-attempt sequence.
  assert.equal(attemptA.scheduler_epoch, attemptB.scheduler_epoch);
  assert.equal(attemptA.scheduler_epoch, service.schedulerGeneration());

  // A's callback is still accepted after B exists. Under the old semantics this threw.
  assert.doesNotThrow(() => service.acceptAttemptEvent(attemptA.id, attemptA.scheduler_epoch, () => {}, {
    terminalState: "SUCCEEDED", validationState: "PASSED",
  }));
});

test("a superseded scheduler generation is still fenced out", async (t) => {
  const { service, project } = await fixture(t);
  const job = await service.createJob({ projectId: project.id, goal: "work" });
  await service.runJob(job.id, { model: "opencode-go/deepseek-v4-flash" });
  const attempt = service.db.prepare("SELECT * FROM attempts WHERE job_id = ?").get(job.id);

  // A takeover advances the generation; callbacks from the previous incarnation must not land.
  service.db.prepare("UPDATE metadata SET value = ? WHERE key = 'scheduler_epoch'")
    .run(String(attempt.scheduler_epoch + 1));
  assert.throws(
    () => service.acceptAttemptEvent(attempt.id, attempt.scheduler_epoch, () => {}),
    /Stale/,
  );
});

test("reservations are visible across connections and refuse an over-commitment", async (t) => {
  // Deliberately NOT through runJob: the scheduler's live-attempt guard would reject the second
  // start on its own, and the test would pass without ever exercising the reservation rule.
  const { service, project, root: dataRoot } = await fixture(t);
  const parent = await service.createJob({
    projectId: project.id, goal: "family", strategy: "managed", maximumCost: 0.10, maxAttempts: 2,
  });

  // A live attempt holding most of the authority, written through connection one.
  service.db.prepare(`INSERT INTO attempts(
    id, job_id, ordinal, scheduler_epoch, backend, started_at, budget_reservation_usd
  ) VALUES ('held.1', ?, 1, ?, 'FakeBackend', ?, 0.09)`)
    .run(parent.id, service.schedulerGeneration(), new Date().toISOString());

  // A genuinely separate connection, as a second scheduler process would have.
  const other = new Dispatcher({ root: dataRoot, backend: new FakeBackend() });
  t.after(() => { try { other.close(); } catch { /* closed */ } });
  assert.notEqual(other.db, service.db);

  assert.equal(other.reservedAuthority(parent.id), 0.09, "a live sibling's authority is visible");
  assert.throws(
    () => other.admitAttempt({ jobId: parent.id, requested: 0.05 }),
    /requested .* of authority but only .* remains/,
    "the second scheduler must be refused by the reservation, not by luck",
  );
  // What does fit is admitted.
  assert.equal(other.admitAttempt({ jobId: parent.id, requested: 0.005 }), 0.005);
});

test("two reservations that fit together both succeed", async (t) => {
  const { service, project } = await fixture(t);
  const parent = await service.createJob({
    projectId: project.id, goal: "family", strategy: "managed", maximumCost: 0.10, maxAttempts: 2,
  });
  const first = service.admitAttempt({ jobId: parent.id, requested: 0.04 });
  service.db.prepare(`INSERT INTO attempts(
    id, job_id, ordinal, scheduler_epoch, backend, started_at, budget_reservation_usd
  ) VALUES ('a.1', ?, 1, ?, 'FakeBackend', ?, ?)`)
    .run(parent.id, service.schedulerGeneration(), new Date().toISOString(), first);
  const second = service.admitAttempt({ jobId: parent.id, requested: 0.04 });
  assert.equal(first, 0.04);
  assert.equal(second, 0.04);
});

test("a terminal attempt releases its authority, and unknown spend does not become headroom", async (t) => {
  const { service, project, root: dataRoot } = await fixture(t);
  const parent = await service.createJob({
    projectId: project.id, goal: "family", strategy: "managed", maximumCost: 5.00, maxAttempts: 3,
  });
  // A silent worker: the attempt terminates but its usage is UNKNOWN.
  const silent = new Dispatcher({
    root: dataRoot,
    backend: new FakeBackend(async ({ worktreePath }) => {
      fs.writeFileSync(path.join(worktreePath, "out.txt"), "done\n");
      return { exitCode: 0, stdout: "ok", stderr: "" };
    }),
  });
  t.after(() => { try { silent.close(); } catch { /* closed */ } });

  await silent.runJob(parent.id, { model: "opencode-go/deepseek-v4-flash", instruction: "do it" });
  // The reservation is released -- the attempt is terminal -- but the family's spend is now
  // unestablished, which must NOT read as free headroom.
  assert.equal(silent.reservedAuthority(parent.id), 0);
  assert.throws(
    () => silent.admitAttempt({ jobId: parent.id }),
    /cannot be established/,
    "releasing a reservation must not turn unknown spend back into available authority",
  );
});

test("overspending a reservation is recorded as an overrun, not reconciled away", async (t) => {
  const { service, project } = await fixture(t);
  const job = await service.createJob({
    projectId: project.id, goal: "expensive", maximumCost: 1.00, maxAttempts: 1,
  });
  // One attempt costing about $0.014, admitted against a reservation deliberately smaller than that.
  await service.runJob(job.id, { model: "opencode-go/deepseek-v4-flash", reservationRequest: 0.001 });
  const attempt = service.db.prepare("SELECT * FROM attempts WHERE job_id = ?").get(job.id);

  assert.equal(attempt.budget_reservation_usd, 0.001);
  const overrun = service.attemptOverrun(attempt.id);
  assert.ok(overrun.spent > overrun.reserved, "the attempt really did exceed its authority");
  assert.ok(overrun.overrun > 0);
  // A provider call cannot be preempted mid-flight, so this is a fact about the world rather than a
  // failure of admission -- and it is reported rather than smoothed over.
  assert.equal(service.getJob(job.id).status, "READY_FOR_INTEGRATION");
});

test("cancelling a managed root cancels the investigation it is running", async (t) => {
  // The hole that exists even serially: during exploration the running worker belongs to a CHILD,
  // and the root has no active attempt of its own, so a root-only search found nothing to cancel.
  const { service, project } = await fixture(t);
  const root = await service.createJob({
    projectId: project.id, goal: "objective", strategy: "managed", maxAttempts: 2,
  });
  const child = await service.createJob({
    projectId: project.id, goal: "investigate", mode: "read", maxAttempts: 1,
    parentJobId: root.id, internalKind: "MANAGER_EXPLORATION",
  });

  // A child attempt left mid-flight, exactly as it would be while a worker runs.
  service.db.prepare(`INSERT INTO attempts(
    id, job_id, ordinal, scheduler_epoch, backend, started_at
  ) VALUES ('child.1', ?, 1, ?, 'FakeBackend', ?)`)
    .run(child.id, service.schedulerGeneration(), new Date().toISOString());
  service.db.prepare("UPDATE jobs SET status = 'RUNNING' WHERE id IN (?, ?)").run(root.id, child.id);

  const result = await service.cancelJob({
    jobId: root.id, principal: "john", origin: "terminal", reason: "changed my mind",
  });

  assert.equal(result.outcome, "CANCELLED", "cancelling the root must not report NOTHING_RUNNING");
  const attempt = service.db.prepare("SELECT * FROM attempts WHERE id = 'child.1'").get();
  assert.equal(attempt.terminal_state, "CANCELLED", "the investigation actually stopped");
  assert.equal(service.getJob(child.id).status, "CANCELLED");
  assert.equal(service.getJob(root.id).status, "CANCELLED");
});

test("cancelling a root cancels every live sibling, and admission stops afterwards", async (t) => {
  const { service, project } = await fixture(t);
  const root = await service.createJob({
    projectId: project.id, goal: "objective", strategy: "managed", maximumCost: 1.00, maxAttempts: 2,
  });
  const children = [];
  for (const question of ["A", "B"]) {
    const child = await service.createJob({
      projectId: project.id, goal: question, mode: "read", maxAttempts: 1,
      parentJobId: root.id, internalKind: "MANAGER_EXPLORATION",
    });
    service.db.prepare(`INSERT INTO attempts(
      id, job_id, ordinal, scheduler_epoch, backend, started_at, budget_reservation_usd
    ) VALUES (?, ?, 1, ?, 'FakeBackend', ?, 0.01)`)
      .run(`${question}.1`, child.id, service.schedulerGeneration(), new Date().toISOString());
    children.push(child);
  }
  service.db.prepare("UPDATE jobs SET status = 'RUNNING' WHERE id = ?").run(root.id);

  await service.cancelJob({ jobId: root.id, principal: "john", origin: "terminal" });

  for (const question of ["A", "B"]) {
    assert.equal(
      service.db.prepare("SELECT terminal_state FROM attempts WHERE id = ?").get(`${question}.1`).terminal_state,
      "CANCELLED",
      `sibling ${question} must be cancelled under its own identity`,
    );
  }
  for (const child of children) assert.equal(service.getJob(child.id).status, "CANCELLED");
  assert.equal(service.getJob(root.id).status, "CANCELLED");
  // Their authority is released with them, so a cancelled family is not still holding budget.
  assert.equal(service.reservedAuthority(root.id), 0);
});
