// Parallel exploration, proved by overlap rather than by two eventual successes.
//
// Every test here that claims concurrency uses a latch: each worker announces it has started and
// then blocks until the test releases it. If the siblings were still serialized, the second worker
// would never announce and the test would time out rather than quietly pass.
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

// A latch a test can wait on and release.
function latch() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

const BRIEF = () => ({
  diagnosis: "d", instructions: "create out.txt", acceptance: ["out.txt exists"],
  relevant_evidence: [], uncertainties: [], worker_tier: "ordinary",
});

// Records every worker start, and blocks read workers on a per-question latch.
function coordinatedWorker({ started, gates, failOn = [], tokens = 10_000 }) {
  return new FakeBackend(async ({ worktreePath, artifactDir, instruction, mode, goal }) => {
    const question = mode === "read"
      ? (instruction.match(/^Question: (.+)$/m)?.[1] ?? goal)
      : "__implementation__";
    started.push(question);
    if (gates[question]) {
      gates[question].arrived?.();
      await gates[question].promise;
    }
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, "opencode-events.jsonl"), JSON.stringify({
      type: "step_finish",
      part: { tokens: { input: tokens, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.0001 },
    }));
    if (failOn.includes(question)) return { exitCode: 1, stdout: "", stderr: "investigation failed" };
    if (mode === "read") {
      const sessions = path.join(artifactDir, "sessions", "ws", "s1");
      fs.mkdirSync(sessions, { recursive: true });
      fs.writeFileSync(path.join(sessions, "session.jsonl"), `${JSON.stringify({
        type: "assistant/message", data: { text: `findings for ${question}` },
      })}\n`);
    } else {
      fs.writeFileSync(path.join(worktreePath, "out.txt"), "done\n");
    }
    return { exitCode: 0, stdout: "ok", stderr: "" };
  });
}

async function fixture(t, { script, backend, maximumCost = null }) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-par-"));
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

  const dispatcher = new Dispatcher({ root, backend });
  const service = new ManagerService({
    dispatcher, backend: new FakeManagerBackend(script), workerModel: "opencode-go/deepseek-v4-flash",
  });
  t.after(async () => {
    try { dispatcher.close(); } catch { /* closed */ }
    const listed = await runProcess("git", ["-C", repo, "worktree", "list", "--porcelain"]);
    for (const worktree of listed.stdout.split(/\r?\n/)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length))
      .filter((worktree) => path.resolve(worktree) !== path.resolve(repo))) {
      await runProcess("git", ["-C", repo, "worktree", "unlock", worktree]);
      await runProcess("git", ["-C", repo, "worktree", "remove", "--force", worktree]);
    }
    for (let n = 0; n < 20; n += 1) {
      try { fs.rmSync(temp, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 50)); }
    }
  });

  const project = await dispatcher.addProject({ name: "Par", repoPath: repo, validation: [] });
  const job = await dispatcher.createJob({
    projectId: project.id, goal: "objective", strategy: "managed", maxAttempts: 2,
    ...(maximumCost ? { maximumCost } : {}),
  });
  return { dispatcher, service, project, job, repo, root };
}

const explorePlan = (questions) => ({
  action: "EXPLORE", reason: "investigate",
  explorations: questions.map((question) => ({ question, deliver: ["files"] })),
});

// Waits until `count` workers have announced they are inside their backend.
function arrival(count) {
  let seen = 0;
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, arrived: () => { seen += 1; if (seen >= count) resolve(); } };
}

test("two sibling investigations are inside their backends at the same time", async (t) => {
  const started = [];
  const both = arrival(2);
  const gates = {
    "A?": { ...latch(), arrived: both.arrived },
    "B?": { ...latch(), arrived: both.arrived },
  };
  const { dispatcher, service, job } = await fixture(t, {
    script: [explorePlan(["A?", "B?"]), { action: "IMPLEMENT", reason: "go", brief: BRIEF() }, { action: "ACCEPT", reason: "ok" }],
    backend: coordinatedWorker({ started, gates }),
  });

  const run = service.advance(job.id);
  // If the siblings were serialized this never resolves and the test fails by timeout, which is the
  // point: two eventual successes would not have distinguished the two designs.
  await both.promise;

  const live = dispatcher.db.prepare(
    "SELECT COUNT(*) AS count FROM attempts WHERE terminal_state IS NULL",
  ).get().count;
  assert.equal(live, 2, "both investigations hold live attempts simultaneously");

  gates["A?"].release();
  gates["B?"].release();
  await run;
  assert.equal(service.getRun(job.id).status, "ACCEPTED");
});

