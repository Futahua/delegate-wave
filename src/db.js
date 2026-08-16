import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { managedPaths } from "./paths.js";

// Bump whenever the normative durable schema changes, so a database cannot advertise a version that
// does not describe its actual objects. Single constant: creation and migration must never drift.
// 10: work_proposals and work_proposal_decisions, with their immutability triggers and indexes.
// 11: attempt_usage_receipts, the normalized executor usage/cost evidence projection.
// 12: usage receipts record cost provenance and enforce their value invariants.
// 13: durable cancellation intents and results.
// 14: jobs carry a pre-attempt worker budget gate.
// 15: integration rollbacks are a first-class recorded outcome.
// 19: the semantic layer. Jobs carry a strategy and a parent; attempts record the exact instruction
//     they were given and the tree they started from; manager runs, turns and usage receipts give
//     scarce-model activity its own ledger; work proposals bind to the repository head they were
//     written against.
export const SCHEMA_VERSION = "19";

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
  -- When the operator stopped tracking this project. Retirement is not deletion: every job, attempt,
  -- cost receipt and integration record it owns stays exactly where it is, because that history is
  -- the point of the database. Retiring only removes it from the everyday surface and from health
  -- checks, so a repository you no longer keep cannot make the system look permanently broken.
  retired_at TEXT,
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
  -- A recorded ceiling in reference dollars. NULL means no ceiling; a value is enforced before each
  -- attempt starts, and unaccounted spend blocks rather than passes.
  maximum_cost REAL CHECK (maximum_cost IS NULL OR maximum_cost > 0),
  -- An explicit request for a narrower worker: a task run against something untrusted, or an
  -- experiment with hidden verifiers. Null means the system default, which is broad.
  capability_profile TEXT,
  -- How this job reaches a candidate. 'direct' is the original path: one authorization, one worker,
  -- the goal as its instruction. 'managed' hands the job to a strong manager that plans, delegates,
  -- reviews and revises. Both paths use the same attempt machinery and the same integration gate;
  -- only who writes the worker's instruction differs.
  strategy TEXT NOT NULL DEFAULT 'direct' CHECK (strategy IN ('direct', 'managed')),
  -- Set on jobs the manager created for itself. A child is real work with real cost and real
  -- evidence -- it is deliberately NOT a private side channel -- but it belongs to its parent's
  -- accounting rather than to the operator's queue.
  parent_job_id TEXT REFERENCES jobs(id),
  internal_kind TEXT CHECK (internal_kind IS NULL OR internal_kind IN ('MANAGER_EXPLORATION')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- An internal job without a parent would be invisible with nothing to be visible under.
  CHECK (internal_kind IS NULL OR parent_job_id IS NOT NULL)
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
  -- Under what authority this worker ran. Recorded because "what the worker could do" is a
  -- selectable policy: reading an attempt's evidence later must not require guessing which one
  -- was in force.
  capability_profile TEXT,
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
  -- What this attempt actually changed, relative to the recorded base. Captured because it is the
  -- attempt's own evidence and it is already computed during candidate capture; keeping it lets the
  -- everyday surface say "3 files changed" without recomputing a diff, and lets a person ask which.
  changed_files_json TEXT,
  failure_signature TEXT,
  -- The tree this attempt's worktree was created from.
  --
  -- Distinct from jobs.base_sha, and the distinction is the whole point of managed revision: a
  -- revising worker starts from the previous candidate so it corrects an implementation rather than
  -- rewriting one from nothing, while candidate capture still measures the result against the
  -- AUTHORIZED base. Without this column those two would have to be the same commit, and a revision
  -- would either lose the prior work or produce a candidate that is not a complete net change from
  -- what the operator authorized.
  start_sha TEXT,
  -- The exact text this worker was given, and its identity.
  --
  -- Stored as an artifact path plus a digest rather than inline: instructions carry whole evidence
  -- packs and SQLite is the operational ledger, not a document store. The digest is what makes
  -- "attempt 2 was told something different from attempt 1" a fact rather than a claim.
  instruction_artifact TEXT,
  instruction_digest TEXT,
  -- What the worker said it did, as an immutable artifact. The candidate is what it actually did;
  -- this is testimony, and the reviewer needs both to notice when they disagree.
  result_text_artifact TEXT,
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

-- Bounded work proposed in ordinary language by a non-operator principal. A proposal is a request,
-- never authority: only an operator-authorized transition turns one into a job.
CREATE TABLE IF NOT EXISTS work_proposals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  goal TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('read', 'write')),
  action_digest TEXT NOT NULL,
  expected_state_version TEXT,
  -- The integration head this proposal was written against.
  --
  -- expected_state_version alone hashes delegate-wave's own job rows, which says nothing about the
  -- code. A proposal reasoned about repository version A could be authorized against version B with
  -- the state version unchanged, and authorization resolves the branch head fresh -- so the system
  -- would report that the world matched while the only world that matters had moved.
  expected_base_sha TEXT,
  strategy TEXT NOT NULL DEFAULT 'direct' CHECK (strategy IN ('direct', 'managed')),
  maximum_cost REAL,
  expires_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  origin_principal TEXT NOT NULL,
  origin_channel TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Terminal decisions on a work proposal. Separate table so proposals stay immutable and every
