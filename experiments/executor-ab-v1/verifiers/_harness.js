// Shared verifier helpers.
//
// Verifiers live OUTSIDE the attempt worktree so a worker cannot read the acceptance criteria
// instead of solving the task. They are invoked with the worktree as the working directory, so
// candidate paths resolve against `process.cwd()` -- never against this file's own location, which
// would read the pristine fixture rather than the candidate.
//
// The governing principle: where a task has a deterministic output, derive the complete expected
// result from the frozen fixture and compare it exactly. Sampling a few properties leaves room for
// an answer that satisfies the checks while violating the task statement, and no amount of adding
// individual counterexamples closes that gap.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const inWorktree = (p) => path.resolve(process.cwd(), p);

// The frozen fixture as committed, used to derive expectations and to prove that files a task did
// not authorize were left alone.
const FIXTURE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixture");
export const baseline = (p) => fs.readFileSync(path.join(FIXTURE_ROOT, p), "utf8");

export const read = (p) => fs.readFileSync(inWorktree(p), "utf8");
export const exists = (p) => fs.existsSync(inWorktree(p));

// Imports a module from the candidate worktree. The cache-busting query matters because several
// tasks import the same specifier within one process run.
export function loadModule(p) {
  return import(`${pathToFileURL(inWorktree(p)).href}?t=${Date.now()}-${Math.random()}`);
}

export function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

export function pass(message) {
  console.log(`ok: ${message}`);
  process.exit(0);
}

export function requireFile(p) {
  if (!exists(p)) fail(`missing ${p}`);
  const text = read(p);
  if (!text.trim()) fail(`empty ${p}`);
  return text;
}

export const lines = (text) => text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.length);

// Compares a candidate file with an exactly expected string, reporting the first divergence rather
// than dumping both documents.
export function expectExact(file, expected) {
  const actual = requireFile(file);
  if (actual === expected) return;
  const a = actual.split("\n");
  const e = expected.split("\n");
  for (let i = 0; i < Math.max(a.length, e.length); i += 1) {
    if (a[i] !== e[i]) {
      fail(`${file} line ${i + 1}: expected ${JSON.stringify(e[i] ?? null)}, got ${JSON.stringify(a[i] ?? null)}`);
    }
  }
  fail(`${file} does not match the expected output exactly`);
}

// Proves a source file changed only in the ways the task authorized, by applying the permitted
// transformation to the frozen baseline and requiring an exact match.
export function expectTransformed(file, transform) {
  expectExact(file, transform(baseline(file)));
}

// Proves a file the task did not mention was left byte-identical.
export function expectUntouched(file) {
  if (read(file) !== baseline(file)) fail(`${file} was modified but the task did not authorize it`);
}

// Deterministic pseudo-random source, so the behavioural domain is large but fixed. A recorded seed
// keeps every run identical: the corpus must not vary between executors or between repeats.
export function seededNumbers(seed, count, spread = 200) {
  let state = seed >>> 0;
  const values = [];
  for (let i = 0; i < count; i += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    values.push((state % (spread * 2 + 1)) - spread);
  }
  return values;
}

// Checks a candidate function against a deterministic reference over a broad fixed domain.
//
// An open-ended semantic requirement cannot be proven by two examples: a worker can hardcode the
// sampled cases and be wrong everywhere else. Exact source comparison is the right tool for
// structural edits, but for behaviour the honest instrument is a hidden reference oracle over a
// declared domain.
export function expectMatchesReference(label, candidate, reference, domain) {
  for (const input of domain) {
    const want = reference(input);
    let got;
    try {
      got = candidate(input);
    } catch (error) {
      fail(`${label}(${JSON.stringify(input)}) threw: ${error.message}`);
    }
    if (!Object.is(got, want) && JSON.stringify(got) !== JSON.stringify(want)) {
      fail(`${label}(${JSON.stringify(input)}) is ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
    }
  }
}

// Parses a two-column CSV with a header row into ordered [key, value] pairs.
//
// Always reads the FROZEN fixture, never the candidate. Deriving expectations from candidate inputs
// would let a worker rewrite the problem -- editing catalog.csv and then producing a matching answer
// -- and have the verifier validate its altered problem instead of the preregistered one.
export function csvRows(file, cast = (v) => v) {
  return lines(baseline(file)).slice(1).map((row) => {
    const [key, value] = row.split(",");
    return [key.trim(), cast(value.trim())];
  });
}

function walk(root, base = root, found = []) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) walk(full, base, found);
    else found.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return found;
}

// Enforces the task's allowed-change boundary over the whole candidate tree.
//
// A verifier that only judges the requested artifact will accept a candidate that produced the right
// answer while damaging something else. Every added, deleted, or modified path outside the declared
// set is a violation, and so is leaving the declared deliverable untouched when the task required
// producing it.
export function expectOnlyChanged(allowed) {
  const permitted = new Set(allowed);
  const candidateFiles = new Set(walk(process.cwd()));
  const baselineFiles = new Set(walk(FIXTURE_ROOT));

  for (const file of candidateFiles) {
    if (permitted.has(file)) continue;
    if (!baselineFiles.has(file)) fail(`created ${file}, which this task does not authorize`);
    if (read(file) !== baseline(file)) fail(`modified ${file}, which this task does not authorize`);
  }
  for (const file of baselineFiles) {
    if (permitted.has(file)) continue;
    if (!candidateFiles.has(file)) fail(`deleted ${file}, which this task does not authorize`);
  }
}
