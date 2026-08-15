// The task corpus for pro-scaffold-v1.
//
// Each task ships a wrong implementation and a correct test suite. The test file is a protected
// path, so a candidate that edits it is rejected by delegate-wave's own policy rather than by
// anything this experiment does -- the worker has to fix the implementation.
//
// The first corpus was too easy: Pro at `high` passed everything on the first attempt, which makes
// A, B and C indistinguishable. These are chosen instead along axes where frontier models are
// documented to still fail -- compensated floating-point summation, Unicode grapheme segmentation,
// calendar duration arithmetic -- plus an asymptotic wall and a misdirected bug, where a
// plausible-looking fix still does not pass.
//
// Every suite is proven satisfiable by a reference solution in reference.mjs before any model
// budget is spent; see verify-solvable.mjs.

export const TASKS = [
  {
    // A correct-looking solution is quadratic and never finishes the large case.
    id: "range-index",
    goal: "The tests in test/rangeindex.test.js are failing. Fix src/rangeindex.js so every test "
      + "passes, including the large-input test, which must complete quickly. Do not modify the tests.",
    validation: ["node --test test/rangeindex.test.js"],
    protectedPaths: ["test/"],
    files: {
      "src/rangeindex.js": `// An index answering "which intervals cover this point" for many queries.
//
// Intervals are [start, end) half-open, given once at construction. Queries are then answered
// repeatedly, so the query path is what has to be fast.
export class RangeIndex {
  constructor(intervals) {
    this.intervals = [...intervals];
  }

  // Every interval covering the point, by original index, ascending.
  covering(point) {
    const hits = [];
    for (let i = 0; i < this.intervals.length; i += 1) {
      const [start, end] = this.intervals[i];
      if (start <= point && point < end) hits.push(i);
    }
    return hits;
  }

  // How many intervals cover the point.
  countCovering(point) {
    return this.covering(point).length;
  }
}
`,
      "test/rangeindex.test.js": `import assert from "node:assert/strict";
import test from "node:test";
import { RangeIndex } from "../src/rangeindex.js";

test("reports covering intervals by original index", () => {
  const index = new RangeIndex([[0, 10], [5, 6], [20, 30]]);
  assert.deepEqual(index.covering(5), [0, 1]);
  assert.deepEqual(index.covering(6), [0]);
  assert.deepEqual(index.covering(25), [2]);
  assert.deepEqual(index.covering(15), []);
});

test("half-open bounds", () => {
  const index = new RangeIndex([[1, 3]]);
  assert.deepEqual(index.covering(1), [0]);
  assert.deepEqual(index.covering(3), []);
});

test("zero-length intervals cover nothing", () => {
  assert.deepEqual(new RangeIndex([[4, 4]]).covering(4), []);
});

// The query path must not be linear in the number of intervals. 150k intervals against 30k queries
// is 4.5e9 comparisons per scan; an ordered structure answers the same questions in milliseconds.
test("answers many queries over many intervals quickly", () => {
  const intervals = [];
  for (let i = 0; i < 150000; i += 1) intervals.push([i, i + 3]);
  const index = new RangeIndex(intervals);

  const started = Date.now();
  let total = 0;
  // Offset off the boundary so every sampled point is covered by exactly three intervals.
  for (let q = 0; q < 30000; q += 1) total += index.countCovering((q * 5) + 2);
  const elapsed = Date.now() - started;

  assert.equal(total, 90000, "each sampled point is covered by three intervals");
  assert.ok(elapsed < 3000, \`30k queries took \${elapsed}ms; the query path is too slow\`);
});
`,
    },
  },
  {
    // The failing assertion names the renderer; the defect is in the tokenizer it depends on.
    id: "template-render",
    goal: "The tests in test/render.test.js are failing. Fix the implementation so every test "
      + "passes. Do not modify the tests.",
    validation: ["node --test test/render.test.js"],
    protectedPaths: ["test/"],
    files: {
      "src/tokenize.js": `// Split a template into literal and placeholder tokens.
//
// A placeholder is {name}. A doubled brace {{ or }} is an escaped literal brace.
export function tokenize(template) {
  const tokens = [];
  let literal = "";
  for (let i = 0; i < template.length; i += 1) {
    const char = template[i];
    if (char === "{") {
      const close = template.indexOf("}", i);
      if (close === -1) { literal += char; continue; }
      if (literal) { tokens.push({ type: "literal", value: literal }); literal = ""; }
      tokens.push({ type: "placeholder", name: template.slice(i + 1, close) });
      i = close;
      continue;
    }
    literal += char;
  }
  if (literal) tokens.push({ type: "literal", value: literal });
  return tokens;
}
`,
      "src/render.js": `import { tokenize } from "./tokenize.js";

// Fill a template from values. A missing key renders as an empty string.
export function render(template, values) {
  return tokenize(template)
    .map((token) => (token.type === "literal" ? token.value : String(values[token.name] ?? "")))
    .join("");
}
`,
      "test/render.test.js": `import assert from "node:assert/strict";
import test from "node:test";
import { render } from "../src/render.js";

test("substitutes placeholders", () => {
  assert.equal(render("Hello {name}!", { name: "world" }), "Hello world!");
});

test("a missing key renders empty", () => {
  assert.equal(render("[{missing}]", {}), "[]");
});

// Doubled braces are escaped literals, not placeholders.
test("escaped braces render as single braces", () => {
  assert.equal(render("{{literal}}", { literal: "no" }), "{literal}");
});

test("an escaped brace around a real placeholder", () => {
  assert.equal(render("{{{name}}}", { name: "x" }), "{x}");
});

test("an unclosed brace is literal", () => {
  assert.equal(render("a { b", {}), "a { b");
});

test("adjacent placeholders", () => {
  assert.equal(render("{a}{b}", { a: "1", b: "2" }), "12");
});

test("a value that looks like a placeholder is not re-expanded", () => {
  assert.equal(render("{a}", { a: "{b}", b: "no" }), "{b}");
});
`,
    },
  },
  {
    // Naive accumulation loses the small terms entirely; Kahan is not sufficient for the last case.
    id: "compensated-sum",
    goal: "The tests in test/sum.test.js are failing. Fix src/sum.js so every test passes. "
      + "Do not modify the tests.",
    validation: ["node --test test/sum.test.js"],
    protectedPaths: ["test/"],
    files: {
      "src/sum.js": `// Sum floating-point values without losing the small terms to rounding.
export function preciseSum(values) {
  let total = 0;
  for (const value of values) total += value;
  return total;
}
`,
      "test/sum.test.js": `import assert from "node:assert/strict";
import test from "node:test";
import { preciseSum } from "../src/sum.js";

test("sums an ordinary list", () => {
  assert.equal(preciseSum([1, 2, 3]), 6);
});

test("empty sums to zero", () => {
  assert.equal(preciseSum([]), 0);
});

// Naive accumulation drifts; the exact answer is representable.
test("repeated tenths sum exactly", () => {
  assert.equal(preciseSum(Array(10).fill(0.1)), 1);
});

// The small term is swallowed by the large one under naive accumulation.
test("a small term survives a large one", () => {
  assert.equal(preciseSum([1e16, 1, -1e16]), 1);
});

// The classic case where plain Kahan compensation still returns 0: the compensation term itself
// is lost because the running total is smaller in magnitude than the incoming value.
test("compensation survives a term larger than the running total", () => {
  assert.equal(preciseSum([1, 1e100, 1, -1e100]), 2);
});

test("order does not change the result", () => {
  const values = [1e100, 1, -1e100, 1];
  assert.equal(preciseSum(values), 2);
});
`,
    },
  },
  {
    // Code points are not characters. Combining marks, surrogate pairs and ZWJ sequences all break
    // the obvious implementation.
    id: "grapheme-text",
    goal: "The tests in test/text.test.js are failing. Fix src/text.js so every test passes. "
      + "Do not modify the tests.",
    validation: ["node --test test/text.test.js"],
    protectedPaths: ["test/"],
    files: {
      "src/text.js": `// User-perceived character operations.
//
// "Character" here means what a reader sees, not a UTF-16 code unit and not a code point.
export function characterLength(text) {
  return text.length;
}

export function reverseText(text) {
  return text.split("").reverse().join("");
}

// The first \`count\` characters.
export function truncate(text, count) {
  return text.slice(0, count);
}
`,
      "test/text.test.js": `import assert from "node:assert/strict";
import test from "node:test";
import { characterLength, reverseText, truncate } from "../src/text.js";

test("plain ASCII", () => {
  assert.equal(characterLength("abc"), 3);
  assert.equal(reverseText("abc"), "cba");
  assert.equal(truncate("abcdef", 3), "abc");
});

// A base letter plus a combining acute accent is ONE character to a reader.
const combined = "e\\u0301"; // é

test("a combining mark does not add a character", () => {
  assert.equal(characterLength(\`caf\${combined}\`), 4);
});

test("reversing keeps a combining mark on its base", () => {
  assert.equal(reverseText(\`ab\${combined}\`), \`\${combined}ba\`);
});

test("truncation does not split a combining mark from its base", () => {
  assert.equal(truncate(\`x\${combined}y\`, 2), \`x\${combined}\`);
});

// Astral characters occupy two UTF-16 code units.
test("an astral character is one character", () => {
  assert.equal(characterLength("a😀b"), 3);
  assert.equal(reverseText("a😀b"), "b😀a");
  assert.equal(truncate("a😀b", 2), "a😀");
});

// A ZWJ sequence renders as a single glyph.
const family = "\\u{1F468}\\u200D\\u{1F469}\\u200D\\u{1F467}";

test("a zero-width-joiner sequence is one character", () => {
  assert.equal(characterLength(family), 1);
  assert.equal(truncate(\`\${family}!\`, 1), family);
});

// A flag is two regional indicators.
test("a regional indicator pair is one character", () => {
  assert.equal(characterLength("\\u{1F1FA}\\u{1F1F8}"), 1);
});
`,
    },
  },
  {
    // Calendar arithmetic is not duration arithmetic. Month-end clamping and leap days both break
    // the obvious implementation.
    id: "calendar-duration",
    goal: "The tests in test/calendar.test.js are failing. Fix src/calendar.js so every test "
      + "passes. Do not modify the tests.",
    validation: ["node --test test/calendar.test.js"],
    protectedPaths: ["test/"],
    files: {
      "src/calendar.js": `// Calendar arithmetic on plain ISO dates, "YYYY-MM-DD", all in UTC.
//
// Adding a month means the same day-of-month in the next month, CLAMPED to that month's last day
// when it does not exist. Adding months must never silently roll into the following month.
export function addMonths(iso, months) {
  const date = new Date(\`\${iso}T00:00:00Z\`);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
}

// Whole months between two dates, truncated toward zero.
export function monthsBetween(fromIso, toIso) {
  const from = new Date(\`\${fromIso}T00:00:00Z\`);
  const to = new Date(\`\${toIso}T00:00:00Z\`);
  return (to.getUTCFullYear() - from.getUTCFullYear()) * 12
    + (to.getUTCMonth() - from.getUTCMonth());
}
`,
      "test/calendar.test.js": `import assert from "node:assert/strict";
import test from "node:test";
import { addMonths, monthsBetween } from "../src/calendar.js";

test("adds an ordinary month", () => {
  assert.equal(addMonths("2026-01-15", 1), "2026-02-15");
  assert.equal(addMonths("2026-01-15", 12), "2027-01-15");
});

// January 31 plus one month is the last day of February, not March 3.
test("month-end clamps instead of rolling over", () => {
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonths("2026-03-31", 1), "2026-04-30");
});

test("clamping respects leap years", () => {
  assert.equal(addMonths("2024-01-31", 1), "2024-02-29");
  assert.equal(addMonths("2024-02-29", 12), "2025-02-28");
});

test("subtracting months clamps too", () => {
  assert.equal(addMonths("2026-03-31", -1), "2026-02-28");
  assert.equal(addMonths("2026-01-31", -2), "2025-11-30");
});

// A whole month has not elapsed until the day-of-month is reached.
test("whole months are truncated, not rounded", () => {
  assert.equal(monthsBetween("2026-01-15", "2026-02-14"), 0);
  assert.equal(monthsBetween("2026-01-15", "2026-02-15"), 1);
  assert.equal(monthsBetween("2026-01-15", "2026-03-14"), 1);
});

test("whole months backwards are truncated toward zero", () => {
  assert.equal(monthsBetween("2026-03-15", "2026-01-16"), -1);
  assert.equal(monthsBetween("2026-03-15", "2026-01-15"), -2);
});

test("month-end to month-end counts as a whole month", () => {
  assert.equal(monthsBetween("2026-01-31", "2026-02-28"), 1);
});
`,
    },
  },
];