test("an unrelated job cannot start while investigations are live", async (t) => {
  const started = [];
  const both = arrival(2);
  const gates = {
    "A?": { ...latch(), arrived: both.arrived },
    "B?": { ...latch(), arrived: both.arrived },
  };
  const { dispatcher, service, project, job } = await fixture(t, {
    script: [explorePlan(["A?", "B?"]), { action: "IMPLEMENT", reason: "go", brief: BRIEF() }, { action: "ACCEPT", reason: "ok" }],
    backend: coordinatedWorker({ started, gates }),
  });

  const run = service.advance(job.id);
  await both.promise;

  const unrelated = await dispatcher.createJob({ projectId: project.id, goal: "someone else's work" });
  await assert.rejects(
    dispatcher.runJob(unrelated.id, { model: "opencode-go/deepseek-v4-flash" }),
    /already has live attempt/,
    "concurrency is relaxed for sibling investigations only",
  );

  // And the root's own implementation cannot start alongside them either.
  await assert.rejects(
    dispatcher.runJob(job.id, { model: "opencode-go/deepseek-v4-flash", instruction: "implement" }),
    /already has live attempt/,
  );

  gates["A?"].release();
  gates["B?"].release();
  await run;
});

test("three investigations split the family authority and never exceed it", async (t) => {
  const started = [];
  const all = arrival(3);
  const gates = Object.fromEntries(["A?", "B?", "C?"].map((q) => [q, { ...latch(), arrived: all.arrived }]));
  const { dispatcher, service, job } = await fixture(t, {
    script: [explorePlan(["A?", "B?", "C?"]), { action: "IMPLEMENT", reason: "go", brief: BRIEF() }, { action: "ACCEPT", reason: "ok" }],
    backend: coordinatedWorker({ started, gates, tokens: 1000 }),
    maximumCost: 0.30,
  });

  const run = service.advance(job.id);
  await all.promise;

  const reservations = dispatcher.db.prepare(
    "SELECT budget_reservation_usd AS r FROM attempts WHERE terminal_state IS NULL",
  ).all().map((row) => row.r);
  assert.equal(reservations.length, 3);
  const total = reservations.reduce((sum, value) => sum + value, 0);
  assert.ok(total <= 0.30 + 1e-9, `three reservations totalling ${total} must fit the ceiling`);
  for (const value of reservations) assert.ok(Math.abs(value - 0.10) < 1e-9, "authority is split equally");

  gates["A?"].release(); gates["B?"].release(); gates["C?"].release();
  await run;

  // Settled cost frees the unused authority, so implementation is admissible afterwards.
  assert.equal(dispatcher.reservedAuthority(job.id), 0);
  assert.ok(dispatcher.familySpend(job.id).spent < 0.30);
  assert.equal(service.getRun(job.id).status, "ACCEPTED");
});

test("one failed investigation does not cancel its siblings, and synthesis is told", async (t) => {
  const started = [];
  const { dispatcher, service, job } = await fixture(t, {
    script: [explorePlan(["A?", "B?", "C?"]), { action: "IMPLEMENT", reason: "go", brief: BRIEF() }, { action: "ACCEPT", reason: "ok" }],
    backend: coordinatedWorker({ started, gates: {}, failOn: ["B?"] }),
  });

  await service.advance(job.id);
  const run = service.getRun(job.id);

  const children = dispatcher.db.prepare(
    "SELECT * FROM jobs WHERE parent_job_id = ? ORDER BY created_at",
  ).all(job.id);
  assert.equal(children.length, 3, "all three settle; none is abandoned because a sibling failed");
  assert.equal(children.filter((c) => c.status === "SUCCEEDED").length, 2);
  assert.equal(children.filter((c) => c.status !== "SUCCEEDED").length, 1);

  const synthesis = service.turns(run.id).find((turn) => turn.phase === "SYNTHESIS");
  const prompt = fs.readFileSync(synthesis.prompt_artifact, "utf8");
  assert.match(prompt, /findings for A\?/);
  assert.match(prompt, /findings for C\?/);
  assert.match(prompt, /1 of 3 investigations produced no usable report/);
  assert.equal(service.getRun(job.id).status, "ACCEPTED");
});

