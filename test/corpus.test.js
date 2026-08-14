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

test("the execution policy is precommitted, balanced, and retry-free", () => {
  const { execution } = corpus;
  assert.ok(execution, "the corpus must precommit its execution policy");

  // The experiment measures a backend's first failure, so the scheduler must not repair it.
  assert.equal(execution.max_attempts, 1);
  assert.ok(execution.max_attempts_rationale?.length > 20, "the retry decision must record its reason");
  assert.ok(execution.pair_adjacency?.length > 20, "pair adjacency must be stated");

  const order = execution.order;
  assert.equal(order.length, 10, "every task must appear in the order");
  assert.deepEqual(
    [...order.map((entry) => entry.task)].sort(),
    corpus.tasks.map((task) => task.id).sort(),
    "the order must cover exactly the corpus tasks",
  );
  const leading = order.reduce((counts, entry) => {
    counts[entry.first] = (counts[entry.first] ?? 0) + 1;
    return counts;
  }, {});
  assert.deepEqual(leading, { opencode: 5, harness: 5 }, "each executor must lead five pairs");

  // The pilot must contain one pair of each leading order, or it cannot detect an order effect.
  assert.equal(execution.pilot.length, 2);
  const pilotLeaders = execution.pilot.map((id) => order.find((entry) => entry.task === id).first);
  assert.deepEqual([...pilotLeaders].sort(), ["harness", "opencode"]);

  // The prose protocol must agree with the machine-readable policy.
  const protocol = fs.readFileSync(path.join(corpusRoot, "PROTOCOL.md"), "utf8");
  assert.match(protocol, /`maxAttempts` is \*\*1\*\*/);
  assert.match(protocol, /back to\s*\n?back/);
});

test("t01 requires exactly the inventory rows and a single final total", async () => {
  const correct = "widget: 12\ngadget: 7\nsprocket: 20\nflange: 5\nTotal: 44\n";
  assert.equal((await verify("t01-csv-totals", (d) => write(d, "TOTALS.md", correct))).exitCode, 0);
  for (const [label, body] of [
    ["wrong sum", correct.replace("Total: 44", "Total: 40")],
    ["missing row", "widget: 12\ngadget: 7\nsprocket: 20\nTotal: 44\n"],
    ["duplicated row", "widget: 12\nwidget: 12\ngadget: 7\nsprocket: 20\nflange: 5\nTotal: 44\n"],
    // A correct total placed first, then a wrong one last: the goal says the total is the final line.
    ["total not last", "Total: 44\nwidget: 12\ngadget: 7\nsprocket: 20\nflange: 5\nTotal: 999\n"],
    ["invented row", "widget: 12\ngadget: 7\nsprocket: 20\nflange: 5\nbracket: 3\nTotal: 47\n"],
  ]) {
    assert.notEqual((await verify("t01-csv-totals", (d) => write(d, "TOTALS.md", body))).exitCode, 0, label);
  }
});

test("t02 requires catalog prices, not merely ascending numbers", async () => {
  const correct = "bracket 2.00\nwidget 3.50\nsprocket 4.99\n";
  assert.equal((await verify("t02-filter-select", (d) => write(d, "CHEAP.md", correct))).exitCode, 0);
  for (const [label, body] of [
    ["includes an item past the boundary", correct + "gadget 7.25\n"],
    ["correct set, wrong order", "sprocket 4.99\nbracket 2.00\nwidget 3.50\n"],
    // Right names, ascending, but the prices were never read from catalog.csv.
    ["invented prices", "bracket 1.00\nwidget 2.00\nsprocket 3.00\n"],
  ]) {
    assert.notEqual((await verify("t02-filter-select", (d) => write(d, "CHEAP.md", body))).exitCode, 0, label);
  }
});

