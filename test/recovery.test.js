// Recovery must never require hand-editing SQLite or Git.
//
// The properties that matter: a backup is verifiable, a restore cannot silently destroy the state it
// replaces, and a rollback refuses rather than guessing when the branch is not where it was expected.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeDataRoot, SCHEMA_VERSION } from "../src/db.js";
import { FakeBackend } from "../src/backend.js";
import { Dispatcher } from "../src/service.js";
import { restoreBackup, writeRestoreMarker, restoreMarkerPath, readRestoreMarker } from "../src/recovery.js";
import { runProcess } from "../src/process.js";
import { managedPaths } from "../src/paths.js";

async function command(name, args, cwd) {
  const result = await runProcess(name, args, { cwd });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-recovery-"));
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
    for (const worktree of listed.stdout.split(/\r?\n/)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length))
      .filter((worktree) => path.resolve(worktree) !== path.resolve(repo))) {
      await runProcess("git", ["-C", repo, "worktree", "unlock", worktree]);
      await runProcess("git", ["-C", repo, "worktree", "remove", "--force", worktree]);
    }
    fs.rmSync(temp, { recursive: true, force: true });
  };
  return { temp, root, repo, cleanup };
}

const writer = (name, body = "done\n") => new FakeBackend(async ({ worktreePath, artifactDir }) => {
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, "opencode-events.jsonl"), JSON.stringify({
    type: "step_finish",
    part: { tokens: { input: 100, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.00001 },
  }));
  fs.writeFileSync(path.join(worktreePath, name), body);
  return { exitCode: 0, stdout: "ok", stderr: "" };
});

test("a backup is checksummed, listable, and verifiable", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: writer("out.txt") });
  t.after(async () => { service.close(); await cleanup(); });

  await service.addProject({ name: "Backup", repoPath: repo, validation: [] });
  const created = await service.backup("test");

  assert.ok(fs.existsSync(path.join(created.backup, "manifest.json")));
  assert.ok(created.files.length >= 1, "the database is captured");
  assert.equal(created.schema_version, SCHEMA_VERSION);
  assert.ok(created.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)));

  const listed = service.listBackups();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].backup, created.backup);
  assert.equal(service.verifyBackup(created.backup).intact, true);
});

test("a damaged backup is detected and refused for restore", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: writer("out.txt") });
  t.after(async () => { service.close(); await cleanup(); });

  await service.addProject({ name: "Damaged", repoPath: repo, validation: [] });
  const created = await service.backup("damaged");
  const target = path.join(created.backup, created.files[0].name);
  fs.appendFileSync(target, "corruption");

  const verified = service.verifyBackup(created.backup);
  assert.equal(verified.intact, false);
  assert.equal(verified.damaged[0].reason, "checksum mismatch");

  const { restoreBackup } = await import("../src/recovery.js");
  await assert.rejects(
    () => restoreBackup({ root, backupDirectory: created.backup, database: service.db }),
    /Refusing to restore a damaged backup/,
  );
});

test("restoring recovers lost state and preserves what it replaced", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  let service = new Dispatcher({ root, backend: writer("out.txt") });
  t.after(async () => { try { service.close(); } catch { /* already closed */ } await cleanup(); });

  const project = await service.addProject({ name: "Restore", repoPath: repo, validation: [] });
  const job = await service.createJob({ projectId: project.id, goal: "before backup" });
  const created = await service.backup("before-loss");

  // Work happens after the backup, then the database is lost.
  const later = await service.createJob({ projectId: project.id, goal: "after backup" });
  assert.equal(service.listJobs().length, 2);
  service.close();

  const { restoreBackup } = await import("../src/recovery.js");
  const restored = await restoreBackup({ root, backupDirectory: created.backup });
  assert.ok(restored.safety_backup, "the replaced database is captured before being overwritten");

  service = new Dispatcher({ root, backend: writer("out.txt") });
  const jobs = service.listJobs();
  assert.equal(jobs.length, 1, "the restored database holds only what the backup held");
  assert.equal(jobs[0].id, job.id);
  assert.equal(jobs.some((row) => row.id === later.id), false);

  // The pre-restore state is recoverable: restoring was not a one-way door.
  assert.equal(service.verifyBackup(restored.safety_backup).intact, true);
});

