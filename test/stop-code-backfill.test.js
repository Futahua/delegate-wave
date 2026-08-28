// Upgrading must not strand a question that was already waiting.
//
// stop_code decides whether a parked run can be answered, and a NULL is treated as "not
// answerable". That is the right default for a run whose reason nobody recorded, but it is the
// wrong answer for a run that had genuinely ESCALATED before the column existed: the manager asked
// a real question, and after the upgrade nobody could answer it. The reason was never lost -- it
// was in the MANAGER_HALTED event all along -- so the migration recovers it.
//
// The fixture drops the column from a current database rather than writing an old schema out by
// hand, so it exercises the same migrate() branch a real installation takes and cannot drift from
// the current SCHEMA.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { initializeDataRoot, openDatabase } from "../src/db.js";
import { managedPaths } from "../src/paths.js";

function seedRun(db, { id, jobId, status }) {
  db.prepare(`INSERT INTO projects(id, name, repo_path, integration_branch, created_at)
    VALUES (?, ?, ?, 'main', datetime('now'))`).run(`proj-${id}`, `p-${id}`, `/tmp/${id}`);
  db.prepare(`INSERT INTO jobs(id, project_id, goal, mode, status, base_sha, created_at, updated_at)
    VALUES (?, ?, 'goal', 'write', 'NEEDS_ATTENTION', 'abc', datetime('now'), datetime('now'))`)
    .run(jobId, `proj-${id}`);
  db.prepare(`INSERT INTO manager_runs(
      id, job_id, status, requested_model, exploration_round, revision_round,
      max_exploration_rounds, max_revision_rounds, max_turns, escalation_question,
      created_at, updated_at)
    VALUES (?, ?, ?, 'm', 0, 0, 2, 2, 12, 'the question as it stood', datetime('now'), datetime('now'))`)
    .run(id, jobId, status);
}

function halt(db, { runId, jobId, code }) {
  db.prepare(`INSERT INTO events(occurred_at, kind, entity_type, entity_id, payload_json)
    VALUES (datetime('now'), 'MANAGER_HALTED', 'job', ?, ?)`)
    .run(jobId, JSON.stringify({ runId, code, reason: "recorded at the time" }));
}

test("a pre-upgrade run recovers why it stopped, so a real question survives the upgrade", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-backfill-"));
  // Handles first, directory last: node:test runs after-hooks in registration order, and Windows
  // refuses to remove a directory holding an open database file.
  const handles = [];
  t.after(() => {
    for (const handle of handles) { try { handle.close(); } catch { /* already closed */ } }
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const root = path.join(temp, "data");
  initializeDataRoot(root);
  const file = managedPaths(root).database;

  // Become a database from before the column existed, with three runs parked the old way: every
  // ManagerStop used to land in AWAITING_HUMAN regardless of what it was.
  const old = new DatabaseSync(file);
  old.exec("PRAGMA foreign_keys = ON");
  seedRun(old, { id: "mrun-asked", jobId: "job-asked", status: "AWAITING_HUMAN" });
  seedRun(old, { id: "mrun-ceiling", jobId: "job-ceiling", status: "AWAITING_HUMAN" });
  seedRun(old, { id: "mrun-silent", jobId: "job-silent", status: "AWAITING_HUMAN" });
  halt(old, { runId: "mrun-asked", jobId: "job-asked", code: "ESCALATED" });
  halt(old, { runId: "mrun-ceiling", jobId: "job-ceiling", code: "TURN_LIMIT" });
  // A run that halted twice: the latest halt is the state it is actually in.
  halt(old, { runId: "mrun-asked", jobId: "job-asked", code: "ESCALATED" });
  // mrun-silent gets no event at all -- genuinely unknowable.
  old.exec("ALTER TABLE manager_runs DROP COLUMN stop_code");
  old.close();

  const db = openDatabase(file);
  handles.push(db);
  const run = (id) => db.prepare("SELECT * FROM manager_runs WHERE id = ?").get(id);

  // 1. The real question is answerable again, and still says what it asked.
  assert.equal(run("mrun-asked").stop_code, "ESCALATED");
  assert.equal(run("mrun-asked").status, "AWAITING_HUMAN");
  assert.equal(run("mrun-asked").escalation_question, "the question as it stood");

  // 2. The bounded stop is recovered as a stop, and no longer sits in a state that invites an
  //    answer -- which is what produced the repeated question loop.
  assert.equal(run("mrun-ceiling").stop_code, "TURN_LIMIT");
  assert.equal(run("mrun-ceiling").status, "FAILED");

  // 3. A run whose reason was never recorded stays unknowable, and unknowable stays non-answerable.
  //    Guessing here would be inventing a provenance, which is worse than admitting we have none.
  assert.equal(run("mrun-silent").stop_code, null);

  // 4. Idempotent: the backfill runs only when the column is added, so reopening changes nothing.
  db.prepare("UPDATE manager_runs SET stop_code = 'ESCALATED' WHERE id = 'mrun-ceiling'").run();
  const again = openDatabase(file);
  handles.push(again);
  assert.equal(
    again.prepare("SELECT stop_code FROM manager_runs WHERE id = 'mrun-ceiling'").get().stop_code,
    "ESCALATED",
    "a second open must not re-run the backfill over current data",
  );
});
