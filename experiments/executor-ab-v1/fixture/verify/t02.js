import { requireFile, lines, fail, pass } from "./_harness.js";

// widget 3.50, sprocket 4.99 and bracket 2.00 are below 5.00; gadget 7.25 is not.
const got = lines(requireFile("CHEAP.md"));
const prices = got.map((l) => {
  const match = l.trim().match(/^(\S+)\s+([\d.]+)$/);
  if (!match) fail(`line is not '<item> <price>': ${l}`);
  return [match[1], Number(match[2])];
});
if (prices.length !== 3) fail(`expected 3 items below 5.00, got ${prices.length}`);
if (prices.some(([item]) => item === "gadget")) fail("gadget (7.25) must be excluded");
const names = prices.map(([name]) => name);
for (const want of ["widget", "sprocket", "bracket"]) {
  if (!names.includes(want)) fail(`missing ${want}`);
}
const values = prices.map(([, price]) => price);
for (let i = 1; i < values.length; i += 1) {
  if (values[i] < values[i - 1]) fail("prices are not ascending");
}
pass("CHEAP.md filters below 5.00 and sorts ascending");
