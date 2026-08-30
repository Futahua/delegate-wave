import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeOpenCodeActivity } from "./activity-open-code.js";

function readManagerNarration(turn) {
  if (turn.state !== "COMPLETED" || !turn.response_artifact) return [];
  try {
    if (fs.statSync(turn.response_artifact).size > 64 * 1024) return [];
    const value = JSON.parse(fs.readFileSync(turn.response_artifact, "utf8"));
    const text = typeof value?.reason === "string" ? value.reason.trim() : "";
    return text ? [{
      id: `manager-text:${turn.id}`, kind: "narration", lifecycle: "completed",
      title: text.slice(0, 1_200), occurred_at: turn.finished_at, authority: "activity",
    }] : [];
  } catch { return []; }
}

function spanState(raw) {
  if (raw === null || ["INTENDED", "RUNNING", "PENDING"].includes(raw)) return "live";
  if (["WAITING_FOR_HERMES", "AWAITING_HUMAN"].includes(raw)) return "waiting";
  if (["COMPLETED", "SUCCEEDED", "PASSED", "ACCEPTED"].includes(raw)) return "completed";
  if (["CANCELLED", "INTERRUPTED", "ORPHANED"].includes(raw)) return "cancelled";
  return "failed";
}

export function listSessionPresentations(db) {
  return db.prepare(`SELECT s.id, s.job_id, s.intent, s.state, s.created_at, s.updated_at,
      (SELECT w.hermes_session_id FROM session_watches w WHERE w.session_id = s.id
       ORDER BY w.created_at DESC, w.id DESC LIMIT 1) AS origin_hermes_session_id
    FROM autonomous_sessions s ORDER BY s.updated_at DESC, s.id DESC`).all().map((session) => ({
    id: session.id,
    root_job_id: session.job_id,
    intent: session.intent,
    state: ["COMPLETED", "FAILED"].includes(session.state) ? "settled"
      : session.state === "WAITING_FOR_HERMES" ? "waiting" : "live",
    origin_hermes_session_id: session.origin_hermes_session_id ?? undefined,
    started_at: session.created_at,
    ...(["COMPLETED", "FAILED"].includes(session.state) ? { settled_at: session.updated_at } : {}),
    updated_at: session.updated_at,
  }));
}

export function buildSessionTimeline({ db, paths, sessionId }) {
  const session = listSessionPresentations(db).find((item) => item.id === sessionId);
  if (!session) throw new Error(`Unknown session: ${sessionId}`);
  const spans = [];
  if (session.root_job_id) {
    const jobs = db.prepare("SELECT * FROM jobs WHERE id = ? OR parent_job_id = ? ORDER BY created_at, id")
      .all(session.root_job_id, session.root_job_id);
    const managerRun = db.prepare("SELECT * FROM manager_runs WHERE job_id = ?").get(session.root_job_id);
    if (managerRun) {
      const turns = db.prepare("SELECT * FROM manager_turns WHERE manager_run_id = ? ORDER BY ordinal").all(managerRun.id);
      for (const turn of turns) spans.push({
        id: `manager-turn:${turn.id}`, actor: "manager", label: `Manager ${turn.phase.toLowerCase()}`,
        state: spanState(turn.state), started_at: turn.started_at,
        ...(turn.finished_at ? { finished_at: turn.finished_at } : {}),
        stream: readManagerNarration(turn),
      });
    }
    for (const job of jobs) {
      const attempts = db.prepare("SELECT * FROM attempts WHERE job_id = ? ORDER BY ordinal").all(job.id);
      for (const attempt of attempts) {
        const stream = normalizeOpenCodeActivity({
          attempt: { ...attempt, actor_role: "worker" }, limit: 5_000,
          filePath: path.join(paths.artifacts, job.project_id, attempt.id, "opencode-events.jsonl"),
          runtimeDatabasePath: path.join(paths.tmp, "executor", attempt.id, "opencode-state.db"),
        }).activities;
        spans.push({
          id: `worker:${attempt.id}`, parent_id: job.id === session.root_job_id ? undefined : session.root_job_id,
          actor: "worker",
          label: job.internal_kind === "MANAGER_EXPLORATION" ? "Exploration worker"
            : attempt.ordinal > 1 ? `Revision worker ${attempt.ordinal}` : "Implementation worker",
          state: spanState(attempt.terminal_state), started_at: attempt.started_at,
          ...(attempt.finished_at ? { finished_at: attempt.finished_at } : {}), stream,
        });
        const validations = db.prepare("SELECT * FROM validation_runs WHERE attempt_id = ? ORDER BY started_at, id").all(attempt.id);
        for (const validation of validations) spans.push({
          id: `validation:${validation.id}`, parent_id: `worker:${attempt.id}`, actor: "validator",
          label: validation.command, state: validation.outcome === "PASSED" ? "completed" : "failed",
          started_at: validation.started_at, ...(validation.finished_at ? { finished_at: validation.finished_at } : {}),
          stream: [{ id: `validation-result:${validation.id}`, kind: "command",
            lifecycle: validation.outcome === "PASSED" ? "completed" : "failed",
            title: validation.command, detail: validation.outcome, occurred_at: validation.finished_at ?? validation.started_at,
            authority: "evidence" }],
        });
      }
    }
  }
  spans.sort((a, b) => a.started_at.localeCompare(b.started_at) || a.id.localeCompare(b.id));
  const projection = { schema: 1, session, spans };
  return { ...projection, revision: crypto.createHash("sha256").update(JSON.stringify(projection)).digest("hex") };
}
