import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { openDatabase, recordEvent, transaction } from "./db.js";
import { managedPaths } from "./paths.js";
import {
  assertRepository,
  snapshotCandidate,
  ignoredWorkerOutput,
  cherryPick,
  commitCandidateTree,
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
import { capabilityProfile as capabilityProfileSpec } from "./harness/backend.js";
import { readFinalText } from "./manager/runtime.js";
import { instructionDigest } from "./manager/contracts.js";
import { finalizeUsageReceipt, observeOpenCodeArtifact } from "./usage.js";
import {
  createBackup, listBackups, verifyBackup, restoreBackup, rollbackIntegration,
  readRestoreMarker, clearRestoreMarker,
} from "./recovery.js";

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
  constructor({ root, backend, router = null, updateRef = updateRefCas }) {
    this.root = root;
    this.paths = managedPaths(root);
    this.db = openDatabase(this.paths.database);
    // A fixed backend still works and is what the tests use. A router selects per attempt from the
    // resolved model, which is what production needs: not every model runs on every executor.
    this.backend = backend ?? null;
    this.router = router;
    this.updateRef = updateRef;
  }

  // The executor for one attempt, chosen from the model that attempt will run.
  //
  // Chosen once, before the attempt row exists, and then used for the whole attempt. There is no
  // mid-attempt reselection: one attempt has one identity, one epoch, one worktree, one executor.
  selectBackend(model, profile = undefined) {
    if (!this.router) return { backend: this.backend, selected: this.backend?.constructor?.name ?? "UnknownBackend" };
    return this.router.select(model, profile ? { profile } : {});
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
  insertJobRow({
    projectId, goal, mode, maxAttempts, baseSha, maximumCost = null, capabilityProfile = null,
    strategy = "direct", parentJobId = null, internalKind = null,
  }) {
    const jobId = id("job");
    const timestamp = now();
    this.db.prepare(`INSERT INTO jobs(
      id, project_id, goal, mode, status, base_sha, max_attempts, maximum_cost,
      capability_profile, strategy, parent_job_id, internal_kind, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      jobId, projectId, goal, mode, baseSha, maxAttempts, maximumCost,
      capabilityProfile, strategy, parentJobId, internalKind, timestamp, timestamp,
    );
    recordEvent(this.db, {
      kind: "JOB_CREATED", entityType: "job", entityId: jobId,
      payload: { baseSha, mode, strategy, parentJobId, internalKind },
    });
    return this.getJob(jobId);
  }

  async createJob({
    projectId, goal, mode = "write", maxAttempts = 2, maximumCost = null, capabilityProfile = null,
    strategy = "direct", parentJobId = null, internalKind = null,
  }) {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Unknown project: ${projectId}`);
    if (!['read', 'write'].includes(mode)) throw new Error("mode must be read or write");
    if (!["direct", "managed"].includes(strategy)) throw new Error("strategy must be direct or managed");

    // A child job carries no ceiling of its own, and this is refused rather than ignored.
    //
    // Authority over spending belongs to one family, held by the root. Letting a child carry its own
    // number would create a second authority that nothing reconciles: five explorations at $0.10
    // each would each pass their own check while spending five times what the operator authorized.
    // Silently discarding the argument would be worse than refusing it, because the caller would go
    // on believing the child was bounded by the figure it supplied.
    if (parentJobId) {
      const parent = this.getJob(parentJobId);
      if (!parent) throw new Error(`Unknown parent job: ${parentJobId}`);
      if (parent.project_id !== projectId) {
        throw new Error("A child job must belong to the same project as its parent");
      }
      if (parent.parent_job_id) {
        // Nesting depth one. A child that could commission children turns a bounded delegation into
        // a recursive one, and the cap that made it affordable stops meaning anything.
        throw new Error("Delegation nests one level: a child job may not commission further children");
      }
      if (maximumCost !== null) {
        throw new Error(
          "A child job may not carry its own cost ceiling; it settles against its parent's family budget",
        );
      }
    } else if (internalKind) {
      throw new Error("An internal job requires a parent job");
    }

    const baseSha = await resolveRevision(project.repo_path, project.integration_branch);
    // Validated at creation, so an unusable profile is refused when the job is described rather
    // than discovered when a worker is about to run.
    if (capabilityProfile) capabilityProfileSpec(capabilityProfile);
    return transaction(this.db, () => this.insertJobRow({
      projectId, goal, mode, maxAttempts, baseSha, maximumCost, capabilityProfile,
      strategy, parentJobId, internalKind,
    }));
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

      // The proposal's cost ceiling becomes the job's enforced ceiling: a bound Hermes stated is a
      // bound the scheduler keeps, not a note.
      const job = this.insertJobRow({
        projectId: proposal.project_id, goal: proposal.goal, mode: proposal.mode, maxAttempts, baseSha,
        maximumCost: proposal.maximum_cost,
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

  // Runs one attempt.
  //
  // `instruction` is the seam this whole layer exists for. Before it, every attempt received
  // `job.goal` -- the human's sentence -- which meant the strong model's only channel into execution
  // was the same string the human typed, and attempt 2 received it again byte-for-byte. Retry was a
  // re-roll rather than iterative problem solving.
  //
  // Direct mode still passes the goal, explicitly, right here. That explicitness matters: the
  // fallback lives at the dispatcher where "direct" is a deliberate choice, not inside the backend
  // where a managed attempt missing its brief would silently receive the objective instead and
  // reintroduce the exact collapse this seam undoes.
  //
  // `startSha` is where the worktree begins, which is NOT what the candidate is measured against. A
  // revision starts from the previous candidate so it corrects an implementation rather than
  // rewriting one from nothing, while snapshotCandidate still measures the result against the
  // AUTHORIZED base, so what is offered for integration remains one complete net change from what
  // the operator approved.
  async runJob(jobId, { model = null, instruction = null, startSha = null } = {}) {
    model = this.resolveModel(model);
    // Selected from the resolved model, before the attempt exists, and held for the whole attempt.
    // A job may ask for a narrower worker; otherwise the system default applies.
    const requestedProfile = this.getJob(jobId)?.capability_profile ?? undefined;
    const selection = this.selectBackend(model, requestedProfile);
    const backend = selection.backend;
    if (!backend) throw new Error("No executor backend is available for this attempt");
    const job = this.getJob(jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);
    if (!['PENDING', 'NEEDS_ATTENTION'].includes(job.status)) throw new Error(`Job ${jobId} is ${job.status}`);
    const project = this.getProject(job.project_id);
    const validationPlan = job.mode === "write" ? parseValidationPlan(project.validation_json) : [];
    const instructionText = instruction ?? job.goal;
    const startFrom = startSha ?? job.base_sha;
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
      // Checked inside the claim transaction, so a ceiling cannot be raced by two starts.
      //
      // Resolved rather than passed in. Handing `current.maximum_cost` to the gate would ask a child
      // job about its own ceiling, which is NULL by construction -- so every exploration would pass
      // unbounded while the family it belongs to was already over budget. The authority is the
      // family's, and only the family can answer.
      this.assertWithinBudget(jobId);
      const ordinal = previousAttempts + 1;
      const attemptId = `${job.id}.${ordinal}`;
      const worktreePath = path.join(this.paths.worktrees, project.id, `attempt-${ordinal}-${job.id.slice(-8)}`);
      const currentEpoch = Number(this.db.prepare("SELECT value FROM metadata WHERE key = 'scheduler_epoch'").get().value);
      const epoch = currentEpoch + 1;
      this.db.prepare("UPDATE metadata SET value = ? WHERE key = 'scheduler_epoch'").run(String(epoch));
      this.db.prepare(`INSERT INTO attempts(
        id, job_id, ordinal, scheduler_epoch, backend, capability_profile, model,
        scheduler_pid, worktree_path, started_at, start_sha, instruction_digest
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        attemptId, jobId, ordinal, epoch, backend.constructor.name,
        // Recorded before the worker starts: the authority a worker ran under is evidence, not a
        // detail to be reconstructed afterwards from which artifacts happen to exist.
        backend.profile ?? null,
        model, process.pid, worktreePath, now(),
        // Both recorded in the claim, before any worker runs. The digest is what makes "attempt 2 was
        // told something different from attempt 1" a mechanical fact rather than the manager's word.
        startFrom, instructionDigest(instructionText),
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
      // Created from startFrom, measured against job.base_sha. Identical for every direct attempt
      // and for a first managed attempt; they diverge only when a revision builds on a candidate.
      await createDetachedWorktree(project.repo_path, worktreePath, startFrom);
      // Written before the worker runs, so the exact text it received survives independently of
      // whatever the worker does with it.
      const instructionPath = path.join(artifactDir, "instruction.txt");
      fs.writeFileSync(instructionPath, instructionText);
      this.db.prepare("UPDATE attempts SET instruction_artifact = ? WHERE id = ?").run(instructionPath, attemptId);
      executorIntentId = id("executor");
      this.acceptAttemptEvent(attemptId, epoch, () => {
        this.db.prepare("UPDATE attempts SET executor_intent_id = ?, executor_pid = NULL WHERE id = ?").run(executorIntentId, attemptId);
        recordEvent(this.db, { kind: "EXECUTOR_INTENDED", entityType: "attempt", entityId: attemptId, epoch, payload: { executorIntentId } });
      }, { terminalState: null, validationState: "NOT_RUN" });
      // A backend that throws may still have consumed tokens before failing, so the throw is held
      // until usage is captured. Jumping straight to the failure handler would lose exactly the
      // evidence that WRK-005 exists to preserve.
      let backendResult = null;
      let backendError = null;
      try {
        backendResult = await backend.run({
          attemptId, worktreePath, artifactDir, model, mode: job.mode,
          // Two distinct inputs. `instruction` is what this worker must do; `goal` is the human's
          // immutable objective, available for framing and never a substitute for the instruction.
          instruction: instructionText,
          goal: job.goal,
          onSpawn: (pid) => this.recordExecutorPid(attemptId, epoch, executorIntentId, pid),
        });
      } catch (error) {
        backendError = error;
      }

      // Record usage before any failure becomes a lifecycle outcome. A throw, timeout, nonzero exit,
      // protected-path rejection, empty diff, or failed validation still consumed tokens, and those
      // attempts belong in the denominator of cost per validated candidate.
      // The attempt's OWN backend reads its usage: each executor writes a different artifact in a
      // different format, so the default would misread another executor's evidence as absent.
      this.recordAttemptUsage({ attemptId, epoch, artifactDir, model, backendResult, backend });

      // What the worker SAYS it did, captured whether or not the attempt goes on to succeed.
      //
      // Testimony, never evidence: the captured tree is what actually changed. It is recorded anyway
      // because the disagreement between the two is frequently the whole finding -- a worker
      // reporting a fix it did not make is the failure mode semantic review exists to catch, and a
      // reviewer that only ever saw the diff could not notice the claim was false.
      const finalText = backendResult ? readFinalText(backendResult, artifactDir) : null;
      if (finalText) {
        const reportPath = path.join(artifactDir, "worker-report.txt");
        fs.writeFileSync(reportPath, finalText);
        this.db.prepare("UPDATE attempts SET result_text_artifact = ? WHERE id = ?").run(reportPath, attemptId);
      }

      if (backendError) {
        // A Harness configuration failure -- a profile that will not compose, a fence the loader
        // refuses -- will recur on every attempt, so the router stops choosing it. This attempt
        // still fails honestly: the failure is recorded after the fact, never as a mid-attempt
        // switch, and the next attempt gets a fresh worktree under whatever the router then picks.
        if (selection.selected === "harness" && this.router) {
          this.router.disableHarness(backendError.message);
        }
        throw backendError;
      }

      // A cancellation that arrived while the worker ran stops here, at a boundary, rather than
      // leaving a killed process to be interpreted as an ordinary failure. Usage is already
      // recorded above, so cancelled work still counts toward cost.
      if (this.isCancellationRequested(jobId, epoch)) throw new Error("cancelled by operator");

      if (backendResult.timedOut) throw new Error("worker timeout");
      if (backendResult.exitCode !== 0) throw new Error(`worker exited ${backendResult.exitCode}: ${backendResult.stderr?.slice(-2000) ?? ""}`);

      // ONE snapshot of what the attempt actually produced, taken through a delegate-wave-owned
      // temporary index rather than the worker's.
      //
      // A trusted worker may use Git freely, and that includes `update-index --assume-unchanged` and
      // `--skip-worktree`, under which `git add --all` in the worker's own index reports a modified
      // file as nothing at all -- hiding it from the protected-path check and dropping it from the
      // candidate. Neither the worker's index nor its HEAD is authoritative; the resulting
      // non-ignored filesystem tree is.
      //
      // Policy, the candidate commit, and the tree validation runs against all come from this single
      // immutable tree. Nothing is re-staged in between, so content the policy check never saw
      // cannot slip into what gets integrated.
      const snapshot = await snapshotCandidate(worktreePath, job.base_sha, artifactDir);
      const files = snapshot.files;
      this.assertAllowedDiff(files, parseJson(project.protected_json));
      let resultCommit = null;
      if (job.mode === "write") {
        if (files.length === 0) {
          // Distinguish "did nothing" from "everything it produced is excluded by this project's own
          // ignore rules". Both fail the attempt, but only one is honestly described as changing
          // nothing, and the other is confusing because the output is visible in the worktree.
          const ignored = await ignoredWorkerOutput(worktreePath);
          if (ignored.length) {
            throw new Error(
              "worker produced only files this project ignores, so there is nothing to integrate: "
              + `${ignored.join(", ")}`,
            );
          }
          throw new Error("worker completed without changing files");
        }
        resultCommit = await commitCandidateTree(
          worktreePath, snapshot.tree, job.base_sha,
          `delegate-wave: ${job.goal.slice(0, 72)} (${attemptId})`,
        );
      }

      this.acceptAttemptEvent(attemptId, epoch, (attempt) => {
        if (attempt.executor_intent_id !== executorIntentId) {
          throw new Error(`Stale executor result rejected for ${attemptId}`);
        }
        this.db.prepare(`UPDATE attempts SET terminal_state = 'SUCCEEDED', validation_state = 'PENDING',
          executor_intent_id = NULL, executor_pid = NULL, finished_at = ?, exit_code = 0,
          result_commit = ?, changed_files_json = ? WHERE id = ?`).run(
          now(), resultCommit, JSON.stringify(files), attemptId,
        );
        recordEvent(this.db, { kind: "EXECUTOR_SUCCEEDED", entityType: "attempt", entityId: attemptId, epoch, payload: { executorIntentId, files, resultCommit } });
      }, { terminalState: null, validationState: "NOT_RUN" });

      for (const command of validationPlan) await this.validate(attemptId, epoch, worktreePath, artifactDir, command);

      // Settled AFTER validation and BEFORE the job claims to be ready.
      //
      // Two independent truths, kept independent. The attempt's engineering record is written
      // unconditionally: it succeeded, its validation passed, its candidate stands. Settlement never
      // writes to that record, because a cost overrun does not make correct code incorrect, and
      // stamping a failure on the attempt would falsify engineering history to express a financial
      // fact.
      //
      // What an exceeded budget withholds is automatic progression. The job does not announce
      // READY_FOR_INTEGRATION -- that is an invitation to integrate, and the operator has not agreed
      // to buy this at this price -- and the start gate independently refuses any further paid call,
      // because family spend now sits at or above the ceiling. The candidate commit is preserved, so
      // raising the limit recovers work already paid for rather than repurchasing it.
      const settlement = this.settleBudget(jobId);
      this.acceptAttemptEvent(attemptId, epoch, () => {
        this.db.prepare("UPDATE attempts SET validation_state = 'PASSED' WHERE id = ?").run(attemptId);
        recordEvent(this.db, { kind: "VALIDATION_PASSED", entityType: "job", entityId: jobId, epoch });
        if (settlement.blocks_integration_offer) {
          this.db.prepare("UPDATE jobs SET status = 'NEEDS_ATTENTION', updated_at = ? WHERE id = ?").run(now(), jobId);
          recordEvent(this.db, {
            kind: "BUDGET_EXCEEDED", entityType: "job", entityId: jobId, epoch,
            payload: {
              ceiling: settlement.ceiling, spent: settlement.spent, attemptId,
              // Named explicitly so the record shows the candidate was preserved, not discarded.
              candidate: resultCommit, validation: "PASSED", root_job_id: settlement.root_job_id,
            },
          });
          return;
        }
        if (settlement.state === "UNVERIFIED") {
          // Not a violation and not a clean pass. The candidate proceeds; what cannot be stated is
          // that it stayed inside the limit, and the everyday surface says so rather than implying it.
          recordEvent(this.db, {
            kind: "BUDGET_UNVERIFIED", entityType: "job", entityId: jobId, epoch,
            payload: {
              ceiling: settlement.ceiling, spent: settlement.spent,
              unpriced_attempts: settlement.unpriced_attempts, root_job_id: settlement.root_job_id,
            },
          });
        }
        this.db.prepare("UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?").run(
          job.mode === "write" ? "READY_FOR_INTEGRATION" : "SUCCEEDED", now(), jobId,
        );
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
  recordAttemptUsage({ attemptId, epoch = null, artifactDir, model, backendResult = null, backend = this.backend }) {
    const backendName = backend?.constructor?.name ?? "UnknownBackend";
    try {
      if (this.db.prepare("SELECT 1 FROM attempt_usage_receipts WHERE attempt_id = ?").get(attemptId)) return null;

      // A backend that reports usage directly is preferred over artifact scraping. Either way it
      // supplies only a neutral observation; pricing is applied centrally by the finalizer, so no
      // executor computes delegate-wave's comparator.
      const observation = backendResult?.usage
        ?? (typeof backend?.observeUsage === "function"
          ? backend.observeUsage({ attemptId, artifactDir, backendResult })
          : observeOpenCodeArtifact(artifactDir ? path.join(artifactDir, "opencode-events.jsonl") : null));

      const receipt = finalizeUsageReceipt({ attemptId, backend: backendName, model, observation });
      this.db.prepare(`INSERT INTO attempt_usage_receipts(
        attempt_id, status, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens,
        cache_write_tokens, provider_steps, reported_cost_usd, reported_cost_source,
        reference_cost_usd, pricing_basis_id, source_backend, source_artifact, source_format,
        malformed_events, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        receipt.attempt_id, receipt.status, receipt.input_tokens, receipt.output_tokens,
        receipt.reasoning_tokens, receipt.cache_read_tokens, receipt.cache_write_tokens,
        receipt.provider_steps, receipt.reported_cost_usd, receipt.reported_cost_source,
        receipt.reference_cost_usd, receipt.pricing_basis_id, receipt.source_backend,
        receipt.source_artifact, receipt.source_format, receipt.malformed_events, receipt.observed_at,
      );
      return receipt;
    } catch (error) {
      // A measurement failure must not fail a product task, but it must not vanish either: a silent
      // parser or schema bug would erase expensive attempts from the experiment. The attempt
      // proceeds; the dataset is marked unhealthy.
      try {
        recordEvent(this.db, {
          kind: "USAGE_RECEIPT_FAILED", entityType: "attempt", entityId: attemptId, epoch,
          payload: { backend: backendName, message: String(error?.message ?? error).slice(0, 500) },
        });
      } catch { /* the audit write is best effort; never propagate into the run */ }
      return null;
    }
  }

  // Measurement health for an experiment dataset.
  //
  // Two distinct questions, deliberately not collapsed:
  //
  //   accounted  every eligible attempt is explained -- it has a receipt, or a durable record saying
  //              why it has none. Nothing vanished silently.
  //   healthy    every eligible attempt has actual usage evidence. A known capture failure is
  //              accounted for but leaves the dataset unusable for cost per validated candidate,
  //              because one attempt has no defensible cost.
  //
  // Eligibility is attempts that reached EXECUTOR_INTENDED. An attempt that failed during worktree
  // setup never invoked a backend and consumed no provider usage, so requiring evidence from it
  // would report a gap that cannot exist.
  usageCoverage({ jobIds = null } = {}) {
    const eligible = jobIds?.length
      ? this.db.prepare(`SELECT DISTINCT a.id FROM attempts a
          JOIN events e ON e.entity_id = a.id AND e.kind = 'EXECUTOR_INTENDED'
          WHERE a.job_id IN (${jobIds.map(() => "?").join(",")})`).all(...jobIds)
      : this.db.prepare(`SELECT DISTINCT a.id FROM attempts a
          JOIN events e ON e.entity_id = a.id AND e.kind = 'EXECUTOR_INTENDED'`).all();

    const receipts = [];
    const captureFailures = [];
    const missingEvidence = [];
    const unknownReceipts = [];
    const partialReceipts = [];
    const unpricedReceipts = [];
    for (const { id } of eligible) {
      const receipt = this.db.prepare(
        "SELECT status, reference_cost_usd FROM attempt_usage_receipts WHERE attempt_id = ?",
      ).get(id);
      if (receipt) {
        receipts.push(id);
        // A receipt row is not the same as usable evidence. Each of these is durable and accounted
        // for, but none supports a defensible cost total for the attempt it describes.
        if (receipt.status === "UNKNOWN") unknownReceipts.push(id);
        else if (receipt.status === "PARTIAL") partialReceipts.push(id);
        else if (receipt.reference_cost_usd === null) unpricedReceipts.push(id);
        continue;
      }
      const failed = this.db.prepare(
        "SELECT 1 FROM events WHERE kind = 'USAGE_RECEIPT_FAILED' AND entity_id = ?",
      ).get(id);
      if (failed) captureFailures.push(id);
      else missingEvidence.push(id);
    }

    return {
      attempts: eligible.length,
      receipts: receipts.length,
      capture_failures: captureFailures,
      missing_evidence: missingEvidence,
      unknown_receipts: unknownReceipts,
      partial_receipts: partialReceipts,
      unpriced_receipts: unpricedReceipts,
      // Nothing vanished silently.
      accounted: missingEvidence.length === 0,
      // Every eligible attempt carries a complete, priceable receipt, so a cost-per-validated-
      // candidate total over this dataset is defensible.
      healthy: missingEvidence.length === 0 && captureFailures.length === 0
        && unknownReceipts.length === 0 && partialReceipts.length === 0
        && unpricedReceipts.length === 0,
    };
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

  // Stop tracking a project without destroying what it did.
  //
  // There was no way to do this at all, so a project registered by mistake -- or one whose
  // repository was deleted -- stayed in the health check and the everyday surface permanently, and
  // the only remedy was editing SQLite by hand. That is precisely what this system exists to make
  // unnecessary.
  //
  // Retirement is reversible and keeps every record. Live work blocks it, because retiring a
  // project mid-attempt would hide something that is still running.
  retireProject({ projectId, principal, origin }) {
    if (!principal || !origin) throw new Error("Retiring a project requires an authorizing identity");
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Unknown project: ${projectId}`);
    if (project.retired_at) return { retired: false, reason: "already retired", project };

    // Only genuinely running work blocks retirement. A candidate awaiting a decision is safe to
    // retire: nothing is executing, nothing is destroyed, and restoring the project brings it back.
    // Requiring every pending candidate be declined first would be friction that pushes people back
    // to editing SQLite, which is the thing this exists to prevent.
    const running = this.db.prepare(
      "SELECT id FROM jobs WHERE project_id = ? AND status = 'RUNNING' LIMIT 1",
    ).get(projectId);
    if (running) {
      throw new Error(
        `Refusing to retire ${project.name}: job ${running.id} is still running. `
        + "Cancel it first, or wait for it to finish.",
      );
    }

    return transaction(this.db, () => {
      const timestamp = now();
      this.db.prepare("UPDATE projects SET retired_at = ? WHERE id = ?").run(timestamp, projectId);
      recordEvent(this.db, {
        kind: "PROJECT_RETIRED", entityType: "project", entityId: projectId,
        payload: { principal, origin, name: project.name },
      });
      return { retired: true, project: this.getProject(projectId) };
    });
  }

  // The counterpart, so retiring is not a one-way door.
  restoreProject({ projectId, principal, origin }) {
    if (!principal || !origin) throw new Error("Restoring a project requires an authorizing identity");
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Unknown project: ${projectId}`);
    if (!project.retired_at) return { restored: false, reason: "not retired", project };
    return transaction(this.db, () => {
      this.db.prepare("UPDATE projects SET retired_at = NULL WHERE id = ?").run(projectId);
      recordEvent(this.db, {
        kind: "PROJECT_RESTORED", entityType: "project", entityId: projectId,
        payload: { principal, origin, name: project.name },
      });
      return { restored: true, project: this.getProject(projectId) };
    });
  }
  // --- Everyday status --------------------------------------------------------------------------
  //
  // One bounded answer to "what is happening", written for a person rather than for a machine.
  //
  // Five states, because those are the things worth knowing: something is running, something needs a
  // decision, something is ready to check, something finished, or something finished and was then
  // taken back. Raw transcripts, worktree paths, and internal identifiers are deliberately absent --
  // they are available on request through the detailed endpoints, and putting them here would bury
  // the answer.
  //
  // `reverted` exists because a rolled-back job was correctly removed from `done` and then appeared
  // nowhere at all. The truth was right and the account of it was missing: work the person watched
  // succeed simply vanished, with no statement that its change is no longer present.
  briefing({ limit = 8 } = {}) {
    const doctor = this.doctor();
    const short = (text, max = 90) => {
      const clean = String(text ?? "").replace(/\s+/g, " ").trim();
      return clean.length > max ? `${clean.slice(0, max - 1)}...` : clean;
    };
    const money = (value) => (value === null || value === undefined ? null : Number(value.toFixed(6)));

    // Cost is reported with its completeness, never as a bare number that might be silently partial.
    const jobCost = (jobId) => {
      const spend = this.jobSpend(jobId);
      return {
        reference_cost_usd: money(spend.spent),
        complete: spend.complete,
        ...(spend.complete ? {} : { unmeasured_attempts: spend.unpriced_attempts }),
      };
    };

    const working = this.db.prepare(`SELECT j.id, j.goal, p.name AS project, j.updated_at
      FROM jobs j JOIN projects p ON p.id = j.project_id
      WHERE j.status = 'RUNNING' AND p.retired_at IS NULL ORDER BY j.updated_at DESC LIMIT ?`).all(limit)
      .map((row) => ({ job: row.id, project: row.project, goal: short(row.goal), since: row.updated_at }));

    const proposals = this.pendingWorkProposals().slice(0, limit).map((row) => ({
      // Written as the question a person is actually being asked. The identifier stays in the
      // payload because acting on it needs one, but it does not belong in the sentence.
      decision: "Approve this work?",
      proposal: row.id,
      project: this.getProject(row.project_id)?.name ?? row.project_id,
      goal: short(row.goal),
      ceiling_usd: money(row.maximum_cost),
      expires_at: row.expires_at,
    }));

    // A proposal still awaits approval only if nothing has successfully integrated it. The stored
    // state column lags the integration records -- integrationStatus already derives around that --
    // so filtering on the column alone would ask the operator to approve work that already landed.
    const candidates = this.db.prepare(`SELECT ip.id, ip.job_id, ip.attempt_id, j.goal, p.name AS project
      FROM integration_proposals ip
      JOIN jobs j ON j.id = ip.job_id JOIN projects p ON p.id = ip.project_id
      WHERE ip.state = 'OPEN' AND p.retired_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM integration_records r
          WHERE r.proposal_id = ip.id AND r.kind = 'INTEGRATION_SUCCEEDED'
        )
        -- A declined candidate is no longer awaiting anything. Derived like the rest, because the
        -- proposal row is immutable and its state column cannot record the decision.
        AND NOT EXISTS (
          SELECT 1 FROM events e
          WHERE e.kind = 'INTEGRATION_DECLINED' AND e.entity_type = 'proposal' AND e.entity_id = ip.id
        )
      ORDER BY ip.created_at DESC LIMIT ?`).all(limit)
      .map((row) => {
        // The facts a person needs to answer "should this land": did the checks pass, how much
        // changed, and what did it cost. Not the digest, the branch, or the executor.
        const attempt = this.db.prepare(
          "SELECT validation_state, changed_files_json FROM attempts WHERE id = ?",
        ).get(row.attempt_id);
        const changed = parseJson(attempt?.changed_files_json ?? null);
        return {
          decision: "Integrate this?",
          validation: attempt?.validation_state === "PASSED" ? "passed" : (attempt?.validation_state ?? "unknown"),
          // Null rather than 0 when the attempt predates the record: claiming nothing changed would
          // be worse than admitting the count is unknown.
          files_changed: Array.isArray(changed) ? changed.length : null,
          proposal: row.id,
          // Carried like every other bucket. Without it a pending approval cannot be correlated back
          // to the work that produced it, so Hermes cannot answer "what happened to what I proposed".
          job: row.job_id,
          project: row.project,
          goal: short(row.goal),
          cost: jobCost(row.job_id),
        };
      });

    const attention = this.db.prepare(`SELECT j.id, j.goal, j.status, p.name AS project,
        (SELECT a.failure_signature FROM attempts a WHERE a.job_id = j.id
         ORDER BY a.ordinal DESC LIMIT 1) AS last_failure
      FROM jobs j JOIN projects p ON p.id = j.project_id
      WHERE j.status = 'NEEDS_ATTENTION' AND p.retired_at IS NULL ORDER BY j.updated_at DESC LIMIT ?`).all(limit)
      .map((row) => {
        // What happened to the change, then what it means, then the mechanism -- never the internal
        // state name. `why` is retained because callers and the detailed tools already use it.
        const outcome = this.jobOutcome(row.id);
        return {
          job: row.id,
          project: row.project,
          goal: short(row.goal),
          says: outcome?.headline ?? null,
          because: outcome?.detail ?? null,
          state: outcome?.state ?? null,
          needs_decision: outcome?.needs_decision ?? false,
          why: this.lastFailureReason(row.id),
          cost: jobCost(row.id),
        };
      });

    // A job whose integration was rolled back is not Done: the change it describes is gone.
    const done = this.db.prepare(`SELECT j.id, j.goal, j.updated_at, p.name AS project
      FROM jobs j JOIN projects p ON p.id = j.project_id
      WHERE j.status = 'SUCCEEDED' AND p.retired_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM integration_rollbacks rb
          JOIN integration_proposals ip ON ip.id = rb.proposal_id
          WHERE ip.job_id = j.id
        )
      ORDER BY j.updated_at DESC LIMIT ?`).all(limit)
      .map((row) => ({
        job: row.id,
        project: row.project,
        goal: short(row.goal),
        finished: row.updated_at,
        changed: this.integratedFiles(row.id),
        cost: jobCost(row.id),
      }));

    // Integrated, then taken back. The job's own SUCCEEDED state is untouched -- the work really did
    // succeed -- so the honest account is that the change is no longer present, not that the job
    // failed. Ordered by when the rollback happened, since that is the event being reported.
    const reverted = this.db.prepare(`SELECT j.id, j.goal, p.name AS project,
        rb.to_sha, rb.from_sha, rb.integration_branch, rb.created_at AS rolled_back_at
      FROM integration_rollbacks rb
      JOIN integration_proposals ip ON ip.id = rb.proposal_id
      JOIN jobs j ON j.id = ip.job_id
      JOIN projects p ON p.id = j.project_id
      WHERE p.retired_at IS NULL
      ORDER BY rb.created_at DESC LIMIT ?`).all(limit)
      .map((row) => ({
        job: row.id,
        project: row.project,
        goal: short(row.goal),
        rolled_back_at: row.rolled_back_at,
        // Both ends of the move, so the account is checkable rather than merely reassuring.
        integration_branch: row.integration_branch,
        reverted_from: row.from_sha,
        restored_to: row.to_sha,
        cost: jobCost(row.id),
      }));

    return {
      schema_version: 1,
      healthy: doctor.healthy,
      working,
      needs_your_decision: [...proposals, ...candidates],
      ready_to_check: attention,
      done,
      reverted,
      ...(doctor.healthy ? {} : { health_detail: {
        missing_repositories: doctor.missing_repositories.length,
        unresolved_integrations: doctor.unresolved_integrations.length,
      } }),
    };
  }

  // The most recent failure in plain language, taken from the recorded event rather than a
  // transcript. A person needs to know what went wrong, not what the model said while it happened.
  lastFailureReason(jobId) {
    const row = this.db.prepare(`SELECT e.payload_json FROM events e
      JOIN attempts a ON a.id = e.entity_id
      WHERE a.job_id = ? AND e.kind = 'ATTEMPT_FAILED'
      ORDER BY e.sequence DESC LIMIT 1`).get(jobId);
    if (!row) return "stopped without a recorded reason";
    try {
      const message = JSON.parse(row.payload_json).message ?? "";
      return String(message).replace(/\s+/g, " ").trim().slice(0, 200) || "stopped without a recorded reason";
    } catch {
      return "stopped without a recorded reason";
    }
  }

  // Turns recorded state into the sentence a person actually needs.
  //
  // Presentation only: nothing here decides anything. The ordering is deliberate -- what happened to
  // the change, then whether anything landed, then whether the person must act, and only then the
  // mechanism. "COMMAND_FAILED" and "validation_state=FAILED" are true and useless.
  //
  // The distinctions matter because they are different events with different meanings, and collapsing
  // them is how a system starts lying gently: a worker that never produced anything did not fail
  // validation, an interrupted validation reached no verdict, and a cancellation is not a test result.
  jobOutcome(jobId) {
    const job = this.getJob(jobId);
    if (!job) return null;
    const goal = String(job.goal ?? "").replace(/\s+/g, " ").trim().replace(/[.!?\s]+$/, "");
    const quoted = goal.length > 70 ? `"${goal.slice(0, 69)}..."` : `"${goal}"`;
    const attempts = this.db.prepare(
      "SELECT * FROM attempts WHERE job_id = ? ORDER BY ordinal",
    ).all(jobId);
    const last = attempts.at(-1) ?? null;
    const spend = this.familySpend(this.budgetRootJobId(jobId));
    const spent = spend.spent > 0
      ? `About $${spend.spent.toFixed(4)} was spent${spend.complete ? "" : " so far"}`
      : null;

    // Nothing has run yet, so there is nothing to explain.
    if (!last) return { state: "pending", headline: `${quoted} has not started yet.`, needs_decision: false };

    const nothingIntegrated = "Nothing was integrated.";
    const detail = this.failureDetail(jobId);

    if (job.status === "CANCELLED" || last.terminal_state === "CANCELLED") {
      return {
        state: "cancelled",
        headline: `Stopped ${quoted}. ${nothingIntegrated}`,
        // Cancellation is not a verdict on the work, so no failure detail is offered -- only what it
        // cost, which is the one thing a person may not expect after stopping something.
        detail: spent ? `${spent} before it stopped.` : null,
        needs_decision: false,
      };
    }

    // The executor succeeded but validation reached no verdict. Saying "validation failed" here
    // would assert a test result that was never produced.
    if (last.terminal_state === "SUCCEEDED" && last.validation_state === "NOT_RUN") {
      return {
        state: "validation-interrupted",
        headline: `Validation was interrupted before it finished. ${nothingIntegrated}`,
        detail: `${quoted} was implemented, but nothing has checked it yet.`,
        needs_decision: job.status === "NEEDS_ATTENTION",
      };
    }

    // The executor succeeded and validation genuinely ran and rejected the candidate.
    if (last.terminal_state === "SUCCEEDED" && last.validation_state === "FAILED") {
      // Out of attempts means the person now has to decide something, and saying only what went
      // wrong leaves them waiting for a retry that will never come. If it took more than one
      // attempt, the count is worth stating: it is the difference between bad luck and a real wall.
      const stuck = job.status === "NEEDS_ATTENTION";
      const tries = stuck && attempts.length > 1 ? ` after ${attempts.length} attempts` : "";
      return {
        state: "validation-failed",
        headline: `${quoted} was implemented, but validation failed${tries}. ${nothingIntegrated}`
          + `${stuck ? " I need your decision." : ""}`,
        detail,
        needs_decision: stuck,
      };
    }

    // Another attempt is genuinely under way right now.
    if (job.status === "RUNNING" && attempts.length > 1) {
      return {
        state: "retrying",
        headline: `The first attempt at ${quoted} didn't work, so I'm trying again.`,
        needs_decision: false,
      };
    }

    if (job.status === "NEEDS_ATTENTION") {
      const budget = this.budgetObstacle(job, spend);
      if (budget) return budget;

      // The same failure twice is a different situation from two unrelated ones: more attempts are
      // unlikely to help, and the person should hear that rather than watch it repeat.
      const signatures = attempts.map((a) => a.failure_signature).filter(Boolean);
      const repeated = signatures.length >= 2 && signatures.at(-1) === signatures.at(-2);
      if (repeated) {
        return {
          state: "repeated-blocker",
          headline: `I hit the same problem again with ${quoted}. ${nothingIntegrated} `
            + "I need your decision before trying more.",
          detail,
          needs_decision: true,
        };
      }
      // "after 1 attempt" only carries meaning once something was actually retried. A single failure
      // gets the plain statement of what happened.
      if (attempts.length === 1) {
        return {
          state: "worker-failed",
          headline: `Couldn't complete ${quoted}. ${nothingIntegrated} I need your decision.`,
          detail,
          needs_decision: true,
        };
      }
      return {
        state: "exhausted",
        headline: `I couldn't finish ${quoted} after ${attempts.length} attempts. `
          + `${nothingIntegrated} I need your decision.`,
        detail,
        needs_decision: true,
      };
    }

    // An attempt failed before producing anything to check. Validation never happened, so it is not
    // mentioned at all.
    if (last.terminal_state === "FAILED") {
      return {
        state: "worker-failed",
        headline: `Couldn't complete ${quoted}. ${nothingIntegrated}`,
        detail,
        needs_decision: false,
      };
    }

    return {
      state: String(job.status).toLowerCase(),
      headline: `${quoted} is ${String(job.status).toLowerCase().replace(/_/g, " ")}.`,
      needs_decision: false,
    };
  }

  // Why another attempt cannot start, when a recorded ceiling is the reason.
  //
  // Derived rather than stored: a budget refusal happens before an attempt exists, so there is no
  // failure record to read. Unmeasured spend must never render as "$0" -- that is the difference
  // between "this cost nothing" and "I cannot tell you what this cost".
  budgetObstacle(job, spend) {
    // Trailing zeros make a limit read as an instrument reading rather than an amount of money.
    const money = (value) => Number(value).toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
    const ceiling = this.budgetAuthority(job.id).ceiling;
    if (ceiling === null || ceiling === undefined) return null;

    // Retraction reads completely differently from refusal, and conflating them would be the worst
    // kind of wrong: "I stopped before another attempt" when the work is finished and a validated
    // candidate is sitting there would send someone looking for a failure that did not happen.
    const exceeded = this.db.prepare(
      "SELECT payload_json FROM events WHERE kind = 'BUDGET_EXCEEDED' AND entity_id = ? ORDER BY sequence DESC LIMIT 1",
    ).get(job.id);
    if (exceeded) {
      const payload = parseJson(exceeded.payload_json, {});
      return {
        state: "budget-exceeded",
        headline: "The work is finished and passed its checks, but it cost about "
          + `$${Number(payload.spent ?? spend.spent).toFixed(4)} against a $${money(ceiling)} limit. `
          + "I have not offered it for integration. I need your decision.",
        detail: "Nothing was integrated and nothing was thrown away: the change itself is fine and "
          + "the candidate is intact, so raising the limit accepts work you have already paid for "
          + "rather than repeating it.",
        needs_decision: true,
      };
    }

    if (!spend.complete) {
      return {
        state: "budget-unverifiable",
        headline: "I paused before another attempt because I can't verify the total spend yet.",
        detail: `${spend.unpriced_attempts} attempt${spend.unpriced_attempts === 1 ? "" : "s"} `
          + `${spend.unpriced_attempts === 1 ? "has" : "have"} usage that could not be measured, so `
          + `spend against the $${money(ceiling)} limit cannot be established.`,
        needs_decision: true,
      };
    }
    if (spend.spent >= ceiling) {
      return {
        state: "budget-reached",
        headline: "I stopped before another attempt because this job reached its "
          + `$${money(ceiling)} limit.`,
        detail: `About $${spend.spent.toFixed(4)} has been spent.`,
        needs_decision: true,
      };
    }
    return null;
  }

  // One useful technical fact, in words rather than in the system's own vocabulary.
  //
  // A generic "something went wrong" is worse than a stack trace, and a stack trace is worse than
  // the one line that says what to do next.
  failureDetail(jobId) {
    const raw = this.lastFailureReason(jobId);
    if (!raw || raw === "stopped without a recorded reason") return null;

    // The compact summary folds newlines into spaces, which runs a stack trace into the one line
    // worth reading. The raw event still has its line breaks, so take the first line from there.
    const recorded = this.db.prepare(`SELECT e.payload_json FROM events e
      JOIN attempts a ON a.id = e.entity_id
      WHERE a.job_id = ? AND e.kind = 'ATTEMPT_FAILED'
      ORDER BY e.sequence DESC LIMIT 1`).get(jobId);
    let firstLine = raw;
    if (recorded) {
      try {
        const message = String(JSON.parse(recorded.payload_json).message ?? "");
        firstLine = message.split(/[\r\n]/).map((line) => line.trim()).find(Boolean) || raw;
      } catch { /* the summary is still usable */ }
    }

    const validation = raw.match(/^validation failed \((\d+)\): (.+)$/);
    if (validation) return "`" + validation[2].trim().slice(0, 80) + "` failed.";

    const blocked = raw.match(/^Protected path changed: ([^\s(]+)/);
    if (blocked) return `It tried to change a protected file: ${blocked[1]}.`;

    if (/^worker completed without changing files/.test(raw)) {
      return "The worker finished without changing anything.";
    }
    if (/^worker produced only files this project ignores/.test(raw)) {
      return raw.replace(
        /^worker produced only files this project ignores[^:]*:\s*/,
        "Everything it produced is ignored by this project: ",
      );
    }
    if (/^worker timeout/.test(raw)) return "The worker ran out of time.";
    if (/^cancelled by operator/.test(raw)) return null;

    // Matched against the first line, so the worker's own first error survives and its stack does
    // not follow it into the sentence.
    const exited = firstLine.match(/^worker exited \d+: (.+)$/);
    if (exited) return `The worker stopped: ${exited[1].trim().slice(0, 120)}`;
    // Configuration and process-level problems: the worker never really started.
    if (/is not installed|spawn |EINVAL|ENOENT/.test(raw)) return "The worker could not start.";
    return raw.slice(0, 120);
  }
  // What actually landed, so "Done" can say what changed rather than only that something did.
  integratedFiles(jobId) {
    const record = this.db.prepare(`SELECT r.detail, r.proposal_id FROM integration_records r
      JOIN integration_proposals ip ON ip.id = r.proposal_id
      WHERE ip.job_id = ? AND r.kind = 'INTEGRATION_SUCCEEDED'
      ORDER BY r.sequence DESC LIMIT 1`).get(jobId);
    if (!record) return null;
    const rolledBack = this.latestRollback(record.proposal_id);
    if (rolledBack) return { rolled_back_from: record.detail, branch_now_at: rolledBack.to_sha };
    return { integrated_commit: record.detail };
  }

  // --- Auto-advance -----------------------------------------------------------------------------
  //
  // Human authority is preserved exactly where it matters and removed everywhere it was ceremony.
  // Two decisions remain: authorize the work, and approve the integration. Everything between them
  // -- running the worker, validating, and proposing the integration -- is mechanical, and requiring
  // a human keystroke for each step bought no safety while guaranteeing the loop stalls whenever the
  // operator is away.
  //
  // What is deliberately NOT automated: integration itself still consumes an explicit approval, and
  // the approval still binds to one exact candidate digest.
  async advanceJob(jobId, { model = null } = {}) {
    const job = this.getJob(jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);

    // Run the worker unless the job already produced a candidate.
    let status = this.status(jobId);
    if (["PENDING", "NEEDS_ATTENTION"].includes(status.job.status)) {
      status = await this.runJob(jobId, { model });
    }

    if (status.job.status !== "READY_FOR_INTEGRATION") {
      return { job: status.job, attempts: status.attempts, stage: "worker", proposal: null };
    }
    if (job.mode !== "write") {
      return { job: status.job, attempts: status.attempts, stage: "complete", proposal: null };
    }

    // Proposing an integration is mechanical: it records what would be integrated and still requires
    // a separate approval before anything moves.
    const existing = this.db.prepare(
      "SELECT * FROM integration_proposals WHERE job_id = ? AND state = 'OPEN' ORDER BY created_at DESC LIMIT 1",
    ).get(jobId);
    const proposal = existing ?? await this.proposeIntegration({ jobId });

    return {
      job: this.getJob(jobId),
      attempts: this.status(jobId).attempts,
      stage: "awaiting_approval",
      proposal,
    };
  }

  // Approving and integrating in one operator action. The approval is still explicit, still bound to
  // the exact candidate, and still recorded separately; this only removes the second keystroke that
  // followed it unconditionally.
  async approveAndIntegrate({ proposalId, principal, origin, idempotencyKey = null }) {
    this.grantApproval({ proposalId, principal, origin, idempotencyKey });
    return this.runIntegration(proposalId);
  }

  // --- Recovery ---------------------------------------------------------------------------------

  backup(label = "manual") {
    return createBackup({ root: this.root, database: this.db, label });
  }

  // Restore closes this dispatcher's database first: the live handle would keep the file open and a
  // restored database beside a live WAL is not the database that was backed up.
  async restore(backupDirectory, { restoreRepositories = true } = {}) {
    const root = this.root;
    const snapshot = verifyBackup(backupDirectory);
    if (!snapshot.intact) {
      throw new Error(`Refusing to restore a damaged backup: ${JSON.stringify(snapshot.damaged)}`);
    }
    const safety = await createBackup({ root, database: this.db, label: "pre-restore" });
    this.db.close();
    try {
      const result = await restoreBackup({ root, backupDirectory, database: null, restoreRepositories });
      return { ...result, safety_backup: safety.backup };
    } finally {
      // Reopen whatever is now on disk, restored or not, so the dispatcher stays usable.
      this.db = openDatabase(this.paths.database);
    }
  }

  listBackups() {
    return listBackups(this.root);
  }

  // Clears the unresolved-restore condition once repository heads have been dealt with.
  //
  // Deliberately explicit. The system cannot decide on its own that a disagreement between
  // operational truth and code truth has been settled -- only a person who looked can, and until
  // they do, `doctor` stays unhealthy rather than quietly recovering.
  resolveRestore() {
    const marker = readRestoreMarker(this.root);
    if (!marker) return { resolved: false, reason: "no unresolved restore was recorded" };
    const cleared = clearRestoreMarker(this.root);
    recordEvent(this.db, {
      kind: "RESTORE_RECONCILED", entityType: "system", entityId: "restore",
      payload: { cleared_marker: cleared.marker ?? null, was: marker },
    });
    return { resolved: true, was: marker };
  }

  verifyBackup(backupDirectory) {
    return verifyBackup(backupDirectory);
  }

  // Decline a candidate rather than integrating it.
  //
  // The missing half of the pair. A candidate could be approved, or rolled back AFTER it landed,
  // but never simply declined -- so deciding "no" left the job sitting in the decision queue
  // forever, and the only way to clear it was editing SQLite. Work proposals have had authorize
  // and reject from the start; integration proposals had approve and nothing.
  //
  // Declining destroys nothing. The attempt, its candidate commit, its cost receipt and its
  // validation record all stay; what changes is that nobody is going to integrate it.
  declineIntegration({ proposalId, principal, origin, reason = "" }) {
    if (!principal || !origin) throw new Error("Declining a candidate requires an authorizing identity");
    const proposal = this.getProposal(proposalId);
    if (!proposal) throw new Error(`Unknown integration proposal: ${proposalId}`);

    // Derived from the records rather than the state column, for the same reason the briefing is:
    // the column lags, and declining something already integrated would be a false claim.
    const integrated = this.db.prepare(
      "SELECT 1 FROM integration_records WHERE proposal_id = ? AND kind = 'INTEGRATION_SUCCEEDED' LIMIT 1",
    ).get(proposalId);
    if (integrated) {
      throw new Error(
        `Proposal ${proposalId} is already integrated; roll it back instead of declining it.`,
      );
    }

    return transaction(this.db, () => {
      // The proposal row is immutable by design, so declining is RECORDED rather than written into
      // it -- the same way integration success is. Everything that asks "is this still awaiting a
      // decision" derives the answer from records, so one more record is all this needs.
      if (this.latestDecline(proposalId)) {
        return { declined: false, reason: "already declined", proposal: this.getProposal(proposalId) };
      }
      const current = this.getProposal(proposalId);
      recordEvent(this.db, {
        kind: "INTEGRATION_DECLINED", entityType: "proposal", entityId: proposalId,
        payload: { principal, origin, reason: reason || null, jobId: current.job_id },
      });
      // The job is finished without an integration, which is exactly what CANCELLED means for a job.
      this.db.prepare("UPDATE jobs SET status = 'CANCELLED', updated_at = ? WHERE id = ?")
        .run(now(), current.job_id);
      return { declined: true, proposal: current };
    });
  }

  // Whether a candidate has been declined, read from the records rather than the row.
  latestDecline(proposalId) {
    return this.db.prepare(`SELECT payload_json, occurred_at FROM events
      WHERE kind = 'INTEGRATION_DECLINED' AND entity_type = 'proposal' AND entity_id = ?
      ORDER BY sequence DESC LIMIT 1`).get(proposalId) ?? null;
  }
  // Rolls an integration branch back to the state before a recorded integration.
  //
  // The target comes from the recorded operation, not from the caller: asking an operator to supply
  // a SHA under stress is how the wrong commit gets typed. The operation's expected head is what the
  // branch pointed at before that integration, so that is where it returns to.
  async rollbackIntegration({ proposalId, principal, origin }) {
    if (!principal || !origin) throw new Error("Rolling back requires an authorizing identity");
    const proposal = this.getProposal(proposalId);
    if (!proposal) throw new Error(`Unknown integration proposal: ${proposalId}`);
    const project = this.getProject(proposal.project_id);
    if (!project) throw new Error(`Unknown project: ${proposal.project_id}`);

    const succeeded = this.db.prepare(`SELECT r.*, o.expected_integration_head, o.integration_branch
      FROM integration_records r JOIN integration_operations o ON o.id = r.operation_id
      WHERE r.proposal_id = ? AND r.kind = 'INTEGRATION_SUCCEEDED'
      ORDER BY r.sequence DESC LIMIT 1`).get(proposalId);
    if (!succeeded) throw new Error(`Proposal ${proposalId} has no succeeded integration to roll back`);

    const result = await rollbackIntegration({
      repoPath: project.repo_path,
      branch: succeeded.integration_branch,
      toSha: succeeded.expected_integration_head,
      expectedCurrentSha: succeeded.detail,
    });

    // Recorded after the branch actually moved. A crash between the two leaves the branch moved with
    // no receipt; reconcile() detects that and completes the record rather than leaving the product
    // reporting a removed change as current.
    transaction(this.db, () => {
      this.db.prepare(`INSERT INTO integration_rollbacks(
        id, proposal_id, integration_branch, from_sha, to_sha, rolled_back_by, rolled_back_origin, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id("rollback"), proposalId, succeeded.integration_branch,
        result.from, result.to, principal, origin, now(),
      );
      recordEvent(this.db, {
        kind: "INTEGRATION_ROLLED_BACK", entityType: "proposal", entityId: proposalId,
        payload: { ...result, principal, origin },
      });
    });
    return result;
  }

  // The most recent rollback of a proposal, if any. Current integration state derives from this.
  latestRollback(proposalId) {
    return this.db.prepare(
      "SELECT * FROM integration_rollbacks WHERE proposal_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(proposalId) ?? null;
  }

  // Detects a rollback whose branch move landed but whose receipt did not, by comparing the recorded
  // integration head against where the branch actually points. Returns what it repaired.
  async reconcileRollbacks({ apply = false } = {}) {
    const repaired = [];
    const succeeded = this.db.prepare(`SELECT r.proposal_id, r.detail AS integrated_sha,
        o.expected_integration_head, o.integration_branch, ip.project_id
      FROM integration_records r
      JOIN integration_operations o ON o.id = r.operation_id
      JOIN integration_proposals ip ON ip.id = r.proposal_id
      WHERE r.kind = 'INTEGRATION_SUCCEEDED'`).all();

    for (const row of succeeded) {
      if (this.latestRollback(row.proposal_id)) continue;
      const project = this.getProject(row.project_id);
      if (!project || !fs.existsSync(project.repo_path)) continue;
      let head;
      try {
        head = await resolveRevision(project.repo_path, row.integration_branch);
      } catch {
        continue;
      }
      // The branch sits exactly where a rollback of this integration would have left it, and no
      // rollback was recorded: the receipt was lost between the CAS and the write.
      if (head === row.expected_integration_head && head !== row.integrated_sha) {
        repaired.push({ proposal_id: row.proposal_id, branch: row.integration_branch, head });
        if (apply) {
          transaction(this.db, () => {
            this.db.prepare(`INSERT INTO integration_rollbacks(
              id, proposal_id, integration_branch, from_sha, to_sha, rolled_back_by, rolled_back_origin, created_at
            ) VALUES (?, ?, ?, ?, ?, 'reconciliation', 'reconcile', ?)`).run(
              id("rollback"), row.proposal_id, row.integration_branch,
              row.integrated_sha, head, now(),
            );
            recordEvent(this.db, {
              kind: "ROLLBACK_RECONCILED", entityType: "proposal", entityId: row.proposal_id,
              payload: { branch: row.integration_branch, head, reason: "branch was rolled back without a receipt" },
            });
          });
        }
      }
    }
    return repaired;
  }

  // --- Budget -----------------------------------------------------------------------------------
  //
  // A cost ceiling that is recorded but never checked is not a ceiling. Spend is summed from the
  // usage receipts, which means it inherits their honesty: an UNKNOWN receipt has no cost, and
  // treating that as zero would let unmeasured work slip under a budget indefinitely.

  // Total reference cost already spent on a job, plus what could not be priced.
  //
  // `unpriced` is not a rounding detail. Attempts whose usage is UNKNOWN or unpriceable consumed
  // real tokens that this figure cannot account for, so a caller comparing `spent` against a ceiling
  // must know the comparison is incomplete.
  jobSpend(jobId) {
    const rows = this.db.prepare(`SELECT r.status, r.reference_cost_usd
      FROM attempt_usage_receipts r JOIN attempts a ON a.id = r.attempt_id
      WHERE a.job_id = ?`).all(jobId);
    const attempts = this.db.prepare(`SELECT COUNT(*) AS count FROM attempts a
      JOIN events e ON e.entity_id = a.id AND e.kind = 'EXECUTOR_INTENDED'
      WHERE a.job_id = ?`).get(jobId).count;

    let spent = 0;
    let priced = 0;
    for (const row of rows) {
      // Only COMPLETE + priced counts as fully measured. The finalizer does compute a reference
      // price for PARTIAL observations, and admitting those here would let a truncated receipt pass
      // as complete spend -- the same "incomplete evidence treated as complete" hole that UNKNOWN
      // already closes, one status along. Whatever was observed is still added to `spent`, because
      // it was really consumed; it just cannot make the accounting complete.
      if (row.reference_cost_usd !== null) spent += row.reference_cost_usd;
      if (row.status === "COMPLETE" && row.reference_cost_usd !== null) priced += 1;
    }
    // Every attempt that ran without producing a complete priced receipt is unaccounted spend.
    const unpriced = Math.max(0, attempts - priced);
    return { spent, priced_attempts: priced, unpriced_attempts: unpriced, complete: unpriced === 0 };
  }

  // --- Budget authority is held by a family, not by a job -----------------------------------------
  //
  // A managed job commissions child jobs for exploration. The obvious implementation gives each child
  // its own ceiling, which silently multiplies the operator's limit by the number of children: five
  // explorations under a $0.10 ceiling would authorize $0.60 of work while every individual check
  // passed. So a ceiling belongs to the family that shares it, and a child settles against its root.
  //
  // Learned rather than derived: Claudexor's delegation belt keeps "one live parent-owned paid-budget
  // authority shared by the parent and every child", and states the failure mode as a typed refusal
  // rather than an independent budget. See docs/research/EXTERNAL-ORCHESTRATION-LESSONS.md.

  // The job that owns the ceiling this job spends against. Bounded rather than recursive: nesting is
  // one level by construction, and a cycle introduced by a bad write must not hang the scheduler.
  budgetRootJobId(jobId) {
    let current = jobId;
    for (let depth = 0; depth < 8; depth += 1) {
      const row = this.db.prepare("SELECT parent_job_id FROM jobs WHERE id = ?").get(current);
      if (!row?.parent_job_id) return current;
      current = row.parent_job_id;
    }
    throw new Error(`Job ${jobId} has a parent chain deeper than delegation permits`);
  }

  // NOT YET CONCURRENCY-SAFE, and this must be fixed before parallel exploration lands.
  //
  // familySpend() sums COMPLETED usage receipts. Three exploration workers started at the same
  // instant would each observe $0 spent, each pass assertWithinBudget against the same $0.10
  // authority, and collectively spend three times it. Nothing reserves headroom at admission time.
  //
  // This is not exploitable today only because the bootstrap scheduler admits one running job at a
  // time -- runJob() refuses to claim while any job is RUNNING or any attempt is live. The safety
  // therefore comes from a scheduler restriction that the manager's 2-3 concurrent explorations are
  // specifically meant to remove.
  //
  // Before parallel exploration: admission must reserve against the family authority atomically, in
  // the same BEGIN IMMEDIATE that claims the attempt, with pending starts counting toward the total
  // and the reservation settling against the real receipt afterwards. Claudexor states the property
  // as "admission is atomic and monotonic (pending starts count toward the max)".
  familyJobIds(rootJobId) {
    const seen = new Set([rootJobId]);
    const queue = [rootJobId];
    while (queue.length) {
      const parent = queue.shift();
      for (const row of this.db.prepare("SELECT id FROM jobs WHERE parent_job_id = ?").all(parent)) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        queue.push(row.id);
      }
    }
    return [...seen];
  }

  // Family spend, in the same shape and with the same honesty as jobSpend.
  familySpend(rootJobId) {
    const ids = this.familyJobIds(rootJobId);
    const totals = { spent: 0, priced_attempts: 0, unpriced_attempts: 0 };
    for (const id of ids) {
      const spend = this.jobSpend(id);
      totals.spent += spend.spent;
      totals.priced_attempts += spend.priced_attempts;
      totals.unpriced_attempts += spend.unpriced_attempts;
    }
    return { ...totals, complete: totals.unpriced_attempts === 0, jobs: ids.length };
  }

  // The ceiling in force for this job, and who holds it.
  budgetAuthority(jobId) {
    const rootJobId = this.budgetRootJobId(jobId);
    const root = this.db.prepare("SELECT maximum_cost FROM jobs WHERE id = ?").get(rootJobId);
    return { rootJobId, ceiling: root?.maximum_cost ?? null };
  }

  // Refuses to start work that a recorded ceiling cannot cover.
  //
  // Unaccounted spend blocks rather than passes: if an earlier attempt's cost is unknown, the honest
  // answer is that the budget cannot be shown to be intact, not that it is.
  //
  // This is a START GATE and nothing more. It cannot bound the attempt it admits: once a worker is
  // running there is no live cost cutoff, so an attempt admitted with $0.01 of headroom may spend
  // many times the ceiling before it exits. settleBudget() below is what gives the ceiling
  // consequences after the fact.
  assertWithinBudget(jobId, ceiling = undefined) {
    const authority = this.budgetAuthority(jobId);
    const limit = ceiling === undefined ? authority.ceiling : ceiling;
    if (limit === null || limit === undefined) return null;
    const spend = this.familySpend(authority.rootJobId);
    if (!spend.complete) {
      throw new Error(
        `Job ${jobId} has ${spend.unpriced_attempts} attempt(s) with unpriced usage, so spend against `
        + `the ${limit} ceiling cannot be established. Resolve the usage evidence or raise the ceiling explicitly.`,
      );
    }
    if (spend.spent >= limit) {
      throw new Error(
        `Job ${jobId} has spent ${spend.spent.toFixed(6)} of its ${limit} ceiling; refusing to start more work`,
      );
    }
    return spend;
  }

  // What the ceiling turned out to mean, once the work is done and the receipts are in.
  //
  // The start gate above can only ever ask "was the budget intact BEFORE this?", so a ceiling has
  // historically been describable only as a permission to begin. Settlement is where it acquires
  // consequences.
  //
  // The critical framing: a cost overrun does not make correct code incorrect. These are two
  // independent truths about one attempt, and collapsing them would corrupt both.
  //
  //   ENGINEERING OUTCOME     candidate captured? validation passed? manager accepted?
  //   BUDGET OUTCOME          within authorization? exceeded? unverifiable?
  //
  // So nothing here touches the attempt's record. The attempt succeeded and its validation passed;
  // stamping a failure signature on it to express a budget opinion would falsify engineering history
  // to record a financial fact. What settlement withholds is AUTOMATIC PROGRESSION -- the job does
  // not claim READY_FOR_INTEGRATION, no further paid call may start, and the overrun is surfaced --
  // while the candidate commit is preserved intact. You cannot unspend money; you can decline to
  // spend more of it, and decline to imply the work is cleared to proceed.
  //
  // Three states, matching the COMPLETE/PARTIAL/UNKNOWN discipline the usage receipts already use:
  //
  //   WITHIN      measured spend is complete and under the ceiling
  //   EXCEEDED    measured spend reached or passed the ceiling -- progression is blocked
  //   UNVERIFIED  spend cannot be established, so compliance cannot be claimed either way
  //
  // UNVERIFIED does NOT block. An executor that failed to report usage is a reporting gap, not
  // evidence of overspending, and withholding a validated candidate over one would penalise the
  // operator for an executor's silence. The start gate already refuses to spend anything further
  // under an unestablished total, so the remaining exposure is bounded at the attempt that already
  // ran -- and the honest response to that is to say the cost is unknown, not to claim the limit
  // held.
  // Two consequences, reported separately, because they genuinely differ per state.
  //
  // An earlier version carried a single `authorized` boolean, which had to answer a ternary question
  // and therefore lied about UNVERIFIED: it read `true`, while the prose one screen above said
  // compliance could not be claimed either way. A boolean cannot express "I do not know", so it
  // stopped being asked.
  //
  //   state        blocks_further_spend   blocks_integration_offer
  //   WITHIN       false                  false
  //   EXCEEDED     true                   true
  //   UNVERIFIED   true                   false
  //
  // UNVERIFIED blocking further spend is not a policy choice made here -- it is a restatement of what
  // assertWithinBudget() already does, since an unestablished total cannot be shown to be intact. It
  // does not block the integration offer, because a validated candidate already paid for should not
  // be withheld from the human over an executor's silence about its cost.
  budgetState(jobId) {
    const { rootJobId, ceiling } = this.budgetAuthority(jobId);
    const spend = this.familySpend(rootJobId);
    const base = {
      ceiling: ceiling ?? null, root_job_id: rootJobId, spent: spend.spent,
      complete: spend.complete, unpriced_attempts: spend.unpriced_attempts, jobs: spend.jobs,
    };
    const decided = (state, blocksSpend, blocksOffer) => ({
      ...base, state, blocks_further_spend: blocksSpend, blocks_integration_offer: blocksOffer,
    });
    if (ceiling === null || ceiling === undefined) return decided("WITHIN", false, false);
    if (spend.complete && spend.spent >= ceiling) return decided("EXCEEDED", true, true);
    if (!spend.complete) return decided("UNVERIFIED", true, false);
    return decided("WITHIN", false, false);
  }

  // The settlement moment. `state` is the budget truth; `blocks_integration_offer` is the only thing
  // settlement is permitted to decide about the engineering lifecycle.
  settleBudget(jobId) {
    return this.budgetState(jobId);
  }

  // --- Cancellation -----------------------------------------------------------------------------
  //
  // Cancellation is a request against a running attempt, not a state a caller can assert. The intent
  // is recorded durably first, so a crash between the request and the kill leaves evidence rather
  // than losing it, and the outcome is discovered afterwards.

  cancellationIntents(jobId) {
    return this.db.prepare(`SELECT i.*, r.outcome, r.killed_pid, r.detail
      FROM cancellation_intents i LEFT JOIN cancellation_results r ON r.intent_id = i.id
      WHERE i.job_id = ? ORDER BY i.created_at`).all(jobId);
  }

  // True when an unresolved cancellation exists for this attempt's epoch. The running loop checks
  // this between stages so a cancel lands at a safe boundary rather than mid-write.
  isCancellationRequested(jobId, epoch) {
    return Boolean(this.db.prepare(`SELECT 1 FROM cancellation_intents i
      LEFT JOIN cancellation_results r ON r.intent_id = i.id
      WHERE i.job_id = ? AND i.scheduler_epoch = ? AND r.intent_id IS NULL`).get(jobId, epoch));
  }

  async cancelJob({ jobId, principal, origin, reason = "" }) {
    const job = this.getJob(jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);
    if (!principal || !origin) throw new Error("Cancelling identity is required");

    const epoch = Number(this.db.prepare("SELECT value FROM metadata WHERE key = 'scheduler_epoch'").get().value);
    // The same lifecycle-active definition doctor and reconcile use. An attempt whose executor
    // succeeded but whose validation is still pending is running work: the job is RUNNING and a
    // validation process may be alive, so treating it as "nothing running" would make cancel useless
    // for exactly the phase most likely to hang.
    const active = this.db.prepare(`SELECT * FROM attempts WHERE job_id = ?
      AND ${lifecycleActive()} ORDER BY ordinal DESC LIMIT 1`).get(jobId);

    // Record the intent before touching any process.
    const intentId = id("cancel");
    transaction(this.db, () => {
      this.db.prepare(`INSERT INTO cancellation_intents(
        id, job_id, attempt_id, scheduler_epoch, requested_by, requested_origin, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        intentId, jobId, active?.id ?? null, epoch, principal, origin, String(reason).slice(0, 500), now(),
      );
      recordEvent(this.db, {
        kind: "CANCELLATION_REQUESTED", entityType: "job", entityId: jobId, epoch,
        payload: { intentId, attemptId: active?.id ?? null, requestedBy: principal },
      });
    });

    const settle = (outcome, detail, killedPid = null) => transaction(this.db, () => {
      this.db.prepare(`INSERT INTO cancellation_results(
        intent_id, outcome, killed_pid, detail, created_at
      ) VALUES (?, ?, ?, ?, ?)`).run(intentId, outcome, killedPid, detail, now());
      recordEvent(this.db, {
        kind: "CANCELLATION_SETTLED", entityType: "job", entityId: jobId, epoch,
        payload: { intentId, outcome, killedPid },
      });
      return { intent_id: intentId, outcome, killed_pid: killedPid, detail };
    });

    if (!active) {
      // Cancelling means "I do not want this job to continue". With nothing running there is nothing
      // to kill, but the job may still be open -- waiting for a decision, or holding a candidate
      // nobody will approve. Those used to stay open forever: cancel reported NOTHING_RUNNING and
      // changed nothing, and there was no other way to close them, so the everyday surface filled
      // with work the person had already mentally abandoned.
      //
      // Genuinely terminal states are left alone. An integrated job cannot be un-integrated by
      // cancelling it, and saying otherwise would be a lie about what happened.
      // READY_FOR_INTEGRATION is deliberately NOT closed here. It holds a validated candidate, and
      // discarding one is a decision in its own right -- `integration decline` exists for that, so a
      // mistyped cancel cannot throw away work that passed its checks.
      const terminal = ["SUCCEEDED", "CANCELLED", "READY_FOR_INTEGRATION"].includes(job.status);
      if (terminal) return settle("ALREADY_TERMINAL", `job status ${job.status}`);

      const open = ["PENDING", "NEEDS_ATTENTION", "FAILED"].includes(job.status);
      if (open) {
        const previous = job.status;
        this.db.prepare("UPDATE jobs SET status = 'CANCELLED', updated_at = ? WHERE id = ?")
          .run(now(), jobId);
        recordEvent(this.db, {
          kind: "JOB_CLOSED", entityType: "job", entityId: jobId,
          payload: { principal, origin, reason: reason || null, from: previous },
        });
        // A distinct outcome from CANCELLED: nothing was killed, and the receipt should not imply
        // that something was.
        return settle("CLOSED", `closed from ${previous} without running work`);
      }
      return settle("NOTHING_RUNNING", `job status ${job.status}`);
    }

    // Kill the executor if one is running. A missing PID is not an error: the attempt may not have
    // spawned yet, and the loop's boundary check will still stop it.
    // Which phase is actually running decides what to kill and what "cancelled" means afterwards.
    const validating = active.terminal_state === "SUCCEEDED" && active.validation_state === "PENDING";
    const targetPid = validating ? active.validation_pid : active.executor_pid;

    let killedPid = null;
    if (targetPid) {
      // Never signal this process or its scheduler. A corrupt or misreported PID must not let a
      // cancel take down the control plane; the attempt is still marked cancelled below.
      const forbidden = [process.pid, active.scheduler_pid].filter(Boolean);
      if (forbidden.includes(targetPid)) {
        recordEvent(this.db, {
          kind: "CANCELLATION_KILL_REFUSED", entityType: "attempt", entityId: active.id, epoch,
          payload: { intentId, pid: targetPid, reason: "pid is the scheduler or this process" },
        });
      } else {
        try {
          process.kill(targetPid);
          killedPid = targetPid;
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
    }

    // Mark the attempt cancelled under the same fencing every other transition uses. If the attempt
    // reached a terminal state first, the cancellation is a no-op against a finished attempt rather
    // than a retroactive undo.
    const applied = transaction(this.db, () => {
      const current = this.db.prepare("SELECT * FROM attempts WHERE id = ?").get(active.id);
      const currentEpoch = Number(this.db.prepare("SELECT value FROM metadata WHERE key = 'scheduler_epoch'").get().value);
      if (!current || current.scheduler_epoch !== epoch || currentEpoch !== epoch) return false;

      const stillValidating = current.terminal_state === "SUCCEEDED" && current.validation_state === "PENDING";
      if (current.terminal_state !== null && !stillValidating) return false;

      if (stillValidating) {
        // The executor really did succeed, and validation was interrupted rather than failed. Marking
        // it FAILED would claim the candidate was tested and rejected, which is not what happened.
        // The candidate stays quarantined because it was never validated.
        this.db.prepare(`UPDATE attempts SET validation_state = 'NOT_RUN',
          validation_intent_id = NULL, validation_pid = NULL,
          failure_signature = 'cancelled-during-validation', quarantined = 1, worktree_locked = 1
          WHERE id = ?`).run(active.id);
      } else {
        this.db.prepare(`UPDATE attempts SET terminal_state = 'CANCELLED', finished_at = ?,
          executor_intent_id = NULL, executor_pid = NULL, quarantined = 1, worktree_locked = 1
          WHERE id = ?`).run(now(), active.id);
      }
      this.db.prepare("UPDATE jobs SET status = 'CANCELLED', updated_at = ? WHERE id = ?").run(now(), jobId);
      recordEvent(this.db, {
        kind: "ATTEMPT_CANCELLED", entityType: "attempt", entityId: active.id, epoch,
        payload: { intentId, killedPid, phase: stillValidating ? "validation" : "executor" },
      });
      return true;
    });

    return applied
      ? settle("CANCELLED", `attempt ${active.id} cancelled`, killedPid)
      : settle("ALREADY_TERMINAL", `attempt ${active.id} reached a terminal state first`, killedPid);
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
    // A rollback is the later fact: an integration that was undone is no longer current, and
    // reporting it as INTEGRATED would describe a change the repository no longer contains.
    const rolledBack = this.latestRollback(proposalId);
    const proposal = {
      ...storedProposal,
      state: rolledBack ? "ROLLED_BACK" : (integrated ? "INTEGRATED" : storedProposal.state),
      ...(rolledBack ? { rolled_back: rolledBack } : {}),
    };
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
    // A retired project's repository is allowed to be gone -- that is what retiring it meant.
    // Reporting it forever would turn the health signal into noise, and a health signal nobody
    // believes is worse than none at all.
    const missingRepositories = this.listProjects()
      .filter((project) => !project.retired_at && !fs.existsSync(project.repo_path))
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
    // A restore that could not complete coherently leaves a durable marker outside the database,
    // because the database is the thing it had to outlive. While it is present the system is
    // unhealthy: operational truth and code truth are known to disagree, and only a person can say
    // which one is right.
    const unresolvedRestore = readRestoreMarker(this.root);
    return {
      healthy: integrity.length === 1 && integrity[0] === "ok" && running.length === 0
        && missingRepositories.length === 0 && unresolvedIntegrations.length === 0
        && !unresolvedRestore,
      database_integrity: integrity,
      running_attempts: running,
      missing_repositories: missingRepositories,
      unresolved_integrations: unresolvedIntegrations,
      ...(unresolvedRestore ? { unresolved_restore: unresolvedRestore } : {}),
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
            // NOT_RUN, not FAILED -- the same reasoning cancellation already applies. A validation
            // interrupted by a crash or restart produced no verdict, so recording FAILED would claim
            // the candidate was tested and rejected. It was not tested at all. The attempt is still
            // quarantined and the job still returns for another attempt; only the reason is honest.
            this.db.prepare(`UPDATE attempts SET validation_state = 'NOT_RUN', finished_at = ?,
              failure_signature = 'validation-interrupted',
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
    // A rollback whose branch move landed but whose receipt did not leaves the product reporting a
    // removed change as current, so reconciliation completes that record too.
    const rollbacks = await this.reconcileRollbacks({ apply });
    return { applied: true, scheduler_epoch: epoch, observations, results: applied, rollbacks };
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
