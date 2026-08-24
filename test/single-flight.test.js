// One decision buys one worker.
//
// The window this closes is between a manager DECIDING to implement and an attempt row existing.
// Two ticks could each look for a live attempt, each find none -- because none existed yet -- and
// each spend a scarce turn concluding IMPLEMENT. Checking attempts cannot close that gap: the fact
// that has to be durable is "work is already on its way", which is true from the decision, not from
// the claim.
//
// Durable rather than an in-memory lock on purpose. A process that dies between deciding and
// dispatching must still tell its replacement that work was commissioned, and a mutex forgets
// exactly when forgetting costs most.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeDataRoot } from "../src/db.js";
import { FakeBackend } from "../src/backend.js";
import { Dispatcher } from "../src/service.js";
import { runProcess } from "../src/process.js";

async function world(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-sf-"));
  const root = path.join(temp, "data");
  const repo = path.join(temp, "repo");
  fs.mkdirSync(repo);
  await runProcess("git", ["init", "-b", "main", repo]);
  await runProcess("git", ["-C", repo, "config", "user.name", "T"]);
  await runProcess("git", ["-C", repo, "config", "user.email", "t@e.invalid"]);
  fs.writeFileSync(path.join(repo, "seed.txt"), "seed\n");
  await runProcess("git", ["-C", repo, "add", "."]);
  await runProcess("git", ["-C", repo, "commit", "-m", "initial"]);
  initializeDataRoot(root);

  const open = new Set();
  t.after(() => {
    for (const d of open) { try { d.close(); } catch { /* closed */ } }
    fs.rmSync(temp, { recursive: true, force: true });
  });
  // A fresh Dispatcher over the same database is what "the process restarted" means here.
  const boot = () => {
    const dispatcher = new Dispatcher({ root, backend: new FakeBackend(async () => ({ exitCode: 0, stdout: "", stderr: "" })) });
    open.add(dispatcher);
    return dispatcher;
  };
  const dispatcher = boot();
  const project = await dispatcher.addProject({ name: "SF", repoPath: repo, validation: [] });
  const job = await dispatcher.createJob({
    projectId: project.id, goal: "do the thing", strategy: "managed", maxAttempts: 2,
  });
  return { boot, dispatcher, job };
}

test("two crossed decisions produce exactly one commission", async (t) => {
  const { dispatcher, job } = await world(t);
  // Both callers looked and both saw nothing: this is the race, made deterministic.
  assert.equal(dispatcher.openCommission(job.id), null);
  const first = dispatcher.commissionWork({ jobId: job.id, action: "IMPLEMENT" });
  const second = dispatcher.commissionWork({ jobId: job.id, action: "IMPLEMENT" });

  assert.ok(first, "the winner holds a reservation");
  assert.equal(second, null, "the loser is told so, rather than buying a second worker");
  assert.equal(
    dispatcher.db.prepare("SELECT COUNT(*) c FROM work_commissions WHERE job_id = ?").get(job.id).c,
    1,
  );
});

test("an open commission is visible before any attempt exists", async (t) => {
  // The whole point: the gap between deciding and dispatching is no longer invisible.
  const { dispatcher, job } = await world(t);
  const commission = dispatcher.commissionWork({ jobId: job.id, action: "IMPLEMENT" });

  assert.equal(dispatcher.liveAttemptFor(job.id), null, "no attempt has been claimed yet");
  assert.ok(dispatcher.openCommission(job.id), "and yet work is known to be on its way");
  assert.equal(dispatcher.openCommission(job.id).id, commission.id);
});

test("a restart recovers the reservation rather than commissioning again", async (t) => {
  // Paused between decision and claim, then the process dies. The replacement must not conclude
  // that nothing is happening.
  const { boot, dispatcher, job } = await world(t);
  dispatcher.commissionWork({ jobId: job.id, action: "IMPLEMENT" });
  dispatcher.close();

  const restarted = boot();
  const recovered = restarted.openCommission(job.id);
  assert.ok(recovered, "the reservation survived the process that made it");
  assert.equal(restarted.commissionWork({ jobId: job.id, action: "IMPLEMENT" }), null,
    "and a second commission is still refused after the restart");
});

test("a commission closes into exactly one attempt", async (t) => {
  const { dispatcher, job } = await world(t);
  const commission = dispatcher.commissionWork({ jobId: job.id, action: "IMPLEMENT" });
  dispatcher.db.prepare(`INSERT INTO attempts(
    id, job_id, ordinal, scheduler_epoch, backend, model, worktree_path, started_at, start_sha,
    instruction_digest, terminal_state
  ) VALUES (?, ?, 1, 1, 'FakeBackend', 'm', 'w', ?, 's', 'd', 'SUCCEEDED')`)
    .run(`${job.id}.1`, job.id, new Date().toISOString());

  dispatcher.settleCommission(commission.id, { state: "CLOSED", attemptId: `${job.id}.1` });
  assert.equal(dispatcher.openCommission(job.id), null, "the reservation is released");
  // And the job may be commissioned again, for the next round of work.
  assert.ok(dispatcher.commissionWork({ jobId: job.id, action: "REVISE" }));
});

test("a dispatch that never arrives releases the reservation", async (t) => {
  // Otherwise single-flight becomes a permanent fence: the job could never be worked again.
  const { dispatcher, job } = await world(t);
  const commission = dispatcher.commissionWork({ jobId: job.id, action: "IMPLEMENT" });
  dispatcher.settleCommission(commission.id, { state: "FAILED", outcome: "executor never started" });

  assert.equal(dispatcher.openCommission(job.id), null);
  assert.ok(dispatcher.commissionWork({ jobId: job.id, action: "IMPLEMENT" }),
    "the manager may reason about this job again");
  const failed = dispatcher.db.prepare("SELECT * FROM work_commissions WHERE id = ?").get(commission.id);
  assert.equal(failed.state, "FAILED");
  assert.match(failed.outcome, /never started/);
});

test("the database refuses a closed commission that names no attempt", async (t) => {
  // A commission that claims to have become work must say which work.
  const { dispatcher, job } = await world(t);
  assert.throws(() => dispatcher.db.prepare(`INSERT INTO work_commissions(
    id, job_id, action, state, created_at, updated_at
  ) VALUES ('wcom_bad', ?, 'IMPLEMENT', 'CLOSED', '2026-08-24', '2026-08-24')`).run(job.id), /CHECK/);
});

test("single-flight is enforced by the database, not by whoever remembers to look", async (t) => {
  // The guard must not depend on callers checking first. A caller that skips the check entirely
  // still cannot create a second open commission.
  const { dispatcher, job } = await world(t);
  dispatcher.commissionWork({ jobId: job.id, action: "IMPLEMENT" });
  assert.throws(() => dispatcher.db.prepare(`INSERT INTO work_commissions(
    id, job_id, action, state, created_at, updated_at
  ) VALUES ('wcom_sneaky', ?, 'IMPLEMENT', 'PENDING', '2026-08-24', '2026-08-24')`).run(job.id),
  /UNIQUE|constraint/i);
});
