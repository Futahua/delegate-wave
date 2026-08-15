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
import { SCHEMA_VERSION } from "./db.js";
import { resolveRevision, updateRefCas, isAncestor } from "./git.js";

const now = () => new Date().toISOString();
const stamp = () => now().replace(/[:.]/g, "-");

// A restore that could not be completed coherently leaves this marker behind.
//
// Deliberately a file rather than a row: the database is the thing being replaced, so a flag written
// inside it would be destroyed by the very operation it needs to outlive. It is cleared only when
// someone resolves the situation, so the system cannot drift back to reporting healthy on its own.
export const RESTORE_MARKER = "restore-needs-reconciliation.json";

export function restoreMarkerPath(root) {
  return path.join(managedPaths(root).state, RESTORE_MARKER);
}

export function readRestoreMarker(root) {
  const file = restoreMarkerPath(root);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // An unreadable marker still means unresolved: refusing to parse it must not clear the warning.
    return { unresolved: true, reason: "the restore marker exists but could not be read" };
  }
}

export function writeRestoreMarker(root, detail) {
  const file = restoreMarkerPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ unresolved: true, created_at: now(), ...detail }, null, 2)}\n`);
  return file;
}

export function clearRestoreMarker(root) {
  const file = restoreMarkerPath(root);
  if (!fs.existsSync(file)) return { cleared: false };
  fs.rmSync(file, { force: true });
  return { cleared: true, marker: file };
}

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
// Checks, before anything is replaced, that every recorded repository head can actually be restored.
//
// A restore that swaps the database and then discovers a repository will not move leaves operational
// truth describing code that does not exist. Finding that out first means the operator still has an
// untouched system and a clear reason, instead of a half-applied recovery.
export async function preflightRepositories(manifest) {
  const blocked = [];
  for (const repository of manifest.repositories ?? []) {
    if (!repository.integration_head) {
      blocked.push({ name: repository.name, reason: "the backup recorded no head for this repository" });
      continue;
    }
    try {
      const current = await resolveRevision(repository.repo_path, repository.integration_branch);
      if (current === repository.integration_head) continue;
      // The target must still exist in the repository, or the branch cannot be moved back to it.
      await resolveRevision(repository.repo_path, repository.integration_head);
    } catch (error) {
      blocked.push({ name: repository.name, reason: String(error?.message ?? error).slice(0, 200) });
    }
  }
  return blocked;
}

export async function restoreBackup({
  root, backupDirectory, database = null, restoreRepositories = true, updateRef = updateRefCas,
}) {
  const verified = verifyBackup(backupDirectory);
  if (!verified.intact) {
    throw new Error(`Refusing to restore a damaged backup: ${JSON.stringify(verified.damaged)}`);
  }

  // A backup from a NEWER build cannot be restored into this one.
  //
  // Opening a database migrates it forward, so an older backup is fine -- that is the ordinary case
  // and it stays supported. The reverse is not knowable: a newer schema may carry tables, columns,
  // or column meanings this build has never heard of, and `CREATE TABLE IF NOT EXISTS` plus additive
  // migration would leave them in place while reporting healthy. Refusing is the only honest answer,
  // because the alternative is operating confidently on a database we cannot interpret.
  const recorded = Number(verified.manifest.schema_version);
  const current = Number(SCHEMA_VERSION);
  if (Number.isFinite(recorded) && Number.isFinite(current) && recorded > current) {
    throw new Error(
      `Refusing to restore a backup from a newer delegate-wave: the backup records schema `
      + `${verified.manifest.schema_version} but this build understands ${SCHEMA_VERSION}. `
      + "Run the newer build to restore it.",
    );
  }

  // Default restore is all-or-nothing. `--database-only` is the escape hatch, and it is incoherent
  // because the operator asked for that, not because the restore quietly gave up partway.
  if (restoreRepositories) {
    const blocked = await preflightRepositories(verified.manifest);
    if (blocked.length) {
      throw new Error(
        "Refusing to restore: these repositories cannot be returned to their recorded heads, so the "
        + "database would describe code that does not exist. "
        + `${JSON.stringify(blocked)} `
        + "Resolve them, or rerun with --database-only to restore operational truth alone.",
      );
    }
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
      await updateRef(
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

  const coherent = repositories.every((entry) => entry.restored || entry.reason === "already at the recorded head");

  // Preflight makes this rare, not impossible: a repository can still become unmovable between the
  // check and the effect. The database is already replaced by this point, so the only honest outcome
  // is a durable marker that keeps the system unhealthy until a person resolves it. Returning an
  // ordinary success with `coherent: false` would let a system whose operational truth and code
  // truth disagree report itself as fine.
  if (restoreRepositories && !coherent) {
    const failures = repositories
      .filter((entry) => !entry.restored && entry.reason !== "already at the recorded head")
      .map((entry) => ({ name: entry.name, repo_path: entry.repo_path, reason: entry.reason }));
    writeRestoreMarker(root, { restored_from: backupDirectory, repositories: failures });
    throw new Error(
      "Restore left operational truth and code truth disagreeing: "
      + `${JSON.stringify(failures)}. The database was restored from ${backupDirectory}, but these `
      + "repositories were not. The system is marked unhealthy until this is reconciled; "
      + `the pre-restore state is at ${safety?.backup ?? "(no safety backup was taken)"}.`,
    );
  }

  return {
    restored: backupDirectory,
    safety_backup: safety?.backup ?? null,
    files: verified.manifest.files.length,
    repositories,
    coherent,
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
