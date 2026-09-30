import crypto from "node:crypto";

const DEFAULT_ADMIN_URL = "http://127.0.0.1:3001";
const DEFAULT_LIMIT = 500;
const MAX_WORKSTREAMS = 40;
const DEFAULT_CACHE_TTL_MS = 500;
const LIVE_ACTIVITY_WINDOW_MS = 90_000;

function isLoopbackHost(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

function normalizeBaseUrl(value) {
  const url = new URL(value || DEFAULT_ADMIN_URL);
  if (url.protocol !== "http:" || !isLoopbackHost(url.hostname)) {
    throw new Error("ChatGPT Local activity source must be an HTTP loopback address");
  }
  return url.origin;
}

function turnToken(entry) {
  const token = entry?.details?.turn_token;
  return typeof token === "string" && token.length >= 16 ? token : null;
}

function workstreamToken(entry) {
  const token = entry?.details?.workstream_token;
  return typeof token === "string" && token.length >= 16 ? token : null;
}

function virtualSessionId(token) {
  const digest = crypto.createHash("sha256").update(token).digest("hex").slice(0, 24);
  return `chatgpt:${digest}`;
}

function compareTime(a, b) {
  return String(a.time || "").localeCompare(String(b.time || "")) || String(a.id || "").localeCompare(String(b.id || ""));
}

function lifecycle(entry) {
  return entry.status === "error" || entry.status === "blocked" ? "failed" : "completed";
}

function toolKind(tool) {
  if (!tool) return "other";
  if (/grep|search|glob|find/i.test(tool)) return "search";
  if (/read|list|status|diff/i.test(tool)) return "read";
  if (/edit|write|patch|restore|commit|add/i.test(tool)) return "edit";
  if (/command|process|shell|git|build|test/i.test(tool)) return "command";
  return "other";
}

function boundedText(value, max = 4000) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

function streamItem(entry, index) {
  const details = entry?.details && typeof entry.details === "object" ? entry.details : {};
  const id = `chatgpt-activity:${entry.id || index}`;
  const occurredAt = typeof entry.time === "string" ? entry.time : new Date(0).toISOString();

  if (entry.kind === "mcp" && entry.action === "tools/call" && typeof entry.tool === "string") {
    const detail = boundedText(entry.summary, 800);
    return {
      id,
      kind: toolKind(entry.tool),
      lifecycle: lifecycle(entry),
      title: entry.tool,
      ...(detail ? { detail } : {}),
      occurred_at: occurredAt,
      authority: "activity",
    };
  }

  if (entry.kind !== "session") return null;
  if (entry.action === "turn_progress") {
    const text = boundedText(details.visible_report_text);
    const detail = boundedText(details.next_step, 800);
    return {
      id, kind: "narration", lifecycle: "updated",
      title: text || "Progress update",
      ...(detail ? { detail } : {}),
      occurred_at: occurredAt, authority: "activity",
    };
  }
  if (entry.action === "turn_reassessed") {
    const detail = boundedText(details.next_step, 800);
    return {
      id, kind: "narration", lifecycle: "updated",
      title: "Reassessed approach",
      ...(detail ? { detail } : {}),
      occurred_at: occurredAt, authority: "activity",
    };
  }
  if (entry.action === "turn_started") {
    return { id, kind: "narration", lifecycle: "started", title: "Started local turn", occurred_at: occurredAt, authority: "activity" };
  }
  if (entry.action === "turn_resumed") {
    return { id, kind: "narration", lifecycle: "updated", title: "Resumed local turn", occurred_at: occurredAt, authority: "activity" };
  }
  if (entry.action === "turn_ended") {
    const detail = boundedText(details.note, 800);
    return {
      id, kind: "narration", lifecycle: "completed", title: "Local turn ended",
      ...(detail ? { detail } : {}),
      occurred_at: occurredAt, authority: "activity",
    };
  }
  return null;
}

function project(entries, nowMs = Date.now()) {
  const turnToWorkstream = new Map();
  for (const entry of entries) {
    const turn = turnToken(entry);
    const workstream = workstreamToken(entry);
    if (turn && workstream) turnToWorkstream.set(turn, workstream);
  }

  const groups = new Map();
  for (const entry of entries) {
    const turn = turnToken(entry);
    if (!turn) continue;
    const workstream = workstreamToken(entry) ?? turnToWorkstream.get(turn);
    // Older Local Coder builds exposed only turn_token. Those records cannot be
    // truthfully reconstructed into ChatGPT conversations, so do not pretend they are sessions.
    if (!workstream) continue;
    if (!groups.has(workstream)) groups.set(workstream, []);
    groups.get(workstream).push(entry);
  }

  const sessions = [];
  const timelines = new Map();
  for (const [workstream, unsorted] of groups) {
    const ordered = [...unsorted].sort(compareTime);
    const startedEvents = ordered.filter((entry) => entry.kind === "session" && entry.action === "turn_started");
    if (!startedEvents.length) continue;

    const byTurn = new Map();
    for (const entry of ordered) {
      const turn = turnToken(entry);
      if (!turn) continue;
      if (!byTurn.has(turn)) byTurn.set(turn, []);
      byTurn.get(turn).push(entry);
    }

    const spans = [];
    let anyLive = false;
    let anyWaiting = false;
    for (const [turn, turnEntries] of byTurn) {
      const turnOrdered = [...turnEntries].sort(compareTime);
      const started = turnOrdered.find((entry) => entry.kind === "session" && entry.action === "turn_started");
      if (!started) continue;
      const ended = [...turnOrdered].reverse().find((entry) => entry.kind === "session" && entry.action === "turn_ended");
      const lastAt = Date.parse(turnOrdered.at(-1)?.time || started.time || 0);
      const fresh = Number.isFinite(lastAt) && nowMs - lastAt <= LIVE_ACTIVITY_WINDOW_MS;
      const state = ended ? "completed" : fresh ? "live" : "waiting";
      if (state === "live") anyLive = true;
      if (state === "waiting") anyWaiting = true;
      const stream = turnOrdered.flatMap((entry, index) => {
        const item = streamItem(entry, index);
        return item ? [item] : [];
      });
      spans.push({
        id: `chatgpt-turn:${crypto.createHash("sha256").update(turn).digest("hex").slice(0, 24)}`,
        actor: "manager",
        label: boundedText(started.summary, 240) || "ChatGPT turn",
        state,
        started_at: started.time,
        ...(ended ? { finished_at: ended.time } : {}),
        stream,
        stream_bounds: { complete: true, has_earlier: false, cursor: null },
      });
    }

    const firstStarted = startedEvents[0];
    const id = virtualSessionId(workstream);
    const startedAt = firstStarted.time;
    const updatedAt = ordered.at(-1)?.time || startedAt;
    const sessionState = anyLive ? "live" : anyWaiting ? "waiting" : "settled";
    const session = {
      id,
      intent: boundedText(firstStarted.summary, 240) || "ChatGPT workstream",
      mode: "CHATGPT_LOCAL",
      state: sessionState,
      origin_hermes_session_id: "chatgpt-local",
      origin_hermes_session_title: "ChatGPT",
      started_at: startedAt,
      updated_at: updatedAt,
      ...(sessionState === "settled" ? { settled_at: updatedAt } : {}),
    };
    const projection = { schema: 2, session, spans };
    timelines.set(id, {
      ...projection,
      revision: crypto.createHash("sha256").update(JSON.stringify(projection)).digest("hex"),
    });
    sessions.push(session);
  }

  sessions.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id));
  const visible = sessions.slice(0, MAX_WORKSTREAMS);
  const visibleIds = new Set(visible.map((session) => session.id));
  return {
    sessions: visible,
    timelines: new Map([...timelines].filter(([id]) => visibleIds.has(id))),
  };
}

