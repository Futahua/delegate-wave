import { requireFile, csvRows, lines, fail, pass } from "./_harness.js";

// Derived from the frozen source: an answer that invents rows, omits one, duplicates one, or places
// the total anywhere but last cannot pass.
const rows = csvRows("inventory.csv", Number);
const expectedTotal = rows.reduce((total, [, qty]) => total + qty, 0);

const got = lines(requireFile("TOTALS.md"));
if (got.length !== rows.length + 1) {
  fail(`expected ${rows.length} item lines and one total, got ${got.length} lines`);
}

// The item lines must be exactly the inventory rows, in order.
for (let i = 0; i < rows.length; i += 1) {
  const [item, qty] = rows[i];
  const expected = `${item}: ${qty}`;
  if (got[i].trim() !== expected) {
    fail(`line ${i + 1}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got[i].trim())}`);
  }
}

// The goal states the total is the final line, so exactly one total may appear and it must be last.
const totals = got.filter((line) => /^total\s*:/i.test(line.trim()));
if (totals.length !== 1) fail(`expected exactly one 'Total:' line, got ${totals.length}`);
const last = got.at(-1).trim();
if (!/^total\s*:/i.test(last)) fail(`the final line is ${JSON.stringify(last)}, expected the total`);
const value = Number(last.split(":")[1].trim());
if (value !== expectedTotal) fail(`Total is ${value}, expected ${expectedTotal}`);

pass(`TOTALS.md lists exactly the inventory rows and ends with Total: ${expectedTotal}`);
