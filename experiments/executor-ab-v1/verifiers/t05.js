import { read, fail, pass, loadModule } from "./_harness.js";

const lib = await loadModule("src/lib.js");
if (typeof lib.median !== "function") fail("median is not exported");
if (lib.median([3, 1, 2]) !== 2) fail(`median([3,1,2]) is ${lib.median([3, 1, 2])}, expected 2`);
if (lib.median([4, 1, 2, 3]) !== 2.5) {
  fail(`median([4,1,2,3]) is ${lib.median([4, 1, 2, 3])}, expected 2.5`);
}
if (lib.median([]) !== null) fail("median of an empty array must be null");

// The task says not to modify existing functions. Behaviour checks alone would accept a worker that
// "helpfully" rewrote lastIndex or tally along the way, so the original source lines must survive.
const source = read("src/lib.js");
const untouched = [
  "export function lastIndex(items) {",
  "  return items.length;",
  "export function tally(items) {",
  "  for (const item of items) counts[item] = (counts[item] ?? 0) + 1;",
  "export function sum(numbers) {",
  "  return numbers.reduce((total, value) => total + value, 0);",
];
for (const line of untouched) {
  if (!source.includes(line)) fail(`an existing function was modified: missing ${JSON.stringify(line)}`);
}
pass("median added with correct edge cases and no change to existing functions");