test("rolling back an integration returns the branch to its pre-integration commit", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: writer("candidate.txt") });
  t.after(async () => { service.close(); await cleanup(); });

  const project = await service.addProject({
    name: "Rollback", repoPath: repo, branch: "integration", validation: [],
  });
  const before = await command("git", ["-C", repo, "rev-parse", "integration"], repo);

  const job = await service.createJob({ projectId: project.id, goal: "produce candidate.txt" });
  await service.runJob(job.id);
  const proposal = await service.proposeIntegration({ jobId: job.id });
  service.grantApproval({ proposalId: proposal.id, principal: "john", origin: "terminal" });
  await service.runIntegration(proposal.id);

  const after = await command("git", ["-C", repo, "rev-parse", "integration"], repo);
  assert.notEqual(after, before, "integration advanced the branch");

  const result = await service.rollbackIntegration({
    proposalId: proposal.id, principal: "john", origin: "local-cli",
  });
  assert.equal(result.moved, true);
  assert.equal(result.to, before);
  assert.equal(await command("git", ["-C", repo, "rev-parse", "integration"], repo), before);

  // The rollback is recorded, not silent.
  const recorded = service.db.prepare(
    "SELECT 1 FROM events WHERE kind = 'INTEGRATION_ROLLED_BACK' AND entity_id = ?",
  ).get(proposal.id);
  assert.ok(recorded);
});

test("rollback refuses when something else moved the branch", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: writer("candidate.txt") });
  t.after(async () => { service.close(); await cleanup(); });

  const project = await service.addProject({
    name: "Moved", repoPath: repo, branch: "integration", validation: [],
  });
  const job = await service.createJob({ projectId: project.id, goal: "produce candidate.txt" });
  await service.runJob(job.id);
  const proposal = await service.proposeIntegration({ jobId: job.id });
  service.grantApproval({ proposalId: proposal.id, principal: "john", origin: "terminal" });
  await service.runIntegration(proposal.id);

  // Someone else advances the branch after the integration.
  fs.writeFileSync(path.join(repo, "unrelated.txt"), "other work\n");
  await command("git", ["-C", repo, "add", "."], repo);
  await command("git", ["-C", repo, "commit", "-m", "unrelated"], repo);
  await command("git", ["-C", repo, "branch", "-f", "integration", "HEAD"], repo);
  const moved = await command("git", ["-C", repo, "rev-parse", "integration"], repo);

  await assert.rejects(
    service.rollbackIntegration({ proposalId: proposal.id, principal: "john", origin: "local-cli" }),
    /Something else moved the branch/,
  );
  assert.equal(await command("git", ["-C", repo, "rev-parse", "integration"], repo), moved,
    "the refusal changed nothing");
});

test("rollback refuses a target that is not an ancestor", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: writer("candidate.txt") });
  t.after(async () => { service.close(); await cleanup(); });
  const { rollbackIntegration } = await import("../src/recovery.js");

  // An unrelated commit on another branch is not a rollback target, whatever the caller believes.
  fs.writeFileSync(path.join(repo, "sideways.txt"), "elsewhere\n");
  await command("git", ["-C", repo, "checkout", "-q", "-b", "sideways"], repo);
  await command("git", ["-C", repo, "add", "."], repo);
  await command("git", ["-C", repo, "commit", "-m", "sideways"], repo);
  const unrelated = await command("git", ["-C", repo, "rev-parse", "sideways"], repo);
  await command("git", ["-C", repo, "checkout", "-q", "main"], repo);

  await assert.rejects(
    rollbackIntegration({ repoPath: repo, branch: "integration", toSha: unrelated }),
    /is not an ancestor of/,
  );
});

