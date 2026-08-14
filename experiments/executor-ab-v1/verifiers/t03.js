import { baseline, requireFile, expectTaskChanges, fail, pass } from "./_harness.js";

expectTaskChanges("t03-json-reshape");

// Derived from the frozen config rather than hardcoded, and compared as an exact object shape:
// permitting extra keys would accept a summary carrying material the task never asked for.
const services = JSON.parse(baseline("config.json")).services;
const expected = {
  services: services.length,
  ports: [...new Set(services.map((service) => service.port))].sort((a, b) => a - b),
};

let parsed;
try {
  parsed = JSON.parse(requireFile("config.summary.json"));
} catch (error) {
  fail(`not valid JSON: ${error.message}`);
}
if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("expected a JSON object");

const keys = Object.keys(parsed).sort();
if (JSON.stringify(keys) !== JSON.stringify(["ports", "services"])) {
  fail(`keys are ${JSON.stringify(keys)}, expected exactly ["ports","services"]`);
}
if (parsed.services !== expected.services) {
  fail(`services is ${JSON.stringify(parsed.services)}, expected ${expected.services}`);
}
if (JSON.stringify(parsed.ports) !== JSON.stringify(expected.ports)) {
  fail(`ports is ${JSON.stringify(parsed.ports)}, expected ${JSON.stringify(expected.ports)}`);
}
pass("config.summary.json counts the services and lists the distinct ports in ascending order");