test("t03 accepts the reshaped summary and rejects undeduplicated ports", async () => {
  const correct = JSON.stringify({ services: 3, ports: [8080, 9090] });
  assert.equal((await verify("t03-json-reshape", (d) => write(d, "config.summary.json", correct))).exitCode, 0);
  for (const [label, body] of [
    ["undeduplicated", JSON.stringify({ services: 3, ports: [8080, 9090, 8080] })],
    ["miscounted", JSON.stringify({ services: 2, ports: [8080, 9090] })],
    ["unsorted", JSON.stringify({ services: 3, ports: [9090, 8080] })],
  ]) {
    assert.notEqual((await verify("t03-json-reshape", (d) => write(d, "config.summary.json", body))).exitCode, 0, label);
  }
});

test("t04 permits only the lastIndex fix and rejects any other source change", async () => {
  const fix = (body) => body.replace("return items.length;", "return items.length - 1;");
  assert.equal((await verify("t04-bugfix-off-by-one", (d) => edit(d, "src/lib.js", fix))).exitCode, 0);
  for (const [label, mutate] of [
    ["unfixed", (b) => b],
    // Passes a behavioural sample of sum while destroying it for every other input.
    ["sum stubbed to the sampled value", (b) => fix(b).replace(
      "return numbers.reduce((total, value) => total + value, 0);", "return 6;")],
    ["tally special-cased", (b) => fix(b).replace(
      "for (const item of items) counts[item] = (counts[item] ?? 0) + 1;",
      "if (items.length === 3) return { a: 2, b: 1 };\n  for (const item of items) counts[item] = (counts[item] ?? 0) + 1;")],
    ["unrelated function added", (b) => fix(b) + "\nexport const extra = () => 1;\n"],
  ]) {
    assert.notEqual((await verify("t04-bugfix-off-by-one", (d) => edit(d, "src/lib.js", mutate))).exitCode, 0, label);
  }
});

test("t05 requires an append that leaves existing content byte-identical", async () => {
  const good = [
    "",
    "export function median(numbers) {",
    "  if (!numbers.length) return null;",
    "  const sorted = [...numbers].sort((a, b) => a - b);",
    "  const middle = Math.floor(sorted.length / 2);",
    "  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;",
    "}",
    "",
  ].join("\n");
  const naive = [
    "",
    "export function median(numbers) {",
    "  const sorted = [...numbers].sort((a, b) => a - b);",
    "  return sorted[Math.floor(sorted.length / 2)];",
    "}",
    "",
  ].join("\n");

  assert.equal((await verify("t05-add-function",
    (d) => edit(d, "src/lib.js", (b) => b + good))).exitCode, 0);
  for (const [label, mutate] of [
    ["naive median ignoring even-length and empty input", (b) => b + naive],
    // Every originally checked line still appears, but an existing function was broken.
    ["existing function modified", (b) => b.replace(
      "export function sum(numbers) {", "export function sum(numbers) {\n  numbers = [];") + good],
    ["nothing appended", (b) => b],
  ]) {
    assert.notEqual((await verify("t05-add-function", (d) => edit(d, "src/lib.js", mutate))).exitCode, 0, label);
  }
});

test("t06 permits only the rename and rejects any other behavioural change", async () => {
  const rename = (body) => body.replace(/\btally\b/g, "countItems");
  assert.equal((await verify("t06-rename-consistent", (d) => {
    edit(d, "src/lib.js", rename);
    edit(d, "src/report.js", rename);
  })).exitCode, 0);

  assert.notEqual((await verify("t06-rename-consistent", (d) => {
    edit(d, "src/lib.js", (b) => b + "\nexport const countItems = tally;\n");
  })).exitCode, 0, "alias left behind");

  assert.notEqual((await verify("t06-rename-consistent",
    (d) => edit(d, "src/lib.js", rename))).exitCode, 0, "downstream reference left stale");

  // Renamed correctly, but the lastIndex bug was "helpfully" fixed along the way.
  assert.notEqual((await verify("t06-rename-consistent", (d) => {
    edit(d, "src/lib.js", (b) => rename(b).replace("return items.length;", "return items.length - 1;"));
    edit(d, "src/report.js", rename);
  })).exitCode, 0, "unrelated behaviour changed");
});

