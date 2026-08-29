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
// 20: a managed root becomes integration-ready only when a REVIEW turn accepted one exact attempt,
//     and manager_runs records which one.
// 22: attempt_runtime_provenance separates what was requested, what the executor can prove it
//     applied, and what the runtime independently observed.
// 21: attempts hold a durable budget reservation, so admission is atomic under concurrency, and
//     scheduler_epoch means the scheduler GENERATION rather than a per-attempt sequence.
// 33: session_watches and wake_outbox. A finished or blocked session becomes something someone is
//     waiting to be told, and every delivery attempt carries the evidence that decides whether it
//     may be retried.
// 34: a wake in flight names the process driving it, so it can only be taken away from an owner
//     proven dead rather than from one that has merely been slow.
// 35: routed wakes have their own ENQUEUED state and receiver observations; legacy SUBMITTED rows
//     remain explicit recovery history rather than being reinterpreted as inbox events.
// 36: receiver_protocol distinguishes pre-metadata routed wakes from newly created typed wakes, so
//     an in-flight schema-35 handoff remains adoptable across upgrade without weakening new events.
export const SCHEMA_VERSION = "36";

// Column bodies shared by table creation and table REBUILD.
//
// `ALTER TABLE ADD COLUMN` cannot add a table-level CHECK, so migrating an old database by adding
// columns produces a table that accepts states the fresh one rejects. Two installations then run
// the same version number with different invariants, and every fresh-root test passes on both.
//
// The only durable fix is one source of DDL text. These constants are interpolated into `CREATE
// TABLE IF NOT EXISTS <name>` for a new database and into `CREATE TABLE <name>_rebuilt` for an old
// one, so "fresh equals migrated" is a property of the code rather than a claim in a test.
const ATTEMPT_USAGE_RECEIPTS_COLUMNS = `
  attempt_id TEXT PRIMARY KEY REFERENCES attempts(id),
  status TEXT NOT NULL CHECK (status IN ('COMPLETE', 'PARTIAL', 'UNKNOWN', 'NO_PROVIDER_CONTACT')),
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
  CHECK (status IN ('UNKNOWN', 'NO_PROVIDER_CONTACT') OR (
    input_tokens >= 0 AND output_tokens >= 0 AND reasoning_tokens >= 0
    AND cache_read_tokens >= 0 AND cache_write_tokens >= 0
    AND provider_steps >= 1
  )),
  -- NO_PROVIDER_CONTACT is the one status whose numbers are all DERIVED zeroes. Writing NULL would
  -- make the row indistinguishable from UNKNOWN, and any nonzero figure would contradict the claim.
  -- reported_* stays NULL because the executor reported nothing -- it died first -- while the zero
  -- reference cost is delegate-wave's own determination and is what keeps the family accountable.
  CHECK (status != 'NO_PROVIDER_CONTACT' OR (
    input_tokens = 0 AND output_tokens = 0 AND reasoning_tokens = 0
    AND cache_read_tokens = 0 AND cache_write_tokens = 0
    AND provider_steps = 0
    AND reported_cost_usd IS NULL AND reported_cost_source IS NULL
    AND reference_cost_usd = 0 AND pricing_basis_id IS NULL
  )),
  CHECK (reported_cost_usd IS NULL OR reported_cost_usd >= 0),
  CHECK (reference_cost_usd IS NULL OR reference_cost_usd >= 0),
  CHECK (malformed_events >= 0)`;

const WAKE_OUTBOX_COLUMNS = `
  id TEXT PRIMARY KEY,
  watch_id TEXT NOT NULL REFERENCES session_watches(id),
  session_id TEXT NOT NULL REFERENCES autonomous_sessions(id),
  hermes_session_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('QUESTION', 'READY', 'COMPLETED', 'FAILED')),
  message_id TEXT REFERENCES autonomous_session_messages(id),
  marker TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL,
  receiver_protocol INTEGER NOT NULL DEFAULT 2 CHECK (receiver_protocol IN (1, 2)),
  -- SUBMITTED is evidence from the legacy direct prompt.submit protocol. ENQUEUED is evidence that
  -- wake.id was read back from Hermes' external-turn inbox. Migration never reinterprets one as the
  -- other; Stage 3 will make ENQUEUED the only state newly produced by routed delivery.
  state TEXT NOT NULL CHECK (state IN (
    'PENDING', 'PREPARING', 'SUBMITTED', 'ENQUEUED', 'DELIVERED', 'PARTIAL', 'ABANDONED'
  )),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  reconciled_at TEXT,
  runtime_session_id TEXT,
  submitted_at TEXT,
  enqueued_at TEXT,
  -- Diagnostic snapshots only. Hermes remains authoritative.
  last_receiver_state TEXT,
  last_receiver_observed_at TEXT,
  owner_pid INTEGER,
  owner_started_at TEXT,
  gateway_pid INTEGER,
  gateway_started_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (state NOT IN ('DELIVERED', 'PARTIAL') OR reconciled_at IS NOT NULL),
  CHECK (state IN ('SUBMITTED', 'DELIVERED', 'PARTIAL') OR submitted_at IS NULL),
  CHECK (state IN ('ENQUEUED', 'DELIVERED', 'PARTIAL') OR enqueued_at IS NULL),
  CHECK (submitted_at IS NULL OR enqueued_at IS NULL),
  CHECK (reason != 'QUESTION' OR message_id IS NOT NULL)
`;

