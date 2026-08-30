import crypto from "node:crypto";
import fs from "node:fs";

export const DEFAULT_TAIL_BYTES = 256 * 1024;
export const DEFAULT_ACTIVITY_LIMIT = 200;

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function firstText(...values) {
  return values.map(text).find(Boolean) ?? "";
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

function normalizeEvent(event, attempt, ordinal) {
  if (!event || typeof event !== "object") return null;
  const part = event.part ?? event.data ?? {};
  const type = String(event.type ?? "").toLowerCase();
  const tool = firstText(part.tool, part.name, event.tool);
  const input = part.input ?? part.state?.input ?? event.input ?? {};
  const occurredAt = firstText(event.timestamp, event.occurred_at, part.timestamp, attempt.started_at);

  if (tool || type.includes("tool")) {
    const detail = firstText(
      part.state?.output, part.output, part.error, event.error,
      typeof input === "string" ? input : "",
    );
    return {
      id: stableEventId(attempt.id, event, ordinal),
      occurred_at: occurredAt,
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
      occurred_at: occurredAt,
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

export function normalizeOpenCodeActivity({ attempt, filePath, limit = DEFAULT_ACTIVITY_LIMIT, maxBytes } = {}) {
  const tail = readJsonlTail(filePath, { maxBytes });
  const byId = new Map();
  tail.events.forEach((event, ordinal) => {
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
