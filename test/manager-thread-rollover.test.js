// The manager's conversation is shorter-lived than the work it commissions.
//
// A managed run is mostly waiting: the manager decides in seconds, then a worker builds for minutes.
// On 2026-08-20 a thread survived 45 seconds of consecutive turns and was gone after a 6m48s gap,
// taking a finished candidate down with it at REVIEW. That gap is the architecture, not an accident.
//
// Continuity is an OPTIMIZATION here, not correctness state: the evidence pack carries the
// objective, the current evidence and the prior decisions, so a fresh thread given the same pack
// decides the same question. That is what makes replay safe -- but only when the old thread was
// positively rejected before inference. Everything else stays uncertain and stops.
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
import { isStaleThreadRejection } from "../src/manager/codex-app-server.js";
import { runProcess } from "../src/process.js";

const THREAD = "01a01d20-b352-7562-9d1e-bfc06bfd2116";

test("only a positively identified stale thread is replayable", () => {
  // The consequence of a false positive is paying twice and overwriting the first answer, so each
  // of these must be refused.
  assert.equal(isStaleThreadRejection({ message: `-32600: thread not found: ${THREAD}` }, THREAD), true);

  assert.equal(isStaleThreadRejection({ message: "-32600: thread not found: a-different-thread" }, THREAD), false,
    "a rejection about another conversation is not about this one");
  assert.equal(isStaleThreadRejection({ message: "the manager turn was accepted but did not complete" }, THREAD), false,
    "a timeout may already have spent money and produced an answer");
  assert.equal(isStaleThreadRejection({ message: "500: internal server error" }, THREAD), false);
  assert.equal(isStaleThreadRejection({ message: "connection reset by peer" }, THREAD), false);
  assert.equal(isStaleThreadRejection({ message: `thread not found: ${THREAD}` }, null), false,
    "no thread was sent, so none can be stale");
});

// A manager whose thread expires exactly once, the way the real one did: mid-run, after work.
class ExpiringThreadBackend extends FakeManagerBackend {
  constructor(script, { expireOnTurn = 2, error = null } = {}) {
    super(script);
    this.expireOnTurn = expireOnTurn;
    this.error = error;
    this.threads = 0;
    this.calls = 0;
    this.seenThreads = [];
  }

  async startRun({ model = "fake-manager" } = {}) {
    this.threads += 1;
    return { threadId: `thread-${this.threads}`, requestedModel: model, actualModel: model };
  }

  async runTurn(context) {
    this.calls += 1;
    this.seenThreads.push(context.threadId);
    if (this.calls === this.expireOnTurn) {
      const failure = this.error ?? Object.assign(
        new Error(`-32600: thread not found: ${context.threadId}`),
        { staleThread: true, uncertain: false },
      );
      throw failure;
    }
    return super.runTurn(context);
  }
}

async function fixture(t, backend) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-roll-"));
  const root = path.join(temp, "data");
  const repo = path.join(temp, "repo");
  fs.mkdirSync(repo);
  const git = async (...args) => {
    const r = await runProcess("git", ["-C", repo, ...args]);
    assert.equal(r.exitCode, 0, r.stderr);
  };
  await runProcess("git", ["init", "-b", "main", repo]);
  await git("config", "user.name", "Test");
  await git("config", "user.email", "test@example.invalid");
  fs.writeFileSync(path.join(repo, "input.txt"), "before\n");
  await git("add", ".");
  await git("commit", "-m", "initial");
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
  const project = await dispatcher.addProject({ name: "Rollover", repoPath: repo, validation: [] });
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

test("a stale thread is replaced and the same turn is asked again", async (t) => {
  const backend = new ExpiringThreadBackend([
    { action: "IMPLEMENT", reason: "known", brief: BRIEF },
    { action: "ACCEPT", reason: "the candidate is right" },
  ], { expireOnTurn: 2 });
  const { dispatcher, service, job } = await fixture(t, backend);
  await service.advance(job.id);

  const run = service.getRun(job.id);
  assert.equal(run.status, "ACCEPTED", "the run survived losing its conversation");
  assert.ok(run.accepted_attempt_id);

  // A new thread, recorded, and the retry sent on it rather than on the dead one.
  assert.equal(backend.threads, 2, "exactly one replacement thread was opened");
  assert.equal(run.thread_id, "thread-2");
  assert.deepEqual(backend.seenThreads, ["thread-1", "thread-1", "thread-2"],
    "the failing turn was re-sent on the fresh thread");

  const rollovers = dispatcher.db.prepare(
    "SELECT * FROM events WHERE kind = 'MANAGER_THREAD_ROLLOVER' AND entity_id = ?",
  ).all(job.id);
  assert.equal(rollovers.length, 1);
  const payload = JSON.parse(rollovers[0].payload_json);
  assert.equal(payload.old_thread, "thread-1");
  assert.equal(payload.new_thread, "thread-2");
  assert.equal(payload.reason, "THREAD_NOT_FOUND");
  assert.equal(payload.retry, 1);
  assert.ok(payload.semantic_turn.phase, "the turn it stands for is named");
});

test("a second refusal on a fresh thread stops the run", async (t) => {
  // One rollover maximum. A brand-new thread being refused is not a stale conversation any more,
  // and replaying again would be guessing.
  const backend = new ExpiringThreadBackend([
    { action: "IMPLEMENT", reason: "known", brief: BRIEF },
    { action: "ACCEPT", reason: "done" },
  ], { expireOnTurn: 1 });
  // Expire every call, not just the first.
  backend.runTurn = async function runTurn(context) {
    this.calls += 1;
    this.seenThreads.push(context.threadId);
    throw Object.assign(new Error(`-32600: thread not found: ${context.threadId}`), { staleThread: true });
  };
  const { dispatcher, service, job } = await fixture(t, backend);
  await service.advance(job.id);

  assert.equal(backend.calls, 2, "tried once, rolled over once, then stopped");
  const run = service.getRun(job.id);
  assert.notEqual(run.status, "ACCEPTED");
  assert.equal(
    dispatcher.db.prepare("SELECT COUNT(*) c FROM events WHERE kind = 'MANAGER_THREAD_ROLLOVER'").get().c, 1,
  );
});

test("an uncertain failure is never replayed", async (t) => {
  // The invariant this fix must not break: a call that may already have spent money and produced an
  // answer stops the run. Replaying it would pay twice and overwrite the first answer with the
  // second.
  const backend = new ExpiringThreadBackend([
    { action: "IMPLEMENT", reason: "known", brief: BRIEF },
  ], {
    expireOnTurn: 1,
    error: Object.assign(new Error("the manager turn was accepted but did not complete within 900000ms"), {
      uncertain: true, timedOut: true,
    }),
  });
  const { dispatcher, service, job } = await fixture(t, backend);
  await service.advance(job.id);

  assert.equal(backend.calls, 1, "an uncertain outcome is asked exactly once");
  assert.equal(backend.threads, 1, "and no replacement thread is opened");
  assert.equal(
    dispatcher.db.prepare("SELECT COUNT(*) c FROM events WHERE kind = 'MANAGER_THREAD_ROLLOVER'").get().c, 0,
  );
  const turns = service.turns(service.getRun(job.id).id);
  assert.equal(turns.at(-1).state, "UNCERTAIN", "recorded as unknown, not as a clean failure");
});
