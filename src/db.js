import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { managedPaths } from "./paths.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repo_path TEXT NOT NULL UNIQUE,
  integration_branch TEXT NOT NULL,
  validation_json TEXT NOT NULL DEFAULT '[]',
  protected_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  goal TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('read', 'write')),
  status TEXT NOT NULL CHECK (status IN (
    'PENDING', 'RUNNING', 'READY_FOR_INTEGRATION', 'SUCCEEDED',
    'FAILED', 'CANCELLED', 'NEEDS_ATTENTION'
  )),
  base_sha TEXT NOT NULL,
  max_attempts INTEGER NOT NULL DEFAULT 2 CHECK (max_attempts BETWEEN 1 AND 10),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  ordinal INTEGER NOT NULL,
  scheduler_epoch INTEGER NOT NULL,
  terminal_state TEXT CHECK (terminal_state IS NULL OR terminal_state IN (
    'SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED', 'ORPHANED'
  )),
  validation_state TEXT NOT NULL DEFAULT 'NOT_RUN' CHECK (validation_state IN (
    'NOT_RUN', 'PENDING', 'PASSED', 'FAILED'
  )),
  backend TEXT NOT NULL,
  model TEXT,
  scheduler_pid INTEGER,
  executor_intent_id TEXT,
  executor_pid INTEGER,
  validation_intent_id TEXT,
  validation_pid INTEGER,
  worktree_path TEXT,
  worktree_locked INTEGER NOT NULL DEFAULT 0,
  quarantined INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  exit_code INTEGER,
  result_commit TEXT,
  failure_signature TEXT,
  UNIQUE(job_id, ordinal)
);

CREATE TABLE IF NOT EXISTS validation_runs (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  command TEXT NOT NULL,
  exit_code INTEGER NOT NULL,
  output_path TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  scheduler_epoch INTEGER,
  payload_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS integration_proposals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  job_id TEXT NOT NULL REFERENCES jobs(id),
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  base_sha TEXT NOT NULL,
  candidate_commit TEXT NOT NULL,
  integration_branch TEXT NOT NULL,
  expected_integration_head TEXT NOT NULL,
  validation_plan_digest TEXT NOT NULL,
  action_digest TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN', 'INTEGRATED', 'CANCELLED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(attempt_id)
);

CREATE TABLE IF NOT EXISTS approval_receipts (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES integration_proposals(id),
  principal TEXT NOT NULL,
  origin TEXT NOT NULL,
  expires_at TEXT,
  idempotency_key TEXT UNIQUE,
  granted_digest TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0 CHECK (consumed IN (0, 1)),
  consumed_at TEXT
);

CREATE TABLE IF NOT EXISTS integration_operations (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES integration_proposals(id),
  approval_receipt_id TEXT NOT NULL REFERENCES approval_receipts(id),
  state TEXT NOT NULL CHECK (state IN ('INTENDED', 'SUCCEEDED', 'FAILED')),
  worktree_path TEXT,
  expected_integration_head TEXT NOT NULL,
  new_head TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS integration_records (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL REFERENCES integration_operations(id),
  proposal_id TEXT NOT NULL REFERENCES integration_proposals(id),
  kind TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_attempts_job ON attempts(job_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity_type, entity_id, sequence);
CREATE INDEX IF NOT EXISTS idx_proposals_job ON integration_proposals(job_id);
CREATE INDEX IF NOT EXISTS idx_proposals_state ON integration_proposals(state);
CREATE INDEX IF NOT EXISTS idx_approvals_proposal ON approval_receipts(proposal_id, consumed);
CREATE INDEX IF NOT EXISTS idx_ops_proposal ON integration_operations(proposal_id, state);
CREATE INDEX IF NOT EXISTS idx_records_operation ON integration_records(operation_id, sequence);
`;

export function initializeDataRoot(root) {
  const paths = managedPaths(root);
  for (const directory of [
    paths.config,
    paths.state,
    paths.worktrees,
    paths.integration,
    paths.artifacts,
    path.join(paths.logs, "scheduler"),
    path.join(paths.logs, "backends"),
    path.join(paths.logs, "audit"),
    paths.cache,
    paths.tmp,
    path.join(paths.backups, "database"),
    path.join(paths.backups, "policy"),
    path.join(paths.backups, "manifests"),
  ]) fs.mkdirSync(directory, { recursive: true });

  const db = openDatabase(paths.database);
  db.close();
  return paths;
}

export function openDatabase(filename) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  migrate(db);
  const now = new Date().toISOString();
  db.prepare("INSERT OR IGNORE INTO metadata(key, value) VALUES ('schema_version', '6')").run();
  db.prepare("INSERT OR IGNORE INTO metadata(key, value) VALUES ('scheduler_epoch', '0')").run();
  db.prepare("INSERT OR IGNORE INTO metadata(key, value) VALUES ('created_at', ?)").run(now);
  return db;
}

function migrate(db) {
  const attemptColumns = db.prepare("PRAGMA table_info(attempts)").all().map((column) => column.name);
  if (!attemptColumns.includes("validation_state")) {
    db.exec("ALTER TABLE attempts ADD COLUMN validation_state TEXT NOT NULL DEFAULT 'NOT_RUN'");
  }
  if (!attemptColumns.includes("executor_pid")) {
    db.exec("ALTER TABLE attempts ADD COLUMN executor_pid INTEGER");
  }
  if (!attemptColumns.includes("scheduler_pid")) {
    db.exec("ALTER TABLE attempts ADD COLUMN scheduler_pid INTEGER");
  }
  if (!attemptColumns.includes("validation_pid")) {
    db.exec("ALTER TABLE attempts ADD COLUMN validation_pid INTEGER");
  }
  if (!attemptColumns.includes("validation_intent_id")) {
    db.exec("ALTER TABLE attempts ADD COLUMN validation_intent_id TEXT");
  }
  if (!attemptColumns.includes("executor_intent_id")) {
    db.exec("ALTER TABLE attempts ADD COLUMN executor_intent_id TEXT");
  }
  db.prepare("UPDATE metadata SET value = '6' WHERE key = 'schema_version'").run();
}

export function transaction(db, action) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function nextSchedulerEpoch(db) {
  return transaction(db, () => {
    const current = Number(db.prepare("SELECT value FROM metadata WHERE key = 'scheduler_epoch'").get().value);
    const next = current + 1;
    db.prepare("UPDATE metadata SET value = ? WHERE key = 'scheduler_epoch'").run(String(next));
    return next;
  });
}

export function recordEvent(db, { kind, entityType, entityId, epoch = null, payload = {} }) {
  db.prepare(`INSERT INTO events(
    occurred_at, kind, entity_type, entity_id, scheduler_epoch, payload_json
  ) VALUES (?, ?, ?, ?, ?, ?)`).run(
    new Date().toISOString(), kind, entityType, entityId, epoch, JSON.stringify(payload),
  );
}
