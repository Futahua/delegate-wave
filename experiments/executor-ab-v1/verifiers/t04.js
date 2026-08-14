import { read, baseline, loadModule, expectUntouched, fail, pass } from "./_harness.js";

// The task authorizes changing exactly one thing: what lastIndex returns. Sampling the neighbouring
// functions would accept a worker that rewrote sum to `return 6` or special-cased tally, so the rest
// of the file is required to be byte-identical to the frozen source.
const source = read("src/lib.js");
const original = baseline("src/lib.js");

const [beforeBody, afterBody] = original.split("  return items.length;\n");
if (afterBody === undefined) fail("the frozen baseline no longer contains the expected buggy line");
if (!source.startsWith(beforeBody)) fail("source before lastIndex's body was modified");
if (!source.endsWith(afterBody)) fail("source after lastIndex's body was modified");

const replacement = source.slice(beforeBody.length, source.length - afterBody.length);
if (/\breturn\b/.test(replacement) === false) fail("lastIndex no longer returns anything");
if (/items\.length\s*;/.test(replacement)) fail("lastIndex still returns items.length");

// Behaviour, not just shape.
const lib = await loadModule("src/lib.js");
if (lib.lastIndex([1, 2, 3]) !== 2) {
  fail(`lastIndex([1,2,3]) is ${lib.lastIndex([1, 2, 3])}, expected 2`);
}
if (lib.lastIndex(["only"]) !== 0) fail("lastIndex of a single-element array must be 0");
if (lib.sum([1, 2, 3]) !== 6) fail("sum was altered");
if (JSON.stringify(lib.tally(["a", "a", "b"])) !== JSON.stringify({ a: 2, b: 1 })) {
  fail("tally was altered");
}
expectUntouched("src/report.js");
pass("lastIndex fixed with every other byte of the module unchanged");
