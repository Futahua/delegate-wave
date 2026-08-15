// Reference solutions for the hard tier. Used only to prove the suites are satisfiable; these never
// enter a task repository.

const BACKSLASH = String.fromCharCode(92);

export const REFERENCE_HARD = {
  "log-pipeline": {
    "src/pipeline.js": `import { loadConfig } from "./config.js";

// The config is parsed once and the pattern compiled once, outside the loop; accumulation is a
// direct property write rather than a scan of the keys already present.
export function summarise(records, configText) {
  const config = loadConfig(configText);
  const hostPattern = new RegExp(config.hostPattern);
  const totals = {};
  for (const record of records) {
    if (!hostPattern.test(record.host)) continue;
    const bucket = \`\${Math.floor(record.status / 100)}xx\`;
    totals[bucket] = (totals[bucket] ?? 0) + record.bytes;
  }
  return totals;
}
`,
  },

  "roundtrip-codec": {
    // Built from a character constant so no layer of quoting can mangle the escaping, which is the
    // entire subject of this task.
    "src/codec.js": [
      "// The escaped format is not distinguishable from the legacy one by inspection -- a backslash is",
      "// data in the old format and an escape in the new one -- so the encoder marks what it writes and",
      "// the decoder dispatches on that marker. Unmarked lines are legacy and split on every delimiter.",
      'const MARKER = "\\u0001";',
      "",
      "export function encodeRecord(fields) {",
      "  return MARKER + fields",
      `    .map((field) => field.split("${BACKSLASH}${BACKSLASH}").join("${BACKSLASH}${BACKSLASH}${BACKSLASH}${BACKSLASH}").split("|").join("${BACKSLASH}${BACKSLASH}|"))`,
      '    .join("|");',
      "}",
      "",
      "export function decodeRecord(line) {",
      '  if (!line.startsWith(MARKER)) return line.split("|");',
      "  const body = line.slice(MARKER.length);",
      "  const fields = [];",
      '  let current = "";',
      "  for (let i = 0; i < body.length; i += 1) {",
      "    const char = body[i];",
      `    if (char === "${BACKSLASH}${BACKSLASH}" && i + 1 < body.length) { current += body[i + 1]; i += 1; continue; }`,
      '    if (char === "|") { fields.push(current); current = ""; continue; }',
      "    current += char;",
      "  }",
      "  fields.push(current);",
      "  return fields;",
      "}",
      "",
    ].join("\n"),
  },

  "async-cache": {
    "src/cache.js": `// Share the in-flight promise so concurrent misses load once, and drop it however it settles so a
// rejection is never remembered.
export class AsyncCache {
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
    try {
      return await promise;
    } finally {
      this.inFlight.delete(key);
    }
  }
}
`,
  },
};
