// Jobs created before branch binding existed, upgraded.
//
// The defect this guards is not a missing column -- ALTER TABLE would have covered that -- but a
// missing VALUE. A database that gains `target_branch` and leaves it NULL forces every read site to
// answer "which branch was this job rooted on?" at runtime, and the only answer available then is
// the project's CURRENT default. That is the original defect wearing a new column: a job authorized
// against one world silently re-pointed at another because the registered branch changed later.
//
// So the migration must WRITE the answer down, once, using the rule that was actually in force when
// those rows were created: the root resolved projects.integration_branch and children inherited it.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { initializeDataRoot, openDatabase } from "../src/db.js";
import { managedPaths } from "../src/paths.js";

const row = (db, sql, ...args) => db.prepare(sql).get(...args);

test("a database that predates branch binding backfills the branch each job was really rooted on", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-bind-"));
  // One teardown, closing every handle before removing the directory: Windows refuses to delete an
  // open SQLite file, so a cleanup registered per-database would fail on the first one.
  const open = new Set();
  t.after(() => {
    for (const db of open) { try { db.close(); } catch { /* already closed */ } }
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const root = path.join(temp, "data");
  initializeDataRoot(root);
  const databasePath = managedPaths(root).database;

  // A current database, seeded through the current schema...
  const fresh = openDatabase(databasePath);
  const stamp = new Date().toISOString();
  fresh.prepare(`INSERT INTO projects(
    id, name, repo_path, integration_branch, validation_json, protected_json, created_at
  ) VALUES ('proj_old', 'Old', ?, 'codex/live-work-ui', '[]', '[]', ?)`).run(path.join(temp, "repo"), stamp);
  fresh.prepare(`INSERT INTO projects(
    id, name, repo_path, integration_branch, validation_json, protected_json, created_at
  ) VALUES ('proj_other', 'Other', ?, 'main', '[]', '[]', ?)`).run(path.join(temp, "repo2"), stamp);
  for (const [jobId, projectId, parent] of [
    ["job_root", "proj_old", null],
    ["job_child", "proj_old", "job_root"],
    ["job_elsewhere", "proj_other", null],
  ]) {
    fresh.prepare(`INSERT INTO jobs(
      id, project_id, goal, mode, status, base_sha, target_branch, max_attempts,
      strategy, parent_job_id, internal_kind, created_at, updated_at
    ) VALUES (?, ?, 'historical work', 'write', 'SUCCEEDED', 'a1b2c3', 'placeholder', 2,
      ?, ?, ?, ?, ?)`).run(
      jobId, projectId, parent ? "managed" : "direct", parent,
      parent ? "MANAGER_EXPLORATION" : null, stamp, stamp,
    );
  }
  fresh.close();

  // ...made genuinely historical by removing the column itself, rather than by hand-writing an old
  // schema that would drift from the real one. What remains is exactly what an installation from
  // before this change has on disk.
  const aged = new DatabaseSync(databasePath);
  aged.exec("ALTER TABLE jobs DROP COLUMN target_branch");
  assert.equal(
    aged.prepare("PRAGMA table_info(jobs)").all().some((c) => c.name === "target_branch"),
    false,
    "the fixture must genuinely predate branch binding",
  );
  aged.close();

  const upgraded = openDatabase(databasePath);
  open.add(upgraded);

  // Every row carries a branch, and it is the one its own project was registered with -- not the
  // first project's, and not NULL.
  assert.equal(
    upgraded.prepare("SELECT COUNT(*) AS count FROM jobs WHERE target_branch IS NULL").get().count,
    0,
    "no job may be left without a recorded branch",
  );
  assert.equal(row(upgraded, "SELECT target_branch AS b FROM jobs WHERE id = 'job_root'").b, "codex/live-work-ui");
  assert.equal(row(upgraded, "SELECT target_branch AS b FROM jobs WHERE id = 'job_child'").b, "codex/live-work-ui");
  assert.equal(row(upgraded, "SELECT target_branch AS b FROM jobs WHERE id = 'job_elsewhere'").b, "main");

  // And the backfill is a one-time write, not a view: moving the project's default afterwards must
  // not move a single historical job, which is the whole point of writing it down.
  upgraded.prepare("UPDATE projects SET integration_branch = 'main' WHERE id = 'proj_old'").run();
  upgraded.close();
  const reopened = openDatabase(databasePath);
  open.add(reopened);
  assert.equal(row(reopened, "SELECT target_branch AS b FROM jobs WHERE id = 'job_root'").b, "codex/live-work-ui");
  assert.equal(row(reopened, "SELECT target_branch AS b FROM jobs WHERE id = 'job_child'").b, "codex/live-work-ui");
});
