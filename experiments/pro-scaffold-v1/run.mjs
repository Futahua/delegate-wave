// Run one configuration against the task corpus through the real delegate-wave pipeline.
//
// Deliberately NOT through the production API: each run gets its own data root and repository, so a
// measurement cannot be perturbed by, or perturb, the live installation.
//
//   node experiments/pro-scaffold-v1/run.mjs <config> [repeat] [corpus]
//
// config  A = Pro / headless / high      B = Pro / headless / max
// corpus  base = the original five        hard = the three depth tasks
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeDataRoot } from "../../src/db.js";
import { Dispatcher } from "../../src/service.js";
import { HarnessBackend } from "../../src/harness/backend.js";
import { runProcess } from "../../src/process.js";
import { TASKS } from "./tasks.mjs";
import { HARD_TASKS } from "./tasks-hard.mjs";

// C is the only config that varies the thing this study is named after. A and B differ only in
// reasoning effort, and both saturate every corpus, so the scaffold is what is left to test.
//
// What C can honestly change is the wording of the opening request: a bare persona and the task,
// with none of delegate-wave's framing about worktrees, capabilities, Git, or acceptance. What it
// deliberately does NOT do is stage the tool catalog across requests -- that would mean building a
// fake Minimal, which would measure the imitation rather than the harness.
const MINIMAL_PROMPT = ({ goal }) =>
  `You are a helpful software engineer assistant.\n\n${goal}`;

const CONFIGS = {
  A: { reasoningEffort: "high", label: "Pro / headless / high" },
  B: { reasoningEffort: "max", label: "Pro / headless / max" },
  C: {
    reasoningEffort: "max",
    label: "Pro / headless / max / bare opening request",
    promptBuilder: MINIMAL_PROMPT,
  },
  // The actual hypothesis: a narrow tool surface on request #1, widened once the worker has used it.
  // Matches the frozen Windows run that scored 98/99 -- pwsh + read first, full catalog after -- and
  // needs no persistent shell, because that run did not use one either.
  D: {
    reasoningEffort: "max",
    label: "Pro / headless / max / staged catalog (pwsh+read -> full)",
    promptBuilder: MINIMAL_PROMPT,
    stageFirstRequest: ["pwsh", "read"],
  },
};

const CORPORA = { base: TASKS, hard: HARD_TASKS };

const configName = (process.argv[2] ?? "A").toUpperCase();
const repeat = Number(process.argv[3] ?? 1);
const corpusName = (process.argv[4] ?? "base").toLowerCase();
const config = CONFIGS[configName];
if (!config) throw new Error(`Unknown config ${configName}; known: ${Object.keys(CONFIGS).join(", ")}`);
const corpus = CORPORA[corpusName];
if (!corpus) throw new Error(`Unknown corpus ${corpusName}; known: ${Object.keys(CORPORA).join(", ")}`);

const apiKey = JSON.parse(
  fs.readFileSync(`${process.env.USERPROFILE}/.local/share/opencode/auth.json`, "utf8"),
)["opencode-go"].key;
const MODEL = "opencode-go/deepseek-v4-pro";

const git = async (repo, ...args) => {
  const r = await runProcess("git", ["-C", repo, ...args]);
  if (r.exitCode !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};

async function buildRepo(root, task, seq) {
  const repo = path.join(root, `repo-${task.id}-${seq}`);
  fs.mkdirSync(repo, { recursive: true });
  await runProcess("git", ["init", "-b", "main", repo]);
  await git(repo, "config", "user.name", "experiment");
  await git(repo, "config", "user.email", "experiment@local");
  for (const [rel, body] of Object.entries(task.files)) {
    fs.mkdirSync(path.join(repo, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), body);
  }
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "broken implementation with a correct test suite");
  return repo;
}

