import { fail, pass } from "./_harness.js";

const lib = await import(`../src/lib.js?t=${Date.now()}`);
if (lib.lastIndex([1, 2, 3]) !== 2) {
  fail(`lastIndex([1,2,3]) is ${lib.lastIndex([1, 2, 3])}, expected 2`);
}
if (lib.lastIndex(["only"]) !== 0) fail("lastIndex of a single-element array must be 0");
// The other exports must be untouched: a fix that breaks a neighbour is not a fix.
if (typeof lib.tally !== "function") fail("tally was removed");
if (lib.sum([1, 2, 3]) !== 6) fail("sum was altered");
if (JSON.stringify(lib.tally(["a", "a", "b"])) !== JSON.stringify({ a: 2, b: 1 })) {
  fail("tally was altered");
}
pass("lastIndex fixed without collateral change");