-- decision keeps its own authorizing identity.
CREATE TABLE IF NOT EXISTS work_proposal_decisions (
  proposal_id TEXT PRIMARY KEY REFERENCES work_proposals(id),
  decision TEXT NOT NULL CHECK (decision IN ('AUTHORIZED', 'REJECTED')),
  job_id TEXT REFERENCES jobs(id),
  decided_by TEXT NOT NULL,
  decided_origin TEXT NOT NULL,
  action_digest TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- A durable cancellation intent. Recorded before anything is killed, so a crash between the request
-- and its effect leaves evidence that cancellation was asked for rather than losing it.
--
-- Cancellation is a request, not an outcome: the job's terminal state still comes from the normal
-- lifecycle, and a worker that finished before the kill landed is not retroactively unfinished.
CREATE TABLE IF NOT EXISTS cancellation_intents (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  attempt_id TEXT REFERENCES attempts(id),
  scheduler_epoch INTEGER NOT NULL,
  requested_by TEXT NOT NULL,
  requested_origin TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- The terminal record of what a cancellation actually achieved. Separate from the intent because the
-- intent is immutable evidence of the request, while the outcome is discovered afterwards.
CREATE TABLE IF NOT EXISTS cancellation_results (
  intent_id TEXT PRIMARY KEY REFERENCES cancellation_intents(id),
  -- CLOSED means the job was open but nothing was running: it was ended by decision rather than
  -- by killing a process. Distinct from CANCELLED so a receipt never implies a kill that did not
  -- happen, and from NOTHING_RUNNING, which changed no state at all.
  outcome TEXT NOT NULL CHECK (outcome IN ('CANCELLED', 'CLOSED', 'ALREADY_TERMINAL', 'NOTHING_RUNNING')),
  killed_pid INTEGER,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS trg_cancel_intents_immutable_update
BEFORE UPDATE ON cancellation_intents
BEGIN SELECT RAISE(ABORT, 'cancellation_intents is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_cancel_intents_immutable_delete
BEFORE DELETE ON cancellation_intents
BEGIN SELECT RAISE(ABORT, 'cancellation_intents is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_cancel_results_immutable_update
BEFORE UPDATE ON cancellation_results
BEGIN SELECT RAISE(ABORT, 'cancellation_results is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_cancel_results_immutable_delete
BEFORE DELETE ON cancellation_results
BEGIN SELECT RAISE(ABORT, 'cancellation_results is immutable'); END;

-- One immutable receipt per executor run, describing what was observed of its provider usage.
-- Deliberately separate from the attempts table: an attempt's lifecycle changes over time, while a
-- receipt records one observation and never changes. Evidence only; MUST NOT influence acceptance.
--
-- status distinguishes three genuinely different situations:
--   COMPLETE  a full accounting receipt was observed (including an explicit zero-usage receipt)
--   PARTIAL   some usage was observed but the accounting is known to be incomplete
--   UNKNOWN   no usage receipt was observed at all
-- Numeric columns are NULL under UNKNOWN. A missing receipt must never be recorded as zero, or
-- failed work appears free in cost per validated candidate.
-- A rollback is a first-class terminal outcome, not an event footnote. Current integration state is
-- derived from these rows, so the product cannot keep reporting a removed change as Done.
--
-- Recorded AFTER the branch actually moved. A crash between the compare-and-swap and this row leaves
-- the branch moved with no receipt, which reconciliation detects and resolves.
CREATE TABLE IF NOT EXISTS integration_rollbacks (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES integration_proposals(id),
  integration_branch TEXT NOT NULL,
  from_sha TEXT NOT NULL,
  to_sha TEXT NOT NULL,
  rolled_back_by TEXT NOT NULL,
  rolled_back_origin TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS trg_rollbacks_immutable_update
BEFORE UPDATE ON integration_rollbacks
BEGIN SELECT RAISE(ABORT, 'integration_rollbacks is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_rollbacks_immutable_delete
BEFORE DELETE ON integration_rollbacks
BEGIN SELECT RAISE(ABORT, 'integration_rollbacks is immutable'); END;

CREATE TABLE IF NOT EXISTS attempt_usage_receipts (
  attempt_id TEXT PRIMARY KEY REFERENCES attempts(id),
  status TEXT NOT NULL CHECK (status IN ('COMPLETE', 'PARTIAL', 'UNKNOWN')),
  input_tokens INTEGER,
  output_tokens INTEGER,
  reasoning_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  provider_steps INTEGER NOT NULL,
  reported_cost_usd REAL,
  reported_cost_source TEXT,
  reference_cost_usd REAL,
  pricing_basis_id TEXT,
  source_backend TEXT NOT NULL,
  source_artifact TEXT,
  source_format TEXT NOT NULL,
  malformed_events INTEGER NOT NULL DEFAULT 0,
  observed_at TEXT NOT NULL,
  -- An UNKNOWN receipt carries no numbers at all: no tokens, no steps, and no cost of either kind.
  -- malformed_events may still be nonzero, because an unreadable artifact is itself evidence that
  -- malformed accounting existed even though no usable usage did.
  CHECK (status != 'UNKNOWN' OR (
    input_tokens IS NULL AND output_tokens IS NULL AND reasoning_tokens IS NULL
    AND cache_read_tokens IS NULL AND cache_write_tokens IS NULL
    AND provider_steps = 0
    AND reported_cost_usd IS NULL AND reported_cost_source IS NULL
    AND reference_cost_usd IS NULL AND pricing_basis_id IS NULL
  )),
  -- A COMPLETE or PARTIAL receipt observed at least one usable step and every token dimension.
  CHECK (status = 'UNKNOWN' OR (
    input_tokens >= 0 AND output_tokens >= 0 AND reasoning_tokens >= 0
    AND cache_read_tokens >= 0 AND cache_write_tokens >= 0
    AND provider_steps >= 1
  )),
  CHECK (reported_cost_usd IS NULL OR reported_cost_usd >= 0),
  CHECK (reference_cost_usd IS NULL OR reference_cost_usd >= 0),
  CHECK (malformed_events >= 0)
);

CREATE TRIGGER IF NOT EXISTS trg_usage_receipts_immutable_update
BEFORE UPDATE ON attempt_usage_receipts
BEGIN SELECT RAISE(ABORT, 'attempt_usage_receipts is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_usage_receipts_immutable_delete
BEFORE DELETE ON attempt_usage_receipts
BEGIN SELECT RAISE(ABORT, 'attempt_usage_receipts is immutable'); END;

-- One strong-manager run per managed job.
--
-- Mutable on purpose, unlike almost everything else here: this is the run's live position in its
-- state machine, and it is the row a reboot reads to discover where it was. The immutable history of
-- what the manager actually did lives in manager_turns and in events.
--
-- The round counters are the bounded-authority invariant. Token accounting depends on what a
-- provider chooses to report; a turn ceiling does not, so the scarce resource stays bounded even
-- when its usage is UNKNOWN.
CREATE TABLE IF NOT EXISTS manager_runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
  status TEXT NOT NULL CHECK (status IN (
    'PLANNING', 'EXPLORING', 'IMPLEMENTING', 'REVIEWING',
    'ACCEPTED', 'AWAITING_HUMAN', 'FAILED', 'CANCELLED'
  )),
  model TEXT,
  -- The manager's conversation identity with its provider. One managed job is one thread, so the
  -- manager's own context is the provider's problem rather than something reassembled per turn.
  thread_id TEXT,
  exploration_round INTEGER NOT NULL DEFAULT 0,
  revision_round INTEGER NOT NULL DEFAULT 0,
  max_exploration_rounds INTEGER NOT NULL,
  max_revision_rounds INTEGER NOT NULL,
  max_turns INTEGER NOT NULL,
  -- The child job currently carrying this run forward, if any.
  active_child_job_id TEXT REFERENCES jobs(id),
  last_candidate_attempt_id TEXT REFERENCES attempts(id),
  -- Set when the manager escalated: the question a person actually has to answer.
  escalation_question TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One row per scarce-model call, recorded BEFORE the call is made.
--
-- Intent and result are separate states of the same row for the reason the Control API already
-- established: a process that dies after an expensive call but before its response is durable must
-- leave evidence that the call happened. Re-asking would be a second scarce call to answer a
-- question that may already have been answered and paid for, which is precisely the resource this
-- system exists to conserve.
CREATE TABLE IF NOT EXISTS manager_turns (
  id TEXT PRIMARY KEY,
  manager_run_id TEXT NOT NULL REFERENCES manager_runs(id),
  ordinal INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('PLAN', 'SYNTHESIS', 'REVIEW')),
  state TEXT NOT NULL CHECK (state IN ('INTENDED', 'RUNNING', 'COMPLETED', 'FAILED', 'UNCERTAIN')),
  model TEXT,
  prompt_artifact TEXT,
  response_artifact TEXT,
  response_digest TEXT,
  -- The parsed decision, small enough to live inline and the thing every later turn reads back.
  action TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE(manager_run_id, ordinal)
);

-- One immutable usage observation per manager turn.
--
-- Deliberately NOT attempt_usage_receipts. That table means one executor attempt, one observation,
-- and widening it to cover a different kind of actor would make "cheap worker cost" and "scarce
-- manager cost" indistinguishable in exactly the query the whole project is optimizing.
--
-- No reference_cost_usd column: the pricing bases price cheap-worker models against a common basis
-- so two executors can be compared. A subscription-plan manager has no marginal token price, and
-- inventing one would be the same fabrication the executor receipts refuse to make. Tokens and turns
-- are what can honestly be reported, so tokens and turns are what is stored.
CREATE TABLE IF NOT EXISTS manager_usage_receipts (
  manager_turn_id TEXT PRIMARY KEY REFERENCES manager_turns(id),
  status TEXT NOT NULL CHECK (status IN ('COMPLETE', 'PARTIAL', 'UNKNOWN')),
  input_tokens INTEGER,
  output_tokens INTEGER,
  reasoning_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  source TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  -- An UNKNOWN receipt carries no numbers. A manager whose provider reported nothing has unknown
  -- cost, not zero cost, and the difference is the entire point of measuring the scarce side.
  CHECK (status != 'UNKNOWN' OR (
    input_tokens IS NULL AND output_tokens IS NULL AND reasoning_tokens IS NULL
    AND cache_read_tokens IS NULL AND cache_write_tokens IS NULL
  )),
  CHECK (status = 'UNKNOWN' OR (input_tokens >= 0 AND output_tokens >= 0))
);

CREATE TRIGGER IF NOT EXISTS trg_manager_usage_immutable_update
BEFORE UPDATE ON manager_usage_receipts
BEGIN SELECT RAISE(ABORT, 'manager_usage_receipts is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_manager_usage_immutable_delete
BEFORE DELETE ON manager_usage_receipts
BEGIN SELECT RAISE(ABORT, 'manager_usage_receipts is immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_work_proposals_immutable_update
BEFORE UPDATE ON work_proposals
BEGIN SELECT RAISE(ABORT, 'work_proposals is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_work_proposals_immutable_delete
BEFORE DELETE ON work_proposals
BEGIN SELECT RAISE(ABORT, 'work_proposals is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_work_decisions_immutable_update
BEFORE UPDATE ON work_proposal_decisions
BEGIN SELECT RAISE(ABORT, 'work_proposal_decisions is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_work_decisions_immutable_delete
BEFORE DELETE ON work_proposal_decisions
BEGIN SELECT RAISE(ABORT, 'work_proposal_decisions is immutable'); END;

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
CREATE INDEX IF NOT EXISTS idx_work_proposals_project ON work_proposals(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_work_decisions_job ON work_proposal_decisions(job_id);
CREATE INDEX IF NOT EXISTS idx_cancel_intents_job ON cancellation_intents(job_id, created_at);
CREATE INDEX IF NOT EXISTS idx_rollbacks_proposal ON integration_rollbacks(proposal_id, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_parent ON jobs(parent_job_id);
CREATE INDEX IF NOT EXISTS idx_manager_turns_run ON manager_turns(manager_run_id, ordinal);
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
  db.prepare("INSERT OR IGNORE INTO metadata(key, value) VALUES ('schema_version', ?)").run(SCHEMA_VERSION);
  db.prepare("INSERT OR IGNORE INTO metadata(key, value) VALUES ('scheduler_epoch', '0')").run();
  db.prepare("INSERT OR IGNORE INTO metadata(key, value) VALUES ('created_at', ?)").run(now);
  return db;
}

function migrate(db) {
  // The cancellation_results CHECK predates the CLOSED outcome. SQLite cannot alter a CHECK in
  // place, so the table is rebuilt and every recorded receipt copied across -- these rows are
  // immutable evidence, and losing them to a schema change would be exactly the wrong trade.
  const cancelCheck = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'cancellation_results'",
  ).get()?.sql ?? "";
  if (cancelCheck && !cancelCheck.includes("'CLOSED'")) {
    db.exec(`
      DROP TRIGGER IF EXISTS trg_cancel_results_immutable_update;
      DROP TRIGGER IF EXISTS trg_cancel_results_immutable_delete;
      CREATE TABLE cancellation_results_rebuilt (
        intent_id TEXT PRIMARY KEY REFERENCES cancellation_intents(id),
        outcome TEXT NOT NULL CHECK (outcome IN ('CANCELLED', 'CLOSED', 'ALREADY_TERMINAL', 'NOTHING_RUNNING')),
        killed_pid INTEGER,
        detail TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      INSERT INTO cancellation_results_rebuilt SELECT * FROM cancellation_results;
      DROP TABLE cancellation_results;
      ALTER TABLE cancellation_results_rebuilt RENAME TO cancellation_results;
    `);
  }
  const projectColumns = db.prepare("PRAGMA table_info(projects)").all().map((column) => column.name);
  if (!projectColumns.includes("retired_at")) {
    db.exec("ALTER TABLE projects ADD COLUMN retired_at TEXT");
  }
  const jobColumns = db.prepare("PRAGMA table_info(jobs)").all().map((column) => column.name);
  if (!jobColumns.includes("maximum_cost")) {
    db.exec("ALTER TABLE jobs ADD COLUMN maximum_cost REAL");
  }
  if (!jobColumns.includes("capability_profile")) {
    db.exec("ALTER TABLE jobs ADD COLUMN capability_profile TEXT");
  }
  // Every job that predates the semantic layer really was a direct job: one worker, the goal as its
  // instruction. Defaulting them to `direct` records history rather than rewriting it.
  if (!jobColumns.includes("strategy")) {
    db.exec("ALTER TABLE jobs ADD COLUMN strategy TEXT NOT NULL DEFAULT 'direct'");
  }
  if (!jobColumns.includes("parent_job_id")) {
    db.exec("ALTER TABLE jobs ADD COLUMN parent_job_id TEXT REFERENCES jobs(id)");
  }
  if (!jobColumns.includes("internal_kind")) {
    db.exec("ALTER TABLE jobs ADD COLUMN internal_kind TEXT");
  }
  const attemptColumns = db.prepare("PRAGMA table_info(attempts)").all().map((column) => column.name);
  if (!attemptColumns.includes("changed_files_json")) {
    // Null for attempts that predate the column: they genuinely have no record, and inventing an
    // empty list would claim they changed nothing.
    db.exec("ALTER TABLE attempts ADD COLUMN changed_files_json TEXT");
  }
  if (!attemptColumns.includes("capability_profile")) {
    // Left null for attempts that predate capability profiles: they ran under the single fixed
    // contract, and inventing a label for them would misreport history.
    db.exec("ALTER TABLE attempts ADD COLUMN capability_profile TEXT");
  }
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
  db.prepare("UPDATE metadata SET value = ? WHERE key = 'schema_version'").run(SCHEMA_VERSION);
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
