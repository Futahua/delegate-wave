// Manager plumbing must not appear as the operator's work, and hiding it must not hide its cost.
//
//   everyday      the ROOT job -- what a person asked for
//   accounting    the whole FAMILY -- what it cost, and what recovery reasons about
//   detailed      a root with its children, on request
//
// The second rule is the one that is easy to get half right. Filtering children out of the surface
// while still costing each root by its own attempts would quietly delete the investigations' spend
// from the operator's account: the manager's research would become free.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeDataRoot } from "../src/db.js";
import { FakeBackend } from "../src/backend.js";
import { Dispatcher } from "../src/service.js";
import { runProcess } from "../src/process.js";

async function command(name, args, cwd) {
  const result = await runProcess(name, args, { cwd });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

// A worker that reports a known token count, so family spend is predictable and checkable.
const spender = (inputTokens) => new FakeBackend(async ({ worktreePath, artifactDir, mode }) => {
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, "opencode-events.jsonl"), JSON.stringify({
    type: "step_finish",
    part: { tokens: { input: inputTokens, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.0001 },
  }));
  if (mode !== "read") fs.writeFileSync(path.join(worktreePath, "out.txt"), "done\n");
  return { exitCode: 0, stdout: "ok", stderr: "" };
});

async function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-internal-"));
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
  const service = new Dispatcher({ root, backend: spender(100_000) });
  t.after(async () => {
    service.close();
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
  const project = await service.addProject({ name: "Surface", repoPath: repo, validation: [] });
  return { service, project, repo, root };
}

// A managed root with two completed investigations and one implementation attempt.
async function managedFamily(service, project, { runRoot = true } = {}) {
  const root = await service.createJob({
    projectId: project.id, goal: "add CSV export", strategy: "managed", maxAttempts: 2,
  });
  const children = [];
  for (const question of ["investigate CSV architecture", "inspect export tests"]) {
    const child = await service.createJob({
      projectId: project.id, goal: question, mode: "read", maxAttempts: 1,
      parentJobId: root.id, internalKind: "MANAGER_EXPLORATION",
    });
    await service.runJob(child.id, { model: "opencode-go/deepseek-v4-flash", instruction: question });
    children.push(child);
  }
  if (runRoot) {
    await service.runJob(root.id, {
      model: "opencode-go/deepseek-v4-flash", instruction: "implement the export as briefed",
    });
  }
  return { root, children };
}

test("the briefing shows one root, and no investigation appears as finished work", async (t) => {
  const { service, project } = await fixture(t);
  const { root, children } = await managedFamily(service, project);
  for (const child of children) assert.equal(service.getJob(child.id).status, "SUCCEEDED");

  const briefing = service.briefing();
  const everyIdMentioned = [...briefing.working, ...briefing.done, ...briefing.needs_your_decision]
    .map((item) => item.job).filter(Boolean);
  for (const child of children) {
    assert.equal(everyIdMentioned.includes(child.id), false, "an investigation is not a deliverable");
  }
  // The root itself is present: a managed root sits at RUNNING while its manager works.
  assert.equal(briefing.working.filter((item) => item.job === root.id).length, 1);
  assert.equal(briefing.done.length, 0, "two successful read jobs must not read as two finished tasks");
});

test("the root's everyday cost includes every investigation it commissioned", async (t) => {
  const { service, project } = await fixture(t);
  const { root, children } = await managedFamily(service, project);

  const own = service.jobSpend(root.id).spent;
  const family = service.familySpend(root.id).spent;
  const childTotal = children.reduce((sum, child) => sum + service.jobSpend(child.id).spent, 0);
  assert.ok(childTotal > 0, "the investigations really did cost something");
  assert.ok(Math.abs(family - (own + childTotal)) < 1e-9);

  const shown = service.briefing().working.find((item) => item.job === root.id);
  assert.ok(Math.abs(shown.cost.reference_cost_usd - family) < 1e-6,
    "hiding the children must not delete their spend from the account");
  assert.notEqual(shown.cost.reference_cost_usd, own);
});

test("a direct job's displayed cost is unchanged", async (t) => {
  const { service, project } = await fixture(t);
  const direct = await service.createJob({ projectId: project.id, goal: "plain work" });
  // advanceJob rather than runJob: a validated candidate reaches the operator as a decision only
  // once its integration proposal exists, which is what the ordinary authorization path does.
  await service.advanceJob(direct.id, { model: "opencode-go/deepseek-v4-flash" });

  // A direct root's family is itself, so the unified rule changes nothing here.
  assert.equal(service.familySpend(direct.id).spent, service.jobSpend(direct.id).spent);
  // A validated direct candidate is a decision the operator owes, so it lands in
  // needs_your_decision rather than the working or ready_to_check buckets.
  const shown = service.briefing().needs_your_decision.find((item) => item.job === direct.id);
  assert.ok(shown, "a direct candidate still reaches the everyday surface");
  assert.ok(Math.abs(shown.cost.reference_cost_usd - service.jobSpend(direct.id).spent) < 1e-6);
});

test("listJobs returns roots only, and listAllJobs still returns everything", async (t) => {
  const { service, project } = await fixture(t);
  const { root, children } = await managedFamily(service, project, { runRoot: false });

  const listed = service.listJobs().map((job) => job.id);
  assert.deepEqual(listed, [root.id]);
  assert.deepEqual(service.listJobs(project.id).map((job) => job.id), [root.id]);

  const all = service.listAllJobs().map((job) => job.id);
  for (const child of children) assert.ok(all.includes(child.id));
});

test("overview totals, counts and latest-job ignore children", async (t) => {
  const { service, project } = await fixture(t);
  const { root, children } = await managedFamily(service, project, { runRoot: false });

  // Make a child the most recently touched job and put it in an attention state, so a projection
  // that counted children would visibly change which project looks busiest and by how much.
  service.db.prepare("UPDATE jobs SET status = 'NEEDS_ATTENTION', updated_at = ? WHERE id = ?")
    .run(new Date(Date.now() + 60_000).toISOString(), children[0].id);

  const overview = service.overview();
  assert.equal(overview.totals.jobs_needing_attention, 0, "a stuck investigation is not the operator's queue");
  const entry = overview.projects.find((item) => item.id === project.id);
  assert.equal(entry.needs_attention, 0);
  assert.equal(entry.latest_job.id, root.id, "a child must not become the project's latest job");
  for (const item of overview.attention) assert.notEqual(item.id, children[0].id);
  for (const item of overview.work) assert.notEqual(item.id, children[0].id);
});

test("attention() surfaces the root, never the child", async (t) => {
  const { service, project } = await fixture(t);
  const { root, children } = await managedFamily(service, project, { runRoot: false });
  service.db.prepare("UPDATE jobs SET status = 'NEEDS_ATTENTION' WHERE id = ?").run(children[0].id);
  service.db.prepare("UPDATE jobs SET status = 'NEEDS_ATTENTION' WHERE id = ?").run(root.id);

  const ids = service.attention().jobs.map((job) => job.id);
  assert.deepEqual(ids, [root.id]);

  // And a failed investigation on its own does NOT drag the root into the queue: the EXPLORE lane
  // treats a failed report as evidence, and synthesis may continue with the successful ones.
  service.db.prepare("UPDATE jobs SET status = 'RUNNING' WHERE id = ?").run(root.id);
  service.db.prepare("UPDATE jobs SET status = 'FAILED' WHERE id = ?").run(children[1].id);
  assert.deepEqual(service.attention().jobs.map((job) => job.id), []);
});

test("the detailed family shows both investigations and the aggregate", async (t) => {
  const { service, project } = await fixture(t);
  const { root, children } = await managedFamily(service, project);

  const detail = service.status(root.id);
  assert.equal(detail.family.children.length, 2);
  for (const child of children) {
    const shown = detail.family.children.find((item) => item.id === child.id);
    assert.equal(shown.internal_kind, "MANAGER_EXPLORATION");
    assert.equal(shown.mode, "read");
    assert.equal(shown.attempts, 1);
    assert.ok(shown.cost.spent > 0);
  }
  assert.equal(detail.family.aggregate_cost.jobs, 3);

  // A direct job's family is simply empty, so callers never branch on strategy.
  const direct = await service.createJob({ projectId: project.id, goal: "plain work" });
  assert.deepEqual(service.status(direct.id).family.children, []);
});

test("doctor and recovery still see a stuck child", async (t) => {
  const { service, project } = await fixture(t);
  const { children } = await managedFamily(service, project, { runRoot: false });

  // A child left mid-flight is exactly the thing an everyday surface must not show and recovery
  // must not miss.
  const attempt = service.db.prepare("SELECT * FROM attempts WHERE job_id = ?").get(children[0].id);
  service.db.prepare("UPDATE attempts SET terminal_state = NULL WHERE id = ?").run(attempt.id);
  service.db.prepare("UPDATE jobs SET status = 'RUNNING' WHERE id = ?").run(children[0].id);

  const running = service.doctor().running_attempts.map((row) => row.id);
  assert.ok(running.includes(attempt.id), "doctor must see every attempt, including internal ones");
});

test("family accounting includes children even though the surface does not", async (t) => {
  const { service, project } = await fixture(t);
  const { root, children } = await managedFamily(service, project);
  const family = service.familyJobIds(root.id);
  assert.equal(family.length, 3);
  for (const child of children) assert.ok(family.includes(child.id));
  assert.equal(service.familySpend(root.id).jobs, 3);
});

test("a child remains individually retrievable for forensics", async (t) => {
  const { service, project } = await fixture(t);
  const { root, children } = await managedFamily(service, project, { runRoot: false });
  for (const child of children) {
    const fetched = service.getJob(child.id);
    assert.ok(fetched, "hidden from listings is not hidden from lookup");
    assert.equal(fetched.parent_job_id, root.id);
    assert.equal(service.status(child.id).attempts.length, 1);
  }
});