// One deterministic check, and whether it actually happened.
//
// `outcome` exists because "the tests failed" and "the tests never ran" were previously the same
// row. In dogfood run 5 the stored plan was a single shell string joined with `&&`, handed to
// Windows PowerShell 5.1 where `&&` is a parse error; the interpreter exited nonzero without
// running anything, and two candidates were recorded as having failed validation. The manager
// reviewed that evidence faithfully and asked for revisions that could not have helped.
//
// A verifier that did not execute produces no evidence about the candidate at all, and must never
// be readable as evidence against it.
const VALIDATION_RUNS_COLUMNS = `
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  command TEXT NOT NULL,
  -- NULL exactly when the command never started, so there was no exit status to observe.
  exit_code INTEGER,
  outcome TEXT NOT NULL DEFAULT 'CHECK_FAILED' CHECK (outcome IN (
    'PASSED', 'CHECK_FAILED', 'CHECK_DID_NOT_RUN'
  )),
  -- Why it could not start, when it could not. Free text from the runner, recorded verbatim.
  did_not_run_reason TEXT,
  output_path TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  CHECK (outcome != 'CHECK_DID_NOT_RUN' OR (exit_code IS NULL AND did_not_run_reason IS NOT NULL)),
  CHECK (outcome = 'CHECK_DID_NOT_RUN' OR (exit_code IS NOT NULL AND did_not_run_reason IS NULL)),
  CHECK (outcome != 'PASSED' OR exit_code = 0)
`;

// SYNTHESIZING is a re-synthesis, not a fresh plan.
//
// A rethink that carries no questions still has something to decide: the previous diagnosis was
// rejected and a candidate may still be repairable. Sending that to PLANNING would relabel it as
// initial planning in the turn ledger, and -- worse -- PLAN cannot act on a candidate, so the
// surviving work would vanish from the manager's decision surface while staying in the database.
const MANAGER_USAGE_RECEIPTS_COLUMNS = `
  manager_turn_id TEXT PRIMARY KEY REFERENCES manager_turns(id),
  status TEXT NOT NULL CHECK (status IN ('COMPLETE', 'PARTIAL', 'UNKNOWN')),
  input_tokens INTEGER,
  output_tokens INTEGER,
  reasoning_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  -- The provider's own reported total, kept separately from the component split.
  --
  -- These are two different measurements with two different reliabilities, and collapsing them
  -- loses the good one. Whether cachedInputTokens nests inside inputTokens is genuinely ambiguous;
  -- the total is not ambiguous at all. Since the primary metric is strong tokens per finished task,
  -- an unresolvable decomposition must not be allowed to destroy a figure the provider stated
  -- exactly.
  total_tokens INTEGER,
  source TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  -- What the scarce side actually cost, in money rather than in tokens.
  --
  -- Three columns because there are three separable facts, and collapsing them loses the ability to
  -- audit any of them. NULL is the honest value throughout: a turn whose model no basis prices has
  -- UNKNOWN cost, not zero cost, and zero is the one answer that would quietly understate the whole
  -- point of measuring the expensive component.
  --
  -- reference_cost_usd is tokens x a named price, never the provider's bill. The App Server reports
  -- token counts and no dollars at all, so no observed figure exists on this route today; if one
  -- ever does it belongs in its own column beside this, not merged into it.
  reference_cost_usd REAL,
  -- Which price list, and which reading of it. Split so that comparing two runs can require the
  -- family to match while auditing one figure can name the exact revision that produced it.
  pricing_basis TEXT,
  pricing_basis_version TEXT,
  -- An UNKNOWN receipt carries no numbers at all, including no total. A manager whose provider
  -- reported nothing has unknown cost, not zero cost, and the difference is the entire point of
  -- measuring the scarce side.
  CHECK (status != 'UNKNOWN' OR (
    input_tokens IS NULL AND output_tokens IS NULL AND reasoning_tokens IS NULL
    AND cache_read_tokens IS NULL AND cache_write_tokens IS NULL AND total_tokens IS NULL
  )),
  CHECK (status = 'UNKNOWN' OR (input_tokens >= 0 AND output_tokens >= 0)),
CHECK (reference_cost_usd IS NULL OR reference_cost_usd >= 0),
  -- A cost without a stated basis is not reproducible, and a basis without a cost is not evidence
  -- of anything. Either both are present or neither is.
  CHECK ((reference_cost_usd IS NULL) = (pricing_basis IS NULL)),
  -- A version cannot exist without the basis it versions.
  CHECK (pricing_basis IS NOT NULL OR pricing_basis_version IS NULL),
  -- An unmeasured turn has no tokens, so it can have no token-derived cost either.
  CHECK (status != 'UNKNOWN' OR reference_cost_usd IS NULL)`;

const MANAGER_RUNS_COLUMNS = `
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
  status TEXT NOT NULL CHECK (status IN (
    'PLANNING', 'SYNTHESIZING', 'EXPLORING', 'IMPLEMENTING', 'REVIEWING',
    'ACCEPTED', 'AWAITING_HUMAN', 'FAILED', 'CANCELLED'
  )),
  -- What was asked for, and what the provider says actually ran. Two facts, because they can differ
  -- and only one of them is evidence. actual_model stays NULL when the provider reports nothing:
  -- backfilling it from the request would record a preference as an observation, and a manufactured
  -- provenance is worse than a missing one because only the missing one is detectable later.
  requested_model TEXT,
  actual_model TEXT,
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
  -- The one attempt a completed ACCEPT review bound itself to.
  --
  -- Written in the same transaction as the ACCEPT transition, and cross-checked against the review
  -- turn's subject_attempt_id. proposeIntegration() reads this instead of choosing among candidates:
  -- after a revision there are two PASSED attempts and 'the passed one' stops being a description of
  -- anything. Null until a review accepts, which is also what makes 'no worker runs after ACCEPT'
  -- checkable.
  accepted_attempt_id TEXT REFERENCES attempts(id),
  escalation_question TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL`;

const JOBS_COLUMNS = `
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
  -- A recorded ceiling in reference dollars, shared by the whole job family. NULL means no ceiling;
  -- a value gates every attempt start and settles after the work is done.
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
`;

const WORK_PROPOSALS_COLUMNS = `
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
`;

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