test("t07 requires exactly the exports with correct parameters and return categories", async () => {
  const section = (name, parameters, returns) => "## " + name + "\nParameters: " + parameters + "\nReturns: " + returns + "\n";
  const correct = ["# API", "",
    section("lastIndex", "items", "number"),
    section("tally", "items", "object"),
    section("sum", "numbers", "number"),
  ].join("\n");
  assert.equal((await verify("t07-doc-from-code", (d) => write(d, "API.md", correct))).exitCode, 0);

  for (const [label, body] of [
    ["invented section", correct + "\n" + section("median", "numbers", "number")],
    // Any invented name must fail, not merely the one the verifier happens to name.
    ["differently invented section", correct + "\n" + section("imaginaryFunction", "x", "number")],
    ["omitted export", ["# API", "", section("lastIndex", "items", "number"),
      section("sum", "numbers", "number")].join("\n")],
    ["prose instead of the requested fields",
      "# API\n\n## lastIndex\nReturns the last index.\n\n## tally\nCounts.\n\n## sum\nAdds.\n"],
    // 'notitems' contains 'items' as a substring but is not the parameter name.
    ["wrong parameter name", correct.replace("Parameters: items", "Parameters: notitems")],
    ["wrong return category", correct.replace("Returns: object", "Returns: number")],
    // Every requested field is graded, so an unrecognised category is not silently accepted.
    ["free prose in the graded field", correct.replace("Returns: number\n", "Returns: does not return anything\n")],
  ]) {
    assert.notEqual((await verify("t07-doc-from-code", (d) => write(d, "API.md", body))).exitCode, 0, label);
  }
});

test("every task rejects a candidate that changed something it did not authorize", async () => {
  // The corpus-wide boundary: a correct deliverable does not excuse collateral damage. Each case
  // produces the right answer and then touches one file the task never mentioned.
  const solutions = {
    "t01-csv-totals": (d) => write(d, "TOTALS.md", "widget: 12\ngadget: 7\nsprocket: 20\nflange: 5\nTotal: 44\n"),
    "t02-filter-select": (d) => write(d, "CHEAP.md", "bracket 2.00\nwidget 3.50\nsprocket 4.99\n"),
    "t03-json-reshape": (d) => write(d, "config.summary.json", JSON.stringify({ services: 3, ports: [8080, 9090] })),
    "t07-doc-from-code": (d) => write(d, "API.md",
      "# API\n\n## lastIndex\nParameters: items\nReturns: number\n\n## tally\nParameters: items\nReturns: object\n\n## sum\nParameters: numbers\nReturns: number\n"),
    "t08-text-transform": (d) => write(d, "notes.clean.md", "first line\n\nsecond line\n\nthird line\n"),
    "t09-two-file-join": (d) => write(d, "REPORT.md",
      "widget 12 x 3.50 = 42.00\ngadget 7 x 7.25 = 50.75\nsprocket 20 x 4.99 = 99.80\n"),
  };

  for (const [taskId, solve] of Object.entries(solutions)) {
    assert.equal((await verify(taskId, solve)).exitCode, 0, `${taskId}: the correct solution must pass`);

    // Rewriting an input redefines the problem: t02 in particular derives its expectation from
    // catalog.csv, so a worker could otherwise alter the catalog and satisfy its own version.
    assert.notEqual((await verify(taskId, (d) => {
      solve(d);
      edit(d, "catalog.csv", (b) => b.replace("widget,3.50", "widget,1.00"));
    })).exitCode, 0, `${taskId}: rewriting an input must fail`);

    // Unrelated source damage alongside a correct deliverable.
    assert.notEqual((await verify(taskId, (d) => {
      solve(d);
      edit(d, "src/lib.js", (b) => b.replace("return numbers.reduce((total, value) => total + value, 0);", "return 0;"));
    })).exitCode, 0, `${taskId}: damaging an unrelated source file must fail`);

    // Deleting a file the task did not mention.
    assert.notEqual((await verify(taskId, (d) => {
      solve(d);
      fs.rmSync(path.join(d, "config.json"));
    })).exitCode, 0, `${taskId}: deleting an unrelated file must fail`);
  }
});

