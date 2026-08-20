// The state the manager kept trying to express and the machine could not represent.
//
// A REVIEW invalidates the diagnosis rather than the work: the candidate is still there, and once
// investigation establishes something new it may be repairable under the corrected understanding.
// On 2026-08-20 the manager said exactly that -- REVIEW/RETHINK, then SYNTHESIS/REVISE -- and the
// contract refused it, throwing away a whole run with ten changed files sitting in a worktree.
//
//   REVIEW(candidate A)
//     +-- REVISE   repair A
//     +-- RETHINK  diagnosis invalidated; A survives as a repair base
//           +-- IMPLEMENT  abandon A, start from the authorized base
//           +-- REVISE     repair A under the new diagnosis
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
import { buildPlanEvidence, renderEvidence } from "../src/manager/evidence.js";
import { runProcess } from "../src/process.js";

const BRIEF = (extra = {}) => ({
  diagnosis: "the totals file is missing",
  instructions: "create out.txt containing the totals",
  acceptance: ["out.txt exists"],
  relevant_evidence: [],
  uncertainties: [],
  worker_tier: "ordinary",
  ...extra,
});

async function fixture(t, script) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-pcr-"));
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

  let written = 0;
  const dispatcher = new Dispatcher({
    root,
    backend: new FakeBackend(async ({ artifactDir, mode, worktreePath }) => {
      fs.mkdirSync(artifactDir, { recursive: true });
      const events = path.join(artifactDir, "opencode-events.jsonl");
      fs.writeFileSync(events, [
        JSON.stringify({ type: "text", part: { text: "findings" } }),
        JSON.stringify({ type: "step_finish", part: { reason: "stop", tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.0001 } }),
      ].join("\n"));
      if (mode !== "read") {
        written += 1;
        fs.writeFileSync(path.join(worktreePath, `out-${written}.txt`), `done ${written}\n`);
      }
      return { exitCode: 0, stdout: "ok", stderr: "", stdoutPath: events };
    }),
  });
  const backend = new FakeManagerBackend(script);
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
  const project = await dispatcher.addProject({ name: "PostCandidate", repoPath: repo, validation: [] });
  const job = await dispatcher.createJob({
    projectId: project.id, goal: "add a totals file", strategy: "managed", maxAttempts: 3,
  });
  return { dispatcher, service, job, backend };
}

test("REVISE before any candidate exists is refused", async (t) => {
  // A synthesis that has never produced anything has nothing to repair, and accepting REVISE would
  // start a "repair" from a base commit with no repair to make.
  const { service, job } = await fixture(t, [
    { action: "EXPLORE", reason: "need facts", explorations: [{ question: "where?", deliver: ["files"] }] },
    { action: "REVISE", reason: "repair it", brief: BRIEF() },
  ]);
  await service.advance(job.id);

  const run = service.getRun(job.id);
  assert.equal(run.status, "AWAITING_HUMAN");
  assert.match(run.escalation_question, /no candidate has been produced yet/);
  assert.equal(run.revision_round, 0, "no revision round was consumed");
});

test("RETHINK from review keeps the candidate, and SYNTHESIS may then repair it", async (t) => {
  const { dispatcher, service, job } = await fixture(t, [
    { action: "IMPLEMENT", reason: "known", brief: BRIEF() },
    { action: "RETHINK", reason: "the diagnosis was wrong", explorations: [{ question: "what really?", deliver: ["files"] }] },
    { action: "REVISE", reason: "repairable under the new understanding", brief: BRIEF({ diagnosis: "corrected" }) },
    { action: "ACCEPT", reason: "now it is right" },
  ]);
  await service.advance(job.id);

  const run = service.getRun(job.id);
  const turns = service.turns(run.id);
  assert.deepEqual(
    turns.map((turn) => `${turn.phase}/${turn.action}`),
    ["PLAN/IMPLEMENT", "REVIEW/RETHINK", "SYNTHESIS/REVISE", "REVIEW/ACCEPT"],
    "the shape the manager was refused for is now the shape that works",
  );
  assert.equal(run.revision_round, 1, "REVISE consumed a revision round");

  // The repair started from the candidate, not from the base.
  const attempts = dispatcher.db.prepare(
    "SELECT * FROM attempts WHERE job_id = ? ORDER BY ordinal",
  ).all(job.id);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1].start_sha, attempts[0].result_commit,
    "the revision builds on the candidate it was repairing");
});

