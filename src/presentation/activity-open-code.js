import crypto from "node:crypto";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

export const DEFAULT_TAIL_BYTES = 256 * 1024;
export const DEFAULT_ACTIVITY_LIMIT = 200;

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function firstText(...values) {
  return values.map(text).find(Boolean) ?? "";
}

function occurredAt(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
    const valueText = text(value);
    if (valueText) return valueText;
  }
  return "";
}

function stableEventId(attemptId, event, ordinal) {
  const part = event?.part ?? event?.data ?? {};
  const providerId = firstText(
    part.callID, part.call_id, part.toolCallId, part.tool_call_id,
    part.id, event.id, event.event_id,
  );
  if (providerId) return `${attemptId}:opencode:${providerId}`;
  const digest = crypto.createHash("sha256")
    .update(JSON.stringify([event?.type ?? "unknown", part.tool ?? part.name ?? "", ordinal, event]))
    .digest("hex").slice(0, 16);
  return `${attemptId}:opencode:${digest}`;
}

function toolKind(name) {
  const tool = String(name ?? "").toLowerCase();
  if (/^(read|cat|view)/.test(tool)) return "read";
  if (/(grep|glob|search|find)/.test(tool)) return "search";
  if (/(edit|write|patch)/.test(tool)) return "edit";
  if (/(bash|shell|command|terminal|exec)/.test(tool)) return "command";
  if (/(task|agent|subagent)/.test(tool)) return "agent";
  return "other";
}

function lifecycle(event) {
  const part = event?.part ?? event?.data ?? {};
  const raw = String(part.state?.status ?? part.status ?? event.status ?? event.type ?? "").toLowerCase();
  if (/(error|failed|failure)/.test(raw)) return "failed";
  if (/(finish|complete|completed|success|done|result)/.test(raw)) return "completed";
  if (/(update|progress|running)/.test(raw)) return "updated";
  return "started";
}

function titleForTool(tool, input) {
  const name = firstText(tool) || "Tool";
  const target = firstText(
    input?.filePath, input?.file_path, input?.path, input?.pattern,
    input?.query, input?.command, input?.description,
  );
  const label = name.replace(/[_-]+/g, " ").replace(/^./, (letter) => letter.toUpperCase());
  return target ? `${label} ${target}` : label;
}

export function normalizeEvent(event, attempt, ordinal) {
  if (!event || typeof event !== "object") return null;
  const part = event.part ?? event.data ?? {};
  const type = String(event.type ?? "").toLowerCase();
  const tool = firstText(part.tool, part.name, event.tool);
  const input = part.input ?? part.state?.input ?? event.input ?? {};
  const timestamp = occurredAt(event.timestamp, event.occurred_at, part.timestamp, part.state?.time?.start, attempt.started_at);

  if (tool || type.includes("tool")) {
    const detail = firstText(
      part.state?.output, part.output, part.error, event.error,
      typeof input === "string" ? input : "",
    );
    return {
      id: stableEventId(attempt.id, event, ordinal),
      occurred_at: timestamp,
      actor_id: `worker:${attempt.id}`,
      actor_role: attempt.actor_role ?? "worker",
      kind: toolKind(tool),
      lifecycle: lifecycle(event),
      title: titleForTool(tool, input),
      ...(detail ? { detail: detail.slice(0, 2_000) } : {}),
      authority: "activity",
    };
  }

  // OpenCode's public `text` part is displayable narration. Reasoning parts are deliberately
  // ignored: this projection never turns private deliberation into a user-visible transcript.
  if (type === "text" || type === "assistant/message" || type === "message") {
    const narration = firstText(part.text, event.text);
    if (!narration) return null;
    return {
      id: stableEventId(attempt.id, event, ordinal),
      occurred_at: timestamp,
      actor_id: `worker:${attempt.id}`,
      actor_role: attempt.actor_role ?? "worker",
      kind: "narration",
      lifecycle: "completed",
      title: narration.slice(0, 240),
      authority: "activity",
    };
  }
  return null;
}

// OpenCode 1.14.28's `run --format json` deliberately emits a tool part only after it is completed
// or errors (packages/opencode/src/cli/cmd/run.ts at v1.14.28). Its isolated state database is the
// actual pre-completion source: the runtime upserts the same part ID/callID for pending, running,
// completed and error states. This reader is intentionally read-only and schema-checked. If a future
// OpenCode changes that private projection, live motion disappears rather than being fabricated;
// the terminal JSONL receipt remains available.
export function readOpenCodeRuntimeParts(databasePath, { limit = DEFAULT_ACTIVITY_LIMIT } = {}) {
  if (!databasePath || !fs.existsSync(databasePath)) return { events: [], compatible: false };
  let db;
  try {
    db = new DatabaseSync(databasePath, { readOnly: true });
    const columns = db.prepare("PRAGMA table_info(part)").all().map((column) => column.name);
    if (!["id", "message_id", "session_id", "time_created", "data"].every((name) => columns.includes(name))) {
      return { events: [], compatible: false };
    }
    const rows = db.prepare("SELECT id, message_id, session_id, time_created, data FROM part ORDER BY time_created DESC, id DESC LIMIT ?")
      .all(limit).reverse();
    const events = [];
    for (const row of rows) {
      let data;
      try { data = JSON.parse(row.data); } catch { continue; }
      if (data?.type !== "tool") continue;
      events.push({
        type: "tool_use",
        timestamp: row.time_created,
        sessionID: row.session_id,
        part: { id: row.id, messageID: row.message_id, sessionID: row.session_id, ...data },
      });
    }
    return { events, compatible: true };
  } catch {
    return { events: [], compatible: false };
  } finally {
    try { db?.close(); } catch { /* read-only observer owns no runtime state */ }
  }
}

