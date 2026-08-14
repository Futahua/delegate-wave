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
  validation_plan_json TEXT NOT NULL,
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
  expected_state_version TEXT NOT NULL,
  granted_scope TEXT NOT NULL,
  maximum_cost REAL,
  granted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS integration_operations (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES integration_proposals(id),
  approval_receipt_id TEXT NOT NULL REFERENCES approval_receipts(id),
  action_digest TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  candidate_commit TEXT NOT NULL,
  integration_branch TEXT NOT NULL,
  expected_integration_head TEXT NOT NULL,
  validation_plan_digest TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'INTENDED' CHECK (state = 'INTENDED'),
  worktree_path TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS integration_records (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL REFERENCES integration_operations(id),
  proposal_id TEXT NOT NULL REFERENCES integration_proposals(id),
  kind TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS control_request_intents (
  request_id TEXT PRIMARY KEY,
  command TEXT NOT NULL,
  args_digest TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  origin_channel TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS control_request_results (
  request_id TEXT PRIMARY KEY REFERENCES control_request_intents(request_id),
  outcome TEXT NOT NULL CHECK (outcome IN ('SUCCEEDED', 'FAILED')),
  response_json TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS trg_proposals_immutable_update
BEFORE UPDATE ON integration_proposals
BEGIN SELECT RAISE(ABORT, 'integration_proposals is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_proposals_immutable_delete
BEFORE DELETE ON integration_proposals
BEGIN SELECT RAISE(ABORT, 'integration_proposals is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_approvals_immutable_update
BEFORE UPDATE ON approval_receipts
BEGIN SELECT RAISE(ABORT, 'approval_receipts is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_approvals_immutable_delete
BEFORE DELETE ON approval_receipts
BEGIN SELECT RAISE(ABORT, 'approval_receipts is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_operations_immutable_update
BEFORE UPDATE ON integration_operations
BEGIN SELECT RAISE(ABORT, 'integration_operations is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_operations_immutable_delete
BEFORE DELETE ON integration_operations
BEGIN SELECT RAISE(ABORT, 'integration_operations is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_records_immutable_update
BEFORE UPDATE ON integration_records
BEGIN SELECT RAISE(ABORT, 'integration_records is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_records_immutable_delete
BEFORE DELETE ON integration_records
BEGIN SELECT RAISE(ABORT, 'integration_records is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_control_intents_immutable_update
BEFORE UPDATE ON control_request_intents
BEGIN SELECT RAISE(ABORT, 'control_request_intents is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_control_intents_immutable_delete
BEFORE DELETE ON control_request_intents
BEGIN SELECT RAISE(ABORT, 'control_request_intents is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_control_results_immutable_update
BEFORE UPDATE ON control_request_results
BEGIN SELECT RAISE(ABORT, 'control_request_results is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_control_results_immutable_delete
BEFORE DELETE ON control_request_results
BEGIN SELECT RAISE(ABORT, 'control_request_results is immutable'); END;

CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_attempts_job ON attempts(job_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity_type, entity_id, sequence);
CREATE INDEX IF NOT EXISTS idx_proposals_job ON integration_proposals(job_id);
CREATE INDEX IF NOT EXISTS idx_proposals_state ON integration_proposals(state);
CREATE INDEX IF NOT EXISTS idx_approvals_proposal ON approval_receipts(proposal_id);
CREATE INDEX IF NOT EXISTS idx_ops_proposal ON integration_operations(proposal_id, state);
CREATE INDEX IF NOT EXISTS idx_records_operation ON integration_records(operation_id, sequence);
CREATE INDEX IF NOT EXISTS idx_control_intents_created ON control_request_intents(created_at);
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
  db.prepare("INSERT OR IGNORE INTO metadata(key, value) VALUES ('schema_version', '9')").run();
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
  const proposalColumns = db.prepare("PRAGMA table_info(integration_proposals)").all().map((column) => column.name);
  if (!proposalColumns.includes("validation_plan_json")) {
    db.exec("ALTER TABLE integration_proposals ADD COLUMN validation_plan_json TEXT NOT NULL DEFAULT '[]'");
  }
  const approvalColumns = db.prepare("PRAGMA table_info(approval_receipts)").all().map((column) => column.name);
  if (approvalColumns.includes("consumed") || approvalColumns.includes("consumed_at")) {
    db.exec("DROP INDEX IF EXISTS idx_approvals_proposal");
    if (approvalColumns.includes("consumed")) db.exec("ALTER TABLE approval_receipts DROP COLUMN consumed");
    if (approvalColumns.includes("consumed_at")) db.exec("ALTER TABLE approval_receipts DROP COLUMN consumed_at");
    db.exec("CREATE INDEX IF NOT EXISTS idx_approvals_proposal ON approval_receipts(proposal_id)");
  }
  if (!approvalColumns.includes("expected_state_version")) {
    db.exec("ALTER TABLE approval_receipts ADD COLUMN expected_state_version TEXT NOT NULL DEFAULT ''");
  }
  if (!approvalColumns.includes("granted_scope")) {
    db.exec("ALTER TABLE approval_receipts ADD COLUMN granted_scope TEXT NOT NULL DEFAULT 'integration'");
  }
  if (!approvalColumns.includes("maximum_cost")) {
    db.exec("ALTER TABLE approval_receipts ADD COLUMN maximum_cost REAL");
  }
  const operationColumns = db.prepare("PRAGMA table_info(integration_operations)").all().map((column) => column.name);
  for (const column of ["action_digest", "base_sha", "candidate_commit", "integration_branch", "validation_plan_digest"]) {
    if (!operationColumns.includes(column)) {
      db.exec(`ALTER TABLE integration_operations ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
    }
  }
  db.prepare("UPDATE metadata SET value = '9' WHERE key = 'schema_version'").run();
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
