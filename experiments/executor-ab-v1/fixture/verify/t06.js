import { fail, pass } from "./_harness.js";

const lib = await import(`../src/lib.js?t=${Date.now()}`);
if (typeof lib.countItems !== "function") fail("countItems is not exported");
if (lib.tally !== undefined) fail("the old name tally must no longer be exported");
if (JSON.stringify(lib.countItems(["a", "a", "b"])) !== JSON.stringify({ a: 2, b: 1 })) {
  fail("countItems does not preserve tally's behaviour");
}
if (lib.sum([1, 2, 3]) !== 6) fail("existing functions must be unchanged");
pass("tally renamed to countItems with behaviour preserved");
