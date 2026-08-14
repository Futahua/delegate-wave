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

// Parses a two-column CSV with a header row into ordered [key, value] pairs.
export function csvRows(file, cast = (v) => v) {
  return lines(baseline(file)).slice(1).map((row) => {
    const [key, value] = row.split(",");
    return [key.trim(), cast(value.trim())];
  });
}
