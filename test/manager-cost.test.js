// The scarce side, in money rather than in tokens.
//
// Run 13 spent 187,723 manager tokens and produced no dollar figure at all, because the App Server
// reports token counts and no cost. That is the largest measurement hole left: the whole premise of
// this layer is that a cheap family supervised by an expensive manager beats spending scarce quota
// directly, and that claim cannot be evaluated in tokens.
//
// The invariant under test throughout: no pricing evidence means NULL, never zero. A zero would
// read as "this turn was free" and would quietly understate exactly the component the system exists
// to conserve.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeDataRoot } from "../src/db.js";
import { FakeBackend } from "../src/backend.js";
import { Dispatcher } from "../src/service.js";
import { FakeManagerBackend } from "../src/manager/backend.js";
import { ManagerService, summarize } from "../src/manager/service.js";
import { PRICING_BASES, pricingBasisParts, isPriceable, referenceCostUsd } from "../src/pricing.js";
import { runProcess } from "../src/process.js";

test("a basis id splits into the family and the revision that produced a figure", () => {
  assert.deepEqual(pricingBasisParts("deepseek-direct-2026-08-14-v2"),
    { basis: "deepseek-direct-2026-08-14", version: "v2" });
  // A basis that carries no revision is still a basis; it is not silently versioned.
  assert.deepEqual(pricingBasisParts("some-basis"), { basis: "some-basis", version: null });
  assert.deepEqual(pricingBasisParts(null), { basis: null, version: null });
});

test("a model no basis prices is unpriceable, and says so before anything is bought", () => {
  assert.equal(isPriceable("opencode-go/deepseek-v4-flash"), true);
  // The manager route today. Recording a number for it would mean inventing a rate.
  assert.equal(isPriceable("opencode-go/gpt-5.6-luna"), false);
  assert.equal(isPriceable(null), false);
});

test("an unpriceable model yields NULL, not zero", () => {
  const usage = {
    input_tokens: 50_000, output_tokens: 1_800, reasoning_tokens: 200,
    cache_read_tokens: 0, cache_write_tokens: 0,
  };
  const priced = referenceCostUsd(usage, { model: "opencode-go/gpt-5.6-luna" });
  assert.equal(priced.reference_cost_usd, null);
  assert.notEqual(priced.reference_cost_usd, 0, "zero would read as free");
  assert.equal(priced.pricing_basis_id, null);
});

test("a priceable model yields a figure and names the basis that produced it", () => {
  const usage = {
    input_tokens: 1_000_000, output_tokens: 0, reasoning_tokens: 0,
    cache_read_tokens: 0, cache_write_tokens: 0,
  };
  const priced = referenceCostUsd(usage, { model: "opencode-go/deepseek-v4-flash" });
  const rate = PRICING_BASES["deepseek-direct-2026-08-14-v2"].models["deepseek-v4-flash"].input_per_mtok;
  assert.equal(priced.reference_cost_usd, rate);
  assert.equal(priced.pricing_basis_id, "deepseek-direct-2026-08-14-v2");
});

const BRIEF = {
  diagnosis: "d", instructions: "make out.txt", acceptance: ["exists"],
  relevant_evidence: [], uncertainties: [], worker_tier: "ordinary",
};

// What the provider reported for a turn. The App Server gives token counts and no dollars, so this
// is deliberately the shape of the evidence that actually arrives.
const USAGE = {
  status: "COMPLETE",
  input_tokens: 30_000, output_tokens: 400, reasoning_tokens: 50,
  cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 30_450,
  source: "test",
};

// The manager's model is settled by the backend when the thread opens, not by a service option.
class ModelledBackend extends FakeManagerBackend {
  constructor(script, model) {
    super(script);
    this.model = model;
  }

  async startRun() {
    this.threads += 1;
    return { threadId: `fake-thread-${this.threads}`, requestedModel: this.model, actualModel: this.model };
  }
}

async function managedRun(t, model) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-cost-"));
  const root = path.join(temp, "data");
  const repo = path.join(temp, "repo");
  fs.mkdirSync(repo);
  await runProcess("git", ["init", "-b", "main", repo]);
  await runProcess("git", ["-C", repo, "config", "user.name", "Test"]);
  await runProcess("git", ["-C", repo, "config", "user.email", "t@example.invalid"]);
  fs.writeFileSync(path.join(repo, "input.txt"), "before\n");
  await runProcess("git", ["-C", repo, "add", "."]);
  await runProcess("git", ["-C", repo, "commit", "-m", "initial"]);
  initializeDataRoot(root);

  const dispatcher = new Dispatcher({
    root,
    backend: new FakeBackend(async ({ artifactDir, mode, worktreePath }) => {
      fs.mkdirSync(artifactDir, { recursive: true });
      const events = path.join(artifactDir, "opencode-events.jsonl");
      fs.writeFileSync(events, JSON.stringify({
        type: "step_finish",
        part: { reason: "stop", tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.0001 },
      }));
      if (mode !== "read") fs.writeFileSync(path.join(worktreePath, "out.txt"), "done\n");
      return { exitCode: 0, stdout: "ok", stderr: "", stdoutPath: events };
    }),
  });
  const service = new ManagerService({
    dispatcher,
    backend: new ModelledBackend([
      { decision: { action: "IMPLEMENT", reason: "known", brief: BRIEF }, usage: USAGE },
      { decision: { action: "ACCEPT", reason: "done" }, usage: USAGE },
    ], model),
    workerModel: "opencode-go/deepseek-v4-flash",
  });
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
  const project = await dispatcher.addProject({ name: "Cost", repoPath: repo, validation: [] });
  const job = await dispatcher.createJob({
    projectId: project.id, goal: "make a file", strategy: "managed", maxAttempts: 2,
  });
  const report = await service.advance(job.id);
  return { dispatcher, service, job, report };
}

