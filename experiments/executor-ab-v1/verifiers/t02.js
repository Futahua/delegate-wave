import { csvRows, expectExact, expectOnlyChanged, pass } from "./_harness.js";

expectOnlyChanged(["CHEAP.md"]);

// Derived from the FROZEN catalog, not the candidate's. Reading the candidate would let a worker
// rewrite catalog.csv and then produce a matching answer, so the verifier would validate the
// worker's altered problem instead of the preregistered one.
const expected = `${csvRows("catalog.csv", Number)
  .filter(([, price]) => price < 5.00)
  .sort((a, b) => a[1] - b[1])
  .map(([item, price]) => `${item} ${price.toFixed(2)}`)
  .join("\n")}\n`;

expectExact("CHEAP.md", expected);
pass("CHEAP.md is exactly the sub-5.00 catalog items in ascending price order");
