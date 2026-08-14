// Proves the frozen paired-task corpus is a usable ruler before either executor sees it.
//
// The failure mode this guards against is a verifier that passes whatever it is given. Such a
// verifier makes first-pass validation rate optimistic for every executor equally, so the comparison
// looks clean and means nothing. Each task therefore asserts both a correct solution passing and at
// least one plausible wrong answer failing.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runProcess } from "../src/process.js";

const corpusRoot = fileURLToPath(new URL("../experiments/executor-ab-v1", import.meta.url));
const corpus = JSON.parse(fs.readFileSync(path.join(corpusRoot, "tasks.json"), "utf8"));
const fixtureRoot = path.join(corpusRoot, "fixture");
const verifierRoot = path.join(corpusRoot, "verifiers");

// Runs one verifier against a scratch copy of the fixture that a candidate solution has mutated.
async function verify(taskId, solve) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `dw-corpus-${taskId}-`));
  fs.cpSync(fixtureRoot, work, { recursive: true });
  await solve(work);
  const task = corpus.tasks.find((entry) => entry.id === taskId);
  // Exactly how the runner invokes it: verifier resolved outside the worktree, worktree as cwd.
  const result = await runProcess(process.execPath, [path.join(verifierRoot, task.verifier)],
    { cwd: work, timeoutMs: 60_000 });
  fs.rmSync(work, { recursive: true, force: true });
  return result;
}

const write = (dir, file, body) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), body);
};
const edit = (dir, file, mutate) => {
  const target = path.join(dir, file);
  fs.writeFileSync(target, mutate(fs.readFileSync(target, "utf8")));
};

test("the corpus is self-consistent", () => {
  assert.equal(corpus.corpus_id, "executor-ab-v1");
  assert.equal(corpus.tasks.length, 10);
  assert.equal(new Set(corpus.tasks.map((t) => t.id)).size, 10, "task ids must be unique");
  for (const task of corpus.tasks) {
    assert.ok(task.goal && task.deliverable && task.verifier, `${task.id} is incompletely specified`);
    assert.ok(fs.existsSync(path.join(verifierRoot, task.verifier)), `${task.id} verifier missing`);
  }
});

test("the attempt worktree exposes no verifier or acceptance criteria", () => {
  // A worker that can read the verifier can satisfy it without solving the task, and because the
  // fixture is copied whole, the first worker would also see every later pair's criteria.
  const fixtureFiles = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else fixtureFiles.push(path.relative(fixtureRoot, full).split(path.sep).join("/"));
    }
  };
  walk(fixtureRoot);

  for (const file of fixtureFiles) {
    assert.ok(!/verif|expect|golden|answer|solution/i.test(file), `fixture leaks ${file}`);
  }
  for (const task of corpus.tasks) {
    assert.ok(!fixtureFiles.includes(`verify/${task.verifier}`), `fixture still contains ${task.verifier}`);
  }
  // The fixture must not mention a verifier path at all.
  for (const file of fixtureFiles) {
    const body = fs.readFileSync(path.join(fixtureRoot, file), "utf8");
    assert.ok(!body.includes("verifiers/"), `${file} references the verifier root`);
  }
  assert.ok(fs.existsSync(path.join(fixtureRoot, ".gitattributes")),
    "the line-ending rule must live inside the fixture so it travels with a standalone copy");
});

test("the recorded digest covers the whole apparatus, not just the task list", async () => {
  const { apparatusDigest, apparatusFiles } = await import(
    pathToFileURL(path.join(corpusRoot, "digest.mjs")).href
  );
  const files = apparatusFiles();
  // Everything normative must be inside the digest, or a later edit would be invisible.
  for (const required of [
    "tasks.json", "PROTOCOL.md", "fixture/.gitattributes", "fixture/inventory.csv",
    "fixture/src/lib.js", "fixture/src/report.js", "verifiers/t01.js", "verifiers/_harness.js",
  ]) {
    assert.ok(files.includes(required), `apparatus digest omits ${required}`);
  }
  assert.ok(!files.includes("DIGEST"), "the digest file cannot contain its own hash");

  const recorded = fs.readFileSync(path.join(corpusRoot, "DIGEST"), "utf8").trim();
  assert.equal(apparatusDigest(), recorded, "apparatus changed without updating DIGEST");
  assert.match(recorded, /^[a-f0-9]{64}$/);
});