test("the semantic tasks reject implementations that hardcode the sampled cases", async () => {
  // Behaviour cannot be established by examples: these implementations satisfy every case an
  // example-based verifier would plausibly check, and are wrong everywhere else.
  const hardcodedLastIndex = (b) => b.replace("return items.length;", "return items.length === 1 ? 0 : 2;");
  assert.notEqual((await verify("t04-bugfix-off-by-one",
    (d) => edit(d, "src/lib.js", hardcodedLastIndex))).exitCode, 0, "t04 hardcoded to the sampled lengths");

  const hardcodedMedian = (b) => b + [
    "",
    "export function median(numbers) {",
    "  if (!numbers.length) return null;",
    "  if (numbers.length === 3) return 2;",
    "  if (numbers.length === 4) return 2.5;",
    "  return 0;",
    "}",
    "",
  ].join("\n");
  assert.notEqual((await verify("t05-add-function",
    (d) => edit(d, "src/lib.js", hardcodedMedian))).exitCode, 0, "t05 hardcoded to the sampled inputs");
});

test("t08 requires each blank run collapsed to exactly one blank line", async () => {
  const correct = "first line\n\nsecond line\n\nthird line\n";
  assert.equal((await verify("t08-text-transform", (d) => write(d, "notes.clean.md", correct))).exitCode, 0);
  for (const [label, body, alsoEditSource] of [
    // All blank lines removed rather than collapsed: fewer blanks, not the requested transformation.
    ["blank lines deleted", "first line\nsecond line\nthird line\n", false],
    ["reordered", "third line\n\nsecond line\n\nfirst line\n", false],
    ["trailing whitespace left", "first line   \n\nsecond line\n\nthird line\n", false],
    ["source cleaned in place", correct, true],
  ]) {
    assert.notEqual((await verify("t08-text-transform", (d) => {
      write(d, "notes.clean.md", body);
      if (alsoEditSource) write(d, "notes.md", correct);
    })).exitCode, 0, label);
  }
});

test("t09 requires the exact requested format, not merely the right numbers", async () => {
  const correct = "widget 12 x 3.50 = 42.00\ngadget 7 x 7.25 = 50.75\nsprocket 20 x 4.99 = 99.80\n";
  assert.equal((await verify("t09-two-file-join", (d) => write(d, "REPORT.md", correct))).exitCode, 0);
  for (const [label, body] of [
    ["outer join", correct + "flange 5 x 0.00 = 0.00\n"],
    ["wrong arithmetic", correct.replace("= 42.00", "= 40.00")],
    // Right numbers, wrong format: no separators and a one-decimal price.
    ["separators dropped", "widget 12 3.5 42\ngadget 7 7.25 50.75\nsprocket 20 4.99 99.80\n"],
    ["total not two decimals", correct.replace("= 42.00", "= 42")],
  ]) {
    assert.notEqual((await verify("t09-two-file-join", (d) => write(d, "REPORT.md", body))).exitCode, 0, label);
  }
});

test("t10 requires the original bytes plus exactly one appended line", async () => {
  assert.equal((await verify("t10-constrained-edit",
    (d) => edit(d, "notes.md", (b) => b + "# end\n"))).exitCode, 0);
  for (const [label, mutate] of [
    ["trailing whitespace tidied", (b) => b.replace(/[ \t]+$/gm, "") + "# end\n"],
    ["blank runs collapsed", (b) => b.replace(/\n{3,}/g, "\n\n") + "# end\n"],
    // An extra line smuggled in before the authorized one.
    ["extra line inserted", (b) => b + "# note\n# end\n"],
    ["appended without the newline", (b) => b + "# end"],
  ]) {
    assert.notEqual((await verify("t10-constrained-edit", (d) => edit(d, "notes.md", mutate))).exitCode, 0, label);
  }
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
