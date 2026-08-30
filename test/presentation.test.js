import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FakeBackend } from "../src/backend.js";
import { initializeDataRoot } from "../src/db.js";
import { Dispatcher } from "../src/service.js";
import { normalizeOpenCodeActivity, readJsonlTail } from "../src/presentation/activity-open-code.js";
import { runProcess } from "../src/process.js";

async function command(name, args, cwd) {
  const result = await runProcess(name, args, { cwd });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(t, backend) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-presentation-"));
  const root = path.join(temp, "data");
  const repo = path.join(temp, "repo");
  fs.mkdirSync(repo);
  await command("git", ["init", "-b", "main"], repo);
  await command("git", ["config", "user.name", "Test"], repo);
  await command("git", ["config", "user.email", "test@example.invalid"], repo);
  fs.writeFileSync(path.join(repo, "before.txt"), "before\n");
  await command("git", ["add", "."], repo);
  await command("git", ["commit", "-m", "initial"], repo);
  initializeDataRoot(root);
  const dispatcher = new Dispatcher({ root, backend });
  t.after(async () => {
    dispatcher.close();
    const listed = await runProcess("git", ["-C", repo, "worktree", "list", "--porcelain"]);
    for (const worktree of listed.stdout.split(/\r?\n/)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length))
      .filter((worktree) => path.resolve(worktree) !== path.resolve(repo))) {
      await runProcess("git", ["-C", repo, "worktree", "unlock", worktree]);
      await runProcess("git", ["-C", repo, "worktree", "remove", "--force", worktree]);
    }
    fs.rmSync(temp, { recursive: true, force: true });
  });
  return { dispatcher, repo };
}

test("OpenCode activity uses provider call identity to replace lifecycle updates", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-activity-"));
  try {
    const events = path.join(temp, "opencode-events.jsonl");
    fs.writeFileSync(events, [
      JSON.stringify({ type: "tool_use", part: { callID: "call_1", tool: "bash", state: { status: "running", input: { command: "node --test" } } } }),
      JSON.stringify({ type: "tool_result", part: { callID: "call_1", tool: "bash", state: { status: "completed", input: { command: "node --test" }, output: "60/60" } } }),
      JSON.stringify({ type: "reasoning", part: { text: "private chain of thought" } }),
      "{malformed",
    ].join("\n"));
    const result = normalizeOpenCodeActivity({ attempt: { id: "attempt_1", started_at: "2026-08-30T00:00:00Z" }, filePath: events });
    assert.equal(result.activities.filter((item) => item.id === "attempt_1:opencode:call_1").length, 1);
    assert.equal(result.activities[0].lifecycle, "completed");
    assert.equal(result.activities[0].detail, "60/60");
    assert.doesNotMatch(JSON.stringify(result), /private chain of thought/);
    assert.equal(result.malformed, 1);
    assert.match(result.activities.at(-1).title, /could not be decoded/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("JSONL reader bounds the artifact tail and discards a cut leading fragment", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-tail-"));
  try {
    const events = path.join(temp, "events.jsonl");
    fs.writeFileSync(events, `${JSON.stringify({ type: "text", part: { text: "x".repeat(4096) } })}\n${JSON.stringify({ type: "text", part: { text: "kept" } })}\n`);
    const result = readJsonlTail(events, { maxBytes: 256 });
    assert.equal(result.truncated, true);
    assert.equal(result.malformed, 0);
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].part.text, "kept");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("job status remains backward compatible and appends deterministic presentation", async (t) => {
  const backend = new FakeBackend(async ({ worktreePath, artifactDir }) => {
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, "opencode-events.jsonl"), [
      JSON.stringify({ type: "tool_use", part: { callID: "read_1", tool: "read", input: { path: "before.txt" } } }),
      JSON.stringify({ type: "text", part: { text: "Implemented the bounded change." } }),
    ].join("\n"));
    fs.writeFileSync(path.join(worktreePath, "result.txt"), "done\n");
    return { exitCode: 0, stdout: "done", stderr: "" };
  });
  const { dispatcher, repo } = await fixture(t, backend);
  const project = await dispatcher.addProject({ name: "Presentation", repoPath: repo, validation: ["node -e \"process.exit(0)\""] });
  const job = await dispatcher.createJob({ projectId: project.id, goal: "add result.txt" });
  await dispatcher.runJob(job.id);

  const first = dispatcher.status(job.id);
  const second = dispatcher.status(job.id);
  assert.deepEqual(Object.keys(first).sort(), ["attempts", "family", "job", "presentation", "validations"]);
  assert.equal(first.presentation.schema, 1);
  assert.equal(first.presentation.phase.id, "ready");
  assert.equal(first.presentation.live_activity.length, 0, "settled attempts do not retain rich tool chatter");
  assert.equal(first.presentation.settled_groups.length, 1);
  assert.equal(first.presentation.evidence.some((item) => item.kind === "validation" && item.authority === "evidence"), true);
  assert.deepEqual(first.presentation.changed_files.files, [{ path: "result.txt" }]);
  assert.equal(first.presentation.revision, second.presentation.revision);
});

test("the Backpack fixture is deterministic and separates activity from evidence", () => {
  const fixturePath = new URL("./fixtures/job-presentation-v1.json", import.meta.url);
  const value = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  assert.equal(value.schema, 1);
  assert.equal(value.phase.id, "reviewing");
  assert.ok(value.evidence.every((item) => item.authority === "evidence"));
  assert.ok(value.live_activity.every((item) => item.authority === "activity"));
});