test("the precommitted execution order is balanced", () => {
  const protocol = fs.readFileSync(path.join(corpusRoot, "PROTOCOL.md"), "utf8");
  const openCodeFirst = /OpenCode first\s+(.+)/.exec(protocol)[1].trim().split(/\s+/);
  const harnessFirst = /Harness first\s+(.+)/.exec(protocol)[1].trim().split(/\s+/);
  assert.equal(openCodeFirst.length, 5, "five pairs must run OpenCode first");
  assert.equal(harnessFirst.length, 5, "five pairs must run Harness first");
  assert.equal(new Set([...openCodeFirst, ...harnessFirst]).size, 10, "each task appears once");
});

test("t01 accepts correct totals and rejects wrong arithmetic", async () => {
  const correct = "widget: 12\ngadget: 7\nsprocket: 20\nflange: 5\nTotal: 44\n";
  assert.equal((await verify("t01-csv-totals", (d) => write(d, "TOTALS.md", correct))).exitCode, 0);
  // A plausible wrong answer: right shape, wrong sum.
  const wrongSum = correct.replace("Total: 44", "Total: 40");
  assert.notEqual((await verify("t01-csv-totals", (d) => write(d, "TOTALS.md", wrongSum))).exitCode, 0);
  // Missing a row.
  const missingRow = "widget: 12\ngadget: 7\nsprocket: 20\nTotal: 44\n";
  assert.notEqual((await verify("t01-csv-totals", (d) => write(d, "TOTALS.md", missingRow))).exitCode, 0);
});

test("t02 accepts the filtered sort and rejects a boundary or ordering error", async () => {
  const correct = "bracket 2.00\nwidget 3.50\nsprocket 4.99\n";
  assert.equal((await verify("t02-filter-select", (d) => write(d, "CHEAP.md", correct))).exitCode, 0);
  // Includes an item above the threshold.
  const included = `${correct}gadget 7.25\n`;
  assert.notEqual((await verify("t02-filter-select", (d) => write(d, "CHEAP.md", included))).exitCode, 0);
  // Correct set, wrong order.
  const unsorted = "sprocket 4.99\nbracket 2.00\nwidget 3.50\n";
  assert.notEqual((await verify("t02-filter-select", (d) => write(d, "CHEAP.md", unsorted))).exitCode, 0);
});

test("t03 accepts the reshaped summary and rejects undeduplicated ports", async () => {
  const correct = JSON.stringify({ services: 3, ports: [8080, 9090] });
  assert.equal((await verify("t03-json-reshape", (d) => write(d, "config.summary.json", correct))).exitCode, 0);
  const duplicated = JSON.stringify({ services: 3, ports: [8080, 9090, 8080] });
  assert.notEqual((await verify("t03-json-reshape", (d) => write(d, "config.summary.json", duplicated))).exitCode, 0);
  const miscounted = JSON.stringify({ services: 2, ports: [8080, 9090] });
  assert.notEqual((await verify("t03-json-reshape", (d) => write(d, "config.summary.json", miscounted))).exitCode, 0);
});

test("t04 accepts the fix and rejects collateral damage", async () => {
  const fix = (body) => body.replace("return items.length;", "return items.length - 1;");
  assert.equal((await verify("t04-bugfix-off-by-one", (d) => edit(d, "src/lib.js", fix))).exitCode, 0);
  // Unfixed.
  assert.notEqual((await verify("t04-bugfix-off-by-one", () => {})).exitCode, 0);
  // Fixed, but a neighbouring function was broken on the way past.
  const collateral = (body) => fix(body).replace("(counts[item] ?? 0) + 1", "1");
  assert.notEqual((await verify("t04-bugfix-off-by-one", (d) => edit(d, "src/lib.js", collateral))).exitCode, 0);
});

