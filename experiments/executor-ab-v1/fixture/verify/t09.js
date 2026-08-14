import { requireFile, lines, fail, pass } from "./_harness.js";

// flange has no price and bracket has no qty, so neither may appear in an inner join.
const got = lines(requireFile("REPORT.md"));
const expected = { widget: [12, 3.50, 42.00], gadget: [7, 7.25, 50.75], sprocket: [20, 4.99, 99.80] };
if (got.length !== 3) fail(`expected 3 joined rows, got ${got.length}`);
for (const [item, [qty, price, total]] of Object.entries(expected)) {
  const line = got.find((l) => l.trim().startsWith(item));
  if (!line) fail(`missing ${item}`);
  const numbers = (line.match(/[\d.]+/g) ?? []).map(Number);
  if (!numbers.includes(qty)) fail(`${item}: qty ${qty} not present`);
  if (!numbers.includes(price)) fail(`${item}: price ${price} not present`);
  if (!numbers.some((n) => Math.abs(n - total) < 0.005)) fail(`${item}: total ${total} not present`);
}
if (got.some((l) => /flange|bracket/.test(l))) fail("an item missing from one source was included");
pass("REPORT.md joins on item with correct totals");