export function readJsonlTail(filePath, { maxBytes = DEFAULT_TAIL_BYTES } = {}) {
  if (!filePath || !fs.existsSync(filePath)) return { events: [], malformed: 0, truncated: false };
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size === 0) return { events: [], malformed: 0, truncated: false };
  const bytes = Math.min(stat.size, maxBytes);
  const start = stat.size - bytes;
  const fd = fs.openSync(filePath, "r");
  let raw;
  try {
    const buffer = Buffer.alloc(bytes);
    fs.readSync(fd, buffer, 0, bytes, start);
    raw = buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
  const lines = raw.split(/\r?\n/);
  // A bounded tail normally starts midway through one JSON record. It is truncation, not a
  // malformed provider event, so discard that fragment without counting it.
  if (start > 0) lines.shift();
  const events = [];
  let malformed = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { malformed += 1; }
  }
  return { events, malformed, truncated: start > 0 };
}

export function normalizeOpenCodeActivity({ attempt, filePath, runtimeDatabasePath, limit = DEFAULT_ACTIVITY_LIMIT, maxBytes } = {}) {
  const tail = readJsonlTail(filePath, { maxBytes });
  const runtime = readOpenCodeRuntimeParts(runtimeDatabasePath, { limit });
  const byId = new Map();
  [...runtime.events, ...tail.events].forEach((event, ordinal) => {
    const item = normalizeEvent(event, attempt, ordinal);
    if (item) byId.set(item.id, item);
  });
  const activities = [...byId.values()].slice(-limit);
  if (tail.malformed) {
    activities.push({
      id: `${attempt.id}:opencode:malformed-tail`,
      occurred_at: attempt.started_at,
      actor_id: `worker:${attempt.id}`,
      actor_role: attempt.actor_role ?? "worker",
      kind: "other",
      lifecycle: "failed",
      title: "Some live activity could not be decoded",
      detail: `${tail.malformed} malformed JSONL record${tail.malformed === 1 ? "" : "s"} ignored`,
      authority: "activity",
    });
  }
  return { activities: activities.slice(-limit), malformed: tail.malformed, truncated: tail.truncated };
}

// Durable history page. Unlike the live tail above, this contract makes its bound explicit and
// recoverable: `before` is an exclusive JSONL line cursor and every earlier page can be requested.
// Reading is intentionally separate from the runtime overlay -- runtime state is current truth and
// belongs only on the newest page; historical pages come solely from the immutable terminal log.
export function normalizeOpenCodeActivityPage({
  attempt, filePath, runtimeDatabasePath, limit = DEFAULT_ACTIVITY_LIMIT, before = null,
} = {}) {
  const boundedLimit = Math.max(1, Math.min(500, Number(limit) || DEFAULT_ACTIVITY_LIMIT));
  let lines = [];
  if (filePath && fs.existsSync(filePath)) {
    const raw = fs.readFileSync(filePath, "utf8");
    lines = raw.split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
  }
  const parsedBefore = before === null || before === undefined || before === ""
    ? lines.length : Number(before);
  const end = Number.isSafeInteger(parsedBefore) && parsedBefore >= 0
    ? Math.min(parsedBefore, lines.length) : lines.length;
  const start = Math.max(0, end - boundedLimit);
  const events = [];
  let malformed = 0;
  for (let index = start; index < end; index += 1) {
    try { events.push({ event: JSON.parse(lines[index]), ordinal: index }); }
    catch { malformed += 1; }
  }
  const runtime = before === null || before === undefined || before === ""
    ? readOpenCodeRuntimeParts(runtimeDatabasePath, { limit: boundedLimit }) : { events: [] };
  const byId = new Map();
  runtime.events.forEach((event, ordinal) => {
    const item = normalizeEvent(event, attempt, lines.length + ordinal);
    if (item) byId.set(item.id, item);
  });
  // Runtime supplies pre-completion truth, but the terminal JSONL receipt is durable authority for
  // the same provider call. Insert it last so completion/error can never regress to running.
  for (const { event, ordinal } of events) {
    const item = normalizeEvent(event, attempt, ordinal);
    if (item) byId.set(item.id, item);
  }
  const activities = [...byId.values()];
  if (malformed) activities.push({
    id: `${attempt.id}:opencode:malformed:${start}:${end}`,
    occurred_at: attempt.started_at,
    actor_id: `worker:${attempt.id}`,
    actor_role: attempt.actor_role ?? "worker",
    kind: "other",
    lifecycle: "failed",
    title: "Some recorded activity could not be decoded",
    detail: `${malformed} malformed JSONL record${malformed === 1 ? "" : "s"} ignored on this page`,
    authority: "activity",
  });
  return {
    activities,
    cursor: start > 0 ? String(start) : null,
    hasEarlier: start > 0,
    complete: start === 0,
    page: { start, end, lineCount: lines.length },
    malformed,
  };
}
