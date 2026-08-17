// Retirement and restore contradicted each other.
//
// Retirement is supported precisely so a project you stopped tracking -- whose repository you then
// deleted -- cannot make the system look permanently broken. But backup recorded every project, and
// preflight treated every missing head as a hard blocker, so performing the supported cleanup made
// default restore permanently impossible. One supported lifecycle closed a recovery path.
//
// The governing rule is a statement about TIME: whether a repository must participate in a restore
// is decided by its retirement state in the backup being restored, never by its state today.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { initializeDataRoot } from "../src/db.js";
import { FakeBackend } from "../src/backend.js";
import { Dispatcher } from "../src/service.js";
import { createBackup, restoreBackup, resolveRestoreRequirements, preflightRepositories } from "../src/recovery.js";
import { managedPaths } from "../src/paths.js";
import { runProcess } from "../src/process.js";

async function command(name, args, cwd) {
  const result = await runProcess(name, args, { cwd });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

async function makeRepo(parent, name) {
  const repo = path.join(parent, name);
  fs.mkdirSync(repo, { recursive: true });
  await command("git", ["init", "-b", "main"], repo);
  await command("git", ["config", "user.name", "Test"], repo);
  await command("git", ["config", "user.email", "test@example.invalid"], repo);
  fs.writeFileSync(path.join(repo, "input.txt"), "before\n");
  await command("git", ["add", "."], repo);
  await command("git", ["commit", "-m", "initial"], repo);
  // Integration happens on a branch that is not checked out; Git refuses a push to the working one.
  await command("git", ["branch", "integration"], repo);
  return repo;
}

async function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-retire-"));
  const root = path.join(temp, "data");
  initializeDataRoot(root);
  const service = new Dispatcher({ root, backend: new FakeBackend() });
  // Restore replaces the database file, so tests close the service first; the hook tolerates that.
  t.after(() => {
    try { service.close(); } catch { /* already closed by the test */ }
    fs.rmSync(temp, { recursive: true, force: true });
  });
  return { temp, root, service };
}

const manifestOf = (backupDirectory) =>
  JSON.parse(fs.readFileSync(path.join(backupDirectory, "manifest.json"), "utf8"));

test("a project retired before backup does not block restore when its repo is gone", async (t) => {
  const { temp, root, service } = await fixture(t);
  const repo = await makeRepo(temp, "retired-repo");
  const project = await service.addProject({ name: "Retired", repoPath: repo, branch: "integration", validation: [] });
  service.retireProject({ projectId: project.id, principal: "john", origin: "terminal" });

  // The supported cleanup: stop tracking it, then remove it.
  fs.rmSync(repo, { recursive: true, force: true });

  const backup = await createBackup({ root, database: service.db, label: "after-retire" });
  const entry = manifestOf(backup.backup).repositories[0];
  assert.equal(entry.restore_required, false);
  assert.ok(entry.retired_at, "the manifest records the retirement itself, not just its consequence");
  assert.equal(entry.integration_head, null);

  service.close();
  const restored = await restoreBackup({ root, backupDirectory: backup.backup });
  assert.equal(restored.coherent, true, "a retired repository owes the restore nothing");

  // Retirement survives the round trip, which is what makes the skip correct rather than convenient.
  const reopened = new DatabaseSync(managedPaths(root).database, { readOnly: true });
  assert.ok(reopened.prepare("SELECT retired_at FROM projects WHERE id = ?").get(project.id).retired_at);
  reopened.close();
});

test("an active project whose repository is gone still blocks restore", async (t) => {
  const { temp, root, service } = await fixture(t);
  const repo = await makeRepo(temp, "active-repo");
  await service.addProject({ name: "Active", repoPath: repo, branch: "integration", validation: [] });

  const backup = await createBackup({ root, database: service.db, label: "active" });
  assert.equal(manifestOf(backup.backup).repositories[0].restore_required, true);

  fs.rmSync(repo, { recursive: true, force: true });
  service.close();
  // After close(): closing checkpoints the WAL into the main file, which changes its mtime.
  const before = fs.statSync(managedPaths(root).database).mtimeMs;
  await assert.rejects(
    restoreBackup({ root, backupDirectory: backup.backup }),
    /Refusing to restore/,
  );
  assert.equal(
    fs.statSync(managedPaths(root).database).mtimeMs, before,
    "a refused restore leaves the database untouched",
  );
});

test("retiring today cannot weaken a backup taken while the project was active", async (t) => {
  // The time-direction case. The restored database will make this project active again, so its
  // repository IS part of the code truth being reconstructed -- regardless of what is true now.
  const { temp, root, service } = await fixture(t);
  const repo = await makeRepo(temp, "later-retired");
  const project = await service.addProject({ name: "WasActive", repoPath: repo, branch: "integration", validation: [] });

  const backup = await createBackup({ root, database: service.db, label: "while-active" });
  assert.equal(manifestOf(backup.backup).repositories[0].restore_required, true);

  // Only afterwards is it retired and deleted.
  service.retireProject({ projectId: project.id, principal: "john", origin: "terminal" });
  fs.rmSync(repo, { recursive: true, force: true });

  service.close();
  await assert.rejects(
    restoreBackup({ root, backupDirectory: backup.backup }),
    /Refusing to restore/,
    "today's retirement must not relax an older backup's requirement",
  );
});

