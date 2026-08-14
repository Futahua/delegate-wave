import { requireFile, lines, fail, pass } from "./_harness.js";

const got = lines(requireFile("TOTALS.md"));
const expectedItems = [["widget", 12], ["gadget", 7], ["sprocket", 20], ["flange", 5]];
for (const [item, qty] of expectedItems) {
  if (!got.some((l) => new RegExp(`^${item}\\s*:\\s*${qty}$`).test(l.trim()))) {
    fail(`no line '${item}: ${qty}'`);
  }
}
const total = got.find((l) => /^total\s*:/i.test(l.trim()));
if (!total) fail("no 'Total:' line");
const value = Number(total.split(":")[1].trim());
if (value !== 44) fail(`Total is ${value}, expected 44`);
pass("TOTALS.md lists each item and totals 44");