test("t05 accepts median and rejects the even-length and empty edge cases", async () => {
  const good = `
export function median(numbers) {
  if (!numbers.length) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
`;
  assert.equal((await verify("t05-add-function", (d) => edit(d, "src/lib.js", (b) => b + good))).exitCode, 0);
  // A naive implementation that ignores even-length averaging and empty input.
  const naive = `
export function median(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
`;
  assert.notEqual((await verify("t05-add-function", (d) => edit(d, "src/lib.js", (b) => b + naive))).exitCode, 0);
});

test("t06 accepts a multi-site rename and rejects an alias or a stale reference", async () => {
  const renameDefinition = (body) => body.replace("export function tally(", "export function countItems(");
  const renameUsage = (body) => body.replace(/\btally\b/g, "countItems");

  // The genuine rename must update both the definition and its downstream references.
  assert.equal((await verify("t06-rename-consistent", (d) => {
    edit(d, "src/lib.js", renameDefinition);
    edit(d, "src/report.js", renameUsage);
  })).exitCode, 0);

  // Added under the new name but the old export was kept: not a rename.
  assert.notEqual((await verify("t06-rename-consistent", (d) => {
    edit(d, "src/lib.js", (b) => `${b}\nexport const countItems = tally;\n`);
  })).exitCode, 0);

  // Definition renamed but the downstream module still imports the old name: the module breaks.
  assert.notEqual((await verify("t06-rename-consistent",
    (d) => edit(d, "src/lib.js", renameDefinition))).exitCode, 0);
});

test("t07 accepts the documented fields and rejects invented or incomplete API surface", async () => {
  const section = (name, parameters, returns) => `## ${name}\nParameters: ${parameters}\nReturns: ${returns}\n`;
  const correct = [
    "# API", "",
    section("lastIndex", "items", "the index of the final element of the array"),
    section("tally", "items", "an object of counts per distinct value"),
    section("sum", "numbers", "the arithmetic total of the numbers"),
  ].join("\n");
  assert.equal((await verify("t07-doc-from-code", (d) => write(d, "API.md", correct))).exitCode, 0);

  // Documents a function that does not exist.
  const confabulated = `${correct}\n${section("median", "numbers", "the middle value of the numbers")}`;
  assert.notEqual((await verify("t07-doc-from-code", (d) => write(d, "API.md", confabulated))).exitCode, 0);

  // Omits an export.
  const partial = ["# API", "", section("lastIndex", "items", "the last index of the array"),
    section("sum", "numbers", "the total of the numbers")].join("\n");
  assert.notEqual((await verify("t07-doc-from-code", (d) => write(d, "API.md", partial))).exitCode, 0);

  // Sections present but the required fields are missing: prose instead of the requested format.
  const prose = "# API\n\n## lastIndex\nReturns the last index.\n\n## tally\nCounts.\n\n## sum\nAdds.\n";
  assert.notEqual((await verify("t07-doc-from-code", (d) => write(d, "API.md", prose))).exitCode, 0);

  // Wrong parameter name: the worker did not actually read the source.
  const wrongParameter = correct.replace("Parameters: numbers", "Parameters: values");
  assert.notEqual((await verify("t07-doc-from-code", (d) => write(d, "API.md", wrongParameter))).exitCode, 0);
});

test("t08 accepts the cleaned copy and rejects reordering or in-place mutation", async () => {
  const correct = "first line\n\nsecond line\n\nthird line\n";
  assert.equal((await verify("t08-text-transform", (d) => write(d, "notes.clean.md", correct))).exitCode, 0);
  // Content reordered.
  const reordered = "third line\n\nsecond line\n\nfirst line\n";
  assert.notEqual((await verify("t08-text-transform", (d) => write(d, "notes.clean.md", reordered))).exitCode, 0);
  // Cleaned the source in place instead of producing a new file.
  assert.notEqual((await verify("t08-text-transform", (d) => {
    write(d, "notes.clean.md", correct);
    write(d, "notes.md", correct);
  })).exitCode, 0);
});

