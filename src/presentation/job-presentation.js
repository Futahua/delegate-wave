import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeOpenCodeActivity } from "./activity-open-code.js";
import { projectEvidence } from "./evidence.js";
import { derivePhase, derivePhaseSteps } from "./phase.js";

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch { return fallback; }
}

function actorState(attempt) {
  if (attempt.terminal_state === null) return "working";
  if (attempt.terminal_state === "SUCCEEDED") return "completed";
  return "failed";
}

function attemptLabel(attempt, job) {
  if (job.internal_kind === "MANAGER_EXPLORATION" || job.mode === "read") return "Exploration worker";
  return attempt.ordinal > 1 ? `Revision worker ${attempt.ordinal}` : "Implementation worker";
}

function workKind(attempt, ownerJob) {
  if (ownerJob.internal_kind === "MANAGER_EXPLORATION") return "exploration";
  return attempt.ordinal > 1 ? "revision" : "implementation";
}

function projectActors({ job, managerRun, attempts, childJobs }) {
  const actors = [];
  if (managerRun) {
    actors.push({
      id: `manager:${managerRun.id}`,
      role: "manager",
      label: "Manager",
      state: ["ACCEPTED", "CANCELLED"].includes(managerRun.status) ? "completed"
        : managerRun.status === "FAILED" ? "failed"
          : ["AWAITING_HUMAN"].includes(managerRun.status) ? "waiting" : "working",
      current: String(managerRun.status).toLowerCase().replaceAll("_", " "),
      started_at: managerRun.created_at,
      ...(managerRun.updated_at ? { finished_at: ["ACCEPTED", "FAILED", "CANCELLED"].includes(managerRun.status) ? managerRun.updated_at : undefined } : {}),
    });
  }
  for (const attempt of attempts) {
    const ownerJob = attempt.job_id === job.id ? job : childJobs.find((child) => child.id === attempt.job_id) ?? job;
    actors.push({
      id: `worker:${attempt.id}`,
      role: "worker",
      label: attemptLabel(attempt, ownerJob),
      work_kind: workKind(attempt, ownerJob),
      state: actorState(attempt),
      current: attempt.terminal_state === null ? "Working" : attempt.validation_state === "PENDING" ? "Validating" : undefined,
      attempt_id: attempt.id,
      ...(ownerJob.id !== job.id ? { child_job_id: ownerJob.id } : {}),
      started_at: attempt.started_at,
      ...(attempt.finished_at ? { finished_at: attempt.finished_at } : {}),
    });
    if (attempt.validation_state !== "NOT_RUN") {
      actors.push({
        id: `validator:${attempt.id}`,
        role: "validator",
        label: "Validator",
        state: attempt.validation_state === "PENDING" ? "working"
          : attempt.validation_state === "PASSED" ? "completed" : "failed",
        current: attempt.validation_state === "PENDING" ? "Running validation" : undefined,
        attempt_id: attempt.id,
        started_at: attempt.finished_at ?? attempt.started_at,
        ...(attempt.validation_state !== "PENDING" && attempt.finished_at ? { finished_at: attempt.finished_at } : {}),
      });
    }
  }
  return actors.map((actor) => Object.fromEntries(Object.entries(actor).filter(([, value]) => value !== undefined)));
}

function managerActivity(managerTurns) {
  const turn = managerTurns.findLast((candidate) => candidate.state === "RUNNING"
    || (candidate.state === "COMPLETED" && candidate.response_artifact));
  if (!turn) return [];
  let summary = null;
  if (turn.state === "COMPLETED" && turn.response_artifact) {
    try {
      const stat = fs.statSync(turn.response_artifact);
      if (stat.size <= 64 * 1024) {
        const parsed = JSON.parse(fs.readFileSync(turn.response_artifact, "utf8"));
        if (typeof parsed?.reason === "string" && parsed.reason.trim()) summary = parsed.reason.trim().slice(0, 1_200);
      }
    } catch { /* absent or malformed display summary stays absent */ }
  }
  if (!summary && turn.state !== "RUNNING") return [];
  return [{
    id: `manager-activity:${turn.id}`,
    occurred_at: turn.finished_at ?? turn.started_at,
    actor_id: `manager:${turn.manager_run_id}`,
    actor_role: "manager",
    kind: "narration",
    lifecycle: turn.state === "RUNNING" ? "started" : "completed",
    title: summary ?? `Manager ${String(turn.phase).toLowerCase()} is in progress`,
    authority: "activity",
  }];
}

