// Recovery must never require hand-editing SQLite or Git.
//
// The properties that matter: a backup is verifiable, a restore cannot silently destroy the state it
// replaces, and a rollback refuses rather than guessing when the branch is not where it was expected.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeDataRoot } from "../src/db.js";
import { FakeBackend } from "../src/backend.js";
import { Dispatcher } from "../src/service.js";
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
  const created = service.backup("test");

  assert.ok(fs.existsSync(path.join(created.backup, "manifest.json")));
  assert.ok(created.files.length >= 1, "the database is captured");
  assert.equal(created.schema_version, "14");
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
  const created = service.backup("damaged");
  const target = path.join(created.backup, created.files[0].name);
  fs.appendFileSync(target, "corruption");

  const verified = service.verifyBackup(created.backup);
  assert.equal(verified.intact, false);
  assert.equal(verified.damaged[0].reason, "checksum mismatch");

  const { restoreBackup } = await import("../src/recovery.js");
  assert.throws(() => restoreBackup({ root, backupDirectory: created.backup, database: service.db }),
    /Refusing to restore a damaged backup/);
});

test("restoring recovers lost state and preserves what it replaced", async (t) => {
  const { root, repo, cleanup } = await fixture(t);
  let service = new Dispatcher({ root, backend: writer("out.txt") });
  t.after(async () => { try { service.close(); } catch { /* already closed */ } await cleanup(); });

  const project = await service.addProject({ name: "Restore", repoPath: repo, validation: [] });
  const job = await service.createJob({ projectId: project.id, goal: "before backup" });
  const created = service.backup("before-loss");

  // Work happens after the backup, then the database is lost.
  const later = await service.createJob({ projectId: project.id, goal: "after backup" });
  assert.equal(service.listJobs().length, 2);
  service.close();

  const { restoreBackup } = await import("../src/recovery.js");
  const restored = restoreBackup({ root, backupDirectory: created.backup });
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
