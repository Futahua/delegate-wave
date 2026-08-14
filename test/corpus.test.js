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
import { fileURLToPath } from "node:url";
import { runProcess } from "../src/process.js";

const corpusRoot = fileURLToPath(new URL("../experiments/executor-ab-v1", import.meta.url));
const corpus = JSON.parse(fs.readFileSync(path.join(corpusRoot, "tasks.json"), "utf8"));
const fixtureRoot = path.join(corpusRoot, "fixture");

// Runs one verifier against a scratch copy of the fixture that a candidate solution has mutated.
async function verify(taskId, solve) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `dw-corpus-${taskId}-`));
  fs.cpSync(fixtureRoot, work, { recursive: true });
  await solve(work);
  const task = corpus.tasks.find((entry) => entry.id === taskId);
  const [command, ...args] = task.validate.split(" ");
  const result = await runProcess(command, args, { cwd: work, timeoutMs: 60_000 });
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

test("the corpus is frozen with a recorded digest and self-consistent rules", () => {
  assert.equal(corpus.corpus_id, "executor-ab-v1");
  assert.equal(corpus.tasks.length, 10);
  assert.equal(new Set(corpus.tasks.map((t) => t.id)).size, 10, "task ids must be unique");
  for (const task of corpus.tasks) {
    assert.ok(task.goal && task.deliverable && task.validate, `${task.id} is incompletely specified`);
    assert.ok(fs.existsSync(path.join(fixtureRoot, task.validate.split(" ")[1])), `${task.id} verifier missing`);
  }
  // Recorded so a post-hoc edit to the corpus is detectable rather than invisible.
  const digest = crypto.createHash("sha256")
    .update(fs.readFileSync(path.join(corpusRoot, "tasks.json")))
    .digest("hex");
  const recorded = fs.readFileSync(path.join(corpusRoot, "DIGEST"), "utf8").trim();
  assert.equal(digest, recorded, "tasks.json changed without updating DIGEST");
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

test("t06 accepts the rename and rejects leaving the old name behind", async () => {
  const renamed = (body) => body.replace("export function tally(", "export function countItems(");
  assert.equal((await verify("t06-rename-consistent", (d) => edit(d, "src/lib.js", renamed))).exitCode, 0);
  // Added under the new name but the old export was kept: not a rename.
  const aliased = (body) => `${body}\nexport const countItems = tally;\n`;
  assert.notEqual((await verify("t06-rename-consistent", (d) => edit(d, "src/lib.js", aliased))).exitCode, 0);
});

test("t07 accepts real documentation and rejects invented API surface", async () => {
  const correct = [
    "# API", "", "## lastIndex", "Takes an array and returns the index of its final element.", "",
    "## tally", "Takes an array and returns counts per distinct value.", "",
    "## sum", "Takes an array of numbers and returns their total.", "",
  ].join("\n");
  assert.equal((await verify("t07-doc-from-code", (d) => write(d, "API.md", correct))).exitCode, 0);
  // Documents a function that does not exist.
  const confabulated = `${correct}\n## median\nReturns the median value.\n`;
  assert.notEqual((await verify("t07-doc-from-code", (d) => write(d, "API.md", confabulated))).exitCode, 0);
  // Omits an export.
  const partial = "# API\n\n## lastIndex\nReturns the last index.\n\n## sum\nReturns the total.\n";
  assert.notEqual((await verify("t07-doc-from-code", (d) => write(d, "API.md", partial))).exitCode, 0);
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
