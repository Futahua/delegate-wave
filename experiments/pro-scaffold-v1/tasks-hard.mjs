// A harder tier, built after Pro at `high` passed the whole first corpus on first attempt.
//
// These target the failure mode the FrontierSWE authors report rather than raw algorithmic
// difficulty: agents "decide to submit solutions very early... due to overconfidence in their wrong
// solutions", and they "misdiagnose performance bottlenecks, implementing ineffective
// optimizations". Each task therefore has an OBVIOUS defect that is real, fixable, and insufficient,
// plus a second one that only shows if the worker keeps going.
//
// A model that fixes the visible thing and submits fails. That is the whole point: it measures
// engagement depth, which is exactly what a first-request scaffold is claimed to change.
//
// Proven satisfiable and proven broken by verify-solvable.mjs, same as the first tier.

export const HARD_TASKS = [
  {
    // The nested loop is real and worth fixing, and fixing only it leaves the code far over budget:
    // the dominant cost is a regex recompiled per record and a config re-parsed per record.
    id: "log-pipeline",
    goal: "test/pipeline.test.js is failing: the pipeline is too slow. Make every test pass. "
      + "Do not modify the tests.",
    validation: ["node --test test/pipeline.test.js"],
    protectedPaths: ["test/"],
    files: {
      "src/pipeline.js": `import { loadConfig } from "./config.js";

// Summarise log records: total bytes per status class, for records matching the configured host.
export function summarise(records, configText) {
  const totals = {};
  for (const record of records) {
    const config = loadConfig(configText);
    const hostPattern = new RegExp(config.hostPattern);
    if (!hostPattern.test(record.host)) continue;

    const bucket = \`\${Math.floor(record.status / 100)}xx\`;
    // Accumulate by scanning what is already there.
    const keys = Object.keys(totals);
    let found = false;
    for (const key of keys) {
      if (key === bucket) { totals[key] += record.bytes; found = true; break; }
    }
    if (!found) totals[bucket] = record.bytes;
  }
  return totals;
}
`,
      "src/config.js": `// Parse the pipeline configuration and normalise the routing rules into lookup form.
export function loadConfig(text) {
  const raw = JSON.parse(text);
  const routes = new Map();
  for (const rule of raw.routes ?? []) {
    routes.set(rule.name, { ...rule, tags: [...(rule.tags ?? [])].sort() });
  }
  return { ...raw, routes };
}
`,
      "test/pipeline.test.js": `import assert from "node:assert/strict";
import test from "node:test";
import { summarise } from "../src/pipeline.js";

// A realistic deployment config: one host pattern plus the routing table for the whole fleet.
const CONFIG = JSON.stringify({
  hostPattern: "^web-[0-9]+$",
  routes: Array.from({ length: 400 }, (_, i) => ({
    name: \`route-\${i}\`,
    upstream: \`http://upstream-\${i}.internal:8080/v1/ingest\`,
    tags: ["tier-" + (i % 5), "region-" + (i % 9), "shard-" + (i % 17)],
    retries: i % 4,
  })),
});

test("summarises by status class", () => {
  const records = [
    { host: "web-1", status: 200, bytes: 10 },
    { host: "web-2", status: 204, bytes: 5 },
    { host: "web-1", status: 500, bytes: 7 },
    { host: "db-1", status: 200, bytes: 99 },
  ];
  assert.deepEqual(summarise(records, CONFIG), { "2xx": 15, "5xx": 7 });
});

test("no matching hosts yields nothing", () => {
  assert.deepEqual(summarise([{ host: "db-1", status: 200, bytes: 1 }], CONFIG), {});
});

// 20k records must summarise well inside a second. Removing the inner key scan alone is NOT
// enough -- with only a handful of buckets that scan is nearly free. The per-record config parse is
// what dominates.
test("summarises a large batch quickly", () => {
  const records = [];
  for (let i = 0; i < 20000; i += 1) {
    records.push({ host: \`web-\${i % 50}\`, status: 200 + (i % 3), bytes: 1 });
  }
  const started = Date.now();
  const totals = summarise(records, CONFIG);
  const elapsed = Date.now() - started;

  assert.equal(totals["2xx"], 20000);
  assert.ok(elapsed < 1000, \`20k records took \${elapsed}ms; something in the hot path is repeated\`);
});
`,
    },
  },
  {
    // The reported bug is in encode. Fixing encode correctly is not enough: decode has to keep
    // reading data written by the OLD encoder, and the fixture proves it.
    id: "roundtrip-codec",
    goal: "test/codec.test.js is failing: encoding a record containing the delimiter corrupts it. "
      + "Make every test pass. Do not modify the tests.",
    validation: ["node --test test/codec.test.js"],
    protectedPaths: ["test/"],
    files: {
      "src/codec.js": `// A compact record format: fields joined by "|".
//
// A field containing the delimiter must survive a round trip.
export function encodeRecord(fields) {
  return fields.join("|");
}

export function decodeRecord(line) {
  return line.split("|");
}
`,
      "test/codec.test.js": `import assert from "node:assert/strict";
import test from "node:test";
import { encodeRecord, decodeRecord } from "../src/codec.js";

test("round-trips ordinary fields", () => {
  const fields = ["alpha", "beta", "gamma"];
  assert.deepEqual(decodeRecord(encodeRecord(fields)), fields);
});

test("round-trips a field containing the delimiter", () => {
  const fields = ["a|b", "c"];
  assert.deepEqual(decodeRecord(encodeRecord(fields)), fields);
});

test("round-trips a field containing the escape character itself", () => {
  const fields = ["back\\\\slash", "x"];
  assert.deepEqual(decodeRecord(encodeRecord(fields)), fields);
});

test("round-trips empty fields", () => {
  assert.deepEqual(decodeRecord(encodeRecord(["", "", "x"])), ["", "", "x"]);
});

// Data already on disk was written by the ORIGINAL encoder, which had no escaping at all. Those
// lines must still decode the way the old writer meant them: every "|" is a separator, and a
// backslash is ordinary data rather than an escape.
//
// So the two formats are not distinguishable by inspection, and simply making decode the mirror of
// the new encode silently corrupts every stored line containing a backslash. The encoder has to
// mark what it writes.
test("still decodes legacy lines written before escaping existed", () => {
  assert.deepEqual(decodeRecord("alpha|beta|gamma"), ["alpha", "beta", "gamma"]);
  assert.deepEqual(decodeRecord("one|two"), ["one", "two"]);
  assert.deepEqual(decodeRecord(""), [""]);
});

test("a legacy line containing a backslash keeps the backslash", () => {
  assert.deepEqual(decodeRecord("back\\\\slash|x"), ["back\\\\slash", "x"]);
  assert.deepEqual(decodeRecord("C:\\\\temp\\\\log|ok"), ["C:\\\\temp\\\\log", "ok"]);
});
`,
    },
  },
  {
    // The visible bug is a cache stampede. Fixing it exposes that failures are cached forever,
    // which the second half of the suite checks.
    id: "async-cache",
    goal: "test/cache.test.js is failing. Make every test pass. Do not modify the tests.",
    validation: ["node --test test/cache.test.js"],
    protectedPaths: ["test/"],
    files: {
      "src/cache.js": `// Cache the results of an async loader.
export class AsyncCache {
  constructor(loader) {
    this.loader = loader;
    this.values = new Map();
  }

  async get(key) {
    if (this.values.has(key)) return this.values.get(key);
    const value = await this.loader(key);
    this.values.set(key, value);
    return value;
  }
}
`,
      "test/cache.test.js": `import assert from "node:assert/strict";
import test from "node:test";
import { AsyncCache } from "../src/cache.js";

test("caches a loaded value", async () => {
  let calls = 0;
  const cache = new AsyncCache(async (key) => { calls += 1; return key.toUpperCase(); });
  assert.equal(await cache.get("a"), "A");
  assert.equal(await cache.get("a"), "A");
  assert.equal(calls, 1);
});

// Concurrent requests for the same missing key must load it once, not once each.
test("concurrent misses load only once", async () => {
  let calls = 0;
  const cache = new AsyncCache(async (key) => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 20));
    return key.toUpperCase();
  });
  const [x, y, z] = await Promise.all([cache.get("k"), cache.get("k"), cache.get("k")]);
  assert.deepEqual([x, y, z], ["K", "K", "K"]);
  assert.equal(calls, 1, "one load for three concurrent misses");
});

// A failed load must not be remembered: the next request has to try again.
test("a failure is not cached", async () => {
  let calls = 0;
  const cache = new AsyncCache(async (key) => {
    calls += 1;
    if (calls === 1) throw new Error("transient");
    return key.toUpperCase();
  });
  await assert.rejects(() => cache.get("a"));
  assert.equal(await cache.get("a"), "A", "the second attempt succeeds");
  assert.equal(calls, 2);
});

// And a failure shared by concurrent waiters must reject all of them, then still be retryable.
test("a concurrent failure rejects every waiter and remains retryable", async () => {
  let calls = 0;
  const cache = new AsyncCache(async (key) => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 10));
    if (calls === 1) throw new Error("transient");
    return key.toUpperCase();
  });
  const results = await Promise.allSettled([cache.get("k"), cache.get("k")]);
  assert.deepEqual(results.map((r) => r.status), ["rejected", "rejected"]);
  assert.equal(calls, 1, "the failing load was still shared");
  assert.equal(await cache.get("k"), "K", "and the key is loadable afterwards");
});
`,
    },
  },
];