function receiptsFor(dispatcher, runId) {
  return dispatcher.db.prepare(
    `SELECT r.* FROM manager_usage_receipts r JOIN manager_turns t ON t.id = r.manager_turn_id
     WHERE t.manager_run_id = ?`,
  ).all(runId);
}

test("an unpriced manager run reports its tokens and refuses to state a cost", async (t) => {
  const { dispatcher, service, job, report } = await managedRun(t, "opencode-go/gpt-5.6-luna");

  assert.ok(report.strong.total_tokens > 0, "tokens are still measured");
  assert.equal(report.strong.reference_cost_usd, null, "and the cost is honestly unknown");
  assert.equal(report.strong.priced_turns, 0);
  assert.ok(report.strong.unpriced_turns > 0);
  assert.deepEqual(report.strong.pricing_bases, []);

  const receipts = receiptsFor(dispatcher, service.getRun(job.id).id);
  assert.ok(receipts.length > 0);
  for (const receipt of receipts) {
    assert.equal(receipt.reference_cost_usd, null);
    assert.equal(receipt.pricing_basis, null);
    assert.equal(receipt.pricing_basis_version, null);
    assert.ok(receipt.total_tokens > 0, "the tokens survive, so a later basis can price this");
  }
});

test("a priced manager run states a cost and the basis behind it", async (t) => {
  // Priced only because this model happens to sit in a basis; the point is the mechanism.
  const { dispatcher, service, job, report } = await managedRun(t, "opencode-go/deepseek-v4-pro");

  assert.ok(report.strong.reference_cost_usd > 0);
  assert.equal(report.strong.unpriced_turns, 0);
  assert.equal(report.strong.priced_turns, report.strong.turns);
  assert.deepEqual(report.strong.pricing_bases, ["deepseek-direct-2026-08-14-v2"]);

  const receipts = receiptsFor(dispatcher, service.getRun(job.id).id);
  for (const receipt of receipts) {
    assert.ok(receipt.reference_cost_usd > 0);
    assert.equal(receipt.pricing_basis, "deepseek-direct-2026-08-14");
    assert.equal(receipt.pricing_basis_version, "v2");
  }
  // The run total is the sum of its turns, not an independently computed figure.
  const summed = receipts.reduce((acc, receipt) => acc + receipt.reference_cost_usd, 0);
  assert.ok(Math.abs(summed - report.strong.reference_cost_usd) < 1e-12);
});

test("one unpriced turn withholds the run total rather than understating it", () => {
  // A partial sum reads as the cost of the run while being the cost of a subset, and nothing in the
  // number itself reveals the difference. Withholding it is the only honest option; the per-turn
  // figures stay individually inspectable either way.
  const priced = {
    status: "COMPLETE", total_tokens: 10, input_tokens: 8, output_tokens: 2, reasoning_tokens: 0,
    reference_cost_usd: 0.25, pricing_basis: "some-basis", pricing_basis_version: "v1",
  };
  const unpriced = {
    status: "COMPLETE", total_tokens: 10, input_tokens: 8, output_tokens: 2, reasoning_tokens: 0,
    reference_cost_usd: null, pricing_basis: null, pricing_basis_version: null,
  };

  const mixed = summarize([priced, unpriced]);
  assert.equal(mixed.reference_cost_usd, null, "not 0.25, which would understate the run");
  assert.equal(mixed.priced_turns, 1);
  assert.equal(mixed.unpriced_turns, 1);
  assert.equal(mixed.total_tokens, 20, "tokens still total, because every turn reported them");

  const whole = summarize([priced, { ...priced, reference_cost_usd: 0.75 }]);
  assert.equal(whole.reference_cost_usd, 1);
  assert.equal(whole.unpriced_turns, 0);
  assert.deepEqual(whole.pricing_bases, ["some-basis-v1"]);

  // No receipts at all is not a free run.
  assert.equal(summarize([]).reference_cost_usd, null);
});

test("the database refuses a cost with no basis, and a basis with no cost", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-cost-ck-"));
  const root = path.join(temp, "data");
  initializeDataRoot(root);
  const dispatcher = new Dispatcher({ root });
  t.after(() => {
    dispatcher.close();
    fs.rmSync(temp, { recursive: true, force: true });
  });

  const insert = (cost, basis, version, status = "COMPLETE") => () =>
    dispatcher.db.prepare(`INSERT INTO manager_usage_receipts(
      manager_turn_id, status, input_tokens, output_tokens, total_tokens, source, observed_at,
      reference_cost_usd, pricing_basis, pricing_basis_version
    ) VALUES ('t1', ?, 1, 1, 2, 'test', '2026-08-20', ?, ?, ?)`).run(status, cost, basis, version);

  // A figure nobody can reproduce is not evidence.
  assert.throws(insert(0.5, null, null), /CHECK/);
  // A basis that priced nothing is not evidence either.
  assert.throws(insert(null, "some-basis", "v1"), /CHECK/);
  // A version floating free of any basis.
  assert.throws(insert(null, null, "v1"), /CHECK/);
  // A turn the provider never accounted for cannot have a token-derived cost.
  assert.throws(insert(0.5, "some-basis", "v1", "UNKNOWN"), /CHECK/);
  assert.throws(insert(-1, "some-basis", "v1"), /CHECK/);
});
