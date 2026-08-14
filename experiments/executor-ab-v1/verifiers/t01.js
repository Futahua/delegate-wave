import { requireFile, read, lines, fail, pass } from "./_harness.js";

// Derived from the source so an answer that invents rows or quantities cannot pass.
const rows = lines(read("inventory.csv")).slice(1).map((row) => {
  const [item, qty] = row.split(",");
  return [item.trim(), Number(qty)];
});
const expectedTotal = rows.reduce((total, [, qty]) => total + qty, 0);

const got = lines(requireFile("TOTALS.md"));
const itemLines = got.filter((line) => !/^total\s*:/i.test(line.trim()));
if (itemLines.length !== rows.length) {
  fail(`expected ${rows.length} item lines, got ${itemLines.length}`);
}
for (const [item, qty] of rows) {
  if (!itemLines.some((line) => new RegExp(`^${item}\\s*:\\s*${qty}$`).test(line.trim()))) {
    fail(`no line '${item}: ${qty}'`);
  }
}

const total = got.find((line) => /^total\s*:/i.test(line.trim()));
if (!total) fail("no 'Total:' line");
const value = Number(total.split(":")[1].trim());
if (value !== expectedTotal) fail(`Total is ${value}, expected ${expectedTotal}`);
pass(`TOTALS.md lists exactly the inventory rows and totals ${expectedTotal}`);
