import { requireFile, read, lines, fail, pass } from "./_harness.js";

// Derived from the source rather than hardcoded: a verifier that accepts invented prices would pass
// an answer that never read catalog.csv at all.
const catalog = new Map(lines(read("catalog.csv")).slice(1).map((row) => {
  const [item, price] = row.split(",");
  return [item.trim(), Number(price)];
}));
const expected = [...catalog.entries()]
  .filter(([, price]) => price < 5.00)
  .sort((a, b) => a[1] - b[1]);

const got = lines(requireFile("CHEAP.md")).map((line) => {
  const match = line.trim().match(/^(\S+)\s+([\d.]+)$/);
  if (!match) fail(`line is not '<item> <price>': ${line}`);
  return [match[1], Number(match[2])];
});

if (got.length !== expected.length) {
  fail(`expected ${expected.length} items below 5.00, got ${got.length}`);
}
for (let i = 0; i < expected.length; i += 1) {
  const [wantItem, wantPrice] = expected[i];
  const [gotItem, gotPrice] = got[i];
  if (gotItem !== wantItem) fail(`position ${i + 1}: expected ${wantItem}, got ${gotItem}`);
  // The reported price must be the catalog price, not an invented value that merely sorts.
  if (Math.abs(gotPrice - wantPrice) > 0.0001) {
    fail(`${gotItem}: price ${gotPrice} does not match catalog price ${wantPrice}`);
  }
}
pass("CHEAP.md filters below 5.00, reports catalog prices, and sorts ascending");
