// The difference between "we do not know what this cost" and "this provably cost nothing".
//
// UNKNOWN must stay blocking: an executor that reached a provider and then lost its accounting really
// did spend money, and treating that as free would make failed work look free in cost per validated
// candidate. But a process that died inside its own local initialization could not have bought
// anything, and recording THAT as unaccounted spend froze a live family permanently -- run 4 of the
// dogfood, 2026-08-19, after 81,495 strong-manager tokens had already been bought.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeDataRoot } from "../src/db.js";
import { FakeBackend, classifyPreProviderFailure } from "../src/backend.js";
import { Dispatcher } from "../src/service.js";
import { runProcess } from "../src/process.js";

async function command(name, args, cwd) {
  const result = await runProcess(name, args, { cwd });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

// The exact stderr OpenCode 1.14.28 wrote when it lost the race for the shared state database.
const WAL_FAILURE = "Error: Unexpected error, check log file at "
  + "C:\\Users\\admin\\.local\\share\\opencode\\log\\2026-08-19T052756.log for more details\n\n"
  + "Failed to run the query 'PRAGMA journal_mode = WAL'\n";

async function fixture(t, handler) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-ppf-"));
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

  const dispatcher = new Dispatcher({ root, backend: new FakeBackend(handler) });
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
  const project = await dispatcher.addProject({ name: "PreProvider", repoPath: repo, validation: [] });
  return { dispatcher, project, repo };
}

// Writes what OpenCode leaves behind when it dies opening its own database: a zero-byte event
// stream and the initialization error on stderr.
const preProviderWorker = async ({ artifactDir }) => {
  fs.mkdirSync(artifactDir, { recursive: true });
  const stdoutPath = path.join(artifactDir, "opencode-events.jsonl");
  const stderrPath = path.join(artifactDir, "opencode-stderr.log");
  fs.writeFileSync(stdoutPath, "");
  fs.writeFileSync(stderrPath, WAL_FAILURE);
  return {
    exitCode: 1, stdout: "", stderr: WAL_FAILURE, stdoutPath, stderrPath,
    preProviderFailure: classifyPreProviderFailure({
      result: { exitCode: 1 }, stdoutPath, stderrPath,
    }),
  };
};

test("a worker that died before provider contact does not freeze the family budget", async (t) => {
  const { dispatcher, project } = await fixture(t, preProviderWorker);
  const job = await dispatcher.createJob({
    projectId: project.id, goal: "anything", maxAttempts: 1, maximumCost: 0.5,
  });
  await dispatcher.runJob(job.id, { model: "opencode-go/deepseek-v4-flash" });

  const attempt = dispatcher.db.prepare(
    "SELECT * FROM attempts WHERE job_id = ? ORDER BY ordinal DESC LIMIT 1",
  ).get(job.id);
  // The attempt still failed. This changes what the failure COST, never whether it worked.
  assert.equal(attempt.terminal_state, "FAILED");

  const receipt = dispatcher.getAttemptUsage(attempt.id);
  assert.equal(receipt.status, "NO_PROVIDER_CONTACT");
  assert.equal(receipt.reference_cost_usd, 0);
  assert.equal(receipt.reported_cost_usd, null, "the executor reported nothing; it died first");
  assert.equal(receipt.pricing_basis_id, null, "no tokens were bought at any rate");

  // The property the whole change exists for.
  const spend = dispatcher.familySpend(job.id);
  assert.equal(spend.complete, true, "a run that never reached a provider leaves spend establishable");
  assert.equal(spend.unpriced_attempts, 0);
  assert.doesNotThrow(() => dispatcher.assertWithinBudget(job.id),
    "the family must still be able to admit work after a pre-provider failure");
});

test("a worker that may have reached a provider still blocks", async (t) => {
  // Same empty log, same nonzero exit -- but stderr this adapter does not recognise. Indistinguishable
  // from a worker that bought tokens and crashed before flushing, so it must stay UNKNOWN.
  const { dispatcher, project } = await fixture(t, async ({ artifactDir }) => {
    fs.mkdirSync(artifactDir, { recursive: true });
    const stdoutPath = path.join(artifactDir, "opencode-events.jsonl");
    const stderrPath = path.join(artifactDir, "opencode-stderr.log");
    fs.writeFileSync(stdoutPath, "");
    fs.writeFileSync(stderrPath, "Error: connection reset by peer\n");
    return {
      exitCode: 1, stdout: "", stderr: "boom", stdoutPath, stderrPath,
      preProviderFailure: classifyPreProviderFailure({ result: { exitCode: 1 }, stdoutPath, stderrPath }),
    };
  });
  const job = await dispatcher.createJob({
    projectId: project.id, goal: "anything", maxAttempts: 1, maximumCost: 0.5,
  });
  await dispatcher.runJob(job.id, { model: "opencode-go/deepseek-v4-flash" });

  const attempt = dispatcher.db.prepare(
    "SELECT * FROM attempts WHERE job_id = ? ORDER BY ordinal DESC LIMIT 1",
  ).get(job.id);
  assert.equal(dispatcher.getAttemptUsage(attempt.id).status, "UNKNOWN");
  assert.equal(dispatcher.familySpend(job.id).complete, false);
  assert.throws(() => dispatcher.assertWithinBudget(job.id), /unpriced usage/);
});

test("the classifier refuses every weaker kind of evidence", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-cls-"));
  const stdoutPath = path.join(dir, "events.jsonl");
  const stderrPath = path.join(dir, "stderr.log");
  const write = (events, stderr) => {
    fs.writeFileSync(stdoutPath, events);
    fs.writeFileSync(stderrPath, stderr);
  };

  write("", WAL_FAILURE);
  assert.ok(classifyPreProviderFailure({ result: { exitCode: 1 }, stdoutPath, stderrPath }),
    "the one case that does qualify");

  // A clean exit is not a failure at all.
  assert.equal(classifyPreProviderFailure({ result: { exitCode: 0 }, stdoutPath, stderrPath }), null);

  // Generic process failure is not evidence: an empty log plus a null exit code is exactly what a
  // worker that spent money and then crashed looks like.
  write("", "Error: something went wrong\n");
  assert.equal(classifyPreProviderFailure({ result: { exitCode: null }, stdoutPath, stderrPath }), null);

  // The signature matches, but the executor demonstrably emitted events -- so it ran.
  write('{"type":"step_finish","part":{"tokens":{"input":10,"output":2}}}\n', WAL_FAILURE);
  assert.equal(classifyPreProviderFailure({ result: { exitCode: 1 }, stdoutPath, stderrPath }), null);

  // A missing event stream is not the same as an empty one; nothing can be concluded.
  fs.rmSync(stdoutPath);
  assert.equal(classifyPreProviderFailure({ result: { exitCode: 1 }, stdoutPath, stderrPath }), null);

  fs.rmSync(dir, { recursive: true, force: true });
});
