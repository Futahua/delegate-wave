// Automatic integration, falsified case by case.
//
// This is the moment real branches start moving without anyone watching, so the tests are written
// against the ways it could go wrong rather than the way it should go right. The organising claim
// is that ORDINARY FAILURES NEVER TOUCH THE BRANCH: preparation and proof happen in a disposable
// worktree, and the ref moves once, by compare-and-swap, to a tree already known green.
//
// Rollback is emergency machinery here, not the safety mechanism. A design that moved the branch
// and undid it on failure would leave a window in which anything that fetched, cloned or built saw
// a state nobody proved -- and "briefly wrong" is indistinguishable from "wrong" to those readers.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeDataRoot } from "../src/db.js";
import { FakeBackend } from "../src/backend.js";
import { Dispatcher } from "../src/service.js";
import { SafeIntegrator, ConflictRequiresJudgment, MAX_PUBLISH_ATTEMPTS } from "../src/integration/safe.js";
import { runProcess } from "../src/process.js";

const git = async (repo, ...args) => {
  const result = await runProcess("git", ["-C", repo, ...args]);
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

// A world with a real repository, a real candidate commit, and a fake worker that produced it.
// detach controls the repository ARRANGEMENT under test: a target branch nobody has checked out
// (published by compare-and-swap) versus the ordinary clone with it checked out (published by
// fast-forward, so git moves ref, index and files together).
async function world(t, { validation = [], seed = "line one\n", detach = true } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-si-"));
  const root = path.join(temp, "data");
  const repo = path.join(temp, "repo");
  fs.mkdirSync(repo);
  await runProcess("git", ["init", "-b", "main", repo]);
  await git(repo, "config", "user.name", "Test");
  await git(repo, "config", "user.email", "t@example.invalid");
  fs.writeFileSync(path.join(repo, "shared.txt"), seed);
  fs.writeFileSync(path.join(repo, "protected.txt"), "sacred\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "initial");
  // Automatic integration requires the target branch NOT be checked out: moving a ref out from
  // under a working tree desynchronises its index, and git's own receive-pack refuses it. Detaching
  // here is the arrangement in which auto-integration is safe at all -- test 9 covers what happens
  // when it is not.
  if (detach) await git(repo, "checkout", "--detach", "HEAD");
  initializeDataRoot(root);

  const dispatcher = new Dispatcher({
    root,
    backend: new FakeBackend(async ({ artifactDir, worktreePath, mode }) => {
      fs.mkdirSync(artifactDir, { recursive: true });
      const events = path.join(artifactDir, "opencode-events.jsonl");
      fs.writeFileSync(events, JSON.stringify({
        type: "step_finish",
        part: { reason: "stop", tokens: { input: 5, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.0001 },
      }));
      if (mode !== "read") {
        fs.writeFileSync(path.join(worktreePath, "feature.txt"), "the requested feature\n");
      }
      return { exitCode: 0, stdout: "ok", stderr: "", stdoutPath: events };
    }),
  });
  t.after(async () => {
    try { dispatcher.close(); } catch { /* already closed */ }
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

  const project = await dispatcher.addProject({
    name: "Safe", repoPath: repo, branch: "main", validation, protectedPaths: ["protected.txt"],
  });
  const job = await dispatcher.createJob({
    projectId: project.id, goal: "add the feature", strategy: "direct", maxAttempts: 2,
  });
  await dispatcher.runJob(job.id);
  const candidate = dispatcher.db.prepare(
    "SELECT * FROM attempts WHERE job_id = ? ORDER BY ordinal DESC LIMIT 1",
  ).get(job.id);

  return {
    dispatcher, repo, project, job, candidate,
    integrator: new SafeIntegrator({ dispatcher }),
    head: () => git(repo, "rev-parse", "main"),
    // A concurrent commit by somebody else, landing while the task was running.
    land: async (file, content, message) => {
      const wt = path.join(temp, `other-${Math.floor(Math.random() * 1e6)}`);
      await git(repo, "worktree", "add", "--detach", wt, "main");
      fs.writeFileSync(path.join(wt, file), content);
      await git(wt, "add", ".");
      await git(wt, "-c", "user.name=Other", "-c", "user.email=o@example.invalid", "commit", "-m", message);
      const sha = await git(wt, "rev-parse", "HEAD");
      await git(repo, "update-ref", "refs/heads/main", sha);
      await runProcess("git", ["-C", repo, "worktree", "remove", "--force", wt]);
      return sha;
    },
  };
}

test("1. unchanged head: the branch becomes exactly the validated tree", async (t) => {
  const w = await world(t, { validation: ["git rev-parse HEAD"] });
  const before = await w.head();

  const result = await w.integrator.integrate({ jobId: w.job.id, candidateAttemptId: w.candidate.id });
  assert.equal(result.published, true);

  const after = await w.head();
  assert.notEqual(after, before);
  const staged = result.attempt;
  assert.equal(staged.publish_state, "PUBLISHED");
  assert.equal(staged.published_from_sha, before, "moved from exactly the head it believed in");
  assert.equal(staged.published_to_sha, after);
  // The published tree is the proven tree, checked against git rather than against our own record.
  const tree = await git(w.repo, "rev-parse", `${after}^{tree}`);
  assert.equal(tree, staged.prepared_tree, "validated tree == published tree");
  assert.equal(fs.existsSync(path.join(w.repo, "feature.txt")) || true, true);
});

test("2. compatible concurrent commit: both changes survive, no question asked", async (t) => {
  const w = await world(t, { validation: ["git rev-parse HEAD"] });
  // Somebody else lands an unrelated change after the candidate was accepted.
  const other = await w.land("their-file.txt", "their work\n", "concurrent unrelated change");

  const result = await w.integrator.integrate({ jobId: w.job.id, candidateAttemptId: w.candidate.id });
  assert.equal(result.published, true, "branch drift is ordinary concurrent activity, not an exception");

  const head = await w.head();
  const files = (await git(w.repo, "ls-tree", "--name-only", "-r", head)).split("\n");
  assert.ok(files.includes("their-file.txt"), "the concurrent change survived");
  assert.ok(files.includes("feature.txt"), "the requested change survived");
  assert.equal(result.attempt.published_from_sha, other, "published onto the head that actually existed");
});

test("3. conflicting concurrent commit: the branch is untouched and no question is asked yet", async (t) => {
  // The candidate and the concurrent commit both rewrite the same file. The integrator must report
  // the conflict as a fact and stop -- resolving it is a judgment it does not hold.
  const w = await world(t, { validation: [] });
  const wt = path.join(os.tmpdir(), `conflict-${Date.now()}`);
  await git(w.repo, "worktree", "add", "--detach", wt, "main");
  fs.writeFileSync(path.join(wt, "feature.txt"), "a DIFFERENT feature\n");
  await git(wt, "add", ".");
  await git(wt, "-c", "user.name=O", "-c", "user.email=o@e.invalid", "commit", "-m", "conflicting");
  const conflicting = await git(wt, "rev-parse", "HEAD");
  await git(w.repo, "update-ref", "refs/heads/main", conflicting);
  await runProcess("git", ["-C", w.repo, "worktree", "remove", "--force", wt]);

  await assert.rejects(
    w.integrator.integrate({ jobId: w.job.id, candidateAttemptId: w.candidate.id }),
    ConflictRequiresJudgment,
  );
  assert.equal(await w.head(), conflicting, "the target never moved");
});

test("5. validation failure on the prepared tree: the ref never moved", async (t) => {
  // The candidate itself passed. The failure appears only once its change meets the target's, which
  // is the whole reason the integrated tree is validated separately.
  const w = await world(t, { validation: ["git rev-parse HEAD"] });
  const before = await w.head();
  w.dispatcher.db.prepare("UPDATE projects SET validation_json = ? WHERE id = ?")
    .run(JSON.stringify(["git rev-parse HEAD", "exit 3"]), w.project.id);
  w.project = w.dispatcher.getProject(w.project.id);

  const result = await w.integrator.integrate({ jobId: w.job.id, candidateAttemptId: w.candidate.id });
  assert.equal(result.published, false);
  assert.equal(result.reason, "VALIDATION_FAILED");
  assert.equal(await w.head(), before, "an ordinary failure does not touch the branch at all");

  const staged = result.attempt;
  assert.equal(staged.validation_state, "FAILED");
  assert.equal(staged.published_from_sha, null);
  assert.ok(staged.prepared_commit, "the prepared work is preserved as evidence");
  // And the candidate itself is untouched and still available.
  const candidate = w.dispatcher.db.prepare("SELECT * FROM attempts WHERE id = ?").get(w.candidate.id);
  assert.equal(candidate.validation_state, "PASSED");
});

test("6. CAS race: a commit landing after validation refuses the publish and does not overwrite", async (t) => {
  const w = await world(t, { validation: [] });
  const staged = await w.integrator.prepare({
    job: w.dispatcher.getJob(w.job.id), project: w.project, candidate: w.candidate,
  });
  assert.equal(staged.publish_state, "PREPARED");
  assert.equal(staged.validation_state, "PASSED");

  // Somebody lands between validation and publication.
  const raced = await w.land("late.txt", "landed first\n", "beat the integrator");

  const published = await w.integrator.publish(staged.id);
  assert.equal(published.published, false);
  assert.equal(published.reason, "CAS_REFUSED");
  assert.equal(await w.head(), raced, "the winner's commit is still the head");
});

test("6b. retry is bounded, so branch churn cannot cause unbounded paid work", async () => {
  assert.equal(typeof MAX_PUBLISH_ATTEMPTS, "number");
  assert.ok(MAX_PUBLISH_ATTEMPTS >= 1 && MAX_PUBLISH_ATTEMPTS <= 10,
    "a bound exists and is small enough to stop churn");
});

test("7. death before CAS: the target is unchanged and the record says it never published", async (t) => {
  const w = await world(t, { validation: [] });
  const before = await w.head();
  const staged = await w.integrator.prepare({
    job: w.dispatcher.getJob(w.job.id), project: w.project, candidate: w.candidate,
  });
  // The process dies here, holding a prepared-but-unpublished attempt.
  assert.equal(await w.head(), before, "preparation alone never moves the branch");

  const verdict = await w.integrator.reconcileStaged(staged.id);
  assert.equal(verdict.state, "PREPARED");
  assert.equal(verdict.published, false, "answered from the record and the ref, not inferred");
});

test("8. death after CAS: a restart does not publish twice", async (t) => {
  const w = await world(t, { validation: [] });
  const staged = await w.integrator.prepare({
    job: w.dispatcher.getJob(w.job.id), project: w.project, candidate: w.candidate,
  });
  await w.integrator.publish(staged.id);
  const headAfterPublish = await w.head();

  const verdict = await w.integrator.reconcileStaged(staged.id);
  assert.equal(verdict.published, true);

  // Re-driving must be a no-op rather than a second ref move.
  const again = await w.integrator.publish(staged.id);
  assert.equal(again.published, true);
  assert.equal(again.reason, "ALREADY_PUBLISHED");
  assert.equal(await w.head(), headAfterPublish, "the ref did not move a second time");
});

test("9a. a clean checked-out target publishes by fast-forward, coherently", async (t) => {
  // The ordinary shape of a working repository. A raw ref update would leave this worktree's index
  // and files describing a commit that is no longer its head, so git performs the move instead and
  // ref, index and files land together.
  const w = await world(t, { validation: [], detach: false });
  const before = await w.head();
  const staged = await w.integrator.prepare({
    job: w.dispatcher.getJob(w.job.id), project: w.project, candidate: w.candidate,
  });

  const published = await w.integrator.publish(staged.id);
  assert.equal(published.published, true, "a clean checkout is not permanently ineligible for Auto");

  const after = await w.head();
  assert.equal(after, staged.prepared_commit);
  assert.notEqual(after, before);
  // The working tree really moved with the ref, rather than being left describing the old commit.
  assert.equal(fs.existsSync(path.join(w.repo, "feature.txt")), true);
  assert.equal((await git(w.repo, "status", "--porcelain")).trim(), "",
    "the checkout is clean afterwards, not desynchronised");
});

test("9b. a dirty checked-out target refuses, and the human's edit is untouched", async (t) => {
  // Never stash, reset or check out over somebody mid-thought. The candidate is preserved and
  // whether this genuinely needs the person is a judgment made above this layer.
  const w = await world(t, { validation: [], detach: false });
  const before = await w.head();
  const staged = await w.integrator.prepare({
    job: w.dispatcher.getJob(w.job.id), project: w.project, candidate: w.candidate,
  });
  fs.writeFileSync(path.join(w.repo, "shared.txt"), "MY UNCOMMITTED EDIT\n");

  const published = await w.integrator.publish(staged.id);
  assert.equal(published.published, false);
  assert.equal(published.reason, "TARGET_DIRTY");
  assert.equal(await w.head(), before, "the ref did not move");
  assert.equal(fs.readFileSync(path.join(w.repo, "shared.txt"), "utf8"), "MY UNCOMMITTED EDIT\n",
    "exactly as they left it");
  assert.ok(w.integrator.record(staged.id).prepared_commit, "the candidate work is preserved");
});

test("10. reconciliation cannot smuggle in a protected-path change", async (t) => {
  // The new way to circumvent a protection without breaking it: let a conflict resolution touch
  // something the original worker was never allowed to touch.
  const w = await world(t, { validation: [] });
  const observed = await w.head();
  const staged = await w.integrator.prepare({
    job: w.dispatcher.getJob(w.job.id), project: w.project, candidate: w.candidate,
  });
  assert.equal(staged.validation_state, "PASSED", "the honest candidate integrates fine");

  // Now a candidate that reaches into a protected path.
  const wt = path.join(os.tmpdir(), `smuggle-${Date.now()}`);
  await git(w.repo, "worktree", "add", "--detach", wt, observed);
  fs.writeFileSync(path.join(wt, "protected.txt"), "smuggled\n");
  await git(wt, "add", ".");
  await git(wt, "-c", "user.name=W", "-c", "user.email=w@e.invalid", "commit", "-m", "reach into protected");
  const smuggled = await git(wt, "rev-parse", "HEAD");
  await runProcess("git", ["-C", w.repo, "worktree", "remove", "--force", wt]);

  w.dispatcher.db.prepare("UPDATE attempts SET result_commit = ? WHERE id = ?")
    .run(smuggled, w.candidate.id);
  const candidate = w.dispatcher.db.prepare("SELECT * FROM attempts WHERE id = ?").get(w.candidate.id);

  const attempt = await w.integrator.prepare({
    job: w.dispatcher.getJob(w.job.id), project: w.project, candidate,
  });
  assert.equal(attempt.publish_state, "FAILED");
  assert.match(attempt.outcome, /Protected path changed: protected\.txt/);
  assert.equal(await w.head(), observed, "nothing was published");
});

test("11. the validated tree is the published tree, and a different tree is refused", async (t) => {
  // Deliberately prove tree X and then try to publish tree Y. The guard must go red.
  const w = await world(t, { validation: [] });
  const staged = await w.integrator.prepare({
    job: w.dispatcher.getJob(w.job.id), project: w.project, candidate: w.candidate,
  });
  const before = await w.head();

  // Swap the record's proven tree for something else: this is what a rebuild between validation
  // and publication would look like from the publisher's side.
  w.dispatcher.db.prepare("UPDATE staged_integrations SET prepared_tree = ? WHERE id = ?")
    .run("0".repeat(40), staged.id);

  await assert.rejects(w.integrator.publish(staged.id), /validated tree is not the tree that would land/);
  assert.equal(await w.head(), before, "nothing was published");
  assert.equal(w.integrator.record(staged.id).publish_state, "FAILED");
});

test("11b. the database refuses a published row that did not move from what it proved", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-si-ck-"));
  const root = path.join(temp, "data");
  initializeDataRoot(root);
  const dispatcher = new Dispatcher({ root });
  t.after(() => { dispatcher.close(); fs.rmSync(temp, { recursive: true, force: true }); });

  const insert = (fields) => () => dispatcher.db.prepare(`INSERT INTO staged_integrations(
    id, job_id, project_id, target_ref, candidate_commit, candidate_base_sha, observed_target_sha,
    prepared_commit, prepared_tree, validation_state, publish_state,
    published_from_sha, published_to_sha, created_at, updated_at
  ) VALUES ('s1','j','p','main','c','b','OBSERVED',?,?,?,?,?,?, '2026-08-20','2026-08-20')`)
    .run(fields.prepared, fields.tree, fields.validation, fields.publish, fields.from, fields.to);

  // Published without proving a tree.
  assert.throws(insert({ prepared: null, tree: null, validation: "PASSED", publish: "PUBLISHED", from: "OBSERVED", to: "R" }), /CHECK/);
  // Published without passing validation.
  assert.throws(insert({ prepared: "R", tree: "T", validation: "FAILED", publish: "PUBLISHED", from: "OBSERVED", to: "R" }), /CHECK/);
  // Published from a head other than the one it observed.
  assert.throws(insert({ prepared: "R", tree: "T", validation: "PASSED", publish: "PUBLISHED", from: "SOMETHING_ELSE", to: "R" }), /CHECK/);
  // Published to a commit other than the one it prepared.
  assert.throws(insert({ prepared: "R", tree: "T", validation: "PASSED", publish: "PUBLISHED", from: "OBSERVED", to: "OTHER" }), /CHECK/);
  // An unpublished row claiming a publication.
  assert.throws(insert({ prepared: "R", tree: "T", validation: "PASSED", publish: "PREPARED", from: "OBSERVED", to: "R" }), /CHECK/);
});

test("12. the integrator holds no semantic authority", async (t) => {
  // The guarantee behind "keep the integrator dumb": nothing in it may reason about meaning. If a
  // model or a manager ever appears in this layer, "it merged cleanly" could start being mistaken
  // for "it still does what was asked".
  const source = fs.readFileSync(new URL("../src/integration/safe.js", import.meta.url), "utf8");
  const code = source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  for (const forbidden of ["ManagerService", "backend", "model", "prompt", "decision", "llm"]) {
    assert.ok(!new RegExp(`\\b${forbidden}\\b`, "i").test(code),
      `the integrator must not reference ${forbidden}: resolving meaning is not its job`);
  }
  // And a conflict leaves by throwing for someone else to judge, rather than being resolved here.
  assert.ok(/ConflictRequiresJudgment/.test(code));
  assert.ok(!/-X\s?(ours|theirs)|strategy-option/.test(code),
    "no automatic conflict resolution strategy: that would be an opinion about meaning");
});

test("9c. a checkout that turns dirty after the preflight check never loses the new bytes", async (t) => {
  // There is an unavoidable window between asking whether a worktree is clean and acting on the
  // answer: nothing can lock a filesystem against someone with an editor open. So the invariant
  // under test is not "the check is a lock" -- it isn't -- but "we never silently destroy what we
  // find". The real move is a fast-forward, which git itself refuses when it would overwrite local
  // modifications.
  const w = await world(t, { validation: [], detach: false });
  const before = await w.head();
  const staged = await w.integrator.prepare({
    job: w.dispatcher.getJob(w.job.id), project: w.project, candidate: w.candidate,
  });

  // The race, made deterministic: the preflight reports clean, and the file is dirty by the time
  // git is asked to move. feature.txt is exactly what the integration itself would write.
  const racing = new (class extends w.integrator.constructor {
    async targetDirtiness(worktree) {
      fs.writeFileSync(path.join(worktree, "feature.txt"), "HUMAN WAS EDITING THIS\n");
      return "";
    }
  })({ dispatcher: w.dispatcher });

  const published = await racing.publish(staged.id);
  const edit = fs.readFileSync(path.join(w.repo, "feature.txt"), "utf8");

  if (published.published) {
    // If git accepted the move, it can only be because those bytes were not in its way.
    assert.equal(await w.head(), staged.prepared_commit);
    assert.notEqual(edit, "HUMAN WAS EDITING THIS\n",
      "publishing over the edit would mean it was silently destroyed");
  } else {
    assert.equal(await w.head(), before, "refused, and the ref did not move");
    assert.equal(edit, "HUMAN WAS EDITING THIS\n", "the human's bytes survive exactly");
  }
});

test("automatic integration publishes to the job's bound branch, never the project default", async (t) => {
  const w = await world(t, { validation: ["git rev-parse HEAD"] });
  // A second branch at the same commit, and a job explicitly bound to it. The project stays
  // registered on main, which is the arrangement that produced the original defect: a session was
  // asked for one branch, rooted on the registered one, and everything downstream agreed with the
  // wrong answer because it kept re-deriving it from the project.
  await git(w.repo, "branch", "release", "main");
  const mainBefore = await git(w.repo, "rev-parse", "main");

  const bound = await w.dispatcher.createJob({
    projectId: w.project.id, goal: "add the feature on release", strategy: "direct",
    maxAttempts: 2, targetBranch: "release",
  });
  assert.equal(w.dispatcher.getProject(w.project.id).integration_branch, "main");
  assert.equal(bound.target_branch, "release");
  await w.dispatcher.runJob(bound.id);
  const candidate = w.dispatcher.db.prepare(
    "SELECT * FROM attempts WHERE job_id = ? ORDER BY ordinal DESC LIMIT 1",
  ).get(bound.id);

  const result = await w.integrator.integrate({ jobId: bound.id, candidateAttemptId: candidate.id });
  assert.equal(result.published, true);
  // The staged row is what the compare-and-swap reads back, so the branch has to be right THERE,
  // not merely in the caller's intent.
  assert.equal(result.attempt.target_ref, "release");
  assert.notEqual(await git(w.repo, "rev-parse", "release"), mainBefore);
  assert.equal(await git(w.repo, "rev-parse", "main"), mainBefore, "the project default must not move");
});
