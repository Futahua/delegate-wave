import { expectTransformed, expectTaskChanges, loadModule, fail, pass } from "./_harness.js";

expectTaskChanges("t06-rename-consistent");

// A rename is an exact transformation: every occurrence of the identifier changes and nothing else
// does. Comparing behaviour alone would accept a worker that also "helpfully" fixed the lastIndex
// bug, which the task's preserve-existing-behaviour requirement forbids.
const rename = (body) => body.replace(/\btally\b/g, "countItems");
expectTransformed("src/lib.js", rename);
expectTransformed("src/report.js", rename);

// Behaviour must survive the rename across both modules.
const lib = await loadModule("src/lib.js");
if (typeof lib.countItems !== "function") fail("countItems is not exported");
if (lib.tally !== undefined) fail("the old name tally must no longer be exported");
if (JSON.stringify(lib.countItems(["a", "a", "b"])) !== JSON.stringify({ a: 2, b: 1 })) {
  fail("countItems does not preserve tally's behaviour");
}
const downstream = await loadModule("src/report.js");
if (JSON.stringify(downstream.summarize(["a", "a", "b"])) !== JSON.stringify({ distinct: 2, total: 3 })) {
  fail("report.summarize is broken after the rename");
}
if (JSON.stringify(downstream.busiest(["a", "a", "b"])) !== JSON.stringify(["a", 2])) {
  fail("report.busiest is broken after the rename");
}
pass("tally renamed to countItems across both modules with nothing else changed");
