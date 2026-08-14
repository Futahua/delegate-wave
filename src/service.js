import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { openDatabase, nextSchedulerEpoch, recordEvent, transaction } from "./db.js";
import { managedPaths } from "./paths.js";
import {
  assertRepository,
  changedFiles,
  commitAll,
  createDetachedWorktree,
  git,
  lockWorktree,
  resolveRevision,
} from "./git.js";
import { runShell } from "./process.js";

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${crypto.randomUUID()}`;

function parseJson(value, fallback = []) {
  try { return JSON.parse(value); } catch { return fallback; }
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

export class Dispatcher {
  constructor({ root, backend }) {
    this.paths = managedPaths(root);
    this.db = openDatabase(this.paths.database);
    this.backend = backend;
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
    this.db.prepare(`INSERT INTO projects(
      id, name, repo_path, integration_branch, validation_json, protected_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      projectId, name, resolvedPath, integrationBranch,
      JSON.stringify(validation), JSON.stringify(protectedPaths), now(),
    );
    recordEvent(this.db, { kind: "PROJECT_REGISTERED", entityType: "project", entityId: projectId });
    return this.getProject(projectId);
  }

  getProject(projectId) {
    return this.db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
  }

  listProjects() {
    return this.db.prepare("SELECT * FROM projects ORDER BY created_at").all();
  }

  async createJob({ projectId, goal, mode = "write", maxAttempts = 2 }) {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Unknown project: ${projectId}`);
    if (!['read', 'write'].includes(mode)) throw new Error("mode must be read or write");
    const baseSha = await resolveRevision(project.repo_path, project.integration_branch);
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

  getJob(jobId) {
    return this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
  }

  listJobs(projectId = null) {
    if (projectId) return this.db.prepare("SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at DESC").all(projectId);
    return this.db.prepare("SELECT * FROM jobs ORDER BY created_at DESC").all();
  }

  async runJob(jobId, { model = null } = {}) {
    const epoch = nextSchedulerEpoch(this.db);
    const job = this.getJob(jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);
    if (!['PENDING', 'NEEDS_ATTENTION'].includes(job.status)) throw new Error(`Job ${jobId} is ${job.status}`);
    const project = this.getProject(job.project_id);
    const previousAttempts = this.db.prepare("SELECT COUNT(*) AS count FROM attempts WHERE job_id = ?").get(jobId).count;
    if (previousAttempts >= job.max_attempts) throw new Error(`Job ${jobId} exhausted its ${job.max_attempts} attempts`);
    const ordinal = previousAttempts + 1;
    const attemptId = `${job.id}.${ordinal}`;
    const worktreePath = path.join(this.paths.worktrees, project.id, `attempt-${ordinal}-${job.id.slice(-8)}`);
    const artifactDir = path.join(this.paths.artifacts, project.id, attemptId);
    fs.mkdirSync(artifactDir, { recursive: true });

    transaction(this.db, () => {
      const current = this.getJob(jobId);
      if (!['PENDING', 'NEEDS_ATTENTION'].includes(current.status)) throw new Error("Job changed before attempt creation");
      this.db.prepare(`INSERT INTO attempts(
        id, job_id, ordinal, scheduler_epoch, backend, model, worktree_path, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        attemptId, jobId, ordinal, epoch, this.backend.constructor.name, model, worktreePath, now(),
      );
      this.db.prepare("UPDATE jobs SET status = 'RUNNING', updated_at = ? WHERE id = ?").run(now(), jobId);
      recordEvent(this.db, { kind: "ATTEMPT_CREATED", entityType: "attempt", entityId: attemptId, epoch });
    });

    try {
      await createDetachedWorktree(project.repo_path, worktreePath, job.base_sha);
      const backendResult = await this.backend.run({
        attemptId, worktreePath, artifactDir, goal: job.goal, model, mode: job.mode,
        onSpawn: (pid) => this.recordExecutorPid(attemptId, epoch, pid),
      });
      if (backendResult.timedOut) throw new Error("worker timeout");
      if (backendResult.exitCode !== 0) throw new Error(`worker exited ${backendResult.exitCode}: ${backendResult.stderr?.slice(-2000) ?? ""}`);

      const files = await changedFiles(worktreePath);
      this.assertAllowedDiff(files, parseJson(project.protected_json));
      let resultCommit = null;
      if (job.mode === "write") {
        if (files.length === 0) throw new Error("worker completed without changing files");
        resultCommit = await commitAll(worktreePath, `delegate-wave: ${job.goal.slice(0, 72)} (${attemptId})`);
      }

      this.acceptAttemptEvent(attemptId, epoch, () => {
        this.db.prepare(`UPDATE attempts SET terminal_state = 'SUCCEEDED', validation_state = 'PENDING',
          finished_at = ?, exit_code = 0, result_commit = ? WHERE id = ?`).run(now(), resultCommit, attemptId);
        recordEvent(this.db, { kind: "EXECUTOR_SUCCEEDED", entityType: "attempt", entityId: attemptId, epoch, payload: { files, resultCommit } });
      });

      const validations = job.mode === "write" ? parseJson(project.validation_json) : [];
      for (const command of validations) await this.validate(attemptId, epoch, worktreePath, artifactDir, command);

      this.acceptAttemptEvent(attemptId, epoch, () => {
        this.db.prepare("UPDATE attempts SET validation_state = 'PASSED' WHERE id = ?").run(attemptId);
        this.db.prepare("UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?").run(
          job.mode === "write" ? "READY_FOR_INTEGRATION" : "SUCCEEDED", now(), jobId,
        );
        recordEvent(this.db, { kind: "VALIDATION_PASSED", entityType: "job", entityId: jobId, epoch });
      }, "SUCCEEDED");
      return this.status(jobId);
    } catch (error) {
      await this.failAttempt({ attemptId, jobId, epoch, project, worktreePath, error });
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

  acceptAttemptEvent(attemptId, epoch, action, expectedTerminalState = null) {
    return transaction(this.db, () => {
      const attempt = this.db.prepare("SELECT * FROM attempts WHERE id = ?").get(attemptId);
      const currentEpoch = Number(this.db.prepare("SELECT value FROM metadata WHERE key = 'scheduler_epoch'").get().value);
      if (!attempt || attempt.scheduler_epoch !== epoch || currentEpoch !== epoch || attempt.terminal_state !== expectedTerminalState) {
        throw new Error(`Stale or terminal attempt event rejected for ${attemptId}`);
      }
      return action(attempt);
    });
  }

  recordExecutorPid(attemptId, epoch, pid) {
    transaction(this.db, () => {
      const attempt = this.db.prepare("SELECT * FROM attempts WHERE id = ?").get(attemptId);
      const currentEpoch = Number(this.db.prepare("SELECT value FROM metadata WHERE key = 'scheduler_epoch'").get().value);
      if (!attempt || attempt.scheduler_epoch !== epoch || currentEpoch !== epoch || attempt.terminal_state !== null) {
        throw new Error(`Stale executor start rejected for ${attemptId}`);
      }
      this.db.prepare("UPDATE attempts SET executor_pid = ? WHERE id = ?").run(pid, attemptId);
      recordEvent(this.db, { kind: "EXECUTOR_STARTED", entityType: "attempt", entityId: attemptId, epoch, payload: { pid } });
    });
  }

  async validate(attemptId, epoch, worktreePath, artifactDir, command) {
    const validationId = id("validation");
    const startedAt = now();
    const result = await runShell(command, { cwd: worktreePath, timeoutMs: 15 * 60_000 });
    const outputPath = path.join(artifactDir, `${validationId}.log`);
    fs.writeFileSync(outputPath, `${result.stdout}\n${result.stderr}`, { flag: "wx" });
    this.db.prepare(`INSERT INTO validation_runs(
      id, attempt_id, command, exit_code, output_path, started_at, finished_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      validationId, attemptId, command, result.exitCode, outputPath, startedAt, now(),
    );
    recordEvent(this.db, { kind: "VALIDATION_FINISHED", entityType: "attempt", entityId: attemptId, epoch, payload: { command, exitCode: result.exitCode } });
    if (result.exitCode !== 0) throw new Error(`validation failed (${result.exitCode}): ${command}`);
  }

  async failAttempt({ attemptId, jobId, epoch, project, worktreePath, error }) {
    const message = error instanceof Error ? error.message : String(error);
    const signature = normalizeFailureSignature(message);
    try {
      if (fs.existsSync(worktreePath)) await lockWorktree(project.repo_path, worktreePath, `quarantined ${attemptId}`);
    } catch { /* preserve the original failure; reconciliation will inspect the lock */ }
    transaction(this.db, () => {
      const attempt = this.db.prepare("SELECT * FROM attempts WHERE id = ?").get(attemptId);
      if (attempt && attempt.scheduler_epoch === epoch && attempt.terminal_state === null) {
        this.db.prepare(`UPDATE attempts SET terminal_state = 'FAILED', finished_at = ?,
          failure_signature = ?, quarantined = 1, worktree_locked = 1 WHERE id = ?`).run(now(), signature, attemptId);
      } else if (attempt && attempt.scheduler_epoch === epoch && attempt.terminal_state === 'SUCCEEDED') {
        this.db.prepare(`UPDATE attempts SET validation_state = 'FAILED',
          failure_signature = ?, quarantined = 1, worktree_locked = 1 WHERE id = ?`).run(signature, attemptId);
      }
      const count = this.db.prepare("SELECT COUNT(*) AS count FROM attempts WHERE job_id = ?").get(jobId).count;
      const job = this.getJob(jobId);
      const nextStatus = count >= job.max_attempts ? "NEEDS_ATTENTION" : "PENDING";
      this.db.prepare("UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?").run(nextStatus, now(), jobId);
      recordEvent(this.db, { kind: "ATTEMPT_FAILED", entityType: "attempt", entityId: attemptId, epoch, payload: { message, signature } });
    });
  }

  status(jobId) {
    const job = this.getJob(jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);
    const attempts = this.db.prepare("SELECT * FROM attempts WHERE job_id = ? ORDER BY ordinal").all(jobId);
    const validations = this.db.prepare(`SELECT v.* FROM validation_runs v
      JOIN attempts a ON a.id = v.attempt_id WHERE a.job_id = ? ORDER BY v.started_at`).all(jobId);
    return { job, attempts, validations };
  }

  doctor() {
    const integrity = this.db.prepare("PRAGMA quick_check").all().map((row) => row.quick_check);
    const running = this.db.prepare(`SELECT a.*, j.project_id, j.status AS job_status
      FROM attempts a JOIN jobs j ON j.id = a.job_id
      WHERE a.terminal_state IS NULL ORDER BY a.started_at`).all().map((attempt) => ({
        ...attempt,
        executor_alive: isProcessAlive(attempt.executor_pid),
        worktree_exists: Boolean(attempt.worktree_path && fs.existsSync(attempt.worktree_path)),
      }));
    const missingRepositories = this.listProjects()
      .filter((project) => !fs.existsSync(project.repo_path))
      .map((project) => ({ id: project.id, repo_path: project.repo_path }));
    return {
      healthy: integrity.length === 1 && integrity[0] === "ok" && running.length === 0 && missingRepositories.length === 0,
      database_integrity: integrity,
      running_attempts: running,
      missing_repositories: missingRepositories,
    };
  }

  async reconcile({ apply = false } = {}) {
    const running = this.db.prepare(`SELECT a.*, j.project_id, j.max_attempts,
      (SELECT COUNT(*) FROM attempts x WHERE x.job_id = a.job_id) AS attempt_count
      FROM attempts a JOIN jobs j ON j.id = a.job_id
      WHERE a.terminal_state IS NULL ORDER BY a.started_at`).all();
    const observations = running.map((attempt) => ({
      attempt_id: attempt.id,
      executor_pid: attempt.executor_pid,
      executor_alive: isProcessAlive(attempt.executor_pid),
      worktree_exists: Boolean(attempt.worktree_path && fs.existsSync(attempt.worktree_path)),
      proposed: isProcessAlive(attempt.executor_pid) ? "LEAVE_RUNNING" : "ORPHAN",
    }));
    if (!apply || running.length === 0) return { applied: false, observations };

    const epoch = nextSchedulerEpoch(this.db);
    const applied = [];
    for (const attempt of running) {
      if (isProcessAlive(attempt.executor_pid)) {
        applied.push({ attempt_id: attempt.id, action: "REFUSED_LIVE_EXECUTOR" });
        continue;
      }
      transaction(this.db, () => {
        const current = this.db.prepare("SELECT * FROM attempts WHERE id = ?").get(attempt.id);
        if (!current || current.terminal_state !== null) return;
        this.db.prepare(`UPDATE attempts SET terminal_state = 'ORPHANED', finished_at = ?,
          quarantined = 1, worktree_locked = 1 WHERE id = ?`).run(now(), attempt.id);
        const nextStatus = attempt.attempt_count >= attempt.max_attempts ? "NEEDS_ATTENTION" : "PENDING";
        this.db.prepare("UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?").run(nextStatus, now(), attempt.job_id);
        recordEvent(this.db, { kind: "ATTEMPT_ORPHANED", entityType: "attempt", entityId: attempt.id, epoch });
      });
      const project = this.getProject(attempt.project_id);
      try {
        if (attempt.worktree_path && fs.existsSync(attempt.worktree_path)) {
          await lockWorktree(project.repo_path, attempt.worktree_path, `quarantined ${attempt.id}`);
        }
      } catch { /* the database quarantine is authoritative; doctor reports filesystem drift */ }
      applied.push({ attempt_id: attempt.id, action: "ORPHANED" });
    }
    return { applied: true, scheduler_epoch: epoch, observations, results: applied };
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
