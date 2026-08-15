// The "stopped too early" solutions.
//
// This tier's whole premise is that each task has an obvious defect which is real, fixable, and
// insufficient. That premise is a claim about the corpus, so it gets checked the same way
// satisfiability does: each entry below is a competent fix to the visible problem ONLY, and the
// suite must still fail against it. If one of these passes, the task is not measuring engagement
// depth -- it is just an ordinary bug fix wearing a costume.

const BACKSLASH = String.fromCharCode(92);

export const PARTIAL_HARD = {
  // Sees the nested key scan, removes it, submits. The config is still parsed per record.
  "log-pipeline": {
    "src/pipeline.js": `import { loadConfig } from "./config.js";

export function summarise(records, configText) {
  const totals = {};
  for (const record of records) {
    const config = loadConfig(configText);
    const hostPattern = new RegExp(config.hostPattern);
    if (!hostPattern.test(record.host)) continue;
    const bucket = \`\${Math.floor(record.status / 100)}xx\`;
    totals[bucket] = (totals[bucket] ?? 0) + record.bytes;
  }
  return totals;
}
`,
  },

  // Fixes the reported encode bug correctly and makes decode symmetric -- which silently breaks
  // every line written before escaping existed.
  "roundtrip-codec": {
    "src/codec.js": [
      "export function encodeRecord(fields) {",
      "  return fields",
      `    .map((field) => field.split("${BACKSLASH}${BACKSLASH}").join("${BACKSLASH}${BACKSLASH}${BACKSLASH}${BACKSLASH}").split("|").join("${BACKSLASH}${BACKSLASH}|"))`,
      '    .join("|");',
      "}",
      "",
      "export function decodeRecord(line) {",
      "  const fields = [];",
      '  let current = "";',
      "  let escaped = false;",
      "  for (const char of line) {",
      "    if (escaped) { current += char; escaped = false; continue; }",
      `    if (char === "${BACKSLASH}${BACKSLASH}") { escaped = true; continue; }`,
      '    if (char === "|") { fields.push(current); current = ""; continue; }',
      "    current += char;",
      "  }",
      "  fields.push(current);",
      "  return fields;",
      "}",
      "",
    ].join("\n"),
  },

  // Fixes the stampede by sharing the in-flight promise, and never clears it on rejection, so the
  // first transient failure is remembered forever.
  "async-cache": {
    "src/cache.js": `export class AsyncCache {
  constructor(loader) {
    this.loader = loader;
    this.values = new Map();
    this.inFlight = new Map();
  }

  async get(key) {
    if (this.values.has(key)) return this.values.get(key);
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const promise = (async () => {
      const value = await this.loader(key);
      this.values.set(key, value);
      return value;
    })();
    this.inFlight.set(key, promise);
    return promise;
  }
}
`,
  },
};
