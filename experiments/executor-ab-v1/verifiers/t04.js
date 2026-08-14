import {
  read, baseline, loadModule, expectTaskChanges, expectMatchesReference, seededNumbers, fail, pass,
} from "./_harness.js";

// A semantic task: the goal states correctness for non-empty arrays generally, which two examples
// cannot establish -- `items.length === 1 ? 0 : 2` would satisfy them and be wrong everywhere else.
// Behaviour is therefore checked against a deterministic reference over a broad fixed domain, while
// the unauthorized bytes are protected structurally.
expectTaskChanges("t04-bugfix-off-by-one");

// Everything except lastIndex's body must be byte-identical to the frozen source.
const source = read("src/lib.js");
const original = baseline("src/lib.js");
const [before, after] = original.split("  return items.length;\n");
if (after === undefined) fail("the frozen baseline no longer contains the expected buggy line");
if (!source.startsWith(before)) fail("source before lastIndex's body was modified");
if (!source.endsWith(after)) fail("source after lastIndex's body was modified");

const lib = await loadModule("src/lib.js");

// The declared domain: every length from 1 to 40, plus seeded contents at assorted lengths.
const domain = [];
for (let length = 1; length <= 40; length += 1) {
  domain.push(Array.from({ length }, (_, i) => i));
}
for (const length of [1, 2, 3, 5, 8, 13, 21, 34, 55, 100]) {
  domain.push(seededNumbers(20260815 + length, length));
}
domain.push(["only"], ["a", "b"], [null, undefined, 0], [{}, {}, {}, {}]);

expectMatchesReference("lastIndex", (items) => lib.lastIndex(items), (items) => items.length - 1, domain);

// The neighbouring functions must still behave as they did.
if (lib.sum([1, 2, 3]) !== 6) fail("sum was altered");
if (JSON.stringify(lib.tally(["a", "a", "b"])) !== JSON.stringify({ a: 2, b: 1 })) {
  fail("tally was altered");
}
pass(`lastIndex matches the reference across ${domain.length} inputs with nothing else changed`);
