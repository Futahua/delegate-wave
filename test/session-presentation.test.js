import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { initializeDataRoot, openDatabase } from "../src/db.js";
import { listSessionPresentations } from "../src/presentation/session-timeline.js";
import { normalizeOpenCodeActivityPage } from "../src/presentation/activity-open-code.js";

function ledger(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-session-index-"));
  const paths = initializeDataRoot(root);
  const db = openDatabase(paths.database);
  db.prepare(`INSERT INTO projects(id, name, repo_path, integration_branch, created_at)
    VALUES ('p1', 'Project', ?, 'main', '2026-01-01T00:00:00.000Z')`).run(path.join(root, "repo"));
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { db, root };
}

function addSession(db, index, { mode = "AUTO", state = "COMPLETED" } = {}) {
  const id = `s${String(index).padStart(3, "0")}`;
  const at = `2026-01-${String(Math.floor(index / 24) + 1).padStart(2, "0")}T${String(index % 24).padStart(2, "0")}:00:00.000Z`;
  db.prepare(`INSERT INTO autonomous_sessions(id, project_id, intent, mode, state, created_at, updated_at)
    VALUES (?, 'p1', ?, ?, ?, ?, ?)`).run(id, `Session ${index}`, mode, state, at, at);
  return { id, at };
}

test("session.list paginates beyond forty without borrowing overview bounds", (t) => {
  const { db } = ledger(t);
  for (let index = 0; index < 85; index += 1) addSession(db, index);
  const first = listSessionPresentations(db, { limit: 40 });
  const second = listSessionPresentations(db, { limit: 40, cursor: first.next_cursor });
  const third = listSessionPresentations(db, { limit: 40, cursor: second.next_cursor });
  assert.equal(first.sessions.length, 40);
  assert.equal(second.sessions.length, 40);
  assert.equal(third.sessions.length, 5);
  assert.equal(new Set([...first.sessions, ...second.sessions, ...third.sessions].map((item) => item.id)).size, 85);
  assert.equal(third.has_more, false);
});

test("origin is the first Hermes watch and a later watcher cannot move it", (t) => {
  const { db } = ledger(t);
  const { id } = addSession(db, 1);
  db.prepare(`INSERT INTO session_watches(id, session_id, hermes_session_id, state, created_at, updated_at)
    VALUES ('w1', ?, 'hermes-origin', 'ACTIVE', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`).run(id);
  db.prepare(`INSERT INTO session_watches(id, session_id, hermes_session_id, state, created_at, updated_at)
    VALUES ('w2', ?, 'hermes-later', 'ACTIVE', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z')`).run(id);
  assert.equal(listSessionPresentations(db).sessions[0].origin_hermes_session_id, "hermes-origin");
});

test("session presentation reuses the authoritative Hermes session title when available", (t) => {
  const { db } = ledger(t);
  const { id } = addSession(db, 1);
  db.prepare(`INSERT INTO session_watches(id, session_id, hermes_session_id, state, created_at, updated_at)
    VALUES ('w-title', ?, 'hermes-titled', 'ACTIVE', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`).run(id);
  const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-hermes-title-"));
  const hermes = new DatabaseSync(path.join(hermesHome, "state.db"));
  hermes.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY, title TEXT)");
  hermes.prepare("INSERT INTO sessions(id, title) VALUES (?, ?)").run("hermes-titled", "Routing investigation");
  hermes.close();
  const before = process.env.HERMES_HOME;
  process.env.HERMES_HOME = hermesHome;
  t.after(() => { if (before === undefined) delete process.env.HERMES_HOME; else process.env.HERMES_HOME = before; fs.rmSync(hermesHome, { recursive: true, force: true }); });
  assert.equal(listSessionPresentations(db).sessions[0].origin_hermes_session_title, "Routing investigation");
});

test("semantic acceptance is settled only for modes whose work ends there", (t) => {
  const { db } = ledger(t);
  addSession(db, 1, { mode: "MANUAL", state: "SEMANTICALLY_ACCEPTED" });
  addSession(db, 2, { mode: "PLAN", state: "SEMANTICALLY_ACCEPTED" });
  addSession(db, 3, { mode: "AUTO", state: "SEMANTICALLY_ACCEPTED" });
  const states = Object.fromEntries(listSessionPresentations(db).sessions.map((item) => [item.mode, item.state]));
  assert.equal(states.MANUAL, "settled");
  assert.equal(states.PLAN, "settled");
  assert.equal(states.AUTO, "live");
});

test("historical activity pages disclose truncation and recover every earlier event", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-stream-page-"));
  const filePath = path.join(root, "events.jsonl");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(filePath, Array.from({ length: 275 }, (_, index) => JSON.stringify({
    type: "text", id: `event-${index}`, timestamp: `2026-01-01T00:${String(index % 60).padStart(2, "0")}:00Z`,
    part: { id: `part-${index}`, text: `Public event ${index}` },
  })).join("\n"));
  const attempt = { id: "attempt-1", started_at: "2026-01-01T00:00:00Z" };
  const newest = normalizeOpenCodeActivityPage({ attempt, filePath, limit: 100 });
  const middle = normalizeOpenCodeActivityPage({ attempt, filePath, limit: 100, before: newest.cursor });
  const oldest = normalizeOpenCodeActivityPage({ attempt, filePath, limit: 100, before: middle.cursor });
  assert.equal(newest.complete, false);
  assert.equal(newest.hasEarlier, true);
  assert.equal(oldest.complete, true);
  assert.equal(oldest.hasEarlier, false);
  assert.equal(new Set([...oldest.activities, ...middle.activities, ...newest.activities].map((item) => item.id)).size, 275);
});
