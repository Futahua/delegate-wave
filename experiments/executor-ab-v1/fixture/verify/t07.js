import { requireFile, fail, pass } from "./_harness.js";

const body = requireFile("API.md").toLowerCase();
// Every exported function must be documented...
for (const name of ["lastindex", "tally", "sum"]) {
  if (!body.includes(name)) fail(`API.md does not document ${name}`);
}
// ...and nothing that does not exist, which catches confabulated API surface.
if (body.includes("median")) fail("API.md documents a function that does not exist");
if (body.split(/\r?\n/).filter((l) => l.trim()).length < 6) {
  fail("API.md is too thin to be per-function documentation");
}
pass("API.md documents each exported function and invents none");