export function createChatGptLocalActivityProvider({
  baseUrl = process.env.CHATGPT_LOCAL_CODER_ADMIN_URL || DEFAULT_ADMIN_URL,
  fetchImpl = globalThis.fetch,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  now = Date.now,
} = {}) {
  const origin = normalizeBaseUrl(baseUrl);
  let cache = { fetchedAt: 0, snapshot: { sessions: [], timelines: new Map() } };
  let inFlight = null;

  async function refresh() {
    const current = now();
    if (current - cache.fetchedAt < cacheTtlMs) return cache.snapshot;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 750);
        timeout.unref?.();
        let response;
        try {
          response = await fetchImpl(`${origin}/api/activity?limit=${DEFAULT_LIMIT}`, {
            signal: controller.signal,
            headers: { accept: "application/json" },
          });
        } finally {
          clearTimeout(timeout);
        }
        if (!response?.ok) throw new Error(`Local Coder activity HTTP ${response?.status ?? "unknown"}`);
        const body = await response.json();
        const entries = Array.isArray(body?.entries) ? body.entries : [];
        const snapshot = project(entries, current);
        cache = { fetchedAt: current, snapshot };
        return snapshot;
      } catch {
        return cache.snapshot;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  return {
    async list() {
      return (await refresh()).sessions;
    },
    async timeline(sessionId) {
      return (await refresh()).timelines.get(sessionId) ?? null;
    },
  };
}