CREATE TABLE IF NOT EXISTS jobs (${JOBS_COLUMNS});

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
  -- Spending authority claimed for this attempt, in the same transaction that created it.
  --
  -- Authority, not a cap: a provider call cannot be preempted mid-flight, so an attempt may still
  -- overshoot what it reserved and that is recorded as an overrun. What this guarantees is that a
  -- family never AUTHORIZES more than its ceiling at one time, which is the property a check that
  -- sums only settled receipts cannot provide once siblings can start together.
  --
  -- NULL means the family carries no ceiling, so there was no authority to divide.
  budget_reservation_usd REAL CHECK (budget_reservation_usd IS NULL OR budget_reservation_usd > 0),
  -- WHY it failed, in words, beside the digest that identifies the failure.
  --
  -- failure_signature stays exactly what it was: a stable hash used to detect an attempt repeating
  -- itself. It is deliberately not human-readable, and for a long time it was the ONLY thing an
  -- operator saw. A real attempt reduced to "FAILED, reason = <64 hex characters>" while its
  -- transcript held an unknown-tool error twelve times over -- the cause was recorded and
  -- unreadable at the same time.
  --
  -- These three answer "what broke, at which stage, and where can I read about it" without touching
  -- the digest, so deduplication keeps working and history keeps its identity.
  failure_stage TEXT,
  failure_code TEXT,
  failure_detail_artifact TEXT,
  -- WHICH executor actually ran this, as opposed to which model was asked for.
  --
  -- manage and the served runtime resolved this differently for months and nothing recorded it, so
  -- the same model string ran under two different executors and the discrepancy was only findable by
  -- reading transcripts. Routing is a fact about the attempt, not a detail of whoever launched it.
  resolved_executor TEXT,
  executor_version TEXT,
  UNIQUE(job_id, ordinal)
);

CREATE TABLE IF NOT EXISTS validation_runs (${VALIDATION_RUNS_COLUMNS});

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
CREATE TABLE IF NOT EXISTS work_proposals (${WORK_PROPOSALS_COLUMNS});

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
--   NO_PROVIDER_CONTACT
--             the executor is positively known to have failed during local initialization, before a
--             provider request was possible. Distinct from UNKNOWN in the one way that matters to
--             the budget: the zero is DERIVED from positive local evidence rather than observed
--             from provider usage, so it does not make family spend unestablishable. Nothing here
--             measured a provider; the proof is that no provider was reached.
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

-- The scarce resource in its own units, sampled either side of every manager turn.
--
-- Token counts are an accounting of what was sent and generated. They are NOT known to be what a
-- plan-authenticated subscription actually charges: billing categories and quota accounting need
-- not coincide, and cache reads were 73% of dogfood run 5's strong total, so the difference is not
-- a rounding error. Optimising "fewest tokens" while the plan meters something else would tune the
-- wrong quantity confidently.
--
-- The provider's ORIGINAL response is stored verbatim. Any normalisation delegate-wave applies is a
-- reading of that response and can be redone later; a percentage computed today cannot be
-- un-computed when the shape turns out to mean something else.
--
-- Evidence only. Nothing enforces a quota from these rows: this exists to answer what one manager
-- turn consumes, which must be known before anything is built to limit it.
CREATE TABLE IF NOT EXISTS manager_rate_limit_snapshots (
  id TEXT PRIMARY KEY,
  manager_turn_id TEXT NOT NULL REFERENCES manager_turns(id),
  boundary TEXT NOT NULL CHECK (boundary IN ('BEFORE', 'AFTER')),
  -- NULL when the account exposes no rate-limit information at all, which is itself worth recording:
  -- absence must be visible rather than inferred from a missing row.
  raw_json TEXT,
  observed_at TEXT NOT NULL,
  UNIQUE (manager_turn_id, boundary)
);

