import { read, fail, pass, loadModule } from "./_harness.js";

const lib = await loadModule("src/lib.js");
if (typeof lib.countItems !== "function") fail("countItems is not exported");
if (lib.tally !== undefined) fail("the old name tally must no longer be exported");
if (JSON.stringify(lib.countItems(["a", "a", "b"])) !== JSON.stringify({ a: 2, b: 1 })) {
  fail("countItems does not preserve tally's behaviour");
}
if (lib.sum([1, 2, 3]) !== 6) fail("existing functions must be unchanged");

// The rename is multi-site: src/report.js imports and calls the old name, so a rename that updates
// only the definition leaves a module that no longer loads.
const downstream = await loadModule("src/report.js");
if (JSON.stringify(downstream.summarize(["a", "a", "b"])) !== JSON.stringify({ distinct: 2, total: 3 })) {
  fail("report.summarize is broken after the rename");
}
if (JSON.stringify(downstream.busiest(["a", "a", "b"])) !== JSON.stringify(["a", 2])) {
  fail("report.busiest is broken after the rename");
}
if (/\btally\b/.test(read("src/report.js"))) {
  fail("src/report.js still references the old name tally");
}
pass("tally renamed to countItems across every source reference");