// Collect every stage marker written under the data root, newest attempt last.
function readStaging(dataRoot) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "stage.jsonl") found.push(full);
    }
  };
  walk(dataRoot);
  const events = found.flatMap((file) => fs.readFileSync(file, "utf8")
    .split("\n").filter(Boolean).map((line) => JSON.parse(line)));
  const narrowed = events.find((e) => e.event === "narrowed");
  const widened = events.find((e) => e.event === "widened");
  return {
    narrowed_to: narrowed?.visible ?? null,
    widened_after: widened?.after ?? null,
    widened_to_count: widened?.count ?? null,
    // The single fact that makes the cell valid.
    verified: Boolean(narrowed && widened && narrowed.count < widened.count),
  };
}

const results = [];
const temp = fs.mkdtempSync(path.join(os.tmpdir(), `pro-scaffold-${configName}-`));
const root = path.join(temp, "data");
initializeDataRoot(root);

for (let round = 1; round <= repeat; round += 1) {
  for (const task of corpus) {
    const backend = new HarnessBackend({
      harnessHome: "D:/AssistantSystem/delegate-wave/harness",
      apiKey,
      reasoningEffort: config.reasoningEffort,
      ...(config.promptBuilder ? { promptBuilder: config.promptBuilder } : {}),
      ...(config.stageFirstRequest ? { stageFirstRequest: config.stageFirstRequest } : {}),
    });
    const service = new Dispatcher({ root, backend });
    const repo = await buildRepo(root, task, `${round}`);
    const started = Date.now();
    let record;
    try {
      const project = await service.addProject({
        name: `${task.id}-${configName}-${round}`,
        repoPath: repo,
        validation: task.validation,
        protectedPaths: task.protectedPaths,
      });
      const job = await service.createJob({
        projectId: project.id, goal: task.goal, mode: "write", maxAttempts: 2,
      });
      await service.runJob(job.id);
      // A second attempt only if the first did not produce a validated candidate.
      if (service.getJob(job.id).status !== "READY_FOR_INTEGRATION") {
        try { await service.runJob(job.id); } catch { /* recorded on the attempt */ }
      }

      const attempts = service.db.prepare(
        "SELECT * FROM attempts WHERE job_id = ? ORDER BY ordinal",
      ).all(job.id);
      const spend = service.jobSpend(job.id);
      const passed = service.getJob(job.id).status === "READY_FOR_INTEGRATION";
      record = {
        config: configName, round, task: task.id,
        validated: passed,
        attempts: attempts.length,
        seconds: Math.round((Date.now() - started) / 1000),
        cost_usd: Number(spend.spent.toFixed(6)),
        cost_complete: spend.complete,
        outcome: service.jobOutcome(job.id)?.state ?? null,
        why: passed ? null : service.failureDetail(job.id),
      };
    } catch (error) {
      record = {
        config: configName, round, task: task.id, validated: false,
        seconds: Math.round((Date.now() - started) / 1000),
        error: String(error?.message ?? error).slice(0, 120),
      };
    }
    // The independent variable, verified rather than assumed. If the marker does not show a narrow
    // opening catalog that later widened, the run did not test what it claims to test -- so the
    // condition is read back off disk and carried on the result.
    if (config.stageFirstRequest) record.staging = readStaging(root);

    results.push(record);
    console.log(
      `${configName}${round} ${task.id.padEnd(16)} `
      + `${record.validated ? "PASS" : "fail"}  ${String(record.attempts ?? "-").padStart(2)} attempt(s)  `
      + `${String(record.seconds).padStart(4)}s  $${(record.cost_usd ?? 0).toFixed(5)}  ${record.why ?? record.error ?? ""}`,
    );
    service.close();
  }
}

const suffix = corpusName === "base" ? configName : `${configName}-${corpusName}`;
const out = path.join(path.dirname(new URL(import.meta.url).pathname.slice(1)), `results-${suffix}.json`);
fs.writeFileSync(out, `${JSON.stringify({ config: config.label, corpus: corpusName, results }, null, 2)}\n`);
console.log(`\n${results.filter((r) => r.validated).length}/${results.length} validated  ->  ${out}`);
fs.rmSync(temp, { recursive: true, force: true });