CREATE TRIGGER IF NOT EXISTS trg_rate_limits_immutable_update
BEFORE UPDATE ON manager_rate_limit_snapshots
BEGIN SELECT RAISE(ABORT, 'manager_rate_limit_snapshots is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_rate_limits_immutable_delete
BEFORE DELETE ON manager_rate_limit_snapshots
BEGIN SELECT RAISE(ABORT, 'manager_rate_limit_snapshots is immutable'); END;

CREATE TABLE IF NOT EXISTS attempt_usage_receipts (${ATTEMPT_USAGE_RECEIPTS_COLUMNS});

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
CREATE TABLE IF NOT EXISTS manager_runs (${MANAGER_RUNS_COLUMNS});

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
  -- What this turn is a judgment ABOUT. Set for REVIEW; null for PLAN and SYNTHESIS.
  --
  -- This is the durable binding that makes "the reviewed candidate is the validated candidate is the
  -- candidate offered for integration" a checkable fact rather than an inference. The tempting
  -- alternative -- trusting that the candidate SHA appeared somewhere in the prompt artifact -- makes
  -- the authoritative link a property of prose that a future orchestration bug can silently break,
  -- validating attempt A while reviewing artifacts from attempt B. A foreign key cannot drift.
  subject_attempt_id TEXT REFERENCES attempts(id),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE(manager_run_id, ordinal),
  -- A review with no subject could never satisfy the acceptance gate, so it is refused at write time
  -- rather than discovered as an unexplained refusal later.
  CHECK (phase != 'REVIEW' OR state IN ('INTENDED', 'RUNNING') OR subject_attempt_id IS NOT NULL)
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
CREATE TABLE IF NOT EXISTS manager_usage_receipts (${MANAGER_USAGE_RECEIPTS_COLUMNS});

-- What delegate-wave asked for, what the executor can prove it launched, and what the runtime
-- independently reported. Three levels, deliberately not two.
--
-- A configuration proves what delegate-wave asked the executor to do; only runtime evidence may
-- claim what actually ran, and absence remains unknown. Collapsing "applied" into "actual" is the
-- error Orca issue #10846 describes from the other side: a requested effort that silently vanishes
-- from the launch args, with no way for the caller to tell it launched at the default.
--
-- Deliberately a separate receipt rather than new meanings for attempts.model and
-- attempts.capability_profile. Those record what was REQUESTED at claim time and have always meant
-- that; redefining them would rewrite the meaning of every historical row.
--
-- Orthogonal to attempt_usage_receipts. Cost evidence and identity evidence fail independently: a
-- run can have perfect token accounting and unverifiable model identity, or verified identity and no
-- usable cost. Neither receipt may stand in for the other's health.
CREATE TABLE IF NOT EXISTS attempt_runtime_provenance (
  attempt_id TEXT PRIMARY KEY REFERENCES attempts(id),
  requested_model TEXT,
  requested_effort TEXT,
  requested_executor TEXT,
  requested_capability_profile TEXT,
  -- What the local executor can mechanically prove it SUPPLIED AT LAUNCH: the patch delegate-wave
  -- wrote, the argv a CLI was invoked with. Strong evidence that intent reached the runtime, and no
  -- evidence whatsoever about what a remote provider then served -- nor, without a config dump, that
  -- every entry survived the runtime's own composition, since Harness skips entries it rejects and
  -- only warns.
  applied_model TEXT,
  applied_effort TEXT,
  applied_executor TEXT,
  applied_capability_profile TEXT,
  applied_source TEXT,
  -- What the runtime or provider independently reported back. NULL means unknown, never "the same as
  -- what we asked for".
  observed_model TEXT,
  observed_effort TEXT,
  observed_source TEXT,
  status TEXT NOT NULL CHECK (status IN ('VERIFIED', 'PARTIAL', 'UNVERIFIED', 'CONTRADICTED')),
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS trg_runtime_provenance_immutable_update
BEFORE UPDATE ON attempt_runtime_provenance
BEGIN SELECT RAISE(ABORT, 'attempt_runtime_provenance is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_runtime_provenance_immutable_delete
BEFORE DELETE ON attempt_runtime_provenance
BEGIN SELECT RAISE(ABORT, 'attempt_runtime_provenance is immutable'); END;

-- A price derived over a receipt's tokens under a basis that did not exist when it was bought.
--
-- Separate from the receipt because the receipt is IMMUTABLE, and rightly so: it records what the
-- provider said, and that observation is not revisable. A dollar figure is not part of that
-- observation. It is a derivation over it, under a price list chosen later, and delegate-wave has
-- already had to supersede one basis after discovering its rates were wrong -- so a price welded to
-- an unrevisable row would have been unrepairable by construction.
--
-- Append-only, keyed by basis, so the same history can be priced under several bases and compared
-- rather than overwritten. A receipt priced at observation time keeps that figure in its own row and
-- needs nothing here.
CREATE TABLE IF NOT EXISTS manager_receipt_pricings (
  manager_turn_id TEXT NOT NULL REFERENCES manager_usage_receipts(manager_turn_id),
  pricing_basis TEXT NOT NULL,
  -- Empty rather than NULL: it is part of the key, and SQLite treats NULLs in a key as distinct,
  -- which would let the same basis be recorded twice.
  pricing_basis_version TEXT NOT NULL DEFAULT '',
  reference_cost_usd REAL NOT NULL CHECK (reference_cost_usd >= 0),
  derived_at TEXT NOT NULL,
  PRIMARY KEY (manager_turn_id, pricing_basis, pricing_basis_version)
);

-- One autonomous task, from the user's words to a finished result.
--
-- The layer Hermes talks to. It holds three things delegate-wave has never had a home for: the
-- user's ORIGINAL intent in their own words, the autonomy mode they granted, and the semantic
-- conversation between Hermes and the manager.
--
-- mode is a permission ENVELOPE, not a workflow state. It says what this session is allowed to do;
-- state says what is currently happening. Keeping them in separate columns is deliberate -- the
-- moment a mode starts meaning "which step comes next" it has become the ceremony this design
-- exists to remove.
--
-- BYPASS suppresses QUESTIONS, never INVARIANTS. Protected paths, deterministic validation, CAS
-- integration, budget admission, worktree and credential isolation are mechanical and refuse under
-- every mode including this one.
-- Work the manager has DECIDED to buy, recorded before anyone is asked to buy it.
--
-- The window this closes is between a decision and an attempt row. Two ticks could both find no
-- live attempt -- because none existed yet -- and both spend a scarce turn concluding IMPLEMENT,
-- and the collision only surfaced later when the dispatcher refused the second. Checking
-- attempts.terminal_state cannot close that gap: the fact that needs to be durable is "work is
-- already on its way", which is true from the moment of the decision, not from the moment an
-- executor claims it.
--
-- Durable rather than an in-memory lock, because a process that dies between deciding and
-- dispatching must still tell its replacement that work was commissioned. An in-memory mutex would
-- forget exactly when forgetting is most expensive.
CREATE TABLE IF NOT EXISTS work_commissions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  manager_run_id TEXT REFERENCES manager_runs(id),
  -- IMPLEMENT or REVISE: which semantic decision bought this.
  action TEXT NOT NULL,
  -- The turn that decided it, so a commission is traceable to the reasoning that caused it.
  decision_turn_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('PENDING', 'CLAIMED', 'CLOSED', 'FAILED')),
  attempt_id TEXT REFERENCES attempts(id),
  outcome TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- A claimed or closed commission names the attempt it became.
  CHECK (state IN ('PENDING', 'FAILED') OR attempt_id IS NOT NULL)
);

-- At most one commission may be OPEN per job. This is the single-flight rule, enforced by the
-- database rather than by whichever caller remembers to look: two crossed ticks race to insert and
-- exactly one wins.
CREATE UNIQUE INDEX IF NOT EXISTS idx_work_commissions_single_flight
  ON work_commissions(job_id) WHERE state IN ('PENDING', 'CLAIMED');

CREATE TABLE IF NOT EXISTS autonomous_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  -- Null until the session commissions work. PLAN sessions may never acquire one.
  job_id TEXT REFERENCES jobs(id),
  -- The user's own words, kept verbatim. delegate-wave never sees their conversation with Hermes,
  -- so this is the only record of what was actually asked for.
  intent TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('AUTO', 'MANUAL', 'ACCEPT_EDITS', 'PLAN', 'BYPASS')),
  state TEXT NOT NULL CHECK (state IN (
    'WORKING', 'WAITING_FOR_HERMES', 'SEMANTICALLY_ACCEPTED', 'COMPLETED', 'FAILED'
  )),
  -- Why the session stopped, when it stopped for a reason worth reporting.
  outcome TEXT,
  maximum_cost REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (maximum_cost IS NULL OR maximum_cost > 0)
);

