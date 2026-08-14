import { csvRows, expectExact, pass } from "./_harness.js";

// Both sides of the join are derived from the frozen sources, and the required format is compared
// exactly. Searching each line for three numbers would accept 'widget 12 3.5 42', which omits the
// requested separators and the two-decimal total.
const quantities = new Map(csvRows("inventory.csv", Number));
const prices = new Map(csvRows("catalog.csv", Number));

const expected = `${[...quantities.entries()]
  .filter(([item]) => prices.has(item))
  .map(([item, qty]) => {
    const price = prices.get(item);
    return `${item} ${qty} x ${price.toFixed(2)} = ${(qty * price).toFixed(2)}`;
  })
  .join("\n")}\n`;

expectExact("REPORT.md", expected);
pass("REPORT.md is exactly the inner join in the requested format");