test("a backup records where every repository's integration branch stood", async (t) => {
  // A database snapshot alone can be restored on top of repositories that moved on, which is exactly
  // the incoherence a recovery feature must prevent.
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: writer("candidate.txt") });
  t.after(async () => { service.close(); await cleanup(); });

  await service.addProject({ name: "Coherent", repoPath: repo, branch: "integration", validation: [] });
  const head = await command("git", ["-C", repo, "rev-parse", "integration"], repo);
  const created = await service.backup("with-repos");

  assert.equal(created.repositories.length, 1);
  assert.equal(created.repositories[0].integration_branch, "integration");
  assert.equal(created.repositories[0].integration_head, head);
});

test("restore returns the database and the integration branch together", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: writer("candidate.txt") });
  t.after(async () => { try { service.close(); } catch { /* closed */ } await cleanup(); });

  const project = await service.addProject({ name: "Together", repoPath: repo, branch: "integration", validation: [] });
  const snapshotHead = await command("git", ["-C", repo, "rev-parse", "integration"], repo);
  const created = await service.backup("before-integration");

  // Real work lands after the snapshot: both the database and the branch move on.
  const job = await service.createJob({ projectId: project.id, goal: "produce candidate.txt" });
  await service.runJob(job.id);
  const proposal = await service.proposeIntegration({ jobId: job.id });
  service.grantApproval({ proposalId: proposal.id, principal: "john", origin: "terminal" });
  await service.runIntegration(proposal.id);
  assert.notEqual(await command("git", ["-C", repo, "rev-parse", "integration"], repo), snapshotHead);
  assert.equal(service.listJobs().length, 1);

  const restored = await service.restore(created.backup);
  assert.equal(restored.coherent, true, "the restore is coherent across both truths");
  assert.equal(restored.repositories[0].restored, true);
  assert.ok(restored.safety_backup, "the replaced state is preserved");

  // Operational truth and code truth both returned to the snapshot.
  assert.equal(service.listJobs().length, 0, "the restored database predates the job");
  assert.equal(await command("git", ["-C", repo, "rev-parse", "integration"], repo), snapshotHead,
    "the integration branch returned with it");
  assert.equal(service.doctor().healthy, true);
});

test("restore can be limited to the database when the repositories must not move", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: writer("candidate.txt") });
  t.after(async () => { try { service.close(); } catch { /* closed */ } await cleanup(); });

  const project = await service.addProject({ name: "DbOnly", repoPath: repo, branch: "integration", validation: [] });
  const created = await service.backup("db-only");
  const job = await service.createJob({ projectId: project.id, goal: "produce candidate.txt" });
  await service.runJob(job.id);
  const proposal = await service.proposeIntegration({ jobId: job.id });
  service.grantApproval({ proposalId: proposal.id, principal: "john", origin: "terminal" });
  await service.runIntegration(proposal.id);
  const moved = await command("git", ["-C", repo, "rev-parse", "integration"], repo);

  const restored = await service.restore(created.backup, { restoreRepositories: false });
  assert.equal(restored.coherent, false, "a database-only restore is explicitly not coherent");
  assert.equal(restored.repositories[0].reason, "skipped");
  assert.equal(await command("git", ["-C", repo, "rev-parse", "integration"], repo), moved,
    "the branch was deliberately left where it was");
});