test("cancelling the root kills every blocked investigation and stops the run", async (t) => {
  const started = [];
  const all = arrival(3);
  const gates = Object.fromEntries(["A?", "B?", "C?"].map((q) => [q, { ...latch(), arrived: all.arrived }]));
  const { dispatcher, service, job } = await fixture(t, {
    script: [explorePlan(["A?", "B?", "C?"]), { action: "IMPLEMENT", reason: "go", brief: BRIEF() }],
    backend: coordinatedWorker({ started, gates }),
  });

  const run = service.advance(job.id);
  await all.promise;

  const result = await dispatcher.cancelJob({ jobId: job.id, principal: "john", origin: "terminal" });
  assert.equal(result.outcome, "CANCELLED");

  gates["A?"].release(); gates["B?"].release(); gates["C?"].release();
  await run;

  const children = dispatcher.db.prepare("SELECT * FROM jobs WHERE parent_job_id = ?").all(job.id);
  assert.equal(children.length, 3);
  for (const child of children) assert.equal(child.status, "CANCELLED");
  // No implementation was commissioned after cancellation.
  assert.equal(
    dispatcher.db.prepare("SELECT COUNT(*) AS count FROM attempts WHERE job_id = ?").get(job.id).count,
    0,
  );
});

test("a sibling that finishes after another still has its result accepted", async (t) => {
  // The generation fix, proved through the real concurrent path rather than below runJob.
  const started = [];
  const both = arrival(2);
  const gates = {
    "A?": { ...latch(), arrived: both.arrived },
    "B?": { ...latch(), arrived: both.arrived },
  };
  const { dispatcher, service, job } = await fixture(t, {
    script: [explorePlan(["A?", "B?"]), { action: "IMPLEMENT", reason: "go", brief: BRIEF() }, { action: "ACCEPT", reason: "ok" }],
    backend: coordinatedWorker({ started, gates }),
  });

  const run = service.advance(job.id);
  await both.promise;
  // B, which started second, is released first; A completes last.
  gates["B?"].release();
  await new Promise((resolve) => setTimeout(resolve, 60));
  gates["A?"].release();
  await run;

  const children = dispatcher.db.prepare("SELECT * FROM jobs WHERE parent_job_id = ?").all(job.id);
  for (const child of children) {
    assert.equal(child.status, "SUCCEEDED", `${child.goal} must not be rejected as stale`);
    const attempt = dispatcher.db.prepare("SELECT * FROM attempts WHERE job_id = ?").get(child.id);
    assert.equal(attempt.terminal_state, "SUCCEEDED");
    assert.ok(dispatcher.getAttemptUsage(attempt.id), "its usage receipt landed too");
  }
});

test("re-entering a partially completed round commissions no duplicates", async (t) => {
  const started = [];
  const { dispatcher, service, job } = await fixture(t, {
    script: async ({ phase, index }) => {
      if (index === 0) return explorePlan(["A?", "B?"]);
      if (phase === "SYNTHESIS") return { action: "IMPLEMENT", reason: "go", brief: BRIEF() };
      return { action: "ACCEPT", reason: "ok" };
    },
    backend: coordinatedWorker({ started, gates: {} }),
  });

  await service.advance(job.id);
  const firstRunStarts = started.filter((q) => q.endsWith("?")).length;
  assert.equal(firstRunStarts, 2);

  await service.advance(job.id);
  assert.equal(
    started.filter((q) => q.endsWith("?")).length, firstRunStarts,
    "a completed investigation is never re-run on re-entry",
  );
  assert.equal(
    dispatcher.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE parent_job_id = ?").get(job.id).count,
    2,
    "and no duplicate child job is created",
  );
});
