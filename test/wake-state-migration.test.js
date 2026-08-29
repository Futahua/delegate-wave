import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { initializeDataRoot, openDatabase, SCHEMA_VERSION } from "../src/db.js";

const SCHEMA_34_WAKE = `
CREATE TABLE wake_outbox_old (
  id TEXT PRIMARY KEY,
  watch_id TEXT NOT NULL REFERENCES session_watches(id),
  session_id TEXT NOT NULL REFERENCES autonomous_sessions(id),
  hermes_session_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('QUESTION', 'READY', 'COMPLETED', 'FAILED')),
  message_id TEXT REFERENCES autonomous_session_messages(id),
  marker TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'PENDING', 'PREPARING', 'SUBMITTED', 'DELIVERED', 'PARTIAL', 'ABANDONED'
  )),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  reconciled_at TEXT,
  runtime_session_id TEXT,
  submitted_at TEXT,
  owner_pid INTEGER,
  owner_started_at TEXT,
  gateway_pid INTEGER,
  gateway_started_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (state NOT IN ('DELIVERED', 'PARTIAL') OR reconciled_at IS NOT NULL),
  CHECK (state IN ('SUBMITTED', 'DELIVERED', 'PARTIAL') OR submitted_at IS NULL),
  CHECK (reason != 'QUESTION' OR message_id IS NOT NULL)
)`;

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-wake-state-"));
  const paths = initializeDataRoot(path.join(temp, "data"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  return paths.database;
}

function seedParents(db, suffix = "1", hermes = `hermes_${suffix}`) {
  const at = "2026-08-29T00:00:00.000Z";
  const project = `proj_${suffix}`;
  const session = `asess_${suffix}`;
  const watch = `wtch_${suffix}`;
  db.prepare(`INSERT INTO projects(id, name, repo_path, integration_branch, created_at)
    VALUES (?, ?, ?, 'main', ?)`).run(project, project, `C:/repo/${project}`, at);
  db.prepare(`INSERT INTO autonomous_sessions(
    id, project_id, intent, mode, state, created_at, updated_at
  ) VALUES (?, ?, 'test', 'AUTO', 'WORKING', ?, ?)`).run(session, project, at, at);
  db.prepare(`INSERT INTO session_watches(
    id, session_id, hermes_session_id, state, created_at, updated_at
  ) VALUES (?, ?, ?, 'ACTIVE', ?, ?)`).run(watch, session, hermes, at, at);
  return { at, session, watch, hermes };
}

function insertWake(db, parent, {
  id, state, submittedAt = null, enqueuedAt = null, reconciledAt = null,
}) {
  db.prepare(`INSERT INTO wake_outbox(
    id, watch_id, session_id, hermes_session_id, reason, marker, body, state,
    reconciled_at, submitted_at, enqueued_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, 'COMPLETED', ?, 'body', ?, ?, ?, ?, ?, ?)`)
    .run(id, parent.watch, parent.session, parent.hermes, `[delegate-wave-wake:${id}]`,
      state, reconciledAt, submittedAt, enqueuedAt, parent.at, parent.at);
}

test("fresh schema gives ENQUEUED its own evidence and single-flight slot", (t) => {
  const database = fixture(t);
  const db = openDatabase(database);
  const first = seedParents(db, "one", "same_conversation");
  const second = seedParents(db, "two", "same_conversation");

  insertWake(db, first, { id: "wake_enqueued", state: "ENQUEUED", enqueuedAt: first.at });
  assert.throws(
    () => insertWake(db, second, { id: "wake_second", state: "PREPARING" }),
    /UNIQUE constraint failed/,
    "an ENQUEUED event must fence another delivery into the same conversation",
  );
  assert.throws(
    () => insertWake(db, seedParents(db, "bad"), {
      id: "wake_bad", state: "PENDING", enqueuedAt: first.at,
    }),
    /CHECK constraint failed/,
    "inbox evidence cannot be attached to a state that says it was not enqueued",
  );
  assert.throws(
    () => insertWake(db, seedParents(db, "both"), {
      id: "wake_both", state: "DELIVERED", submittedAt: first.at, enqueuedAt: first.at,
    }),
    /CHECK constraint failed/,
    "one row cannot claim both delivery protocols",
  );
  db.close();
});

test("schema 34 migration preserves every legacy state without relabelling it", (t) => {
  const database = fixture(t);
  let db = openDatabase(database);
  const parent = seedParents(db, "legacy");
  insertWake(db, parent, {
    id: "wake_legacy", state: "SUBMITTED", submittedAt: parent.at,
  });
  db.prepare(`UPDATE wake_outbox SET attempts = 3, last_error = 'pipe lost',
    runtime_session_id = 'runtime_old', owner_pid = 41, owner_started_at = 'owner-start',
    gateway_pid = 42, gateway_started_at = 'gateway-start' WHERE id = 'wake_legacy'`).run();
  insertWake(db, seedParents(db, "pending"), { id: "wake_pending", state: "PENDING" });
  insertWake(db, seedParents(db, "preparing"), { id: "wake_preparing", state: "PREPARING" });
  insertWake(db, seedParents(db, "delivered"), {
    id: "wake_delivered", state: "DELIVERED", submittedAt: parent.at, reconciledAt: parent.at,
  });
  insertWake(db, seedParents(db, "partial"), {
    id: "wake_partial", state: "PARTIAL", submittedAt: parent.at, reconciledAt: parent.at,
  });
  const beforeRows = db.prepare(`SELECT id, state, attempts, last_error, reconciled_at,
    runtime_session_id, submitted_at, owner_pid, owner_started_at, gateway_pid,
    gateway_started_at, created_at, updated_at FROM wake_outbox ORDER BY id`).all();
  db.close();

  // Turn the current fixture into the actual schema-34 table shape. This is intentionally a table
  // rebuild rather than editing sqlite_master text: openDatabase must migrate a database SQLite
  // itself considers valid.
  db = new DatabaseSync(database);
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  db.exec("DROP TRIGGER trg_wake_outbox_immutable_delete");
  db.exec("DROP INDEX idx_wake_outbox_single_flight; DROP INDEX idx_wake_outbox_pending");
  db.exec(SCHEMA_34_WAKE);
  db.exec(`INSERT INTO wake_outbox_old(
    id, watch_id, session_id, hermes_session_id, reason, message_id, marker, body, state,
    attempts, last_error, reconciled_at, runtime_session_id, submitted_at,
    owner_pid, owner_started_at, gateway_pid, gateway_started_at, created_at, updated_at
  ) SELECT id, watch_id, session_id, hermes_session_id, reason, message_id, marker, body, state,
    attempts, last_error, reconciled_at, runtime_session_id, submitted_at,
    owner_pid, owner_started_at, gateway_pid, gateway_started_at, created_at, updated_at
    FROM wake_outbox`);
  db.exec("DROP TABLE wake_outbox; ALTER TABLE wake_outbox_old RENAME TO wake_outbox");
  db.exec(`CREATE UNIQUE INDEX idx_wake_outbox_single_flight
    ON wake_outbox(hermes_session_id) WHERE state IN ('PREPARING', 'SUBMITTED')`);
  db.exec("CREATE INDEX idx_wake_outbox_pending ON wake_outbox(state, created_at)");
  db.exec(`CREATE TRIGGER trg_wake_outbox_immutable_delete BEFORE DELETE ON wake_outbox
    BEGIN SELECT RAISE(ABORT, 'wake_outbox is immutable'); END`);
  db.prepare("UPDATE metadata SET value = '34' WHERE key = 'schema_version'").run();
  db.exec("COMMIT");
  db.close();

  db = openDatabase(database);
  const row = db.prepare("SELECT * FROM wake_outbox WHERE id = 'wake_legacy'").get();
  assert.equal(row.state, "SUBMITTED");
  assert.equal(row.submitted_at, parent.at);
  assert.equal(row.enqueued_at, null);
  assert.equal(row.last_receiver_state, null);
  assert.equal(row.last_receiver_observed_at, null);
  assert.equal(row.attempts, 3);
  assert.equal(row.last_error, "pipe lost");
  assert.equal(row.runtime_session_id, "runtime_old");
  assert.equal(row.owner_pid, 41);
  assert.equal(row.gateway_pid, 42);
  const afterRows = db.prepare(`SELECT id, state, attempts, last_error, reconciled_at,
    runtime_session_id, submitted_at, owner_pid, owner_started_at, gateway_pid,
    gateway_started_at, created_at, updated_at FROM wake_outbox ORDER BY id`).all();
  assert.deepEqual(afterRows, beforeRows, "migration must preserve all legacy evidence byte-for-byte");
  assert.deepEqual(db.prepare(`SELECT id, enqueued_at, last_receiver_state,
    last_receiver_observed_at FROM wake_outbox ORDER BY id`).all().map((row) => ({ ...row })),
  beforeRows.map((old) => ({
    id: old.id, enqueued_at: null, last_receiver_state: null, last_receiver_observed_at: null,
  })));
  assert.equal(db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get().value,
    SCHEMA_VERSION);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.throws(() => db.prepare("DELETE FROM wake_outbox WHERE id = 'wake_legacy'").run(),
    /wake_outbox is immutable/);
  db.close();
});