test("after a rollback the product stops reporting the change as done", async (t) => {
  // The defect this covers: rollback moved Git but left integrationStatus and the briefing saying
  // INTEGRATED, so Hermes would describe a removed change as current.
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: writer("candidate.txt") });
  t.after(async () => { service.close(); await cleanup(); });

  const project = await service.addProject({ name: "Truthful", repoPath: repo, branch: "integration", validation: [] });
  const job = await service.createJob({ projectId: project.id, goal: "produce candidate.txt" });
  await service.runJob(job.id, { model: "opencode-go/deepseek-v4-flash" });
  const proposal = await service.proposeIntegration({ jobId: job.id });
  service.grantApproval({ proposalId: proposal.id, principal: "john", origin: "terminal" });
  await service.runIntegration(proposal.id);

  assert.equal(service.integrationStatus(proposal.id).proposal.state, "INTEGRATED");
  assert.equal(service.briefing().done.length, 1, "before rollback it is Done");

  await service.rollbackIntegration({ proposalId: proposal.id, principal: "john", origin: "local-cli" });

  const after = service.integrationStatus(proposal.id);
  assert.equal(after.proposal.state, "ROLLED_BACK", "the current state reflects the rollback");
  assert.ok(after.proposal.rolled_back, "the rollback is attached as evidence");
  assert.deepEqual(service.briefing().done, [], "the removed change is no longer reported as Done");
});

test("a rollback whose receipt was lost is completed by reconciliation", async (t) => {
  // Fault injection: the branch compare-and-swap lands, then the process dies before the receipt is
  // written. Without repair the product would keep calling the removed change current.
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: writer("candidate.txt") });
  t.after(async () => { service.close(); await cleanup(); });

  const project = await service.addProject({ name: "CrashedRollback", repoPath: repo, branch: "integration", validation: [] });
  const before = await command("git", ["-C", repo, "rev-parse", "integration"], repo);
  const job = await service.createJob({ projectId: project.id, goal: "produce candidate.txt" });
  await service.runJob(job.id, { model: "opencode-go/deepseek-v4-flash" });
  const proposal = await service.proposeIntegration({ jobId: job.id });
  service.grantApproval({ proposalId: proposal.id, principal: "john", origin: "terminal" });
  await service.runIntegration(proposal.id);

  // The branch moves back, exactly as rollback would leave it, with no receipt written.
  await command("git", ["-C", repo, "branch", "-f", "integration", before], repo);
  assert.equal(service.latestRollback(proposal.id), null, "no receipt exists yet");
  assert.equal(service.integrationStatus(proposal.id).proposal.state, "INTEGRATED",
    "before reconciliation the record still claims it is integrated");

  const observed = await service.reconcileRollbacks({ apply: false });
  assert.equal(observed.length, 1, "reconciliation observes the discrepancy without applying");
  assert.equal(service.latestRollback(proposal.id), null, "a dry run changes nothing");

  const repaired = await service.reconcileRollbacks({ apply: true });
  assert.equal(repaired.length, 1);
  assert.ok(service.latestRollback(proposal.id), "the receipt is completed");
  assert.equal(service.integrationStatus(proposal.id).proposal.state, "ROLLED_BACK");
  assert.deepEqual(service.briefing().done, []);
});

// Default restore must be all-or-nothing.
//
// Restoring the database and then failing to move a repository leaves operational truth describing
// code that does not exist. Reporting that as an ordinary success -- merely with `coherent: false`
// -- lets a system whose two truths are known to disagree call itself recovered.
test("a restore that cannot return a repository refuses before touching the database", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: writer("a.txt") });
  try {
    const project = await service.addProject({ name: "coherent", repoPath: repo, validation: [] });
    const backup = await service.backup("before");
    assert.ok(backup.repositories.some((entry) => entry.name === "coherent"));

    const jobsBefore = service.listJobs().length;
    // The repository the manifest names is gone by the time restore runs.
    fs.rmSync(repo, { recursive: true, force: true });

    await assert.rejects(
      () => service.restore(backup.backup),
      /Refusing to restore/,
      "the operator keeps an untouched system and a clear reason",
    );
    assert.equal(service.listJobs().length, jobsBefore, "the database was never replaced");
    assert.equal(service.doctor().unresolved_restore, undefined, "and nothing needs reconciling");
    assert.ok(project.id);
  } finally {
    service.close();
    await cleanup();
  }
});

