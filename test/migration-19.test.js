// Migration from a real schema-18 database, then a real attempt against it.
//
// The bug this exists to catch is invisible to every other test in the suite. Fresh-root tests build
// their tables from SCHEMA, so they always have the newest columns and never migrate anything. An
// existing installation takes the other path: migrate() runs, the version write at the end stamps it
// schema 19 regardless, and the first runJob() INSERT then names columns that were never added.
//
// The database advertises a version that does not describe its objects -- exactly what the
// SCHEMA_VERSION comment says must never happen -- and the only symptom is a live attempt failing.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { initializeDataRoot, openDatabase, SCHEMA_VERSION } from "../src/db.js";
import { managedPaths } from "../src/paths.js";
import { FakeBackend } from "../src/backend.js";
import { Dispatcher } from "../src/service.js";
import { runProcess } from "../src/process.js";

async function command(name, args, cwd) {
  const result = await runProcess(name, args, { cwd });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

// The parts of schema 18 this test needs: the tables a direct attempt touches, exactly as they stood
// before the semantic layer. Written out rather than checked out, so the fixture cannot drift with
// the current SCHEMA and quietly start including the columns under test.
const SCHEMA_18 = `
CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL UNIQUE,
  integration_branch TEXT NOT NULL, validation_json TEXT NOT NULL DEFAULT '[]',
  protected_json TEXT NOT NULL DEFAULT '[]', retired_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), goal TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('read', 'write')),
  status TEXT NOT NULL CHECK (status IN (
    'PENDING', 'RUNNING', 'READY_FOR_INTEGRATION', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'NEEDS_ATTENTION'
  )),
  base_sha TEXT NOT NULL, max_attempts INTEGER NOT NULL DEFAULT 2,
  maximum_cost REAL, capability_profile TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE attempts (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), ordinal INTEGER NOT NULL,
  scheduler_epoch INTEGER NOT NULL, terminal_state TEXT, validation_state TEXT NOT NULL DEFAULT 'NOT_RUN',
  backend TEXT NOT NULL, capability_profile TEXT, model TEXT, scheduler_pid INTEGER,
  executor_intent_id TEXT, executor_pid INTEGER, validation_intent_id TEXT, validation_pid INTEGER,
  worktree_path TEXT, worktree_locked INTEGER NOT NULL DEFAULT 0, quarantined INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL, finished_at TEXT, exit_code INTEGER, result_commit TEXT,
  changed_files_json TEXT, failure_signature TEXT, UNIQUE(job_id, ordinal)
);
CREATE TABLE validation_runs (
  id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES attempts(id), command TEXT NOT NULL,
  exit_code INTEGER NOT NULL, output_path TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT NOT NULL
);
CREATE TABLE events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at TEXT NOT NULL, kind TEXT NOT NULL,
  entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, scheduler_epoch INTEGER,
  payload_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE work_proposals (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), goal TEXT NOT NULL,
  mode TEXT NOT NULL, action_digest TEXT NOT NULL, expected_state_version TEXT, maximum_cost REAL,
  expires_at TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, origin_principal TEXT NOT NULL,
  origin_channel TEXT NOT NULL, created_at TEXT NOT NULL
);
`;

async function fixture() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-migrate-"));
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

  // Replace the fresh database with a genuine schema-18 one.
  // The MANAGED path, not an invented one. An earlier version wrote its schema-18 fixture to
  // state/delegate-wave.db while the Dispatcher opens state/delegate-wave.sqlite, so the "runs
  // against a migrated database" test was quietly running against a fresh one and passing for the
  // wrong reason.
  const databasePath = managedPaths(root).database;
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${databasePath}${suffix}`, { force: true });
  const old = new DatabaseSync(databasePath);
  old.exec(SCHEMA_18);
  old.prepare("INSERT INTO metadata(key, value) VALUES ('schema_version', '18')").run();
  old.prepare("INSERT INTO metadata(key, value) VALUES ('scheduler_epoch', '0')").run();
  old.close();

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
  return { root, repo, databasePath, cleanup };
}

test("a schema-18 database gains every column schema 19 declares", async (t) => {
  const { root, databasePath, cleanup } = await fixture();
  t.after(async () => { await cleanup(); });

  const before = new DatabaseSync(databasePath);
  const beforeColumns = before.prepare("PRAGMA table_info(attempts)").all().map((c) => c.name);
  assert.equal(beforeColumns.includes("start_sha"), false, "the fixture must genuinely be schema 18");
  // And it must genuinely lack the constraints, or the equivalence test below proves nothing: a
  // fixture that already carried them would pass whether or not the rebuild ran at all.
  const beforeJobs = before.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'",
  ).get().sql;
  assert.equal(beforeJobs.includes("strategy"), false);
  assert.equal(beforeJobs.includes("max_attempts BETWEEN"), false);
  before.close();

  const db = openDatabase(databasePath);
  const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  for (const column of ["start_sha", "instruction_artifact", "instruction_digest", "result_text_artifact"]) {
    assert.ok(columns("attempts").includes(column), `attempts.${column} was not migrated`);
  }
  for (const column of ["expected_base_sha", "strategy"]) {
    assert.ok(columns("work_proposals").includes(column), `work_proposals.${column} was not migrated`);
  }
  for (const column of ["strategy", "parent_job_id", "internal_kind"]) {
    assert.ok(columns("jobs").includes(column), `jobs.${column} was not migrated`);
  }
  assert.ok(columns("manager_turns").includes("subject_attempt_id"));
  assert.ok(columns("manager_usage_receipts").includes("total_tokens"));

  // The rebuild actually ran: the migrated table now carries constraints ALTER TABLE cannot add.
  const afterJobs = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'",
  ).get().sql;
  assert.match(afterJobs, /strategy IN \('direct', 'managed'\)/);
  assert.match(afterJobs, /max_attempts BETWEEN 1 AND 10/);
  assert.match(afterJobs, /internal_kind IS NULL OR parent_job_id IS NOT NULL/);

  // The version is only honest if the objects match it.
  assert.equal(db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get().value, SCHEMA_VERSION);

  // Closed here rather than in an after-hook: hooks run last-registered-first, so an open handle
  // would hold the temp directory while the fixture tries to remove it.
  db.close();
});

// The states a schema-19 database must refuse. Column presence proves none of these: a table built
// by ALTER TABLE ADD COLUMN has the columns and none of the CHECKs, so it accepts every one.
const FORBIDDEN = [
  {
    what: "jobs.strategy outside its enumeration",
    sql: `INSERT INTO jobs(id, project_id, goal, mode, status, base_sha, max_attempts, strategy, created_at, updated_at)
          VALUES ('j1', ?, 'g', 'write', 'PENDING', 'abc', 2, 'nonsense', 't', 't')`,
  },
  {
    what: "jobs.internal_kind outside its enumeration",
    sql: `INSERT INTO jobs(id, project_id, goal, mode, status, base_sha, max_attempts, parent_job_id, internal_kind, created_at, updated_at)
          VALUES ('j2', ?, 'g', 'write', 'PENDING', 'abc', 2, 'root', 'SOMETHING_ELSE', 't', 't')`,
  },
  {
    what: "an internal job with no parent",
    sql: `INSERT INTO jobs(id, project_id, goal, mode, status, base_sha, max_attempts, internal_kind, created_at, updated_at)
          VALUES ('j3', ?, 'g', 'write', 'PENDING', 'abc', 2, 'MANAGER_EXPLORATION', 't', 't')`,
  },
  {
    what: "max_attempts outside its range",
    sql: `INSERT INTO jobs(id, project_id, goal, mode, status, base_sha, max_attempts, created_at, updated_at)
          VALUES ('j4', ?, 'g', 'write', 'PENDING', 'abc', 99, 't', 't')`,
  },
  {
    what: "a non-positive maximum_cost",
    sql: `INSERT INTO jobs(id, project_id, goal, mode, status, base_sha, max_attempts, maximum_cost, created_at, updated_at)
          VALUES ('j5', ?, 'g', 'write', 'PENDING', 'abc', 2, 0, 't', 't')`,
  },
  {
    what: "jobs.mode outside its enumeration",
    sql: `INSERT INTO jobs(id, project_id, goal, mode, status, base_sha, max_attempts, created_at, updated_at)
          VALUES ('j6', ?, 'g', 'sideways', 'PENDING', 'abc', 2, 't', 't')`,
  },
  {
    what: "work_proposals.strategy outside its enumeration",
    sql: `INSERT INTO work_proposals(id, project_id, goal, mode, action_digest, strategy, expires_at, idempotency_key, origin_principal, origin_channel, created_at)
          VALUES ('p1', ?, 'g', 'write', 'd', 'nonsense', 't', 'k1', 'h', 'c', 't')`,
  },
  {
    what: "work_proposals.mode outside its enumeration",
    sql: `INSERT INTO work_proposals(id, project_id, goal, mode, action_digest, strategy, expires_at, idempotency_key, origin_principal, origin_channel, created_at)
          VALUES ('p2', ?, 'g', 'sideways', 'd', 'direct', 't', 'k2', 'h', 'c', 't')`,
  },
];

function refusals(db, projectId) {
  return FORBIDDEN.map(({ what, sql }) => {
    try {
      db.prepare(sql).run(projectId);
      return { what, refused: false };
    } catch {
      return { what, refused: true };
    }
  });
}

test("a migrated database refuses exactly what a fresh one refuses", async (t) => {
  // The acceptance condition for P0-4 is behavioural, not structural. Two installations running the
  // same version number must not disagree about which states are legal, or an orchestration bug
  // becomes installation-specific and survives every fresh-root test in the suite.
  const migrated = await fixture();
  const fresh = await fixture();
  t.after(async () => { await migrated.cleanup(); await fresh.cleanup(); });

  const migratedDb = openDatabase(migrated.databasePath);
  // A fresh root that was never downgraded to schema 18.
  const freshRoot = path.join(fresh.root, "..", "fresh-data");
  initializeDataRoot(freshRoot);
  const freshDb = openDatabase(path.join(freshRoot, "state", "delegate-wave.db"));

  for (const db of [migratedDb, freshDb]) {
    db.prepare(`INSERT INTO projects(id, name, repo_path, integration_branch, created_at)
                VALUES ('proj', 'P', ?, 'main', 't')`).run(`repo-${Math.random()}`);
  }

  const migratedResults = refusals(migratedDb, "proj");
  const freshResults = refusals(freshDb, "proj");

  for (const [index, expected] of freshResults.entries()) {
    assert.equal(expected.refused, true, `fresh schema 19 must refuse ${expected.what}`);
    assert.equal(
      migratedResults[index].refused, true,
      `migrated schema 19 accepted ${expected.what}, which fresh schema 19 refuses`,
    );
  }

  migratedDb.close();
  freshDb.close();
  fs.rmSync(freshRoot, { recursive: true, force: true });
});

test("a rebuild preserves legacy rows and their references", async (t) => {
  const { root, repo, databasePath, cleanup } = await fixture();
  t.after(async () => { await cleanup(); });

  // Seed the schema-18 database with a legacy job and proposal before migrating.
  const old = new DatabaseSync(databasePath);
  old.prepare(`INSERT INTO projects(id, name, repo_path, integration_branch, created_at)
               VALUES ('proj', 'Legacy', ?, 'main', 't')`).run(repo);
  old.prepare(`INSERT INTO jobs(id, project_id, goal, mode, status, base_sha, max_attempts, created_at, updated_at)
               VALUES ('legacy-job', 'proj', 'old work', 'write', 'SUCCEEDED', 'deadbeef', 2, 't1', 't2')`).run();
  old.prepare(`INSERT INTO attempts(id, job_id, ordinal, scheduler_epoch, backend, started_at)
               VALUES ('legacy-job.1', 'legacy-job', 1, 3, 'FakeBackend', 't')`).run();
  old.prepare(`INSERT INTO work_proposals(id, project_id, goal, mode, action_digest, expires_at, idempotency_key, origin_principal, origin_channel, created_at)
               VALUES ('legacy-prop', 'proj', 'old proposal', 'write', 'digest', 't', 'k', 'hermes', 'mcp', 't')`).run();
  old.close();

  const db = openDatabase(databasePath);

  const job = db.prepare("SELECT * FROM jobs WHERE id = 'legacy-job'").get();
  assert.equal(job.goal, "old work", "the rebuild must not transpose columns");
  assert.equal(job.base_sha, "deadbeef");
  assert.equal(job.max_attempts, 2);
  assert.equal(job.strategy, "direct", "a job that predates strategy really was direct");
  assert.equal(job.parent_job_id, null);

  const proposal = db.prepare("SELECT * FROM work_proposals WHERE id = 'legacy-prop'").get();
  assert.equal(proposal.goal, "old proposal");
  assert.equal(proposal.strategy, "direct");
  assert.equal(proposal.expected_base_sha, null, "it genuinely was not bound to a head");

  // The attempt still points at its job across the table swap.
  const attempt = db.prepare("SELECT * FROM attempts WHERE id = 'legacy-job.1'").get();
  assert.equal(attempt.job_id, "legacy-job");
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);

  // Immutability triggers survived the rebuild rather than being dropped with the old table.
  assert.throws(
    () => db.prepare("UPDATE work_proposals SET goal = 'edited' WHERE id = 'legacy-prop'").run(),
    /immutable/,
  );

  db.close();
});

test("a direct attempt runs against a migrated database", async (t) => {
  // The assertion that would actually have failed. Column presence is checkable by inspection; that
  // runJob's INSERT succeeds is the property an installation cares about.
  const { root, repo, cleanup } = await fixture();
  const backend = new FakeBackend(async ({ worktreePath }) => {
    fs.writeFileSync(path.join(worktreePath, "out.txt"), "done\n");
    return { exitCode: 0, stdout: "ok", stderr: "" };
  });
  const service = new Dispatcher({ root, backend });
  t.after(async () => { service.close(); await cleanup(); });

  const project = await service.addProject({ name: "Migrated", repoPath: repo, validation: [] });
  const job = await service.createJob({ projectId: project.id, goal: "write a file" });
  const status = await service.runJob(job.id);

  assert.equal(status.job.status, "READY_FOR_INTEGRATION");
  const attempt = status.attempts.at(-1);
  assert.ok(attempt.start_sha, "the migrated column is written, not merely present");
  assert.ok(attempt.instruction_digest);
  assert.ok(fs.existsSync(attempt.instruction_artifact));

  // Pre-existing rows keep NULL rather than a fabricated value: those attempts really were given the
  // goal as their instruction, but no artifact of it was ever written.
  const legacy = service.db.prepare(
    "SELECT COUNT(*) AS count FROM attempts WHERE instruction_digest IS NULL",
  ).get().count;
  assert.equal(legacy, 0, "this database had no prior attempts, so none should be null");
});