test("IMPLEMENT after a rethink abandons the candidate and starts from the base", async (t) => {
  const { dispatcher, service, job } = await fixture(t, [
    { action: "IMPLEMENT", reason: "known", brief: BRIEF() },
    { action: "RETHINK", reason: "wrong approach entirely", explorations: [{ question: "what really?", deliver: ["files"] }] },
    { action: "IMPLEMENT", reason: "start over", brief: BRIEF({ instructions: "different approach entirely" }) },
    { action: "ACCEPT", reason: "done" },
  ]);
  await service.advance(job.id);

  const job_ = dispatcher.getJob(job.id);
  const attempts = dispatcher.db.prepare(
    "SELECT * FROM attempts WHERE job_id = ? ORDER BY ordinal",
  ).all(job.id);
  assert.equal(attempts[1].start_sha, job_.base_sha,
    "starting over means starting from the authorized base, not from the discarded work");
  assert.equal(service.getRun(job.id).revision_round, 0, "abandoning is not revising");

  const abandoned = dispatcher.db.prepare(
    "SELECT * FROM events WHERE kind = 'MANAGER_CANDIDATE_ABANDONED' AND entity_id = ?",
  ).all(job.id);
  assert.equal(abandoned.length, 1, "throwing away finished work is recorded, not silent");
  assert.equal(JSON.parse(abandoned[0].payload_json).attemptId, attempts[0].id);
});

test("the post-rethink pack carries the candidate state, so a fresh thread decides the same thing", async (t) => {
  // This is what turns thread rollover from a transport patch into a property of the architecture:
  // every turn is reconstructible from durable evidence, so losing the conversation loses nothing.
  const { dispatcher, service, job } = await fixture(t, [
    { action: "IMPLEMENT", reason: "known", brief: BRIEF() },
    { action: "RETHINK", reason: "the totals were computed in the wrong place entirely", explorations: [{ question: "where?", deliver: ["files"] }] },
    { action: "REVISE", reason: "repairable", brief: BRIEF({ diagnosis: "corrected" }) },
    { action: "ACCEPT", reason: "done" },
  ]);
  await service.advance(job.id);

  const run = service.getRun(job.id);
  // The SYNTHESIS prompt the manager actually received after the rethink.
  const synthesis = service.turns(run.id).find((turn) => turn.phase === "SYNTHESIS");
  const prompt = fs.readFileSync(synthesis.prompt_artifact, "utf8");

  assert.match(prompt, /Prior candidate \(still available as a revision base\)/);
  assert.match(prompt, /candidate commit: [0-9a-f]{7,}/);
  assert.match(prompt, /previous review decision: RETHINK/);
  assert.match(prompt, /the totals were computed in the wrong place entirely/,
    "the reason that review rejected it travels in the pack, not in the conversation");
  assert.match(prompt, /REVISE repairs this candidate.*IMPLEMENT abandons it/s,
    "both options are stated, so the choice is deliberate rather than inferred");

  // And the state is assembled from the ledger, so it survives a thread that no longer exists.
  //
  // Reconstruction reflects the ledger AS IT STANDS, which is the point: it reports the latest
  // review of that candidate rather than a snapshot frozen at some earlier turn. The RETHINK value
  // asserted above was true when that synthesis ran, and the prompt is the proof of it.
  const rebuilt = service.priorCandidate(run);
  assert.ok(rebuilt, "reconstructible without any conversation");
  assert.equal(rebuilt.attempt_id, run.last_candidate_attempt_id);
  assert.ok(rebuilt.result_commit, "the commit a repair would start from");

  dispatcher.db.prepare("UPDATE manager_runs SET thread_id = 'a-thread-that-no-longer-exists' WHERE id = ?").run(run.id);
  assert.deepEqual(service.priorCandidate(service.getRun(job.id)), rebuilt,
    "the decision state does not depend on which thread is current, or on there being one at all");
});

test("a pack with no prior candidate says nothing about one", () => {
  // Silence, not an empty section. A synthesis before any implementation must not be told there is
  // a candidate to weigh.
  const rendered = renderEvidence(buildPlanEvidence({
    objective: "build it", baseSha: "abc123", validationCommands: [], protectedPaths: [],
    explorations: [], priorCandidate: null,
  }));
  assert.doesNotMatch(rendered, /Prior candidate/);
  assert.doesNotMatch(rendered, /revision base/);
});
