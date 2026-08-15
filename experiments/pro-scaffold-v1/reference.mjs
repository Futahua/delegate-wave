// Reference solutions, used ONLY to prove each task's suite is satisfiable.
//
// These never enter a task repository. A test suite no implementation can pass would measure the
// experimenter's mistake rather than the model, so every suite must go green against these before
// any model budget is spent on it.

export const REFERENCE = {
  "range-index": {
    "src/rangeindex.js": `// Sweep the endpoints once, then answer each query by binary search.
export class RangeIndex {
  constructor(intervals) {
    this.intervals = [...intervals];
    // Every boundary where the covering set can change.
    const points = new Set();
    for (const [start, end] of this.intervals) {
      if (end <= start) continue;
      points.add(start);
      points.add(end);
    }
    this.boundaries = [...points].sort((a, b) => a - b);

    // Counts per segment, from a sweep over sorted starts and ends.
    const starts = this.intervals.filter(([s, e]) => e > s).map(([s]) => s).sort((a, b) => a - b);
    const ends = this.intervals.filter(([s, e]) => e > s).map(([, e]) => e).sort((a, b) => a - b);
    this.counts = new Array(this.boundaries.length).fill(0);
    let si = 0;
    let ei = 0;
    let open = 0;
    for (let i = 0; i < this.boundaries.length; i += 1) {
      const at = this.boundaries[i];
      while (si < starts.length && starts[si] <= at) { open += 1; si += 1; }
      while (ei < ends.length && ends[ei] <= at) { open -= 1; ei += 1; }
      this.counts[i] = open;
    }
  }

  // The index of the last boundary <= point, or -1.
  segmentFor(point) {
    let lo = 0;
    let hi = this.boundaries.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.boundaries[mid] <= point) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found;
  }

  covering(point) {
    const hits = [];
    for (let i = 0; i < this.intervals.length; i += 1) {
      const [start, end] = this.intervals[i];
      if (start <= point && point < end) hits.push(i);
    }
    return hits;
  }

  countCovering(point) {
    const at = this.segmentFor(point);
    return at === -1 ? 0 : this.counts[at];
  }
}
`,
  },

  "template-render": {
    "src/tokenize.js": `// Doubled braces are escaped literals and must be consumed before placeholder scanning.
export function tokenize(template) {
  const tokens = [];
  let literal = "";
  const flush = () => { if (literal) { tokens.push({ type: "literal", value: literal }); literal = ""; } };

  for (let i = 0; i < template.length; i += 1) {
    const char = template[i];
    if (char === "{" && template[i + 1] === "{") { literal += "{"; i += 1; continue; }
    if (char === "}" && template[i + 1] === "}") { literal += "}"; i += 1; continue; }
    if (char === "{") {
      const close = template.indexOf("}", i + 1);
      if (close === -1) { literal += char; continue; }
      flush();
      tokens.push({ type: "placeholder", name: template.slice(i + 1, close) });
      i = close;
      continue;
    }
    literal += char;
  }
  flush();
  return tokens;
}
`,
  },

  "compensated-sum": {
    "src/sum.js": `// Neumaier compensation: plain Kahan loses the correction when the incoming value is larger in
// magnitude than the running total, which is exactly the [1, 1e100, 1, -1e100] case.
export function preciseSum(values) {
  let total = 0;
  let compensation = 0;
  for (const value of values) {
    const next = total + value;
    compensation += Math.abs(total) >= Math.abs(value)
      ? (total - next) + value
      : (value - next) + total;
    total = next;
  }
  return total + compensation;
}
`,
  },

  "grapheme-text": {
    "src/text.js": `// Grapheme clusters are what a reader counts. Intl.Segmenter knows the rules; hand-rolled
// code-point logic does not handle ZWJ sequences or regional indicator pairs.
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const graphemes = (text) => [...segmenter.segment(text)].map((s) => s.segment);

export function characterLength(text) {
  return graphemes(text).length;
}

export function reverseText(text) {
  return graphemes(text).reverse().join("");
}

export function truncate(text, count) {
  return graphemes(text).slice(0, count).join("");
}
`,
  },

  "calendar-duration": {
    "src/calendar.js": `// Calendar arithmetic, clamping to the target month's last day rather than rolling over.
const parse = (iso) => iso.split("-").map(Number);
const lastDayOf = (year, month) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
const format = (year, month, day) =>
  \`\${String(year).padStart(4, "0")}-\${String(month + 1).padStart(2, "0")}-\${String(day).padStart(2, "0")}\`;

export function addMonths(iso, months) {
  const [year, month, day] = parse(iso);
  const total = (year * 12) + (month - 1) + months;
  const targetYear = Math.floor(total / 12);
  const targetMonth = total - (targetYear * 12);
  return format(targetYear, targetMonth, Math.min(day, lastDayOf(targetYear, targetMonth)));
}

export function monthsBetween(fromIso, toIso) {
  const [fy, fm, fd] = parse(fromIso);
  const [ty, tm, td] = parse(toIso);
  let months = ((ty - fy) * 12) + (tm - fm);
  if (months > 0) {
    // Not a whole month until the day-of-month is reached, allowing for clamping at month end.
    const clamped = Math.min(fd, lastDayOf(ty, tm - 1));
    if (td < clamped) months -= 1;
  } else if (months < 0) {
    const clamped = Math.min(fd, lastDayOf(ty, tm - 1));
    if (td > clamped) months += 1;
  }
  return months;
}
`,
  },
};