test("a retired repository's branch is not moved back", async (t) => {
  const { temp, root, service } = await fixture(t);
  const repo = await makeRepo(temp, "retired-but-present");
  const project = await service.addProject({ name: "Left alone", repoPath: repo, branch: "integration", validation: [] });
  service.retireProject({ projectId: project.id, principal: "john", origin: "terminal" });

  const backup = await createBackup({ root, database: service.db, label: "retired-present" });

  // The operator keeps working in a repository delegate-wave no longer tracks.
  fs.writeFileSync(path.join(repo, "input.txt"), "their work\n");
  await command("git", ["add", "."], repo);
  await command("git", ["commit", "-m", "their own commit"], repo);
  const moved = await command("git", ["rev-parse", "integration"], repo);

  service.close();
  const restored = await restoreBackup({ root, backupDirectory: backup.backup });
  assert.equal(restored.coherent, true);
  assert.equal(
    await command("git", ["rev-parse", "integration"], repo), moved,
    "retirement withdrew the claim to keep this repository synchronized; restore must not reassert it",
  );
  const entry = restored.repositories.find((item) => item.name === "Left alone");
  assert.equal(entry.restored, false);
  assert.equal(entry.reason, "retired at backup time");
});

test("a mixed backup restores the active repository and skips the retired one", async (t) => {
  const { temp, root, service } = await fixture(t);
  const activeRepo = await makeRepo(temp, "mixed-active");
  const retiredRepo = await makeRepo(temp, "mixed-retired");
  await service.addProject({ name: "StillTracked", repoPath: activeRepo, branch: "integration", validation: [] });
  const retired = await service.addProject({ name: "NoLongerTracked", repoPath: retiredRepo, branch: "integration", validation: [] });
  service.retireProject({ projectId: retired.id, principal: "john", origin: "terminal" });

  const recorded = await command("git", ["rev-parse", "integration"], activeRepo);
  const backup = await createBackup({ root, database: service.db, label: "mixed" });

  // The retired repository disappears; the active one moves on.
  fs.rmSync(retiredRepo, { recursive: true, force: true });
  fs.writeFileSync(path.join(activeRepo, "input.txt"), "moved\n");
  await command("git", ["add", "."], activeRepo);
  await command("git", ["commit", "-m", "drift"], activeRepo);
  // The tracked branch itself must drift, or the restore has nothing to put back and reports
  // "already at the recorded head" -- which would make this test pass without restoring anything.
  await command("git", ["branch", "-f", "integration", "main"], activeRepo);
  assert.notEqual(await command("git", ["rev-parse", "integration"], activeRepo), recorded);

  service.close();
  const restored = await restoreBackup({ root, backupDirectory: backup.backup });
  assert.equal(restored.coherent, true);
  assert.equal(await command("git", ["rev-parse", "integration"], activeRepo), recorded, "the tracked repo is restored");
  assert.equal(restored.repositories.find((r) => r.name === "StillTracked").restored, true);
  assert.equal(restored.repositories.find((r) => r.name === "NoLongerTracked").restored, false);
});

test("database-only restore keeps its own semantics", async (t) => {
  const { temp, root, service } = await fixture(t);
  const repo = await makeRepo(temp, "db-only");
  await service.addProject({ name: "DbOnly", repoPath: repo, branch: "integration", validation: [] });
  const backup = await createBackup({ root, database: service.db, label: "db-only" });

  fs.writeFileSync(path.join(repo, "input.txt"), "moved\n");
  await command("git", ["add", "."], repo);
  await command("git", ["commit", "-m", "drift"], repo);
  const moved = await command("git", ["rev-parse", "integration"], repo);

  service.close();
  const restored = await restoreBackup({ root, backupDirectory: backup.backup, restoreRepositories: false });
  // The escape hatch is unchanged by retirement: it restores operational truth alone, and says so.
  assert.equal(await command("git", ["rev-parse", "integration"], repo), moved);
  assert.equal(restored.repositories.find((r) => r.name === "DbOnly").restored, false);
});

test("an old manifest without restore_required derives it from the snapshot, never from absence", async (t) => {
  const { temp, root, service } = await fixture(t);
  const repo = await makeRepo(temp, "legacy-manifest");
  const project = await service.addProject({ name: "LegacyRetired", repoPath: repo, branch: "integration", validation: [] });
  service.retireProject({ projectId: project.id, principal: "john", origin: "terminal" });
  const backup = await createBackup({ root, database: service.db, label: "legacy" });

  // Strip the new field, as a backup written by an older build would have.
  const manifestPath = path.join(backup.backup, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  for (const entry of manifest.repositories) {
    delete entry.restore_required;
    delete entry.retired_at;
  }

  // The snapshot inside the backup still records what the world was at backup time, so it decides.
  const resolved = resolveRestoreRequirements(manifest, backup.backup);
  assert.equal(resolved[0].restore_required, false, "the backed-up database is authoritative");

  // Without the snapshot there is nothing to derive from, and absence must never read as retirement:
  // that would silently weaken a guarantee the old backup was made under.
  const blind = resolveRestoreRequirements(manifest, null);
  assert.equal(blind[0].restore_required, true, "unknown means required, not retired");

  const blocked = await preflightRepositories(manifest, backup.backup);
  assert.deepEqual(blocked, []);
});
