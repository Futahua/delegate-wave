import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { openDatabase, recordEvent, transaction } from "./db.js";
import { managedPaths } from "./paths.js";
import {
  assertRepository,
  changedFiles,
  cherryPick,
  commitAll,
  createDetachedWorktree,
  git,
  isAncestor,
  listWorktrees,
  lockWorktree,
  removeWorktree,
  resolveRevision,
  updateRefCas,
} from "./git.js";
import { runShell } from "./process.js";
import { buildUsageReceipt } from "./usage.js";

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${crypto.randomUUID()}`;

// Deterministic default worker. OpenCode's ambient provider selection is deliberately never used:
// under the supervised task it resolved to Google and failed on a missing provider key, which cost
// an attempt. Routing stays explicit rather than automatic.
//
//   default bulk implementation and ordinary investigation -> opencode-go/deepseek-v4-flash
//   focused review and debugging                           -> opencode-go/gpt-5.6-luna  (explicit)
//   hard implementation escalation                         -> opencode-go/deepseek-v4-pro (explicit)
export const DEFAULT_WORKER_MODEL = "opencode-go/deepseek-v4-flash";
export const REVIEW_MODEL = "opencode-go/gpt-5.6-luna";
export const ESCALATION_MODEL = "opencode-go/deepseek-v4-pro";
const OVERVIEW_PROJECT_LIMIT = 20;
const OVERVIEW_ATTENTION_LIMIT = 20;
const OVERVIEW_SUMMARY_LIMIT = 160;
const OVERVIEW_BYTE_LIMIT = 3 * 1024;

const lifecycleActive = (alias = "") => {
  const p = alias ? `${alias}.` : "";
  return `(${p}terminal_state IS NULL OR (${p}terminal_state = 'SUCCEEDED' AND ${p}validation_state = 'PENDING'))`;
};

function parseJson(value, fallback = []) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function parseValidationPlan(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`Stored validation plan is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed) || parsed.some((command) => typeof command !== "string" || !command.trim())) {
    throw new Error("Stored validation plan must be an array of non-empty command strings");
  }
  return parsed;
}

function safeProjectId(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "project";
  return `${slug}-${crypto.randomBytes(3).toString("hex")}`;
}

function normalizeFailureSignature(text) {
  return crypto.createHash("sha256").update(
    text.toLowerCase()
      .replace(/[a-f0-9]{7,64}/g, "<sha>")
      .replace(/\b\d+(?:\.\d+)?\b/g, "<n>")
      .replace(/\\/g, "/")
      .slice(-8000),
  ).digest("hex");
}

function compactOverviewText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, OVERVIEW_SUMMARY_LIMIT);
}

export class Dispatcher {
  constructor({ root, backend, updateRef = updateRefCas }) {
    this.paths = managedPaths(root);
    this.db = openDatabase(this.paths.database);
    this.backend = backend;
    this.updateRef = updateRef;
  }

  close() { this.db.close(); }

