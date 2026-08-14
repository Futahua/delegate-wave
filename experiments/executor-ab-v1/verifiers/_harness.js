// Shared verifier helpers.
//
// A verifier must reject a plausible wrong answer, not merely a missing file. A plan that passes
// without testing what was asked for makes first-pass validation rate optimistic for every executor,
// which would silently invalidate the comparison.
//
// These verifiers live OUTSIDE the attempt worktree so a worker cannot read the acceptance criteria
// instead of solving the task. They are invoked with the worktree as the working directory, so every
// path here resolves against `process.cwd()` -- never against this file's own location, which would
// read the pristine fixture rather than the candidate.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const inWorktree = (p) => path.resolve(process.cwd(), p);

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