-- The semantic exchange, append-only.
--
-- Durable because it is EVIDENCE, not conversation. A manager question and the answer Hermes gave
-- it are what the next turn reasons from, so they must survive a restart, a dropped stdio pipe and
-- an expired provider thread. Conversation continuity stays an optimisation; this is the record.
CREATE TABLE IF NOT EXISTS autonomous_session_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES autonomous_sessions(id),
  ordinal INTEGER NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('TO_HERMES', 'FROM_HERMES')),
  -- A question carries its own stakes: what was asked, why it matters, what was already found.
  body TEXT NOT NULL,
  why_it_matters TEXT,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  -- Set when a TO_HERMES question has been answered, naming the message that answered it.
  answered_by TEXT REFERENCES autonomous_session_messages(id),
  created_at TEXT NOT NULL,
  UNIQUE (session_id, ordinal)
);

-- One attempt to publish an accepted candidate onto a real branch.
--
-- PREPARE, VALIDATE, PUBLISH -- in that order, and the branch moves only at the last step.
--
-- The obvious design is to integrate, test, and roll back if bad. This is not that. Rollback as a
-- happy-path mechanism means every ordinary failure briefly moves a real branch, and "briefly" is
-- indistinguishable from "permanently" to anything that read it, cloned it, or built from it in
-- between. Here an ordinary failure never touches the branch at all: the integrated tree is
-- constructed and proven in a disposable worktree first, and the ref moves once, by
-- compare-and-swap, to a commit already known to be green.
--
-- The columns exist to answer one question after a crash, without inferring anything from Git
-- history: WHAT EXACT TREE DID WE VALIDATE, WHAT TARGET DID WE BELIEVE EXISTED, AND DID THAT EXACT
-- TREE ACTUALLY BECOME THE BRANCH HEAD?
CREATE TABLE IF NOT EXISTS staged_integrations (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES autonomous_sessions(id),
  job_id TEXT NOT NULL REFERENCES jobs(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  target_ref TEXT NOT NULL,
  -- What was accepted, and the world it was accepted against.
  candidate_commit TEXT NOT NULL,
  candidate_base_sha TEXT NOT NULL,
  -- The target head observed when this attempt began. Distinct from candidate_base_sha whenever
  -- the branch advanced while the work was happening, which is ordinary concurrent activity rather
  -- than an exceptional condition.
  observed_target_sha TEXT NOT NULL,
  -- The commit built in the disposable worktree, and the tree it names.
  --
  -- prepared_tree is recorded separately and deliberately: publishing a DIFFERENT tree than the one
  -- validated is the failure this whole table exists to make impossible, and comparing commits
  -- would not catch a rebuild that produced an identical tree under a new commit id, nor a swap to
  -- a different tree under a reused id.
  prepared_commit TEXT,
  prepared_tree TEXT,
  -- The exact plan proven against prepared_tree, by digest, so a plan that changed afterwards
  -- cannot be mistaken for the one that passed.
  validation_plan_digest TEXT,
  validation_state TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (validation_state IN ('PENDING', 'PASSED', 'FAILED')),
  publish_state TEXT NOT NULL CHECK (publish_state IN (
    'PREPARING', 'PREPARED', 'PUBLISHED', 'SUPERSEDED', 'FAILED'
  )),
  -- Only a published attempt has these, and it has both.
  published_from_sha TEXT,
  published_to_sha TEXT,
  -- Why it ended, when it ended badly or was overtaken.
  outcome TEXT,
  attempt_number INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- Nothing is publishable until an exact tree has been proven.
  CHECK (publish_state != 'PUBLISHED' OR (
    prepared_commit IS NOT NULL AND prepared_tree IS NOT NULL
    AND validation_state = 'PASSED'
    AND published_from_sha IS NOT NULL AND published_to_sha IS NOT NULL
  )),
  -- A published attempt moved the ref from exactly the head it believed in, to exactly the commit
  -- it prepared. Any other pairing means something published a tree nobody proved.
  CHECK (publish_state != 'PUBLISHED' OR (
    published_from_sha = observed_target_sha AND published_to_sha = prepared_commit
  )),
  CHECK (publish_state = 'PUBLISHED' OR (published_from_sha IS NULL AND published_to_sha IS NULL)),
  CHECK (publish_state != 'PREPARED' OR (prepared_commit IS NOT NULL AND prepared_tree IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_staged_integrations_job ON staged_integrations(job_id, created_at);

-- WHO IS WAITING TO BE TOLD, AND ABOUT WHAT.
--
-- delegate-wave never sees the conversation a request came from. hermes_session_id is the only
-- thread back to it: the durable Hermes session that asked for this work, which a wake continues
-- rather than replaces. Without this row a finished session is a fact nobody is looking at, and the
-- only way to learn it finished is to keep asking.
--
-- Durable rather than an in-memory subscription, because the whole point is to survive the wait. A
-- session that finishes at 3am must still reach the conversation that asked for it after a restart,
-- and a subscription registered in a process that has since died would be exactly the evidence that
-- went missing.
CREATE TABLE IF NOT EXISTS session_watches (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES autonomous_sessions(id),
  hermes_session_id TEXT NOT NULL,
  -- BLOCKED is not a synonym for CLOSED. It records that a delivery reached PARTIAL -- the marker is
  -- durable in Hermes but no assistant turn answered it -- so what already happened in that
  -- conversation is unknown, and this watch must not enqueue more automatic wakes into it.
  state TEXT NOT NULL CHECK (state IN ('ACTIVE', 'BLOCKED', 'CLOSED')),
  -- What has already been enqueued, so a state that persists for an hour is announced once.
  --
  -- The state alone is not enough. A session may ask, be answered, work, and ask again: three
  -- WAITING_FOR_HERMES observations of which two are different questions. Recording WHICH question
  -- was announced is what distinguishes "still waiting on the same one" from "asking a new one".
  notified_state TEXT,
  notified_message_id TEXT REFERENCES autonomous_session_messages(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- One watch per conversation per session. Two Hermes sessions may each watch the same work; the
  -- same one may not watch it twice.
  UNIQUE (session_id, hermes_session_id)
);

CREATE INDEX IF NOT EXISTS idx_session_watches_session ON session_watches(session_id);

-- ONE THING TO SAY, AND WHAT IS KNOWN ABOUT WHETHER IT WAS SAID.
--
-- The receiver has no idempotency: submitting the same event twice produces two independent agent
-- turns, and prompt.submit returns {"status":"streaming"} before anything is durable. So the
-- acknowledgement is not evidence of delivery -- canonical Hermes history is. marker is the
-- identity that history is searched for, written once at enqueue and never regenerated: a
-- regenerated marker would make an already-durable delivery invisible and the retry would duplicate
-- it.
--
-- PARTIAL is a state, not an error code. Marker durable, no assistant turn: tools may already have
-- run, a session_answer may already have come back, and the only honest thing to do is stop and
-- say so. Automatic retry from that evidence would violate the rule the rest of this system runs
-- on -- evidence authorises the mutation.
CREATE TABLE IF NOT EXISTS wake_outbox (${WAKE_OUTBOX_COLUMNS});

-- At most one wake in flight per Hermes conversation.
--
-- Two gateways resuming the same durable session is the hazard section 2 of the wake-path research
-- measured, and delegate-wave is not permitted to be the thing that causes it. This index is the
-- half of that problem this side owns: whatever else is running, THIS system will not have two
-- deliveries open into one conversation at once.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wake_outbox_single_flight
  ON wake_outbox(hermes_session_id) WHERE state IN ('PREPARING', 'SUBMITTED', 'ENQUEUED');

CREATE INDEX IF NOT EXISTS idx_wake_outbox_pending ON wake_outbox(state, created_at);

CREATE TRIGGER IF NOT EXISTS trg_wake_outbox_immutable_delete
BEFORE DELETE ON wake_outbox
BEGIN SELECT RAISE(ABORT, 'wake_outbox is immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_staged_integrations_immutable_delete
BEFORE DELETE ON staged_integrations
BEGIN SELECT RAISE(ABORT, 'staged_integrations is immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_session_messages_immutable_delete
BEFORE DELETE ON autonomous_session_messages
BEGIN SELECT RAISE(ABORT, 'autonomous_session_messages is immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_manager_receipt_pricings_immutable_update
BEFORE UPDATE ON manager_receipt_pricings
BEGIN SELECT RAISE(ABORT, 'manager_receipt_pricings is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_manager_receipt_pricings_immutable_delete
BEFORE DELETE ON manager_receipt_pricings
BEGIN SELECT RAISE(ABORT, 'manager_receipt_pricings is immutable'); END;

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
CREATE INDEX IF NOT EXISTS idx_manager_turns_run ON manager_turns(manager_run_id, ordinal);
`;

// Indexes over columns that MIGRATIONS add.
//
// These cannot live in SCHEMA. openDatabase() runs SCHEMA first, where CREATE TABLE IF NOT EXISTS
// leaves an existing table at its old shape, and only then runs migrate() to add columns. An index
// in SCHEMA naming a migrated column therefore executes against a table that does not have it yet,
// and opening any real pre-19 database throws "no such column" before a single migration runs.
//
// Fresh-root tests never see this: their tables are created by SCHEMA with every column present.
const POST_MIGRATION_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_jobs_parent ON jobs(parent_job_id);
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
  // Readable failure evidence and executor identity. Plain ADD COLUMNs: all five are nullable with
  // no constraint, so a migrated table matches a fresh one exactly and historical attempts simply
  // carry NULL -- which is the truth about them, since nothing recorded these facts at the time.
  for (const column of [
    "failure_stage", "failure_code", "failure_detail_artifact",
    "resolved_executor", "executor_version",
  ]) {
    if (!attemptColumns.includes(column)) db.exec(`ALTER TABLE attempts ADD COLUMN ${column} TEXT`);
  }
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
  // Schema 19's attempt columns.
  //
  // Declaring these only in the fresh SCHEMA was a real defect, not a tidiness issue: an existing
  // installation would be stamped schema 19 by the version write at the end of this function and
  // then fail its very next runJob() INSERT, because the columns it names do not exist. Fresh-root
  // tests cannot see this class of bug at all -- they create the table from SCHEMA and never migrate.
  //
  // Left NULL for attempts that predate them, which is the truth: those attempts were given the
  // job's goal as their instruction, but no artifact of it was written and inventing a digest for a
  // file that never existed would fabricate provenance.
  for (const column of ["start_sha", "instruction_artifact", "instruction_digest", "result_text_artifact"]) {
    if (!attemptColumns.includes(column)) {
      db.exec(`ALTER TABLE attempts ADD COLUMN ${column} TEXT`);
    }
  }
  if (!attemptColumns.includes("budget_reservation_usd")) {
    db.exec("ALTER TABLE attempts ADD COLUMN budget_reservation_usd REAL");
  }
  const workProposalColumns = db.prepare("PRAGMA table_info(work_proposals)").all().map((column) => column.name);
  if (workProposalColumns.length) {
    if (!workProposalColumns.includes("expected_base_sha")) {
      db.exec("ALTER TABLE work_proposals ADD COLUMN expected_base_sha TEXT");
    }
    if (!workProposalColumns.includes("strategy")) {
      db.exec("ALTER TABLE work_proposals ADD COLUMN strategy TEXT NOT NULL DEFAULT 'direct'");
    }
  }
  const managerRunColumns = db.prepare("PRAGMA table_info(manager_runs)").all().map((column) => column.name);
  if (managerRunColumns.length) {
    if (!managerRunColumns.includes("requested_model")) {
      db.exec("ALTER TABLE manager_runs ADD COLUMN requested_model TEXT");
    }
    if (!managerRunColumns.includes("actual_model")) {
      db.exec("ALTER TABLE manager_runs ADD COLUMN actual_model TEXT");
    }
    if (!managerRunColumns.includes("accepted_attempt_id")) {
      db.exec("ALTER TABLE manager_runs ADD COLUMN accepted_attempt_id TEXT REFERENCES attempts(id)");
    }
  }
  const managerTurnColumns = db.prepare("PRAGMA table_info(manager_turns)").all().map((column) => column.name);
  if (managerTurnColumns.length && !managerTurnColumns.includes("subject_attempt_id")) {
    db.exec("ALTER TABLE manager_turns ADD COLUMN subject_attempt_id TEXT REFERENCES attempts(id)");
  }
  const managerUsageColumns = db.prepare("PRAGMA table_info(manager_usage_receipts)").all().map((column) => column.name);
  if (managerUsageColumns.length && !managerUsageColumns.includes("total_tokens")) {
    db.exec("ALTER TABLE manager_usage_receipts ADD COLUMN total_tokens INTEGER");
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
  // A wake_outbox from schema 33 records no owner. Left NULL rather than invented, which is the
  // truth about those rows -- and the conservative outcome, because an unknown owner can never be
  // proven dead and so its row is never reclaimed automatically.
  const wakeColumns = db.prepare("PRAGMA table_info(wake_outbox)").all().map((column) => column.name);
  if (wakeColumns.length) {
    for (const [column, type] of [
      ["owner_pid", "INTEGER"], ["owner_started_at", "TEXT"],
      ["gateway_pid", "INTEGER"], ["gateway_started_at", "TEXT"],
      // Schema 35. Existing rows were carried by direct submit, so these stay NULL. An old
      // SUBMITTED row is never relabelled ENQUEUED merely because the inbox now exists.
      ["enqueued_at", "TEXT"],
      ["last_receiver_state", "TEXT"], ["last_receiver_observed_at", "TEXT"],
      // Schema 36. Every row already on disk predates typed receiver metadata. New rows explicitly
      // use protocol 2 at creation; this default exists only to truthfully backfill old evidence.
      ["receiver_protocol", "INTEGER NOT NULL DEFAULT 1"],
    ]) {
      if (!wakeColumns.includes(column)) db.exec(`ALTER TABLE wake_outbox ADD COLUMN ${column} ${type}`);
    }
  }
  // Only now that every column exists.
  db.exec(POST_MIGRATION_INDEXES);
  // And only now that every table enforces what the fresh schema enforces.
  rebuildConstrainedTables(db);
  db.prepare("UPDATE metadata SET value = ? WHERE key = 'schema_version'").run(SCHEMA_VERSION);
}

// Brings tables whose CHECK constraints were added by ALTER TABLE up to the canonical definition.
//
// A migrated database that merely has the right COLUMNS is not the same database as a fresh one. It
// accepts `strategy = 'nonsense'`, an internal job with no parent, and every other state the fresh
// CHECKs reject -- so an orchestration bug becomes installation-specific and survives every
// fresh-root test. The schema version must not be stamped until this is untrue.
//
// SQLite's documented table-rebuild procedure, followed exactly:
//
//   PRAGMA foreign_keys = OFF        (must be outside a transaction, or it is a silent no-op)
//   BEGIN
//     create the replacement from the SAME DDL text the fresh schema uses
//     copy every row
//     drop the original, rename the replacement
//     recreate indexes and triggers, which the drop removed
//     PRAGMA foreign_key_check       (rollback on any row)
//   COMMIT
//   PRAGMA foreign_keys = ON
function rebuildConstrainedTables(db) {
  const definition = (name) => db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name)?.sql ?? "";

  const pending = [];
  // Detected from the stored DDL rather than from the schema version: a database part-way through an
  // interrupted upgrade must be judged on what it actually contains.
  if (definition("jobs") && !definition("jobs").includes("strategy IN ('direct', 'managed')")) {
    pending.push({
      name: "jobs",
      columns: JOBS_COLUMNS,
      // Named explicitly rather than SELECT *: column order after successive ALTER TABLE ADD COLUMN
      // is not the order of the canonical definition, and a positional copy would silently transpose
      // values into the wrong columns.
      copy: `id, project_id, goal, mode, status, base_sha, max_attempts, maximum_cost,
             capability_profile, strategy, parent_job_id, internal_kind, created_at, updated_at`,
      after: [
        "CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id, created_at)",
        "CREATE INDEX IF NOT EXISTS idx_jobs_parent ON jobs(parent_job_id)",
      ],
    });
  }
  if (definition("work_proposals") && !definition("work_proposals").includes("strategy IN ('direct', 'managed')")) {
    pending.push({
      name: "work_proposals",
      columns: WORK_PROPOSALS_COLUMNS,
      copy: `id, project_id, goal, mode, action_digest, expected_state_version, expected_base_sha,
             strategy, maximum_cost, expires_at, idempotency_key, origin_principal, origin_channel,
             created_at`,
      after: [
        "CREATE INDEX IF NOT EXISTS idx_work_proposals_project ON work_proposals(project_id, created_at)",
        `CREATE TRIGGER IF NOT EXISTS trg_work_proposals_immutable_update
         BEFORE UPDATE ON work_proposals
         BEGIN SELECT RAISE(ABORT, 'work_proposals is immutable'); END`,
        `CREATE TRIGGER IF NOT EXISTS trg_work_proposals_immutable_delete
         BEFORE DELETE ON work_proposals
         BEGIN SELECT RAISE(ABORT, 'work_proposals is immutable'); END`,
      ],
    });
  }
  if (definition("attempt_usage_receipts")
    && !definition("attempt_usage_receipts").includes("NO_PROVIDER_CONTACT")) {
    pending.push({
      name: "attempt_usage_receipts",
      columns: ATTEMPT_USAGE_RECEIPTS_COLUMNS,
      // Positional copies transpose after ALTER TABLE, so every column is named. Historical rows
      // migrate unchanged: a receipt written as UNKNOWN under the old semantics stays UNKNOWN,
      // because it was a correct observation of what was knowable at the time.
      copy: `attempt_id, status, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens,
             cache_write_tokens, provider_steps, reported_cost_usd, reported_cost_source,
             reference_cost_usd, pricing_basis_id, source_backend, source_artifact, source_format,
             malformed_events, observed_at`,
      after: [
        `CREATE TRIGGER IF NOT EXISTS trg_usage_receipts_immutable_update
         BEFORE UPDATE ON attempt_usage_receipts
         BEGIN SELECT RAISE(ABORT, 'attempt_usage_receipts is immutable'); END`,
        `CREATE TRIGGER IF NOT EXISTS trg_usage_receipts_immutable_delete
         BEFORE DELETE ON attempt_usage_receipts
         BEGIN SELECT RAISE(ABORT, 'attempt_usage_receipts is immutable'); END`,
      ],
    });
  }
  if (definition("wake_outbox") && (
    !definition("wake_outbox").includes("'ENQUEUED'")
    || !definition("wake_outbox").includes("receiver_protocol IN (1, 2)")
  )) {
    pending.push({
      name: "wake_outbox",
      columns: WAKE_OUTBOX_COLUMNS,
      // Named rather than positional: migration columns are appended physically, not placed where
      // the canonical definition declares them.
      copy: `id, watch_id, session_id, hermes_session_id, reason, message_id, marker, body,
             receiver_protocol,
             state, attempts, last_error, reconciled_at, runtime_session_id, submitted_at,
             enqueued_at, last_receiver_state, last_receiver_observed_at,
             owner_pid, owner_started_at, gateway_pid, gateway_started_at, created_at, updated_at`,
      after: [
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_wake_outbox_single_flight
           ON wake_outbox(hermes_session_id) WHERE state IN ('PREPARING', 'SUBMITTED', 'ENQUEUED')`,
        "CREATE INDEX IF NOT EXISTS idx_wake_outbox_pending ON wake_outbox(state, created_at)",
        `CREATE TRIGGER IF NOT EXISTS trg_wake_outbox_immutable_delete
         BEFORE DELETE ON wake_outbox
         BEGIN SELECT RAISE(ABORT, 'wake_outbox is immutable'); END`,
      ],
    });
  }
  if (definition("validation_runs") && !definition("validation_runs").includes("CHECK_DID_NOT_RUN")) {
    pending.push({
      name: "validation_runs",
      columns: VALIDATION_RUNS_COLUMNS,
      // Historical rows are migrated on their own terms: every existing row DID run, because the
      // old schema could not represent anything else, so outcome derives from the exit code it
      // recorded. That is a faithful reading of what those rows meant, not a reinterpretation --
      // including run 5's, which genuinely did execute an interpreter that then refused the line.
      copy: null,
      insert: `INSERT INTO validation_runs_rebuilt
                 (id, attempt_id, command, exit_code, outcome, did_not_run_reason,
                  output_path, started_at, finished_at)
               SELECT id, attempt_id, command, exit_code,
                      CASE WHEN exit_code = 0 THEN 'PASSED' ELSE 'CHECK_FAILED' END,
                      NULL, output_path, started_at, finished_at
               FROM validation_runs`,
      after: [],
    });
  }
  if (definition("manager_runs") && !definition("manager_runs").includes("SYNTHESIZING")) {
    pending.push({
      name: "manager_runs",
      columns: MANAGER_RUNS_COLUMNS,
      copy: `id, job_id, status, requested_model, actual_model, thread_id, exploration_round,
             revision_round, max_exploration_rounds, max_revision_rounds, max_turns,
             active_child_job_id, last_candidate_attempt_id, accepted_attempt_id,
             escalation_question, created_at, updated_at`,
      after: [],
    });
  }
  if (definition("manager_usage_receipts")
      && !definition("manager_usage_receipts").includes("reference_cost_usd")) {
    pending.push({
      name: "manager_usage_receipts",
      columns: MANAGER_USAGE_RECEIPTS_COLUMNS,
      // Historical receipts keep their tokens and gain NULL cost, which is the truthful value: they
      // were observed before any basis priced this model. Because the tokens survive, adding a basis
      // later can price them retroactively without re-running anything.
      copy: `manager_turn_id, status, input_tokens, output_tokens, reasoning_tokens,
             cache_read_tokens, cache_write_tokens, total_tokens, source, observed_at`,
      after: [],
    });
  }
  if (pending.length === 0) return;

  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const table of pending) {
        const temporary = `${table.name}_rebuilt`;
        db.exec(`DROP TABLE IF EXISTS ${temporary}`);
        db.exec(`CREATE TABLE ${temporary} (${table.columns})`);
        db.exec(table.insert
          ?? `INSERT INTO ${temporary} (${table.copy}) SELECT ${table.copy} FROM ${table.name}`);
        db.exec(`DROP TABLE ${table.name}`);
        db.exec(`ALTER TABLE ${temporary} RENAME TO ${table.name}`);
        for (const statement of table.after) db.exec(statement);
      }
      // Every reference must still resolve. A rebuild that orphaned an attempt or a proposal decision
      // has corrupted operational truth, and committing it would be worse than never migrating.
      const violations = db.prepare("PRAGMA foreign_key_check").all();
      if (violations.length) {
        throw new Error(
          `Refusing to migrate: rebuilding ${pending.map((t) => t.name).join(", ")} left `
          + `${violations.length} broken foreign key reference(s)`,
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    // Restored on every path, including the failure path: leaving a live connection with foreign
    // keys disabled would silently relax every constraint for the rest of the process.
    db.exec("PRAGMA foreign_keys = ON");
  }
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