test("t09 accepts the join and rejects including unmatched items", async () => {
  const correct = "widget 12 x 3.50 = 42.00\ngadget 7 x 7.25 = 50.75\nsprocket 20 x 4.99 = 99.80\n";
  assert.equal((await verify("t09-two-file-join", (d) => write(d, "REPORT.md", correct))).exitCode, 0);
  // An outer join: flange has no price.
  const outer = `${correct}flange 5 x 0.00 = 0.00\n`;
  assert.notEqual((await verify("t09-two-file-join", (d) => write(d, "REPORT.md", outer))).exitCode, 0);
  // Right shape, wrong arithmetic.
  const wrongMath = correct.replace("= 42.00", "= 40.00");
  assert.notEqual((await verify("t09-two-file-join", (d) => write(d, "REPORT.md", wrongMath))).exitCode, 0);
});

test("t10 accepts the minimal edit and rejects tidying the file on the way past", async () => {
  assert.equal((await verify("t10-constrained-edit",
    (d) => edit(d, "notes.md", (b) => `${b}# end\n`))).exitCode, 0);
  // Appended correctly, but trailing whitespace was helpfully removed.
  assert.notEqual((await verify("t10-constrained-edit",
    (d) => edit(d, "notes.md", (b) => `${b.replace(/[ \t]+$/gm, "")}# end\n`))).exitCode, 0);
  // Appended correctly, but blank runs were collapsed.
  assert.notEqual((await verify("t10-constrained-edit",
    (d) => edit(d, "notes.md", (b) => `${b.replace(/\n{3,}/g, "\n\n")}# end\n`))).exitCode, 0);
});

test("a standalone fixture repository preserves bytes and hides the verifiers", async (t) => {
  // The exact construction the runner performs: copy the fixture into its own Git repository, which
  // becomes the attempt worktree. The .gitattributes must travel with it, or the byte-exact tasks
  // fail on checkout for reasons unrelated to the executor.
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "dw-standalone-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const origin = path.join(temp, "origin");
  fs.mkdirSync(origin);
  fs.cpSync(fixtureRoot, origin, { recursive: true });

  const git = (args, cwd) => runProcess("git", ["-C", cwd, ...args], { timeoutMs: 60_000 });
  await git(["init", "-b", "main"], origin);
  await git(["config", "user.name", "corpus"], origin);
  await git(["config", "user.email", "corpus@example.invalid"], origin);
  await git(["add", "-A"], origin);
  await git(["commit", "-m", "fixture"], origin);

  const clone = path.join(temp, "clone");
  await runProcess("git", ["clone", "-q", origin, clone], { timeoutMs: 60_000 });

  // Byte-exact fidelity through commit and checkout.
  assert.equal(
    fs.readFileSync(path.join(clone, "notes.md"), "utf8"),
    fs.readFileSync(path.join(fixtureRoot, "notes.md"), "utf8"),
    "notes.md changed passing through Git, which would fail t08 and t10 spuriously",
  );

  // No acceptance criteria are reachable from inside the worktree.
  assert.equal(fs.existsSync(path.join(clone, "verify")), false);
  assert.equal(fs.existsSync(path.join(clone, "verifiers")), false);

  // The byte-exact tasks still verify correctly against a cloned worktree.
  fs.appendFileSync(path.join(clone, "notes.md"), "# end\n");
  const t10 = await runProcess(process.execPath, [path.join(verifierRoot, "t10.js")],
    { cwd: clone, timeoutMs: 60_000 });
  assert.equal(t10.exitCode, 0, `t10 failed on a cloned worktree: ${t10.stderr}`);
});
