// Backup, restore, and rollback.
//
// The point of this module is that recovering from an ordinary problem must never require hand
// editing SQLite or Git. Every operation here is explicit, records what it did, and refuses rather
// than guessing when the world does not match what it expected.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { backup as sqliteBackup } from "node:sqlite";
import { managedPaths } from "./paths.js";
import { resolveRevision, updateRefCas, isAncestor } from "./git.js";

const now = () => new Date().toISOString();
const stamp = () => now().replace(/[:.]/g, "-");

// SQLite in WAL mode keeps recent commits in side files. Copying only the main database can
// therefore lose work that was durably committed, so all three are captured together.
const DATABASE_FILES = ["", "-wal", "-shm"];

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// Captures the operational database plus a manifest describing what it was, where it came from, and
// crucially where every registered repository's integration branch stood at that moment.
//
// Uses node:sqlite's module-level backup(), which produces a consistent snapshot. A plain file copy
// taken while a write is in flight can be torn, and a backup that cannot be trusted is worse than
// none. An earlier version checked for a `database.backup` method, which does not exist, so it
// silently always used the copy fallback.
export async function createBackup({ root, database, label = "manual" }) {
  const paths = managedPaths(root);
  const directory = path.join(paths.backups, `${stamp()}-${label}`);
  fs.mkdirSync(directory, { recursive: true });

  const target = path.join(directory, "delegate-wave.sqlite");
  if (database) {
    await sqliteBackup(database, target);
  } else {
    // No open handle to snapshot from: copy the database and its WAL side files together, since
    // copying only the main file can lose durably committed work.
    for (const suffix of DATABASE_FILES) {
      const source = `${paths.database}${suffix}`;
      if (fs.existsSync(source)) fs.copyFileSync(source, `${target}${suffix}`);
    }
  }

  // Operational truth and code truth must be restorable together. A database snapshot alone can be
  // restored on top of repositories that have moved on, which is precisely the inconsistency a
  // recovery feature exists to prevent, so where each integration branch stood is recorded here.
  const repositories = [];
  if (database) {
    const projects = database.prepare("SELECT id, name, repo_path, integration_branch FROM projects").all();
    for (const project of projects) {
      let head = null;
      let error = null;
      try {
        head = await resolveRevision(project.repo_path, project.integration_branch);
      } catch (failure) {
        error = String(failure?.message ?? failure).slice(0, 200);
      }
      repositories.push({ ...project, integration_head: head, ...(error ? { error } : {}) });
    }
  }

  const manifest = {
    created_at: now(),
    label,
    schema_version: database?.prepare?.("SELECT value FROM metadata WHERE key = 'schema_version'")?.get()?.value ?? null,
    source_database: paths.database,
    repositories,
    files: fs.readdirSync(directory).filter((name) => name !== "manifest.json").map((name) => ({
      name,
      bytes: fs.statSync(path.join(directory, name)).size,
      sha256: sha256(path.join(directory, name)),
    })),
  };
  fs.writeFileSync(path.join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { backup: directory, ...manifest };
}

export function listBackups(root) {
  const paths = managedPaths(root);
  if (!fs.existsSync(paths.backups)) return [];
  return fs.readdirSync(paths.backups)
    .map((name) => path.join(paths.backups, name))
    .filter((directory) => fs.existsSync(path.join(directory, "manifest.json")))
    .map((directory) => ({
      backup: directory,
      ...JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8")),
    }))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function verifyBackup(backupDirectory) {
  const manifestPath = path.join(backupDirectory, "manifest.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`Not a backup directory: ${backupDirectory}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const damaged = [];
  for (const file of manifest.files) {
    const full = path.join(backupDirectory, file.name);
    if (!fs.existsSync(full)) { damaged.push({ name: file.name, reason: "missing" }); continue; }
    if (sha256(full) !== file.sha256) damaged.push({ name: file.name, reason: "checksum mismatch" });
  }
  return { backup: backupDirectory, intact: damaged.length === 0, damaged, manifest };
}

// Replaces the live database with a backup.
//
// The database being replaced is itself backed up first, unconditionally. Restoring is the operation
// most likely to be performed under stress, and losing the pre-restore state because the restore was
// the wrong choice would be the worst possible outcome.
export async function restoreBackup({ root, backupDirectory, database = null, restoreRepositories = true }) {
  const verified = verifyBackup(backupDirectory);
  if (!verified.intact) {
    throw new Error(`Refusing to restore a damaged backup: ${JSON.stringify(verified.damaged)}`);
  }
  const paths = managedPaths(root);
  const safety = fs.existsSync(paths.database)
    ? await createBackup({ root, database, label: "pre-restore" })
    : null;

  // Remove the live WAL side files: leaving them beside a restored database would replay changes
  // that belong to the database being replaced.
  for (const suffix of DATABASE_FILES) {
    const live = `${paths.database}${suffix}`;
    if (fs.existsSync(live)) fs.rmSync(live, { force: true });
  }
  for (const file of verified.manifest.files) {
    const source = path.join(backupDirectory, file.name);
    const suffix = file.name.replace("delegate-wave.sqlite", "");
    fs.copyFileSync(source, `${paths.database}${suffix}`);
  }

  // Operational truth is back; code truth must follow, or the restored database will describe
  // integrations that the repositories no longer match. Each branch returns to the head recorded in
  // the manifest, compare-and-swap against where it actually is.
  const repositories = [];
  for (const repository of verified.manifest.repositories ?? []) {
    if (!restoreRepositories || !repository.integration_head) {
      repositories.push({ ...repository, restored: false, reason: repository.integration_head ? "skipped" : "no recorded head" });
      continue;
    }
    try {
      const current = await resolveRevision(repository.repo_path, repository.integration_branch);
      if (current === repository.integration_head) {
        repositories.push({ ...repository, restored: false, reason: "already at the recorded head" });
        continue;
      }
      await updateRefCas(
        repository.repo_path, `refs/heads/${repository.integration_branch}`,
        repository.integration_head, current,
      );
      repositories.push({ ...repository, restored: true, from: current });
    } catch (error) {
      // Reported rather than thrown: the database is already restored, and a repository that cannot
      // be moved is a fact the operator must see, not a reason to leave the restore half-applied
      // with no record of what happened.
      repositories.push({ ...repository, restored: false, reason: String(error?.message ?? error).slice(0, 200) });
    }
  }

  return {
    restored: backupDirectory,
    safety_backup: safety?.backup ?? null,
    files: verified.manifest.files.length,
    repositories,
    coherent: repositories.every((entry) => entry.restored || entry.reason === "already at the recorded head"),
  };
}

// Moves an integration branch back to a recorded commit.
//
// Compare-and-swap, never a force reset: if the branch is not where the caller believes it is,
// something else moved it and silently overwriting that would destroy work. The caller must state
// the commit it expects to find.
export async function rollbackIntegration({ repoPath, branch, toSha, expectedCurrentSha }) {
  const ref = `refs/heads/${branch}`;
  const current = await resolveRevision(repoPath, branch);
  if (expectedCurrentSha && current !== expectedCurrentSha) {
    throw new Error(
      `Refusing to roll back ${branch}: expected it at ${expectedCurrentSha} but found ${current}. `
      + "Something else moved the branch; inspect before retrying.",
    );
  }
  // The target must be an ancestor of where we are, or this is not a rollback -- it is an
  // unrelated branch move wearing a rollback's name.
  if (!await isAncestor(repoPath, toSha, current)) {
    throw new Error(`Refusing to roll back ${branch}: ${toSha} is not an ancestor of ${current}`);
  }
  if (toSha === current) return { branch, moved: false, from: current, to: toSha };

  await updateRefCas(repoPath, ref, toSha, current);
  return { branch, moved: true, from: current, to: toSha };
}
