// What a person is told when something goes wrong.
//
// The rule is: what happened to the change, then whether anything landed, then whether a decision is
// needed, and only then the mechanism. The states below are genuinely different events, and the
// tests exist to keep them from collapsing into each other -- a worker that never produced anything
// did not fail validation, an interrupted validation reached no verdict, and a cancellation is not a
// test result. Blurring those is how a system starts lying gently.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeDataRoot } from "../src/db.js";
import { Dispatcher } from "../src/service.js";
import { FakeBackend } from "../src/backend.js";
import { runProcess } from "../src/process.js";
import { summarizeStatus } from "../src/mcp/server.js";

async function command(name, args, cwd) {
  const result = await runProcess(name, args, { cwd });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

const usage = (dir, cost = 0.0012) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "opencode-events.jsonl"), JSON.stringify({
    type: "step_finish",
    part: { tokens: { input: 900, output: 40, reasoning: 0, cache: { read: 0, write: 0 } }, cost },
  }));
};

// One repository per project, because repo_path is unique and that is correct.
async function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-phrasing-"));
  const root = path.join(temp, "data");
  initializeDataRoot(root);
  let made = 0;
  const services = [];
  const newRepo = async () => {
    const repo = path.join(temp, `repo-${made += 1}`);
    fs.mkdirSync(repo);
    await command("git", ["init", "-b", "main"], repo);
    await command("git", ["config", "user.name", "Test"], repo);
    await command("git", ["config", "user.email", "test@example.invalid"], repo);
    fs.mkdirSync(path.join(repo, "protected"));
    fs.writeFileSync(path.join(repo, "protected", "KEEP.txt"), "keep\n");
    fs.writeFileSync(path.join(repo, "input.txt"), "before\n");
    await command("git", ["add", "."], repo);
    await command("git", ["commit", "-m", "initial"], repo);
    return repo;
  };
  t.after(async () => {
    for (const service of services) { try { service.close(); } catch { /* closed */ } }
    for (let i = 1; i <= made; i += 1) {
      const repo = path.join(temp, `repo-${i}`);
      const listed = await runProcess("git", ["-C", repo, "worktree", "list", "--porcelain"]);
      for (const worktree of listed.stdout.split(/\r?\n/)
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length))
        .filter((w) => path.resolve(w) !== path.resolve(repo))) {
        await runProcess("git", ["-C", repo, "worktree", "unlock", worktree]);
        await runProcess("git", ["-C", repo, "worktree", "remove", "--force", worktree]);
      }
    }
    fs.rmSync(temp, { recursive: true, force: true });
  });

  // Runs one job to completion and returns its outcome sentence.
  return async ({ backend, validation = [], protectedPaths = [], maxAttempts = 1, goal = "add CSV export", after }) => {
    const repo = await newRepo();
    const service = new Dispatcher({ root, backend });
    services.push(service);
    const project = await service.addProject({
      name: `p-${made}`, repoPath: repo, validation, protectedPaths,
    });
    const job = await service.createJob({ projectId: project.id, goal, maxAttempts });
    try { await service.runJob(job.id); } catch { /* recorded on the attempt */ }
    if (after) await after(service, job);
    return { service, job, outcome: service.jobOutcome(job.id) };
  };
}

const failing = (stderr) => new FakeBackend(async ({ artifactDir }) => {
  usage(artifactDir);
  return { exitCode: 1, stdout: "", stderr };
});
const writing = (name = "out.txt") => new FakeBackend(async ({ worktreePath, artifactDir }) => {
  usage(artifactDir);
  fs.writeFileSync(path.join(worktreePath, name), "done\n");
  return { exitCode: 0, stdout: "ok", stderr: "" };
});

// The four states the brief insists must never be confusable.

