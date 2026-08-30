import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeOpenCodeActivityPage } from "./activity-open-code.js";

export const DEFAULT_SESSION_PAGE = 40;
export const MAX_SESSION_PAGE = 100;
export const DEFAULT_STREAM_PAGE = 120;
export const MAX_STREAM_PAGE = 500;

function boundedInteger(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    return typeof parsed?.createdAt === "string" && typeof parsed?.id === "string" ? parsed : null;
  } catch { return null; }
}

function presentationState(session) {
  if (["COMPLETED", "FAILED"].includes(session.state)) return "settled";
  if (session.state === "WAITING_FOR_HERMES") return "waiting";
  // Delegate Wave itself stops MANUAL and PLAN at semantic acceptance. AUTO-like modes retain a
  // publication lane and remain live until that lane either publishes or fails.
  if (session.state === "SEMANTICALLY_ACCEPTED" && ["MANUAL", "PLAN"].includes(session.mode)) return "settled";
  return "live";
}

function sessionRecord(session) {
  const state = presentationState(session);
  return {
    id: session.id,
    root_job_id: session.job_id,
    intent: session.intent,
    mode: session.mode,
    state,
    origin_hermes_session_id: session.origin_hermes_session_id ?? undefined,
    started_at: session.created_at,
    ...(state === "settled" ? { settled_at: session.updated_at } : {}),
    updated_at: session.updated_at,
  };
}

export function listSessionPresentations(db, { limit, cursor } = {}) {
  const pageLimit = boundedInteger(limit, DEFAULT_SESSION_PAGE, MAX_SESSION_PAGE);
  const decoded = decodeCursor(cursor);
  const rows = db.prepare(`SELECT s.id, s.job_id, s.intent, s.mode, s.state, s.created_at, s.updated_at,
      (SELECT w.hermes_session_id FROM session_watches w WHERE w.session_id = s.id
       ORDER BY w.created_at ASC, w.id ASC LIMIT 1) AS origin_hermes_session_id
    FROM autonomous_sessions s
    WHERE (? IS NULL OR s.created_at < ? OR (s.created_at = ? AND s.id < ?))
    ORDER BY s.created_at DESC, s.id DESC LIMIT ?`).all(
      decoded?.createdAt ?? null, decoded?.createdAt ?? null,
      decoded?.createdAt ?? null, decoded?.id ?? null, pageLimit + 1,
    );
  const hasMore = rows.length > pageLimit;
  const visible = rows.slice(0, pageLimit);
  const last = visible.at(-1);
  return {
    sessions: visible.map(sessionRecord),
    has_more: hasMore,
    next_cursor: hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null,
  };
}

function readManagerNarration(turn) {
  if (turn.state !== "COMPLETED" || !turn.response_artifact) return [];
  try {
    if (fs.statSync(turn.response_artifact).size > 64 * 1024) return [];
    const value = JSON.parse(fs.readFileSync(turn.response_artifact, "utf8"));
    const text = typeof value?.reason === "string" ? value.reason.trim() : "";
    return text ? [{ id: `manager-text:${turn.id}`, kind: "narration", lifecycle: "completed",
      title: text, occurred_at: turn.finished_at, authority: "activity",
      source: { table: "manager_turns", id: turn.id, artifact: "public_response_reason" } }] : [];
  } catch { return []; }
}

function spanState(raw) {
  if (raw === null || ["INTENDED", "RUNNING", "PENDING"].includes(raw)) return "live";
  if (["WAITING_FOR_HERMES", "AWAITING_HUMAN"].includes(raw)) return "waiting";
  if (["COMPLETED", "SUCCEEDED", "PASSED", "ACCEPTED"].includes(raw)) return "completed";
  if (["CANCELLED", "INTERRUPTED", "ORPHANED"].includes(raw)) return "cancelled";
  return "failed";
}