  async addProject({ name, repoPath, branch = "HEAD", validation = [], protectedPaths = [] }) {
    const resolvedPath = path.resolve(repoPath);
    await assertRepository(resolvedPath);
    const integrationBranch = branch === "HEAD"
      ? await git(resolvedPath, ["branch", "--show-current"])
      : branch;
    if (!integrationBranch) throw new Error("Register a named integration branch; detached HEAD is not supported");
    await resolveRevision(resolvedPath, integrationBranch);
    const projectId = safeProjectId(name);
    return transaction(this.db, () => {
      this.db.prepare(`INSERT INTO projects(
        id, name, repo_path, integration_branch, validation_json, protected_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        projectId, name, resolvedPath, integrationBranch,
        JSON.stringify(validation), JSON.stringify(protectedPaths), now(),
      );
      recordEvent(this.db, { kind: "PROJECT_REGISTERED", entityType: "project", entityId: projectId });
      return this.getProject(projectId);
    });
  }

  getProject(projectId) {
    return this.db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
  }

  listProjects() {
    return this.db.prepare("SELECT * FROM projects ORDER BY created_at").all();
  }

  // Transaction-internal job insert. Callers MUST already hold a transaction; this exists so that
  // job creation can be committed atomically together with whatever authorized it.
  insertJobRow({ projectId, goal, mode, maxAttempts, baseSha }) {
    const jobId = id("job");
    const timestamp = now();
    this.db.prepare(`INSERT INTO jobs(
      id, project_id, goal, mode, status, base_sha, max_attempts, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?, ?)`).run(
      jobId, projectId, goal, mode, baseSha, maxAttempts, timestamp, timestamp,
    );
    recordEvent(this.db, { kind: "JOB_CREATED", entityType: "job", entityId: jobId, payload: { baseSha, mode } });
    return this.getJob(jobId);
  }

  async createJob({ projectId, goal, mode = "write", maxAttempts = 2 }) {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Unknown project: ${projectId}`);
    if (!['read', 'write'].includes(mode)) throw new Error("mode must be read or write");
    const baseSha = await resolveRevision(project.repo_path, project.integration_branch);
    return transaction(this.db, () => this.insertJobRow({ projectId, goal, mode, maxAttempts, baseSha }));
  }

  // --- Proposal-only work authority -------------------------------------------------------------
  // A work proposal is a bounded request, never authority. Creating one has no side effect on any
  // job/attempt lifecycle; only an operator authorization turns a proposal into a job.

  // Digest of the requested action only. The expiry is deliberately excluded: it may be defaulted
  // from the clock, and including it would make two identical retries hash differently and defeat
  // the idempotency key.
  workActionDigest({ projectId, goal, mode, maximumCost, expectedStateVersion }) {
    return crypto.createHash("sha256").update(JSON.stringify([
      projectId, goal, mode, maximumCost ?? null, expectedStateVersion ?? null,
    ])).digest("hex");
  }

  // The state version a proposal is written against. A proposal that expected a different world than
  // the one the operator is authorizing in must not silently execute.
  projectStateVersion(projectId) {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS jobs, MAX(updated_at) AS latest FROM jobs WHERE project_id = ?",
    ).get(projectId);
    return crypto.createHash("sha256")
      .update(JSON.stringify([projectId, row.jobs, row.latest || null]))
      .digest("hex")
      .slice(0, 16);
  }

  proposeWork({
    projectId, goal, mode = "write", maximumCost = null, expiresAt = null,
    expectedStateVersion = null, idempotencyKey, principal, origin,
  }) {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Unknown project: ${projectId}`);
    if (!["read", "write"].includes(mode)) throw new Error("mode must be read or write");
    if (typeof goal !== "string" || !goal.trim()) throw new Error("goal must be a non-empty string");
    if (!idempotencyKey || typeof idempotencyKey !== "string") throw new Error("idempotency_key is required");
    if (!principal || !origin) throw new Error("Proposal origin identity is required");
    if (maximumCost !== null && !(Number.isFinite(maximumCost) && maximumCost > 0)) {
      throw new Error("maximum_cost must be a positive number when supplied");
    }

    // A proposal without an expiry would be indefinitely authorizable; default to a bounded window.
    const expiry = expiresAt || new Date(Date.now() + 3600_000).toISOString();
    if (Number.isNaN(Date.parse(expiry))) throw new Error("expires_at must be an ISO timestamp");

    const stateVersion = expectedStateVersion || this.projectStateVersion(projectId);
    const actionDigest = this.workActionDigest({
      projectId, goal: goal.trim(), mode, maximumCost, expectedStateVersion: stateVersion,
    });

    const proposalId = id("wprop");
    const timestamp = now();
    // Lookup and insert share one BEGIN IMMEDIATE so two simultaneous identical requests both
    // resolve to the same proposal identity, rather than one winning and the other seeing a
    // uniqueness error.
    return transaction(this.db, () => {
      const existing = this.db.prepare("SELECT * FROM work_proposals WHERE idempotency_key = ?").get(idempotencyKey);
      if (existing) {
        if (existing.action_digest !== actionDigest) {
          throw new Error(`idempotency_key ${idempotencyKey} was already used for a different proposal`);
        }
        return this.getWorkProposal(existing.id);
      }
      this.db.prepare(`INSERT INTO work_proposals(
        id, project_id, goal, mode, action_digest, expected_state_version, maximum_cost,
        expires_at, idempotency_key, origin_principal, origin_channel, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        proposalId, projectId, goal.trim(), mode, actionDigest, stateVersion,
        maximumCost, expiry, idempotencyKey, principal, origin, timestamp,
      );
      recordEvent(this.db, {
        kind: "WORK_PROPOSED", entityType: "work_proposal", entityId: proposalId,
        payload: { projectId, mode, origin, principal },
      });
      return this.getWorkProposal(proposalId);
    });
  }

  getWorkProposal(proposalId) {
    const proposal = this.db.prepare("SELECT * FROM work_proposals WHERE id = ?").get(proposalId);
    if (!proposal) return null;
    const decision = this.db.prepare("SELECT * FROM work_proposal_decisions WHERE proposal_id = ?").get(proposalId);
    return { ...proposal, decision: decision || null, state: decision ? decision.decision : "PENDING" };
  }

  listWorkProposals(projectId = null) {
    const rows = projectId
      ? this.db.prepare("SELECT id FROM work_proposals WHERE project_id = ? ORDER BY created_at DESC").all(projectId)
      : this.db.prepare("SELECT id FROM work_proposals ORDER BY created_at DESC").all();
    return rows.map((row) => this.getWorkProposal(row.id));
  }

  // The human gate. Turns one exact proposal into one job, under operator identity, and refuses
  // anything the proposal did not already bound.
  assertAuthorizable(proposal) {
    if (Date.parse(proposal.expires_at) <= Date.now()) {
      throw new Error(`Work proposal ${proposal.id} expired at ${proposal.expires_at}`);
    }
    const currentVersion = this.projectStateVersion(proposal.project_id);
    if (proposal.expected_state_version !== currentVersion) {
      throw new Error(
        `Work proposal ${proposal.id} expected state version ${proposal.expected_state_version} `
        + `but the project is at ${currentVersion}`,
      );
    }
    // Re-derive the digest so a tampered stored row cannot authorize different work than proposed.
    const expected = this.workActionDigest({
      projectId: proposal.project_id, goal: proposal.goal, mode: proposal.mode,
      maximumCost: proposal.maximum_cost, expectedStateVersion: proposal.expected_state_version,
    });
    if (expected !== proposal.action_digest) {
      throw new Error(`Work proposal ${proposal.id} action digest does not match its stored intent`);
    }
  }

  // The job and the decision that authorizes it MUST commit together. If they did not, a failure
  // between them would leave a durable unauthorized job, and that orphan would move
  // projectStateVersion() so the proposal could never be authorized again -- permanently stranded,
  // not merely uncommitted. Git I/O happens before the transaction; every check is then re-run
  // inside it so a concurrent authorization cannot interleave.
  async authorizeWorkProposal({ proposalId, principal, origin, maxAttempts = 2 }) {
    const preliminary = this.getWorkProposal(proposalId);
    if (!preliminary) throw new Error(`Unknown work proposal: ${proposalId}`);
    if (!principal || !origin) throw new Error("Authorizing identity is required");
    if (preliminary.decision) {
      if (preliminary.decision.decision === "AUTHORIZED") return preliminary;
      throw new Error(`Work proposal ${proposalId} was already rejected`);
    }
    this.assertAuthorizable(preliminary);

    const project = this.getProject(preliminary.project_id);
    if (!project) throw new Error(`Unknown project: ${preliminary.project_id}`);
    // Async Git resolution must happen outside the transaction.
    const baseSha = await resolveRevision(project.repo_path, project.integration_branch);

    return transaction(this.db, () => {
      // Re-read under BEGIN IMMEDIATE: a concurrent request may have decided this proposal since
      // the checks above. The loser returns the winner's job rather than creating a second one.
      const proposal = this.getWorkProposal(proposalId);
      if (proposal.decision) {
        if (proposal.decision.decision === "AUTHORIZED") return this.getWorkProposal(proposalId);
        throw new Error(`Work proposal ${proposalId} was already rejected`);
      }
      this.assertAuthorizable(proposal);

      const job = this.insertJobRow({
        projectId: proposal.project_id, goal: proposal.goal, mode: proposal.mode, maxAttempts, baseSha,
      });
      this.db.prepare(`INSERT INTO work_proposal_decisions(
        proposal_id, decision, job_id, decided_by, decided_origin, action_digest, created_at
      ) VALUES (?, 'AUTHORIZED', ?, ?, ?, ?, ?)`).run(
        proposalId, job.id, principal, origin, proposal.action_digest, now(),
      );
      recordEvent(this.db, {
        kind: "WORK_PROPOSAL_AUTHORIZED", entityType: "work_proposal", entityId: proposalId,
        payload: { jobId: job.id, decidedBy: principal },
      });
      return this.getWorkProposal(proposalId);
    });
  }

  rejectWorkProposal({ proposalId, principal, origin }) {
    const proposal = this.getWorkProposal(proposalId);
    if (!proposal) throw new Error(`Unknown work proposal: ${proposalId}`);
    if (!principal || !origin) throw new Error("Deciding identity is required");
    if (proposal.decision) {
      if (proposal.decision.decision === "REJECTED") return this.getWorkProposal(proposalId);
      throw new Error(`Work proposal ${proposalId} was already authorized`);
    }
    return transaction(this.db, () => {
      this.db.prepare(`INSERT INTO work_proposal_decisions(
        proposal_id, decision, decided_by, decided_origin, action_digest, created_at
      ) VALUES (?, 'REJECTED', ?, ?, ?, ?)`).run(
        proposalId, principal, origin, proposal.action_digest, now(),
      );
      recordEvent(this.db, {
        kind: "WORK_PROPOSAL_REJECTED", entityType: "work_proposal", entityId: proposalId,
        payload: { decidedBy: principal },
      });
      return this.getWorkProposal(proposalId);
    });
  }

  getJob(jobId) {
    return this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
  }

  listJobs(projectId = null) {
    if (projectId) return this.db.prepare("SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at DESC").all(projectId);
    return this.db.prepare("SELECT * FROM jobs ORDER BY created_at DESC").all();
  }

  // Work proposals awaiting an operator decision. Excludes expired ones, which can no longer be
  // authorized and would otherwise accumulate as permanent noise.
  pendingWorkProposals() {
    return this.db.prepare(`SELECT p.* FROM work_proposals p
      LEFT JOIN work_proposal_decisions d ON d.proposal_id = p.id
      WHERE d.proposal_id IS NULL AND p.expires_at > ?
      ORDER BY p.created_at`).all(now());
  }

  attention() {
    const jobs = this.db.prepare(`SELECT * FROM jobs
      WHERE status IN ('NEEDS_ATTENTION', 'READY_FOR_INTEGRATION')
      ORDER BY updated_at`).all();
    const unresolvedIntegrations = this.doctor().unresolved_integrations;
    // A proposal nobody can see is a proposal nobody acts on: surface it in the normal path rather
    // than only under an explicit `proposal list`.
    return {
      jobs,
      unresolved_integrations: unresolvedIntegrations,
      work_proposals_awaiting_decision: this.pendingWorkProposals(),
    };
  }

  overview() {
    const doctor = this.doctor();
    const projectTotal = this.db.prepare("SELECT COUNT(*) AS count FROM projects").get().count;
    const jobTotals = this.db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN status = 'NEEDS_ATTENTION' THEN 1 ELSE 0 END), 0) AS needs_attention,
      COALESCE(SUM(CASE WHEN status = 'READY_FOR_INTEGRATION' THEN 1 ELSE 0 END), 0) AS ready_for_integration
      FROM jobs`).get();
    const unresolvedIntegrations = doctor.unresolved_integrations.length;
    const activeAttempts = doctor.running_attempts.length;
    const pendingProposalTotal = this.db.prepare(`SELECT COUNT(*) AS count FROM work_proposals w
      LEFT JOIN work_proposal_decisions d ON d.proposal_id = w.id
      WHERE d.proposal_id IS NULL AND w.expires_at > ?`).get(now()).count;
    const projects = this.db.prepare(`SELECT
        p.id,
        p.name,
        p.integration_branch,
        (SELECT j.id FROM jobs j WHERE j.project_id = p.id ORDER BY j.updated_at DESC, j.id DESC LIMIT 1) AS latest_job_id,
        (SELECT j.status FROM jobs j WHERE j.project_id = p.id ORDER BY j.updated_at DESC, j.id DESC LIMIT 1) AS latest_job_status,
        (SELECT j.updated_at FROM jobs j WHERE j.project_id = p.id ORDER BY j.updated_at DESC, j.id DESC LIMIT 1) AS latest_job_updated_at,
        (SELECT COUNT(*) FROM jobs j WHERE j.project_id = p.id AND j.status = 'NEEDS_ATTENTION') AS needs_attention,
        (SELECT COUNT(*) FROM jobs j WHERE j.project_id = p.id AND j.status = 'READY_FOR_INTEGRATION') AS ready_for_integration
      FROM projects p
      ORDER BY (needs_attention + ready_for_integration) DESC,
        COALESCE(latest_job_updated_at, p.created_at) DESC,
        p.id
      LIMIT ?`).all(OVERVIEW_PROJECT_LIMIT).map((project) => ({
      id: project.id,
      name: project.name,
      integration_branch: project.integration_branch,
      latest_job: project.latest_job_id ? {
        id: project.latest_job_id,
        status: project.latest_job_status,
        updated_at: project.latest_job_updated_at,
      } : null,
      needs_attention: project.needs_attention,
      ready_for_integration: project.ready_for_integration,
    }));
    const attention = this.db.prepare(`SELECT kind, id, project_id, project_name, status, summary, updated_at
      FROM (
        SELECT
          'integration' AS kind,
          o.id AS id,
          p.project_id AS project_id,
          projects.name AS project_name,
          'UNRESOLVED_INTEGRATION' AS status,
          'Integration operation requires deterministic reconciliation' AS summary,
          o.created_at AS updated_at,
          0 AS priority
        FROM integration_operations o
        JOIN integration_proposals p ON p.id = o.proposal_id
        JOIN projects ON projects.id = p.project_id
        WHERE NOT EXISTS (
          SELECT 1 FROM integration_records r
          WHERE r.operation_id = o.id
            AND r.kind IN ('INTEGRATION_SUCCEEDED', 'INTEGRATION_FAILED')
        )
        UNION ALL
        SELECT
          'work_proposal' AS kind,
          w.id AS id,
          w.project_id AS project_id,
          projects.name AS project_name,
          'AWAITING_DECISION' AS status,
          substr(w.goal, 1, ?) AS summary,
          w.created_at AS updated_at,
          0 AS priority
        FROM work_proposals w
        JOIN projects ON projects.id = w.project_id
        LEFT JOIN work_proposal_decisions d ON d.proposal_id = w.id
        WHERE d.proposal_id IS NULL AND w.expires_at > ?
        UNION ALL
        SELECT
          'job' AS kind,
          j.id AS id,
          j.project_id AS project_id,
          p.name AS project_name,
          j.status AS status,
          substr(j.goal, 1, ?) AS summary,
          j.updated_at AS updated_at,
          CASE WHEN j.status = 'NEEDS_ATTENTION' THEN 1 ELSE 2 END AS priority
        FROM jobs j JOIN projects p ON p.id = j.project_id
        WHERE j.status IN ('NEEDS_ATTENTION', 'READY_FOR_INTEGRATION')
      )
      ORDER BY priority, updated_at DESC, id
      LIMIT ?`)
      // Bind order follows the UNION branches: work-proposal summary/expiry, then job summary.
      .all(OVERVIEW_SUMMARY_LIMIT, now(), OVERVIEW_SUMMARY_LIMIT, OVERVIEW_ATTENTION_LIMIT)
      .map((item) => ({
      ...item,
      summary: compactOverviewText(item.summary),
    }));
    const totalAttention = jobTotals.needs_attention + jobTotals.ready_for_integration
      + unresolvedIntegrations + pendingProposalTotal;
    const overview = {
      schema_version: 1,
      health: {
        healthy: doctor.healthy,
        unresolved_integrations: unresolvedIntegrations,
        active_attempts: activeAttempts,
        missing_repositories: doctor.missing_repositories.length,
      },
      totals: {
        projects: projectTotal,
        jobs_needing_attention: jobTotals.needs_attention,
        jobs_ready_for_integration: jobTotals.ready_for_integration,
        proposals_awaiting_decision: pendingProposalTotal,
      },
      projects,
      attention,
      truncated: projectTotal > projects.length || totalAttention > attention.length,
    };
    while (Buffer.byteLength(JSON.stringify(overview), "utf8") > OVERVIEW_BYTE_LIMIT) {
      overview.truncated = true;
      const nonActionable = overview.projects.findLastIndex(
        (project) => project.needs_attention === 0 && project.ready_for_integration === 0,
      );
      if (nonActionable >= 0) overview.projects.splice(nonActionable, 1);
      else if (overview.attention.length) overview.attention.pop();
      else if (overview.projects.length) overview.projects.pop();
      else throw new Error("Overview metadata exceeds its serialized size limit");
    }
    return overview;
  }

  // Deterministic worker routing. A job that names no model resolves to the default here, before the
  // attempt row is written, so the resolved provider/model is persisted as evidence and OpenCode is
  // always given an explicit --model. The executor's ambient default provider is never reachable.
  resolveModel(model = null) {
    const resolved = model || DEFAULT_WORKER_MODEL;
    if (typeof resolved !== "string" || !resolved.includes("/")) {
      throw new Error(`Worker model must be a provider-qualified identifier, got: ${resolved}`);
    }
    return resolved;
  }

  async runJob(jobId, { model = null } = {}) {
    model = this.resolveModel(model);
    const job = this.getJob(jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);
    if (!['PENDING', 'NEEDS_ATTENTION'].includes(job.status)) throw new Error(`Job ${jobId} is ${job.status}`);
    const project = this.getProject(job.project_id);
    const validationPlan = job.mode === "write" ? parseValidationPlan(project.validation_json) : [];
    const claim = transaction(this.db, () => {
      const current = this.getJob(jobId);
      if (!current || !['PENDING', 'NEEDS_ATTENTION'].includes(current.status)) {
        throw new Error(`Job ${jobId} cannot be claimed from ${current?.status ?? "missing"}`);
      }
      const runningJob = this.db.prepare("SELECT id FROM jobs WHERE status = 'RUNNING' LIMIT 1").get();
      if (runningJob) throw new Error(`Bootstrap scheduler already has running job ${runningJob.id}`);
      const conflict = this.db.prepare(`SELECT id FROM attempts WHERE ${lifecycleActive()} LIMIT 1`).get();
      if (conflict) throw new Error(`Bootstrap scheduler already has live attempt ${conflict.id}`);
      const previousAttempts = this.db.prepare("SELECT COUNT(*) AS count FROM attempts WHERE job_id = ?").get(jobId).count;
      if (previousAttempts >= current.max_attempts) throw new Error(`Job ${jobId} exhausted its ${current.max_attempts} attempts`);
      const ordinal = previousAttempts + 1;
      const attemptId = `${job.id}.${ordinal}`;
      const worktreePath = path.join(this.paths.worktrees, project.id, `attempt-${ordinal}-${job.id.slice(-8)}`);
      const currentEpoch = Number(this.db.prepare("SELECT value FROM metadata WHERE key = 'scheduler_epoch'").get().value);
      const epoch = currentEpoch + 1;
      this.db.prepare("UPDATE metadata SET value = ? WHERE key = 'scheduler_epoch'").run(String(epoch));
      this.db.prepare(`INSERT INTO attempts(
        id, job_id, ordinal, scheduler_epoch, backend, model, scheduler_pid, worktree_path, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        attemptId, jobId, ordinal, epoch, this.backend.constructor.name, model, process.pid, worktreePath, now(),
      );
      this.db.prepare("UPDATE jobs SET status = 'RUNNING', updated_at = ? WHERE id = ?").run(now(), jobId);
      recordEvent(this.db, { kind: "ATTEMPT_CREATED", entityType: "attempt", entityId: attemptId, epoch });
      return { epoch, ordinal, attemptId, worktreePath };
    });
    const { epoch, attemptId, worktreePath } = claim;
    const artifactDir = path.join(this.paths.artifacts, project.id, attemptId);
    fs.mkdirSync(artifactDir, { recursive: true });
    let executorIntentId = null;

    try {
      await createDetachedWorktree(project.repo_path, worktreePath, job.base_sha);
      executorIntentId = id("executor");
      this.acceptAttemptEvent(attemptId, epoch, () => {
        this.db.prepare("UPDATE attempts SET executor_intent_id = ?, executor_pid = NULL WHERE id = ?").run(executorIntentId, attemptId);
        recordEvent(this.db, { kind: "EXECUTOR_INTENDED", entityType: "attempt", entityId: attemptId, epoch, payload: { executorIntentId } });
      }, { terminalState: null, validationState: "NOT_RUN" });
      const backendResult = await this.backend.run({
        attemptId, worktreePath, artifactDir, goal: job.goal, model, mode: job.mode,
        onSpawn: (pid) => this.recordExecutorPid(attemptId, epoch, executorIntentId, pid),
      });
      // Record usage before any failure becomes a lifecycle outcome. A timeout, nonzero exit,
      // protected-path rejection, empty diff, or failed validation still consumed tokens, and those
      // attempts belong in the denominator of cost per validated candidate.
      this.recordAttemptUsage({ attemptId, artifactDir, model, backendResult });

      if (backendResult.timedOut) throw new Error("worker timeout");
      if (backendResult.exitCode !== 0) throw new Error(`worker exited ${backendResult.exitCode}: ${backendResult.stderr?.slice(-2000) ?? ""}`);

      const files = await changedFiles(worktreePath);
      this.assertAllowedDiff(files, parseJson(project.protected_json));
      let resultCommit = null;
      if (job.mode === "write") {
        if (files.length === 0) throw new Error("worker completed without changing files");
        resultCommit = await commitAll(worktreePath, `delegate-wave: ${job.goal.slice(0, 72)} (${attemptId})`);
      }

      this.acceptAttemptEvent(attemptId, epoch, (attempt) => {
        if (attempt.executor_intent_id !== executorIntentId) {
          throw new Error(`Stale executor result rejected for ${attemptId}`);
        }
        this.db.prepare(`UPDATE attempts SET terminal_state = 'SUCCEEDED', validation_state = 'PENDING',
          executor_intent_id = NULL, executor_pid = NULL, finished_at = ?, exit_code = 0,
          result_commit = ? WHERE id = ?`).run(now(), resultCommit, attemptId);
        recordEvent(this.db, { kind: "EXECUTOR_SUCCEEDED", entityType: "attempt", entityId: attemptId, epoch, payload: { executorIntentId, files, resultCommit } });
      }, { terminalState: null, validationState: "NOT_RUN" });

      for (const command of validationPlan) await this.validate(attemptId, epoch, worktreePath, artifactDir, command);

      this.acceptAttemptEvent(attemptId, epoch, () => {
        this.db.prepare("UPDATE attempts SET validation_state = 'PASSED' WHERE id = ?").run(attemptId);
        this.db.prepare("UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?").run(
          job.mode === "write" ? "READY_FOR_INTEGRATION" : "SUCCEEDED", now(), jobId,
        );
        recordEvent(this.db, { kind: "VALIDATION_PASSED", entityType: "job", entityId: jobId, epoch });
      }, { terminalState: "SUCCEEDED", validationState: "PENDING" });
      return this.status(jobId);
    } catch (error) {
      await this.failAttempt({ attemptId, jobId, epoch, project, worktreePath, executorIntentId, error });
      return this.status(jobId);
    }
  }

  assertAllowedDiff(files, protectedPaths) {
    for (const file of files) {
      if (file === ".git" || file.startsWith(".git/")) throw new Error(`Git metadata change rejected: ${file}`);
      const blocked = protectedPaths.find((item) => {
        const normalized = item.replaceAll("\\", "/").replace(/\*\*?$/, "");
        return file === normalized.replace(/\/$/, "") || file.startsWith(normalized);
      });
      if (blocked) throw new Error(`Protected path changed: ${file} (rule ${blocked})`);
    }
  }

  acceptAttemptEvent(attemptId, epoch, action, expected = { terminalState: null }) {
    return transaction(this.db, () => {
      const attempt = this.db.prepare("SELECT * FROM attempts WHERE id = ?").get(attemptId);
      const currentEpoch = Number(this.db.prepare("SELECT value FROM metadata WHERE key = 'scheduler_epoch'").get().value);
      const terminalMatches = attempt?.terminal_state === (expected.terminalState ?? null);
      const validationMatches = expected.validationState === undefined || attempt?.validation_state === expected.validationState;
      if (!attempt || attempt.scheduler_epoch !== epoch || currentEpoch !== epoch || !terminalMatches || !validationMatches) {
        throw new Error(`Stale or terminal attempt event rejected for ${attemptId}`);
      }
      return action(attempt);
    });
  }

  recordExecutorPid(attemptId, epoch, executorIntentId, pid) {
    this.acceptAttemptEvent(attemptId, epoch, (attempt) => {
      if (attempt.executor_intent_id !== executorIntentId) {
        throw new Error(`Stale executor start rejected for ${attemptId}`);
      }
      this.db.prepare("UPDATE attempts SET executor_pid = ? WHERE id = ?").run(pid, attemptId);
      recordEvent(this.db, { kind: "EXECUTOR_STARTED", entityType: "attempt", entityId: attemptId, epoch, payload: { executorIntentId, pid } });
    }, { terminalState: null, validationState: "NOT_RUN" });
  }

  recordValidationPid(attemptId, epoch, validationId, pid) {
    this.acceptAttemptEvent(attemptId, epoch, (attempt) => {
      if (attempt.validation_intent_id !== validationId) {
        throw new Error(`Stale validation start rejected for ${attemptId}`);
      }
      this.db.prepare("UPDATE attempts SET validation_pid = ? WHERE id = ?").run(pid, attemptId);
      recordEvent(this.db, { kind: "VALIDATION_STARTED", entityType: "attempt", entityId: attemptId, epoch, payload: { validationId, pid } });
    }, { terminalState: "SUCCEEDED", validationState: "PENDING" });
  }

  // Persists one immutable usage receipt per attempt. Evidence only: it never affects acceptance.
  //
  // Failures here are swallowed deliberately. Losing an observation must not fail an attempt that
  // otherwise succeeded, and re-recording is a no-op so a retry cannot double-count usage.
  recordAttemptUsage({ attemptId, artifactDir, model, backendResult = null, backend = this.backend }) {
    try {
      if (this.db.prepare("SELECT 1 FROM attempt_usage_receipts WHERE attempt_id = ?").get(attemptId)) return null;
      const backendName = backend?.constructor?.name ?? "UnknownBackend";
      const receipt = buildUsageReceipt({
        attemptId,
        backend: backendName,
        model,
        artifactPath: artifactDir ? path.join(artifactDir, "opencode-events.jsonl") : null,
        format: "opencode-events-jsonl",
      });
      // A backend may report usage directly rather than through an artifact; prefer that when given.
      if (backendResult?.usage) {
        Object.assign(receipt, backendResult.usage, { attempt_id: attemptId, source_backend: backendName });
      }
      this.db.prepare(`INSERT INTO attempt_usage_receipts(
        attempt_id, status, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens,
        cache_write_tokens, provider_steps, provider_reported_cost_usd, reference_cost_usd,
        pricing_basis_id, source_backend, source_artifact, source_format, malformed_events, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        receipt.attempt_id, receipt.status, receipt.input_tokens, receipt.output_tokens,
        receipt.reasoning_tokens, receipt.cache_read_tokens, receipt.cache_write_tokens,
        receipt.provider_steps, receipt.provider_reported_cost_usd, receipt.reference_cost_usd,
        receipt.pricing_basis_id, receipt.source_backend, receipt.source_artifact,
        receipt.source_format, receipt.malformed_events, receipt.observed_at,
      );
      return receipt;
    } catch {
      return null;
    }
  }

  getAttemptUsage(attemptId) {
    return this.db.prepare("SELECT * FROM attempt_usage_receipts WHERE attempt_id = ?").get(attemptId) ?? null;
  }

  async validate(attemptId, epoch, worktreePath, artifactDir, command) {
    const validationId = id("validation");
    const startedAt = now();
    this.acceptAttemptEvent(attemptId, epoch, () => {
      this.db.prepare("UPDATE attempts SET validation_intent_id = ?, validation_pid = NULL WHERE id = ?").run(validationId, attemptId);
      recordEvent(this.db, { kind: "VALIDATION_INTENDED", entityType: "attempt", entityId: attemptId, epoch, payload: { validationId, command } });
    }, { terminalState: "SUCCEEDED", validationState: "PENDING" });
    const result = await runShell(command, {
      cwd: worktreePath,
      timeoutMs: 15 * 60_000,
      onSpawn: (pid) => this.recordValidationPid(attemptId, epoch, validationId, pid),
    });
    const outputPath = path.join(artifactDir, `${validationId}.log`);
    fs.writeFileSync(outputPath, `${result.stdout}\n${result.stderr}`, { flag: "wx" });
    this.acceptAttemptEvent(attemptId, epoch, (attempt) => {
      if (attempt.validation_intent_id !== validationId) {
        throw new Error(`Stale validation result rejected for ${attemptId}`);
      }
      this.db.prepare(`INSERT INTO validation_runs(
        id, attempt_id, command, exit_code, output_path, started_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        validationId, attemptId, command, result.exitCode, outputPath, startedAt, now(),
      );
      this.db.prepare("UPDATE attempts SET validation_intent_id = NULL, validation_pid = NULL WHERE id = ?").run(attemptId);
      recordEvent(this.db, { kind: "VALIDATION_FINISHED", entityType: "attempt", entityId: attemptId, epoch, payload: { command, exitCode: result.exitCode } });
    }, { terminalState: "SUCCEEDED", validationState: "PENDING" });
    if (result.exitCode !== 0) throw new Error(`validation failed (${result.exitCode}): ${command}`);
  }

  async failAttempt({ attemptId, jobId, epoch, project, worktreePath, executorIntentId = null, error }) {
    const message = error instanceof Error ? error.message : String(error);
    const signature = normalizeFailureSignature(message);
    const applied = transaction(this.db, () => {
      const attempt = this.db.prepare("SELECT * FROM attempts WHERE id = ?").get(attemptId);
      const currentEpoch = Number(this.db.prepare("SELECT value FROM metadata WHERE key = 'scheduler_epoch'").get().value);
      if (!attempt || attempt.scheduler_epoch !== epoch || currentEpoch !== epoch) return false;
      if (attempt && attempt.scheduler_epoch === epoch && attempt.terminal_state === null) {
        if (attempt.executor_intent_id !== executorIntentId) return false;
        this.db.prepare(`UPDATE attempts SET terminal_state = 'FAILED', finished_at = ?,
          executor_intent_id = NULL, executor_pid = NULL, failure_signature = ?,
          quarantined = 1, worktree_locked = 1 WHERE id = ?`).run(now(), signature, attemptId);
      } else if (attempt.terminal_state === 'SUCCEEDED' && attempt.validation_state === 'PENDING') {
        this.db.prepare(`UPDATE attempts SET validation_state = 'FAILED',
          failure_signature = ?, quarantined = 1, worktree_locked = 1 WHERE id = ?`).run(signature, attemptId);
      } else return false;
      const count = this.db.prepare("SELECT COUNT(*) AS count FROM attempts WHERE job_id = ?").get(jobId).count;
      const job = this.getJob(jobId);
      const nextStatus = count >= job.max_attempts ? "NEEDS_ATTENTION" : "PENDING";
      this.db.prepare("UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?").run(nextStatus, now(), jobId);
      recordEvent(this.db, { kind: "ATTEMPT_FAILED", entityType: "attempt", entityId: attemptId, epoch, payload: { message, signature } });
      return true;
    });
    if (!applied) return false;
    try {
      if (fs.existsSync(worktreePath)) await lockWorktree(project.repo_path, worktreePath, `quarantined ${attemptId}`);
    } catch { /* database quarantine is authoritative; doctor reports filesystem drift */ }
    return true;
  }

  status(jobId) {
    const job = this.getJob(jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);
    const attempts = this.db.prepare("SELECT * FROM attempts WHERE job_id = ? ORDER BY ordinal").all(jobId);
    const validations = this.db.prepare(`SELECT v.* FROM validation_runs v
      JOIN attempts a ON a.id = v.attempt_id WHERE a.job_id = ? ORDER BY v.started_at`).all(jobId);
    return { job, attempts, validations };
  }

  planDigest(commands) {
    const canonical = commands.map((command) => String(command)).join("\n");
    return crypto.createHash("sha256").update(canonical).digest("hex");
  }

  actionDigest(fields) {
    const canonical = [
      fields.projectId, fields.jobId, fields.attemptId, fields.baseSha,
      fields.candidateCommit, fields.integrationBranch, fields.expectedHead, fields.planDigest,
    ].join("\n");
    return crypto.createHash("sha256").update(canonical).digest("hex");
  }

  getProposal(proposalId) {
    return this.db.prepare("SELECT * FROM integration_proposals WHERE id = ?").get(proposalId);
  }

  listProposals(jobId = null) {
    if (jobId) return this.db.prepare("SELECT * FROM integration_proposals WHERE job_id = ? ORDER BY created_at DESC").all(jobId);
    return this.db.prepare("SELECT * FROM integration_proposals ORDER BY created_at DESC").all();
  }

  listApprovals(proposalId = null) {
    if (proposalId) return this.db.prepare("SELECT * FROM approval_receipts WHERE proposal_id = ? ORDER BY granted_at").all(proposalId);
    return this.db.prepare("SELECT * FROM approval_receipts ORDER BY granted_at").all();
  }

  async proposeIntegration({ jobId }) {
    const job = this.getJob(jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);
    if (job.mode !== "write") throw new Error(`Job ${jobId} is a ${job.mode} job; only write jobs can be proposed`);
    if (job.status !== "READY_FOR_INTEGRATION") {
      throw new Error(`Job ${jobId} is ${job.status}, expected READY_FOR_INTEGRATION`);
    }
    const candidates = this.db.prepare(
      "SELECT * FROM attempts WHERE job_id = ? AND terminal_state = 'SUCCEEDED' AND validation_state = 'PASSED' ORDER BY ordinal",
    ).all(jobId);
    if (candidates.length !== 1) {
      throw new Error(`Job ${jobId} must have exactly one SUCCEEDED/PASSED candidate attempt, found ${candidates.length}`);
    }
    const candidate = candidates[0];
    if (!candidate.result_commit) throw new Error(`Candidate attempt ${candidate.id} has no result commit`);
    const project = this.getProject(job.project_id);
    const expectedHead = await resolveRevision(project.repo_path, project.integration_branch);
    const planCommands = parseValidationPlan(project.validation_json);
    const planJson = JSON.stringify(planCommands);
    const planDigest = this.planDigest(planCommands);
    const digest = this.actionDigest({
      projectId: project.id, jobId, attemptId: candidate.id,
      baseSha: job.base_sha, candidateCommit: candidate.result_commit,
      integrationBranch: project.integration_branch, expectedHead, planDigest,
    });
    return transaction(this.db, () => {
      const existing = this.db.prepare("SELECT * FROM integration_proposals WHERE attempt_id = ?").get(candidate.id);
      if (existing) {
        if (existing.action_digest !== digest) {
          throw new Error(`Existing proposal ${existing.id} has a different action digest for attempt ${candidate.id}`);
        }
        if (existing.validation_plan_digest !== planDigest) {
          throw new Error(`Existing proposal ${existing.id} has a different validation plan digest for attempt ${candidate.id}`);
        }
        return existing;
      }
      const proposalId = id("proposal");
      const timestamp = now();
      this.db.prepare(`INSERT INTO integration_proposals(
        id, project_id, job_id, attempt_id, base_sha, candidate_commit, integration_branch,
        expected_integration_head, validation_plan_json, validation_plan_digest, action_digest,
        state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?)`).run(
        proposalId, project.id, jobId, candidate.id, job.base_sha, candidate.result_commit,
        project.integration_branch, expectedHead, planJson, planDigest, digest, timestamp, timestamp,
      );
      recordEvent(this.db, {
        kind: "INTEGRATION_PROPOSED", entityType: "proposal", entityId: proposalId,
        payload: { jobId, attemptId: candidate.id, digest },
      });
      return this.getProposal(proposalId);
    });
  }

  grantApproval({ proposalId, principal, origin, expiresAt = null, idempotencyKey = null, maximumCost = null }) {
    const proposal = this.getProposal(proposalId);
    if (!proposal) throw new Error(`Unknown integration proposal: ${proposalId}`);
    const integrated = this.db.prepare(
      "SELECT 1 FROM integration_records WHERE proposal_id = ? AND kind = 'PROPOSAL_INTEGRATED' LIMIT 1",
    ).get(proposalId);
    if (integrated) throw new Error(`Proposal ${proposalId} is INTEGRATED`);
    if (!principal || !principal.trim()) throw new Error("principal is required");
    if (!origin || !origin.trim()) throw new Error("origin is required");
    if (maximumCost !== null && (!Number.isFinite(Number(maximumCost)) || Number(maximumCost) < 0)) {
      throw new Error("maximumCost must be a non-negative number");
    }
    if (expiresAt) {
      const parsed = new Date(expiresAt);
      if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid --expires-at: ${expiresAt}`);
      if (parsed.getTime() <= Date.now()) throw new Error(`Approval already expired at ${parsed.toISOString()}`);
      expiresAt = parsed.toISOString();
    }
    return transaction(this.db, () => {
      const integratedNow = this.db.prepare(
        "SELECT 1 FROM integration_records WHERE proposal_id = ? AND kind = 'PROPOSAL_INTEGRATED' LIMIT 1",
      ).get(proposalId);
      if (integratedNow) throw new Error(`Proposal ${proposalId} is INTEGRATED`);
      if (idempotencyKey) {
        const keyed = this.db.prepare("SELECT * FROM approval_receipts WHERE idempotency_key = ?").get(idempotencyKey);
        if (keyed) {
          if (keyed.proposal_id !== proposalId || keyed.granted_digest !== proposal.action_digest) {
            throw new Error(`Idempotency key ${idempotencyKey} was already used for a different approval`);
          }
          return keyed;
        }
      }
      const existing = this.db.prepare(`SELECT * FROM approval_receipts
        WHERE proposal_id = ? AND principal = ?
          AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY granted_at DESC LIMIT 1`).get(proposalId, principal, now());
      if (existing) {
        if (existing.granted_digest !== proposal.action_digest) {
          throw new Error(`Existing approval ${existing.id} grants a different digest`);
        }
        const consumed = this.db.prepare("SELECT 1 FROM integration_operations WHERE approval_receipt_id = ? LIMIT 1").get(existing.id);
        if (!consumed) return existing;
      }
      const receiptId = id("approval");
      this.db.prepare(`INSERT INTO approval_receipts(
        id, proposal_id, principal, origin, expires_at, idempotency_key, granted_digest,
        expected_state_version, granted_scope, maximum_cost, granted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'integration', ?, ?)`).run(
        receiptId, proposalId, principal, origin, expiresAt, idempotencyKey, proposal.action_digest,
        proposal.action_digest, maximumCost === null ? null : Number(maximumCost), now(),
      );
      recordEvent(this.db, {
        kind: "APPROVAL_GRANTED", entityType: "approval", entityId: receiptId,
        payload: { proposalId, principal, origin, digest: proposal.action_digest },
      });
      return this.db.prepare("SELECT * FROM approval_receipts WHERE id = ?").get(receiptId);
    });
  }

  recordIntegrationRecord(operationId, proposalId, kind, detail = "") {
    this.db.prepare(`INSERT INTO integration_records(operation_id, proposal_id, kind, detail, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(
      operationId, proposalId, kind, typeof detail === "string" ? detail : JSON.stringify(detail), now(),
    );
  }

  async runIntegrationValidation(commands, worktreePath, operationId, proposalId) {
    for (const command of commands) {
      const result = await runShell(command, { cwd: worktreePath, timeoutMs: 15 * 60_000 });
      this.recordIntegrationRecord(operationId, proposalId, "VALIDATION_RUN", `${command} => ${result.exitCode}`);
      if (result.exitCode !== 0) throw new Error(`integration validation failed (${result.exitCode}): ${command}`);
    }
    this.recordIntegrationRecord(operationId, proposalId, "VALIDATION_PASSED", String(commands.length));
  }

  async assertIntegrationHeadUnchanged(project, proposal, branchRef) {
    const checkedOut = (await listWorktrees(project.repo_path)).some((entry) => entry.branch === branchRef);
    if (checkedOut) {
      throw new Error(`Integration branch ${proposal.integration_branch} is checked out in another worktree`);
    }
    const currentHead = await resolveRevision(project.repo_path, proposal.integration_branch);
    if (currentHead !== proposal.expected_integration_head) {
      throw new Error(`Integration head changed: expected ${proposal.expected_integration_head}, found ${currentHead}`);
    }
  }

  async runIntegration(proposalId) {
    const proposal = this.getProposal(proposalId);
    if (!proposal) throw new Error(`Unknown integration proposal: ${proposalId}`);
    const project = this.getProject(proposal.project_id);
    if (!project) throw new Error(`Unknown project: ${proposal.project_id}`);

    const proposalIntegrated = this.db.prepare(
      "SELECT * FROM integration_records WHERE proposal_id = ? AND kind = 'PROPOSAL_INTEGRATED' ORDER BY sequence DESC LIMIT 1",
    ).get(proposalId);
    if (proposalIntegrated) return this.integrationStatus(proposalId);

    const operations = this.db.prepare(
      "SELECT * FROM integration_operations WHERE proposal_id = ? ORDER BY created_at",
    ).all(proposalId);
    if (operations.length > 0) {
      const last = operations[operations.length - 1];
      const terminal = this.db.prepare(
        "SELECT * FROM integration_records WHERE operation_id = ? AND kind IN ('INTEGRATION_SUCCEEDED', 'INTEGRATION_FAILED') ORDER BY sequence DESC LIMIT 1",
      ).get(last.id);
      if (!terminal) {
        throw new Error(`Integration operation ${last.id} is stuck without a terminal outcome`);
      }
      if (terminal.kind === "INTEGRATION_SUCCEEDED") {
        throw new Error(`Proposal ${proposalId} has a succeeded operation but no terminal proposal record`);
      }
    }

    const storedPlan = parseValidationPlan(proposal.validation_plan_json);
    const storedPlanDigest = this.planDigest(storedPlan);
    if (storedPlanDigest !== proposal.validation_plan_digest) {
      throw new Error(`Stored validation plan digest mismatch for proposal ${proposalId}`);
    }
    const recomputedAction = this.actionDigest({
      projectId: proposal.project_id, jobId: proposal.job_id, attemptId: proposal.attempt_id,
      baseSha: proposal.base_sha, candidateCommit: proposal.candidate_commit,
      integrationBranch: proposal.integration_branch, expectedHead: proposal.expected_integration_head,
      planDigest: storedPlanDigest,
    });
    if (recomputedAction !== proposal.action_digest) {
      throw new Error(`Action digest mismatch for proposal ${proposalId}`);
    }

    const claim = transaction(this.db, () => {
      const current = this.getProposal(proposalId);
      if (!current) throw new Error(`Proposal ${proposalId} no longer exists`);
      if (current.action_digest !== proposal.action_digest) {
        throw new Error(`Proposal ${proposalId} action digest mismatch`);
      }
      const integratedNow = this.db.prepare(
        "SELECT 1 FROM integration_records WHERE proposal_id = ? AND kind = 'PROPOSAL_INTEGRATED' LIMIT 1",
      ).get(proposalId);
      if (integratedNow) throw new Error(`Proposal ${proposalId} is already integrated`);
      const unresolved = this.db.prepare(`SELECT o.id, o.proposal_id
        FROM integration_operations o
        WHERE NOT EXISTS (
          SELECT 1 FROM integration_records r
          WHERE r.operation_id = o.id
            AND r.kind IN ('INTEGRATION_SUCCEEDED', 'INTEGRATION_FAILED')
        )
        ORDER BY o.created_at LIMIT 1`).get();
      if (unresolved) {
        throw new Error(`Integration operation ${unresolved.id} for proposal ${unresolved.proposal_id} is unresolved`);
      }
      const receipt = this.db.prepare(`SELECT r.* FROM approval_receipts r
        WHERE r.proposal_id = ?
          AND r.granted_digest = ?
          AND r.expected_state_version = ?
          AND r.granted_scope = 'integration'
          AND (r.expires_at IS NULL OR r.expires_at > ?)
          AND NOT EXISTS (
            SELECT 1 FROM integration_operations o WHERE o.approval_receipt_id = r.id
          )
        ORDER BY r.granted_at LIMIT 1`).get(
        proposalId, proposal.action_digest, proposal.action_digest, now(),
      );
      if (!receipt) throw new Error(`No unexpired unconsumed approval for proposal ${proposalId}`);
      const operationId = id("integration_op");
      const worktreePath = path.join(this.paths.integration, project.id, proposal.id);
      this.db.prepare(`INSERT INTO integration_operations(
        id, proposal_id, approval_receipt_id, action_digest, base_sha, candidate_commit,
        integration_branch, expected_integration_head, validation_plan_digest, state,
        worktree_path, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'INTENDED', ?, ?)`).run(
        operationId, proposalId, receipt.id, proposal.action_digest, proposal.base_sha,
        proposal.candidate_commit, proposal.integration_branch, proposal.expected_integration_head,
        proposal.validation_plan_digest, worktreePath, now(),
      );
      this.recordIntegrationRecord(operationId, proposalId, "INTEGRATION_STARTED", JSON.stringify({
        approvalId: receipt.id,
        baseSha: proposal.base_sha,
        candidateCommit: proposal.candidate_commit,
        integrationBranch: proposal.integration_branch,
        expectedHead: proposal.expected_integration_head,
        validationPlanDigest: proposal.validation_plan_digest,
      }));
      recordEvent(this.db, {
        kind: "INTEGRATION_INTENDED", entityType: "operation", entityId: operationId,
        payload: { proposalId, approvalId: receipt.id },
      });
      return { operationId, worktreePath };
    });

    const { operationId, worktreePath } = claim;
    const branchRef = `refs/heads/${proposal.integration_branch}`;
    let branchAdvanced = false;
    let branchOutcomeUncertain = false;
    try {
      await this.assertIntegrationHeadUnchanged(project, proposal, branchRef);
      if (!(await isAncestor(project.repo_path, proposal.base_sha, proposal.candidate_commit))) {
        throw new Error(`Candidate ${proposal.candidate_commit} does not descend from base ${proposal.base_sha}`);
      }
      await removeWorktree(project.repo_path, worktreePath);
      await createDetachedWorktree(project.repo_path, worktreePath, proposal.expected_integration_head);
      this.recordIntegrationRecord(operationId, proposalId, "WORKTREE_CREATED", worktreePath);
      const newHead = await cherryPick(worktreePath, proposal.candidate_commit);
      this.recordIntegrationRecord(operationId, proposalId, "CANDIDATE_CHERRY_PICKED", newHead);
      await this.runIntegrationValidation(storedPlan, worktreePath, operationId, proposalId);
      await this.assertIntegrationHeadUnchanged(project, proposal, branchRef);
      this.recordIntegrationRecord(operationId, proposalId, "BRANCH_ADVANCE_INTENDED", JSON.stringify({
        branchRef, newHead, expectedHead: proposal.expected_integration_head,
      }));
      try {
        await this.updateRef(project.repo_path, branchRef, newHead, proposal.expected_integration_head);
        branchAdvanced = true;
      } catch (casError) {
        try {
          const observedHead = await resolveRevision(project.repo_path, proposal.integration_branch);
          if (observedHead === newHead) branchAdvanced = true;
          else if (observedHead !== proposal.expected_integration_head) branchOutcomeUncertain = true;
        } catch {
          branchOutcomeUncertain = true;
        }
        throw casError;
      }
      this.recordIntegrationRecord(operationId, proposalId, "BRANCH_ADVANCED", newHead);
      transaction(this.db, () => {
        const operation = this.db.prepare("SELECT * FROM integration_operations WHERE id = ?").get(operationId);
        if (!operation || operation.state !== "INTENDED") {
          throw new Error(`Operation ${operationId} state mismatch`);
        }
        this.recordIntegrationRecord(operationId, proposalId, "INTEGRATION_SUCCEEDED", newHead);
        this.recordIntegrationRecord(operationId, proposalId, "PROPOSAL_INTEGRATED", proposalId);
        this.db.prepare(
          "UPDATE jobs SET status = 'SUCCEEDED', updated_at = ? WHERE id = ? AND status = 'READY_FOR_INTEGRATION'",
        ).run(now(), proposal.job_id);
        recordEvent(this.db, { kind: "INTEGRATION_SUCCEEDED", entityType: "operation", entityId: operationId, payload: { newHead } });
        return true;
      });
      return this.integrationStatus(proposalId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (branchAdvanced || branchOutcomeUncertain) {
        const uncertain = new Error(
          `Integration branch outcome is uncertain for ${operationId}; reconciliation required: ${message}`,
        );
        uncertain.code = "POST_CAS_RECEIPT_UNCERTAIN";
        throw uncertain;
      }
      transaction(this.db, () => {
        const operation = this.db.prepare("SELECT * FROM integration_operations WHERE id = ?").get(operationId);
        if (operation && operation.state === "INTENDED") {
          this.recordIntegrationRecord(operationId, proposalId, "INTEGRATION_FAILED", message);
          recordEvent(this.db, { kind: "INTEGRATION_FAILED", entityType: "operation", entityId: operationId, payload: { message } });
        }
      });
      throw error;
    }
  }

  integrationStatus(proposalId) {
    const storedProposal = this.getProposal(proposalId);
    if (!storedProposal) throw new Error(`Unknown integration proposal: ${proposalId}`);
    const records = this.db.prepare("SELECT * FROM integration_records WHERE proposal_id = ? ORDER BY sequence").all(proposalId);
    const integrated = records.find((record) => record.kind === "PROPOSAL_INTEGRATED");
    const proposal = { ...storedProposal, state: integrated ? "INTEGRATED" : storedProposal.state };
    const storedApprovals = this.db.prepare(
      "SELECT * FROM approval_receipts WHERE proposal_id = ? ORDER BY granted_at",
    ).all(proposalId);
    const storedOperations = this.db.prepare(
      "SELECT * FROM integration_operations WHERE proposal_id = ? ORDER BY created_at",
    ).all(proposalId);
    const approvals = storedApprovals.map((approval) => ({
      ...approval,
      consumed: storedOperations.some((operation) => operation.approval_receipt_id === approval.id) ? 1 : 0,
    }));
    const operations = storedOperations.map((operation) => {
      const terminal = records.find((record) => record.operation_id === operation.id
        && (record.kind === "INTEGRATION_SUCCEEDED" || record.kind === "INTEGRATION_FAILED"));
      return {
        ...operation,
        state: terminal?.kind === "INTEGRATION_SUCCEEDED" ? "SUCCEEDED"
          : (terminal?.kind === "INTEGRATION_FAILED" ? "FAILED" : "INTENDED"),
        new_head: terminal?.kind === "INTEGRATION_SUCCEEDED" ? terminal.detail : null,
      };
    });
    return { proposal, approvals, operations, records };
  }

  doctor() {
    const integrity = this.db.prepare("PRAGMA quick_check").all().map((row) => row.quick_check);
    const running = this.db.prepare(`SELECT a.*, j.project_id, j.status AS job_status
      FROM attempts a JOIN jobs j ON j.id = a.job_id
      WHERE ${lifecycleActive("a")} ORDER BY a.started_at`).all().map((attempt) => ({
        ...attempt,
        phase: attempt.terminal_state === "SUCCEEDED" ? "VALIDATION" : "EXECUTOR",
        scheduler_alive: isProcessAlive(attempt.scheduler_pid),
        executor_alive: isProcessAlive(attempt.executor_pid),
        executor_start_uncertain: Boolean(attempt.executor_intent_id && !attempt.executor_pid),
        validation_alive: isProcessAlive(attempt.validation_pid),
        validation_start_uncertain: Boolean(attempt.validation_intent_id && !attempt.validation_pid),
        worktree_exists: Boolean(attempt.worktree_path && fs.existsSync(attempt.worktree_path)),
      }));
    const missingRepositories = this.listProjects()
      .filter((project) => !fs.existsSync(project.repo_path))
      .map((project) => ({ id: project.id, repo_path: project.repo_path }));
    const unresolvedIntegrations = this.db.prepare(`SELECT
        o.id AS operation_id,
        o.proposal_id,
        o.integration_branch,
        o.created_at,
        EXISTS (
          SELECT 1 FROM integration_records r
          WHERE r.operation_id = o.id AND r.kind = 'BRANCH_ADVANCE_INTENDED'
        ) AS branch_advance_intended
      FROM integration_operations o
      WHERE NOT EXISTS (
        SELECT 1 FROM integration_records r
        WHERE r.operation_id = o.id
          AND r.kind IN ('INTEGRATION_SUCCEEDED', 'INTEGRATION_FAILED')
      )
      ORDER BY o.created_at`).all();
    return {
      healthy: integrity.length === 1 && integrity[0] === "ok" && running.length === 0
        && missingRepositories.length === 0 && unresolvedIntegrations.length === 0,
      database_integrity: integrity,
      running_attempts: running,
      missing_repositories: missingRepositories,
      unresolved_integrations: unresolvedIntegrations,
    };
  }

  async reconcile({ apply = false } = {}) {
    const running = this.db.prepare(`SELECT a.*, j.project_id, j.max_attempts,
      (SELECT COUNT(*) FROM attempts x WHERE x.job_id = a.job_id) AS attempt_count
      FROM attempts a JOIN jobs j ON j.id = a.job_id
      WHERE ${lifecycleActive("a")} ORDER BY a.started_at`).all();
    const observations = running.map((attempt) => {
      const phase = attempt.terminal_state === "SUCCEEDED" ? "VALIDATION" : "EXECUTOR";
      const schedulerAlive = isProcessAlive(attempt.scheduler_pid);
      const executorAlive = isProcessAlive(attempt.executor_pid);
      const executorStartUncertain = Boolean(attempt.executor_intent_id && !attempt.executor_pid);
      const validationAlive = isProcessAlive(attempt.validation_pid);
      const validationStartUncertain = Boolean(attempt.validation_intent_id && !attempt.validation_pid);
      const anyOwnerAlive = schedulerAlive || executorAlive || validationAlive;
      return {
        attempt_id: attempt.id,
        phase,
        scheduler_pid: attempt.scheduler_pid,
        scheduler_alive: schedulerAlive,
        executor_pid: attempt.executor_pid,
        executor_alive: executorAlive,
        executor_intent_id: attempt.executor_intent_id,
        executor_start_uncertain: executorStartUncertain,
        validation_pid: attempt.validation_pid,
        validation_alive: validationAlive,
        validation_intent_id: attempt.validation_intent_id,
        validation_start_uncertain: validationStartUncertain,
        worktree_exists: Boolean(attempt.worktree_path && fs.existsSync(attempt.worktree_path)),
        proposed: anyOwnerAlive ? "LEAVE_RUNNING"
          : (executorStartUncertain ? "REFUSE_UNCERTAIN_EXECUTOR_START"
            : (validationStartUncertain ? "REFUSE_UNCERTAIN_VALIDATION_START"
              : (phase === "VALIDATION" ? "VALIDATION_INTERRUPTED" : "ORPHAN"))),
      };
    });
    if (!apply || running.length === 0) return { applied: false, observations };
    if (observations.some((item) => item.scheduler_alive || item.executor_alive || item.validation_alive)) {
      return { applied: false, refused: "LIVE_ATTEMPT_PROCESS", observations };
    }
    if (observations.some((item) => item.executor_start_uncertain)) {
      return { applied: false, refused: "UNCERTAIN_EXECUTOR_START", observations };
    }
    if (observations.some((item) => item.validation_start_uncertain)) {
      return { applied: false, refused: "UNCERTAIN_VALIDATION_START", observations };
    }

    let epoch;
    let recovered;
    try {
      ({ epoch, recovered } = transaction(this.db, () => {
        const candidates = this.db.prepare(`SELECT a.*, j.project_id, j.max_attempts,
          (SELECT COUNT(*) FROM attempts x WHERE x.job_id = a.job_id) AS attempt_count
          FROM attempts a JOIN jobs j ON j.id = a.job_id
          WHERE ${lifecycleActive("a")} ORDER BY a.started_at`).all();
        if (candidates.some((attempt) => [attempt.scheduler_pid, attempt.executor_pid, attempt.validation_pid]
          .some((pid) => isProcessAlive(pid)))) {
          const refusal = new Error("live attempt process appeared during reconciliation");
          refusal.code = "LIVE_ATTEMPT_PROCESS";
          throw refusal;
        }
        if (candidates.some((attempt) => attempt.executor_intent_id && !attempt.executor_pid)) {
          const refusal = new Error("uncertain executor start appeared during reconciliation");
          refusal.code = "UNCERTAIN_EXECUTOR_START";
          throw refusal;
        }
        if (candidates.some((attempt) => attempt.validation_intent_id && !attempt.validation_pid)) {
          const refusal = new Error("uncertain validation start appeared during reconciliation");
          refusal.code = "UNCERTAIN_VALIDATION_START";
          throw refusal;
        }
        const currentEpoch = Number(this.db.prepare("SELECT value FROM metadata WHERE key = 'scheduler_epoch'").get().value);
        const claimedEpoch = currentEpoch + 1;
        this.db.prepare("UPDATE metadata SET value = ? WHERE key = 'scheduler_epoch'").run(String(claimedEpoch));
        for (const attempt of candidates) {
          const interrupted = attempt.terminal_state === "SUCCEEDED";
          if (interrupted) {
            this.db.prepare(`UPDATE attempts SET validation_state = 'FAILED', finished_at = ?,
              quarantined = 1, worktree_locked = 1 WHERE id = ?`).run(now(), attempt.id);
            recordEvent(this.db, { kind: "VALIDATION_INTERRUPTED", entityType: "attempt", entityId: attempt.id, epoch: claimedEpoch });
          } else {
            this.db.prepare(`UPDATE attempts SET terminal_state = 'ORPHANED', finished_at = ?,
              quarantined = 1, worktree_locked = 1 WHERE id = ?`).run(now(), attempt.id);
            recordEvent(this.db, { kind: "ATTEMPT_ORPHANED", entityType: "attempt", entityId: attempt.id, epoch: claimedEpoch });
          }
          const nextStatus = attempt.attempt_count >= attempt.max_attempts ? "NEEDS_ATTENTION" : "PENDING";
          this.db.prepare("UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?").run(nextStatus, now(), attempt.job_id);
        }
        return { epoch: claimedEpoch, recovered: candidates };
      }));
    } catch (error) {
      if (error.code === "LIVE_ATTEMPT_PROCESS") return { applied: false, refused: "LIVE_ATTEMPT_PROCESS", observations };
      if (error.code === "UNCERTAIN_EXECUTOR_START") return { applied: false, refused: "UNCERTAIN_EXECUTOR_START", observations };
      if (error.code === "UNCERTAIN_VALIDATION_START") return { applied: false, refused: "UNCERTAIN_VALIDATION_START", observations };
      throw error;
    }
    const applied = [];
    for (const attempt of recovered) {
      const project = this.getProject(attempt.project_id);
      try {
        if (attempt.worktree_path && fs.existsSync(attempt.worktree_path)) {
          await lockWorktree(project.repo_path, attempt.worktree_path, `quarantined ${attempt.id}`);
        }
      } catch { /* the database quarantine is authoritative; doctor reports filesystem drift */ }
      applied.push({
        attempt_id: attempt.id,
        action: attempt.terminal_state === "SUCCEEDED" ? "VALIDATION_INTERRUPTED" : "ORPHANED",
      });
    }
    return { applied: true, scheduler_epoch: epoch, observations, results: applied };
  }
}

export function isProcessAlive(pid, probe = (candidate) => process.kill(candidate, 0)) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    probe(pid);
    return true;
  } catch (error) {
    return !["ESRCH", "ENOENT"].includes(error?.code);
  }
}