// The escape hatch stays available, because an operator who asks for operational truth alone has
// made an informed choice rather than been handed a silent half-recovery.
test("--database-only restores without repositories and says so", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: writer("a.txt") });
  try {
    await service.addProject({ name: "dbonly", repoPath: repo, validation: [] });
    const backup = await service.backup("before");
    fs.rmSync(repo, { recursive: true, force: true });

    const restored = await service.restore(backup.backup, { restoreRepositories: false });
    assert.equal(restored.coherent, false, "explicitly incoherent, by request");
    assert.equal(service.doctor().unresolved_restore, undefined,
      "an operator's deliberate choice is not an unresolved condition");
  } finally {
    service.close();
    await cleanup();
  }
});

// Preflight makes a mid-restore failure rare, not impossible. When it happens the database is
// already replaced, so the only honest outcome is a durable condition that survives the swap.
test("a repository that fails during the restore leaves the system durably unhealthy", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: writer("a.txt") });
  try {
    await service.addProject({ name: "racy", repoPath: repo, validation: [] });
    const backup = await service.backup("before");

    assert.equal(service.doctor().healthy, true, "healthy before the failure");

    // The outcome a mid-restore repository failure produces: the database is already replaced, so
    // the marker is the only thing that can carry the disagreement forward.
    writeRestoreMarker(root, { restored_from: backup.backup, repositories: [{ name: "racy", reason: "locked" }] });
    const doctor = service.doctor();
    assert.equal(doctor.healthy, false, "the system must not claim health while the truths disagree");
    assert.equal(doctor.unresolved_restore.unresolved, true);

    // And it stays unhealthy until a person says otherwise.
    assert.equal(service.doctor().healthy, false, "it does not clear on its own");
    const resolved = service.resolveRestore();
    assert.equal(resolved.resolved, true);
    assert.equal(service.doctor().healthy, true, "only an explicit reconciliation clears it");
  } finally {
    service.close();
    await cleanup();
  }
});

test("an unreadable restore marker still counts as unresolved", async (t) => {
  const { root, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: writer("a.txt") });
  try {
    fs.mkdirSync(path.dirname(restoreMarkerPath(root)), { recursive: true });
    fs.writeFileSync(restoreMarkerPath(root), "{ not json");
    assert.equal(service.doctor().healthy, false,
      "refusing to parse the marker must not clear the warning it carries");
  } finally {
    service.close();
    await cleanup();
  }
});

// Proves the real code path writes the marker, not merely that doctor reads one placed by hand.
// A repository that passes preflight and then cannot be moved is the race this exists for.
test("restoreBackup itself records the unresolved condition and refuses to report success", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: writer("a.txt") });
  let backupDir = null;
  try {
    await service.addProject({ name: "racy", repoPath: repo, branch: "integration", validation: [] });
    backupDir = (await service.backup("before")).backup;
  } finally {
    service.close();
  }

  // The branch moves after the backup, so restoring genuinely has to move it back -- otherwise the
  // update is skipped as "already at the recorded head" and nothing is exercised.
  fs.writeFileSync(path.join(repo, "later.txt"), "after\n");
  await command("git", ["-C", repo, "add", "."], repo);
  await command("git", ["-C", repo, "commit", "-m", "moved on"], repo);
  await command("git", ["-C", repo, "branch", "-f", "integration", "HEAD"], repo);

  try {
    // Preflight sees a healthy repository; the update fails when it is actually attempted.
    const failingUpdate = async () => { throw new Error("ref lock held by another process"); };
    await assert.rejects(
      () => restoreBackup({
        root, backupDirectory: backupDir, database: null, restoreRepositories: true,
        updateRef: failingUpdate,
      }),
      /operational truth and code truth disagreeing/,
      "a half-applied restore is an error, never an ordinary success",
    );

    const marker = readRestoreMarker(root);
    assert.equal(marker.unresolved, true, "and it leaves a durable condition behind");
    assert.equal(marker.repositories[0].name, "racy");
    assert.match(marker.repositories[0].reason, /ref lock held/);
  } finally {
    await cleanup();
  }
});