function workerSpan({ attempt, job, rootJobId, paths, before, streamLimit }) {
  const page = normalizeOpenCodeActivityPage({
    attempt: { ...attempt, actor_role: "worker" }, before,
    limit: boundedInteger(streamLimit, DEFAULT_STREAM_PAGE, MAX_STREAM_PAGE),
    filePath: path.join(paths.artifacts, job.project_id, attempt.id, "opencode-events.jsonl"),
    runtimeDatabasePath: path.join(paths.tmp, "executor", attempt.id, "opencode-state.db"),
  });
  return {
    id: `worker:${attempt.id}`,
    ...(job.id === rootJobId ? {} : { parent_id: rootJobId }),
    actor: "worker",
    label: job.internal_kind === "MANAGER_EXPLORATION" ? "Exploration worker"
      : attempt.ordinal > 1 ? `Revision worker ${attempt.ordinal}` : "Implementation worker",
    state: spanState(attempt.terminal_state),
    started_at: attempt.started_at,
    ...(attempt.finished_at ? { finished_at: attempt.finished_at } : {}),
    stream: page.activities,
    stream_bounds: { complete: page.complete, has_earlier: page.hasEarlier, cursor: page.cursor },
  };
}

export function buildSessionTimeline({ db, paths, sessionId, streamSpanId = null, before = null, streamLimit = null }) {
  const row = db.prepare(`SELECT s.*,
      (SELECT w.hermes_session_id FROM session_watches w WHERE w.session_id = s.id
       ORDER BY w.created_at ASC, w.id ASC LIMIT 1) AS origin_hermes_session_id
    FROM autonomous_sessions s WHERE s.id = ?`).get(sessionId);
  if (!row) throw new Error(`Unknown session: ${sessionId}`);
  const session = sessionRecord(row);
  const spans = [];
  if (session.root_job_id) {
    const jobs = db.prepare("SELECT * FROM jobs WHERE id = ? OR parent_job_id = ? ORDER BY created_at, id")
      .all(session.root_job_id, session.root_job_id);
    const managerRun = db.prepare("SELECT * FROM manager_runs WHERE job_id = ?").get(session.root_job_id);
    if (!streamSpanId && managerRun) {
      const turns = db.prepare("SELECT * FROM manager_turns WHERE manager_run_id = ? ORDER BY ordinal").all(managerRun.id);
      for (const turn of turns) spans.push({ id: `manager-turn:${turn.id}`, actor: "manager",
        label: `Manager ${turn.phase.toLowerCase()}`, state: spanState(turn.state), started_at: turn.started_at,
        ...(turn.finished_at ? { finished_at: turn.finished_at } : {}), stream: readManagerNarration(turn),
        stream_bounds: { complete: true, has_earlier: false, cursor: null } });
    }
    for (const job of jobs) {
      const attempts = db.prepare("SELECT * FROM attempts WHERE job_id = ? ORDER BY ordinal").all(job.id);
      for (const attempt of attempts) {
        const spanId = `worker:${attempt.id}`;
        if (!streamSpanId || streamSpanId === spanId) spans.push(workerSpan({
          attempt, job, rootJobId: session.root_job_id, paths,
          before: streamSpanId === spanId ? before : null, streamLimit,
        }));
        if (!streamSpanId) {
          const validations = db.prepare("SELECT * FROM validation_runs WHERE attempt_id = ? ORDER BY started_at, id").all(attempt.id);
          for (const validation of validations) spans.push({ id: `validation:${validation.id}`, parent_id: spanId,
            actor: "validator", label: validation.command,
            state: !validation.finished_at ? "live" : validation.outcome === "PASSED" ? "completed" : "failed",
            started_at: validation.started_at, ...(validation.finished_at ? { finished_at: validation.finished_at } : {}),
            stream: [{ id: `validation-result:${validation.id}`, kind: "command",
              lifecycle: !validation.finished_at ? "started" : validation.outcome === "PASSED" ? "completed" : "failed", title: validation.command,
              detail: validation.outcome, occurred_at: validation.finished_at ?? validation.started_at,
              authority: "evidence", source: { table: "validation_runs", id: validation.id } }],
            stream_bounds: { complete: true, has_earlier: false, cursor: null } });
        }
      }
    }
  }
  if (streamSpanId && spans.length === 0) throw new Error(`Unknown process span: ${streamSpanId}`);
  spans.sort((a, b) => a.started_at.localeCompare(b.started_at) || a.id.localeCompare(b.id));
  const projection = { schema: 2, session, spans, ...(streamSpanId ? { stream_page_for: streamSpanId } : {}) };
  return { ...projection, revision: crypto.createHash("sha256").update(JSON.stringify(projection)).digest("hex") };
}
