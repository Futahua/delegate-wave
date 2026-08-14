// Shared verifier helpers.
//
// A verifier must reject a plausible wrong answer, not merely a missing file. A plan that passes
// without testing what was asked for makes first-pass validation rate optimistic for every executor,
// which would silently invalidate the comparison.
import fs from "node:fs";

export const read = (p) => fs.readFileSync(p, "utf8");
export const exists = (p) => fs.existsSync(p);

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
