import {
  read, baseline, loadModule, expectTaskChanges, expectMatchesReference, seededNumbers, fail, pass,
} from "./_harness.js";

// A semantic task with a structural constraint. The append-only requirement is enforced exactly;
// median's general behaviour is checked against a deterministic reference, because a function that
// hardcodes three sampled cases would otherwise pass while being wrong everywhere else.
expectTaskChanges("t05-add-function");

const source = read("src/lib.js");
const original = baseline("src/lib.js");
if (!source.startsWith(original)) {
  fail("existing content changed: the addition must be appended without modifying what was there");
}
if (source.length === original.length) fail("nothing was appended");

const lib = await loadModule("src/lib.js");
if (typeof lib.median !== "function") fail("median is not exported");

const reference = (numbers) => {
  if (!numbers.length) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

// The declared domain: empty, singletons, pairs, sorted and reversed runs, duplicates, negatives,
// and seeded contents across many lengths.
const domain = [[], [7], [-3], [1, 2], [2, 1], [5, 5], [-1, 1]];
for (let length = 1; length <= 24; length += 1) {
  const ascending = Array.from({ length }, (_, i) => i + 1);
  domain.push(ascending, [...ascending].reverse());
  domain.push(Array.from({ length }, () => 4));
  domain.push(Array.from({ length }, (_, i) => -i));
}
for (const length of [2, 3, 6, 9, 15, 32, 64, 101]) {
  domain.push(seededNumbers(20260815 + length, length));
}
// The task says "numbers", not integers, so the domain includes fractional values and the halving
// that even-length input requires.
domain.push([0.5], [1.5, 2.5], [0.1, 0.2, 0.3], [-1.5, 2.25], [1.25, 1.75, 2.5, 3.5]);
for (const length of [4, 7, 12]) {
  domain.push(seededNumbers(20260815 + length, length).map((value) => value / 4));
}

expectMatchesReference("median", (numbers) => lib.median(numbers), reference, domain);

// The existing functions must still behave as they did.
if (lib.lastIndex([1, 2, 3]) !== 3) fail("lastIndex's existing behaviour changed");
if (lib.sum([1, 2, 3]) !== 6) fail("sum's existing behaviour changed");
if (JSON.stringify(lib.tally(["a", "a", "b"])) !== JSON.stringify({ a: 2, b: 1 })) {
  fail("tally's existing behaviour changed");
}
pass(`median matches the reference across ${domain.length} inputs, appended without other change`);
