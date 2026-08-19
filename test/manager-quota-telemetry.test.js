// What one manager turn takes out of the subscription, in the subscription's own units.
//
// Token counts answer a different question. Cache reads were 73% of dogfood run 5's strong total,
// and whether a plan-authenticated account charges them like fresh input is unknown -- billing
// categories and quota accounting need not coincide. Optimising "fewest tokens" while the plan
// meters something else would tune the wrong quantity with great confidence.
//
// This is evidence only. Nothing here enforces anything; a brake designed before this measurement
// exists would be guessing at which lever matters.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeDataRoot } from "../src/db.js";
import { FakeBackend } from "../src/backend.js";
import { Dispatcher } from "../src/service.js";
import { FakeManagerBackend } from "../src/manager/backend.js";
import { ManagerService } from "../src/manager/service.js";
import { runProcess } from "../src/process.js";

async function command(name, args, cwd) {
  const result = await runProcess(name, args, { cwd });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

// A manager backend that reports dwindling allowance, in a shape delegate-wave does not interpret.
class MeteredManagerBackend extends FakeManagerBackend {
  constructor(script, { limits = null, throws = false } = {}) {
    super(script);
    this.remaining = 100;
    this.limits = limits;
    this.throws = throws;
    this.calls = 0;
  }

  async rateLimits() {
    this.calls += 1;
    if (this.throws) throw new Error("account endpoint unavailable");
    if (this.limits === null) return null;
    this.remaining -= 3;
    return {
      primary: { used_percent: 100 - this.remaining, window_minutes: 300, resets_at: "2026-08-19T12:00:00Z" },
      secondary: { used_percent: 4, window_minutes: 10080 },
    };
  }
}

async function fixture(t, backend) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-quota-"));
  const root = path.join(temp, "data");
  const repo = path.join(temp, "repo");
  fs.mkdirSync(repo);
  await command("git", ["init", "-b", "main"], repo);
  await command("git", ["config", "user.name", "Test"], repo);
  await command("git", ["config", "user.email", "test@example.invalid"], repo);
  fs.writeFileSync(path.join(repo, "input.txt"), "before\n");
  await command("git", ["add", "."], repo);
  await command("git", ["commit", "-m", "initial"], repo);
  initializeDataRoot(root);

  const dispatcher = new Dispatcher({
    root,
    backend: new FakeBackend(async ({ artifactDir, mode, worktreePath }) => {
      fs.mkdirSync(artifactDir, { recursive: true });
      const events = path.join(artifactDir, "opencode-events.jsonl");
      fs.writeFileSync(events, [
        JSON.stringify({ type: "text", part: { text: "findings" } }),
        JSON.stringify({ type: "step_finish", part: { reason: "stop", tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.0001 } }),
      ].join("\n"));
      if (mode !== "read") fs.writeFileSync(path.join(worktreePath, "out.txt"), "done\n");
      return { exitCode: 0, stdout: "ok", stderr: "", stdoutPath: events };
    }),
  });
  const service = new ManagerService({ dispatcher, backend, workerModel: "opencode-go/deepseek-v4-flash" });
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
  const project = await dispatcher.addProject({ name: "Quota", repoPath: repo, validation: [] });
  const job = await dispatcher.createJob({
    projectId: project.id, goal: "add a totals file", strategy: "managed", maxAttempts: 2,
  });
  return { dispatcher, service, job };
}

const BRIEF = {
  diagnosis: "the totals file is missing",
  instructions: "create out.txt containing the totals",
  acceptance: ["out.txt exists"],
  relevant_evidence: [],
  uncertainties: [],
  worker_tier: "ordinary",
};

test("every manager turn is bracketed by a raw rate-limit sample", async (t) => {
  const backend = new MeteredManagerBackend([
    { action: "IMPLEMENT", reason: "known", brief: BRIEF },
    { action: "ACCEPT", reason: "done" },
  ], { limits: true });
  const { dispatcher, service, job } = await fixture(t, backend);
  await service.advance(job.id);

  const run = service.getRun(job.id);
  const turns = service.turns(run.id);
  assert.ok(turns.length >= 2, "the run took turns");

  for (const turn of turns) {
    const rows = dispatcher.db.prepare(
      "SELECT * FROM manager_rate_limit_snapshots WHERE manager_turn_id = ? ORDER BY boundary",
    ).all(turn.id);
    assert.deepEqual(rows.map((r) => r.boundary), ["AFTER", "BEFORE"],
      `turn ${turn.ordinal} must be sampled on both sides`);

    // Stored verbatim. A percentage computed today cannot be un-computed when the shape turns out
    // to mean something other than what was assumed.
    for (const row of rows) {
      const parsed = JSON.parse(row.raw_json);
      assert.ok(parsed.primary, "the provider's original response is retained, not a summary");
      assert.equal(typeof parsed.primary.window_minutes, "number");
    }

    // A turn's consumption is a difference between two observations, which is the whole point of
    // sampling either side rather than once.
    const before = JSON.parse(rows.find((r) => r.boundary === "BEFORE").raw_json);
    const after = JSON.parse(rows.find((r) => r.boundary === "AFTER").raw_json);
    assert.ok(after.primary.used_percent > before.primary.used_percent,
      "the AFTER sample must postdate the call, not duplicate the BEFORE one");
  }
});

test("an account that reports nothing is recorded as reporting nothing", async (t) => {
  // Absence has to be visible. A missing row would be indistinguishable from a turn nobody sampled,
  // and that is exactly the ambiguity this system refuses everywhere else.
  const backend = new MeteredManagerBackend([{ action: "ESCALATE", reason: "n/a", question: "why?" }], { limits: null });
  const { dispatcher, service, job } = await fixture(t, backend);
  await service.advance(job.id);

  const rows = dispatcher.db.prepare("SELECT * FROM manager_rate_limit_snapshots").all();
  assert.ok(rows.length >= 2, "samples are still taken");
  assert.ok(rows.every((r) => r.raw_json === null), "and record the absence explicitly");
});

test("telemetry cannot fail the work it measures", async (t) => {
  // A manager turn must not die because the account endpoint was slow, absent, or unsupported.
  const backend = new MeteredManagerBackend([
    { action: "IMPLEMENT", reason: "known", brief: BRIEF },
    { action: "ACCEPT", reason: "done" },
  ], { throws: true });
  const { dispatcher, service, job } = await fixture(t, backend);
  await service.advance(job.id);

  const run = service.getRun(job.id);
  assert.equal(run.status, "ACCEPTED", "the run completed despite telemetry failing throughout");
  assert.ok(run.accepted_attempt_id, "and still accepted a candidate");
  const rows = dispatcher.db.prepare("SELECT * FROM manager_rate_limit_snapshots").all();
  assert.ok(rows.every((r) => r.raw_json === null), "the failed samples are recorded as absent");
});