function settledGroups(attempts) {
  return attempts.filter((attempt) => attempt.terminal_state !== null && attempt.validation_state !== "PENDING").map((attempt) => {
    const parsedFiles = parseJson(attempt.changed_files_json, []);
    const files = Array.isArray(parsedFiles) ? parsedFiles : [];
    return {
      id: `attempt:${attempt.id}`,
      actor_id: `worker:${attempt.id}`,
      label: attempt.terminal_state === "SUCCEEDED" ? "Worker completed" : "Worker stopped",
      state: attempt.terminal_state === "SUCCEEDED" ? "completed" : "failed",
      summary: [
        files.length ? `${files.length} file${files.length === 1 ? "" : "s"} changed` : null,
        attempt.validation_state === "PASSED" ? "validation passed" : null,
      ].filter(Boolean).join(" · ") || `Attempt ${attempt.ordinal} settled`,
      attempt_id: attempt.id,
      started_at: attempt.started_at,
      finished_at: attempt.finished_at,
    };
  });
}

function changedFiles(attempts) {
  const paths = new Set();
  for (const attempt of attempts) {
    const parsedFiles = parseJson(attempt.changed_files_json, []);
    for (const item of Array.isArray(parsedFiles) ? parsedFiles : []) {
      const value = typeof item === "string" ? item : item?.path;
      if (value) paths.add(value);
    }
  }
  if (!paths.size) return undefined;
  return { count: paths.size, files: [...paths].sort().map((filePath) => ({ path: filePath })) };
}

export function projectAttention(job, managerRun, attempts) {
  if (managerRun?.status === "AWAITING_HUMAN") return { kind: "question", summary: managerRun.escalation_question || "Delegate Wave needs input before it can continue." };
  const failed = attempts.find((attempt) => attempt.terminal_state === "FAILED");
  if (job.status === "NEEDS_ATTENTION" && failed) return { kind: "failure", summary: failed.failure?.message ?? "A worker attempt failed and needs attention." };
  if (job.status === "NEEDS_ATTENTION") return { kind: "approval", summary: "This job needs attention before it can continue." };
  return undefined;
}

function outcome(job, attempts) {
  if (job.status === "SUCCEEDED") return { kind: "completed", summary: "Delegate Wave completed the job." };
  if (["FAILED", "CANCELLED"].includes(job.status)) {
    const failed = attempts.findLast((attempt) => attempt.failure?.message);
    return { kind: "failed", summary: failed?.failure?.message ?? `Delegate Wave stopped with ${job.status.toLowerCase()}.` };
  }
  return undefined;
}

export function buildJobPresentation({ db, paths, job, attempts, validations, family }) {
  const managerRun = db.prepare("SELECT * FROM manager_runs WHERE job_id = ?").get(job.id) ?? null;
  const managerTurns = managerRun
    ? db.prepare("SELECT * FROM manager_turns WHERE manager_run_id = ? ORDER BY ordinal").all(managerRun.id)
    : [];
  const childJobs = db.prepare("SELECT * FROM jobs WHERE parent_job_id = ? ORDER BY created_at").all(job.id);
  const childAttempts = childJobs.flatMap((child) => db.prepare("SELECT * FROM attempts WHERE job_id = ? ORDER BY ordinal").all(child.id));
  const allAttempts = [...attempts, ...childAttempts];
  const childValidations = childJobs.flatMap((child) => db.prepare(`SELECT v.* FROM validation_runs v
    JOIN attempts a ON a.id = v.attempt_id WHERE a.job_id = ? ORDER BY v.started_at`).all(child.id));
  const allValidations = [...validations, ...childValidations];
  const activeAttempts = allAttempts.filter((attempt) => attempt.terminal_state === null);
  const liveActivity = [...managerActivity(managerTurns), ...activeAttempts.flatMap((attempt) => normalizeOpenCodeActivity({
    attempt: { ...attempt, actor_role: "worker" },
    filePath: path.join(paths.artifacts, job.project_id, attempt.id, "opencode-events.jsonl"),
    runtimeDatabasePath: path.join(paths.tmp, "executor", attempt.id, "opencode-state.db"),
  }).activities)].sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)));
  const phase = derivePhase({ job, managerRun, attempts: allAttempts });
  const phaseSteps = derivePhaseSteps({ job, managerRun, managerTurns, attempts: allAttempts, validations: allValidations, childJobs });
  const actors = projectActors({ job, managerRun, attempts: allAttempts, childJobs });
  const evidence = projectEvidence({ validations: allValidations, managerTurns, attempts: allAttempts });
  const projection = {
    schema: 1,
    phase,
    phase_steps: phaseSteps,
    actors,
    live_activity: liveActivity,
    settled_groups: settledGroups(allAttempts),
    evidence,
    ...(changedFiles(allAttempts) ? { changed_files: changedFiles(allAttempts) } : {}),
    ...(projectAttention(job, managerRun, allAttempts) ? { attention: projectAttention(job, managerRun, allAttempts) } : {}),
    ...(outcome(job, allAttempts) ? { outcome: outcome(job, allAttempts) } : {}),
  };
  const revision = crypto.createHash("sha256").update(JSON.stringify(projection)).digest("hex");
  return { schema: 1, revision, generated_at: new Date().toISOString(), ...projection };
}