// A backup from a newer build must be refused, not silently accepted.
//
// Opening a database migrates it forward, so restoring an OLDER backup is the ordinary supported
// case. The reverse is not knowable: a newer schema may carry tables, columns, or column meanings
// this build has never seen, and `CREATE TABLE IF NOT EXISTS` plus additive migration would leave
// them in place while `doctor` reported healthy -- operating confidently on a database it cannot
// interpret.
test("a backup recording a newer schema version is refused", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: writer("a.txt") });
  let backupDir = null;
  try {
    await service.addProject({ name: "schema-guard", repoPath: repo, validation: [] });
    backupDir = (await service.backup("newer")).backup;
  } finally {
    service.close();
  }

  // Rewrite the manifest as a genuinely newer build would have produced it, checksums included, so
  // the damaged-backup guard is not what fires.
  const manifestPath = path.join(backupDir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.schema_version = String(Number(SCHEMA_VERSION) + 7);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const reopened = new Dispatcher({ root, backend: writer("a.txt") });
  try {
    await assert.rejects(
      () => reopened.restore(backupDir),
      /newer delegate-wave/,
      "restoring a future schema into this build must fail closed",
    );
    assert.equal(reopened.doctor().healthy, true, "and the untouched system stays healthy");
  } finally {
    reopened.close();
    await cleanup();
  }
});

test("a backup from an older schema still restores", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: writer("a.txt") });
  let backupDir = null;
  try {
    await service.addProject({ name: "older", repoPath: repo, validation: [] });
    backupDir = (await service.backup("older")).backup;
  } finally {
    service.close();
  }

  const manifestPath = path.join(backupDir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.schema_version = "1";
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const reopened = new Dispatcher({ root, backend: writer("a.txt") });
  try {
    const restored = await reopened.restore(backupDir);
    assert.equal(restored.coherent, true, "forward migration is the ordinary supported case");
  } finally {
    reopened.close();
    await cleanup();
  }
});

// A validation the machine interrupted produced no verdict.
//
// Cancellation already records NOT_RUN for exactly this situation, with the reasoning written into
// the code: marking it FAILED would claim the candidate was tested and rejected. Reconciliation --
// the path a crash or reboot actually takes -- recorded FAILED for the same real-world event, so an
// interrupted machine made the system assert that the code failed its tests.
test("reconciling an interrupted validation records NOT_RUN, not FAILED", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  const service = new Dispatcher({ root, backend: writer("candidate.txt") });
  try {
    const project = await service.addProject({
      name: "interrupted", repoPath: repo, branch: "integration", validation: [],
    });
    const job = await service.createJob({ projectId: project.id, goal: "produce a candidate" });
    await service.runJob(job.id);

    // Put the attempt back into the validation-pending phase a crash would leave behind: the
    // executor succeeded, validation was owned by a process that is now gone.
    const attempt = service.db.prepare("SELECT * FROM attempts WHERE job_id = ?").get(job.id);
    service.db.prepare(`UPDATE attempts SET validation_state = 'PENDING', finished_at = NULL,
      validation_pid = 999999, scheduler_pid = 999998 WHERE id = ?`).run(attempt.id);

    const reconciled = await service.reconcile({ apply: true });
    assert.ok(reconciled.applied, "the dead attempt is reconcilable");

    const after = service.db.prepare("SELECT * FROM attempts WHERE id = ?").get(attempt.id);
    assert.equal(after.validation_state, "NOT_RUN",
      "an interrupted validation reached no verdict; FAILED would assert one it never made");
    assert.equal(after.terminal_state, "SUCCEEDED", "the executor really did succeed");
    assert.equal(after.quarantined, 1, "and the untested candidate is still quarantined");

    const recorded = service.db.prepare(
      "SELECT 1 FROM events WHERE kind = 'VALIDATION_INTERRUPTED' AND entity_id = ?",
    ).get(attempt.id);
    assert.ok(recorded, "the interruption itself is still recorded");
  } finally {
    service.close();
    await cleanup();
  }
});
