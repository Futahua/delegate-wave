import { read, baseline, loadModule, expectUntouched, fail, pass } from "./_harness.js";

// The task says to append without changing the existing content, which is mechanically enforceable:
// the candidate must start with the frozen source byte-for-byte. Checking that a handful of original
// lines still appear somewhere would accept a breaking statement inserted inside an existing
// function, and the existing functions were never executed.
const source = read("src/lib.js");
const original = baseline("src/lib.js");
if (!source.startsWith(original)) {
  fail("existing content changed: the addition must be appended without modifying what was there");
}
if (source.length === original.length) fail("nothing was appended");

const lib = await loadModule("src/lib.js");
if (typeof lib.median !== "function") fail("median is not exported");
if (lib.median([3, 1, 2]) !== 2) fail(`median([3,1,2]) is ${lib.median([3, 1, 2])}, expected 2`);
if (lib.median([4, 1, 2, 3]) !== 2.5) {
  fail(`median([4,1,2,3]) is ${lib.median([4, 1, 2, 3])}, expected 2.5`);
}
if (lib.median([]) !== null) fail("median of an empty array must be null");

// The existing functions must still behave as they did.
if (lib.lastIndex([1, 2, 3]) !== 3) fail("lastIndex's existing behaviour changed");
if (lib.sum([1, 2, 3]) !== 6) fail("sum's existing behaviour changed");
if (JSON.stringify(lib.tally(["a", "a", "b"])) !== JSON.stringify({ a: 2, b: 1 })) {
  fail("tally's existing behaviour changed");
}
expectUntouched("src/report.js");
pass("median appended with the existing module content unchanged");
