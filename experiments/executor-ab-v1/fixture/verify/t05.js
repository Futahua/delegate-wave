import { fail, pass } from "./_harness.js";

const lib = await import(`../src/lib.js?t=${Date.now()}`);
if (typeof lib.median !== "function") fail("median is not exported");
if (lib.median([3, 1, 2]) !== 2) fail(`median([3,1,2]) is ${lib.median([3, 1, 2])}, expected 2`);
if (lib.median([4, 1, 2, 3]) !== 2.5) {
  fail(`median([4,1,2,3]) is ${lib.median([4, 1, 2, 3])}, expected 2.5`);
}
if (lib.median([]) !== null) fail("median of an empty array must be null");
if (lib.sum([1, 2, 3]) !== 6) fail("existing functions must be unchanged");
pass("median added with correct even-length and empty handling");
