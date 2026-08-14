import { csvRows, expectExact, expectOnlyChanged, pass } from "./_harness.js";

expectOnlyChanged(["TOTALS.md"]);

// The task says the file contains the rows and nothing else except a final total, so the complete
// output is derived from the frozen source and compared exactly. A line-by-line helper that strips
// blank lines and trailing whitespace would not actually enforce "nothing else".
const rows = csvRows("inventory.csv", Number);
const total = rows.reduce((sum, [, qty]) => sum + qty, 0);
const expected = `${rows.map(([item, qty]) => `${item}: ${qty}`).join("\n")}\nTotal: ${total}\n`;

expectExact("TOTALS.md", expected);
pass(`TOTALS.md is exactly the inventory rows and Total: ${total}`);