test("a worker that failed never mentions validation", async (t) => {
  const run = await fixture(t);
  const { outcome } = await run({ backend: failing("npm ERR! could not resolve dependency") });
  assert.equal(outcome.state, "worker-failed");
  assert.match(outcome.headline, /Couldn't complete "add CSV export"\. Nothing was integrated\./);
  assert.ok(!/validation/i.test(outcome.headline), "validation never happened, so it is not mentioned");
  assert.ok(!/validation/i.test(outcome.detail ?? ""));
});

test("a candidate rejected by validation says so, and says it was implemented", async (t) => {
  const run = await fixture(t);
  const { outcome } = await run({ backend: writing(), validation: ['node -e "process.exit(1)"'] });
  assert.equal(outcome.state, "validation-failed");
  assert.match(outcome.headline, /was implemented, but validation failed/);
  assert.match(outcome.headline, /Nothing was integrated/);
  assert.match(outcome.detail, /failed\./, "and names the command that failed");
  // Out of attempts means a person now has to act; saying only what broke leaves them waiting for a
  // retry that will never come.
  assert.match(outcome.headline, /I need your decision/);
  assert.equal(outcome.needs_decision, true);
});

test("an interrupted validation is never described as a failure", async (t) => {
  const run = await fixture(t);
  const { outcome } = await run({
    backend: writing(),
    after: async (service, job) => {
      const attempt = service.db.prepare("SELECT * FROM attempts WHERE job_id = ?").get(job.id);
      service.db.prepare("UPDATE attempts SET validation_state = 'NOT_RUN' WHERE id = ?").run(attempt.id);
      service.db.prepare("UPDATE jobs SET status = 'NEEDS_ATTENTION' WHERE id = ?").run(job.id);
    },
  });
  assert.equal(outcome.state, "validation-interrupted");
  assert.match(outcome.headline, /Validation was interrupted before it finished/);
  assert.ok(!/validation failed/i.test(outcome.headline), "no verdict was reached, so none is reported");
  assert.ok(!/couldn't complete/i.test(outcome.headline), "the work itself was implemented");
});

test("a cancellation is not a verdict on the work or the tests", async (t) => {
  const run = await fixture(t);
  const { outcome } = await run({
    backend: writing(),
    after: async (service, job) => {
      const attempt = service.db.prepare("SELECT * FROM attempts WHERE job_id = ?").get(job.id);
      service.db.prepare("UPDATE attempts SET terminal_state = 'CANCELLED' WHERE id = ?").run(attempt.id);
      service.db.prepare("UPDATE jobs SET status = 'CANCELLED' WHERE id = ?").run(job.id);
    },
  });
  assert.equal(outcome.state, "cancelled");
  assert.match(outcome.headline, /Stopped "add CSV export"\. Nothing was integrated\./);
  assert.ok(!/fail/i.test(outcome.headline), "stopping something is not it failing");
  assert.ok(!/validation/i.test(outcome.headline));
  assert.match(outcome.detail, /was spent before it stopped/, "what it cost is the surprising part");
  assert.equal(outcome.needs_decision, false);
});

test("retries exhausted counts the attempts and asks for a decision", async (t) => {
  const run = await fixture(t);
  const { outcome } = await run({
    backend: (() => {
      // Genuinely different problems, so this is exhaustion rather than one repeated blocker. The
      // signature normalises numbers to a placeholder, so varying a number would NOT vary the
      // problem -- the words have to differ.
      const reasons = ["could not reach the registry", "the build step is missing"];
      let call = 0;
      return new FakeBackend(async ({ artifactDir }) => {
        usage(artifactDir);
        return { exitCode: 1, stdout: "", stderr: reasons[call++ % reasons.length] };
      });
    })(),
    maxAttempts: 2,
    after: async (service, job) => { try { await service.runJob(job.id); } catch { /* recorded */ } },
  });
  assert.equal(outcome.state, "exhausted");
  assert.match(outcome.headline, /after 2 attempts/);
  assert.match(outcome.headline, /I need your decision/);
  assert.equal(outcome.needs_decision, true);
});

test("the same failure twice is reported as the same problem, not as two", async (t) => {
  const run = await fixture(t);
  const { outcome } = await run({
    backend: failing("TypeError: cannot read property of undefined"),
    maxAttempts: 2,
    after: async (service, job) => { try { await service.runJob(job.id); } catch { /* recorded */ } },
  });
  assert.equal(outcome.state, "repeated-blocker");
  assert.match(outcome.headline, /I hit the same problem again/);
  assert.match(outcome.headline, /before trying more/);
  assert.ok(!/[0-9a-f]{16}/.test(outcome.headline + outcome.detail), "no signature hashes in prose");
});

// A single failure is not "after 1 attempt" -- that phrasing only means something after a retry.
test("one failed attempt does not claim a retry count", async (t) => {
  const run = await fixture(t);
  const { outcome } = await run({ backend: failing("boom") });
  assert.ok(!/after 1 attempt/.test(outcome.headline));
});

// Budget refusals happen before an attempt exists, so they are derived rather than recorded.
test("a reached ceiling says so, with the limit as money", async (t) => {
  const run = await fixture(t);
  const { outcome } = await run({
    backend: writing(),
    after: async (service, job) => {
      service.db.prepare(
        "UPDATE jobs SET status = 'NEEDS_ATTENTION', maximum_cost = 0.0001 WHERE id = ?",
      ).run(job.id);
    },
  });
  assert.equal(outcome.state, "budget-reached");
  assert.match(outcome.headline, /reached its \$0\.0001 limit/);
  assert.ok(!/\$0\.000100/.test(outcome.headline), "a limit is money, not an instrument reading");
});

test("unverifiable spend is never rendered as zero", async (t) => {
  const run = await fixture(t);
  const { outcome } = await run({
    // No usage artifact at all, so the attempt's spend is UNKNOWN rather than measured.
    backend: new FakeBackend(async () => ({ exitCode: 1, stdout: "", stderr: "boom" })),
    after: async (service, job) => {
      service.db.prepare(
        "UPDATE jobs SET status = 'NEEDS_ATTENTION', maximum_cost = 0.05 WHERE id = ?",
      ).run(job.id);
    },
  });
  assert.equal(outcome.state, "budget-unverifiable");
  assert.match(outcome.headline, /can't verify the total spend/);
  // The point is that no spend FIGURE is claimed at all -- not that the string "$0" is absent, which
  // would also match the "$0.05" limit this sentence legitimately quotes.
  const prose = outcome.headline + outcome.detail;
  assert.ok(!/\$0\.0000\b/.test(prose), "unmeasured is not free; $0.0000 would be the lie");
  assert.ok(!/was spent|has been spent/.test(prose),
    "and it must not state a spend it cannot establish");
  assert.match(outcome.detail, /1 attempt has/, "and counts in words rather than as attempt(s)");
});

// Ordinary prose must not leak the system's own identifiers.
test("no identifiers, paths, or internal state names appear in the sentence", async (t) => {
  const run = await fixture(t);
  const { outcome, job } = await run({ backend: failing("worker exited with a problem") });
  const prose = `${outcome.headline} ${outcome.detail ?? ""}`;
  for (const leak of [job.id, "job_", "attempt", "proposal_", "epoch", "worktree",
    "NEEDS_ATTENTION", "terminal_state", "validation_state", "FakeBackend", "COMMAND_FAILED"]) {
    assert.ok(!prose.includes(leak), `${leak} does not belong in ordinary prose`);
  }
});

// The status answer must not recite a backlog.
test("Hermes reports the newest problem and counts the rest", async (t) => {
  const sentence = summarizeStatus({
    healthy: true, working: [], needs_your_decision: [], done: [], reverted: [],
    ready_to_check: [
      { job: "a", goal: "newest", says: "Couldn't complete \"newest\". Nothing was integrated.", because: "The worker could not start." },
      { job: "b", goal: "older", says: "should not be recited" },
      { job: "c", goal: "older still", says: "should not be recited either" },
    ],
  });
  assert.match(sentence, /Couldn't complete "newest"/);
  assert.match(sentence, /The worker could not start\./);
  assert.match(sentence, /And 2 older items need attention\./);
  assert.ok(!sentence.includes("should not be recited"), "older failures are counted, not read aloud");
});

test("a single older item is not pluralised", async () => {
  const sentence = summarizeStatus({
    healthy: true, working: [], needs_your_decision: [], done: [], reverted: [],
    ready_to_check: [{ job: "a", goal: "x", says: "Couldn't complete \"x\". Nothing was integrated." }, { job: "b", goal: "y", says: "z" }],
  });
  assert.match(sentence, /And 1 older item needs attention\./);
});
