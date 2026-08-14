import { requireFile, fail, pass } from "./_harness.js";

let parsed;
try {
  parsed = JSON.parse(requireFile("config.summary.json"));
} catch (error) {
  fail(`not valid JSON: ${error.message}`);
}
if (parsed.services !== 3) fail(`services is ${parsed.services}, expected 3`);
if (!Array.isArray(parsed.ports)) fail("ports must be an array");
// 8080 appears twice in the source and must be deduplicated.
if (JSON.stringify(parsed.ports) !== JSON.stringify([8080, 9090])) {
  fail(`ports is ${JSON.stringify(parsed.ports)}, expected [8080,9090]`);
}
pass("config.summary.json counts services and dedupes ports");
