// Which executor runs ordinary work, and what happens when the preferred one cannot.
//
// The policy is: Harness is preferred, OpenCode is the proven fallback, and the choice is made
// between attempts. The reason must always be reported, because a silent fallback is
// indistinguishable from a working preference until someone reads the artifacts.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { selectBackendForModel, harnessReadiness, BackendRouter } from "../src/harness/select.js";
import { HARNESS_PACKAGE, HARNESS_VERSION } from "../src/harness/backend.js";
import { CONTROL_AUTHORITY_NAMES, childEnvironment } from "../src/process.js";
import { DEFAULT_WORKER_MODEL as FLASH, REVIEW_MODEL as LUNA, ESCALATION_MODEL as PRO } from "../src/service.js";

// Builds a directory that looks like a Harness installation at a given version.
function fakeInstall(t, version) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-harness-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  if (version) {
    const pkg = path.join(home, "node_modules", HARNESS_PACKAGE);
    fs.mkdirSync(path.join(pkg, "lib"), { recursive: true });
    fs.writeFileSync(path.join(pkg, "lib", "bin.js"), "// stand-in\n");
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ version }));
  }
  return home;
}

test("Harness is chosen when it is installed at the pinned version with a key", (t) => {
  const home = fakeInstall(t, HARNESS_VERSION);
  const chosen = selectBackendForModel(FLASH, { harnessHome: home, apiKey: "key" });
  assert.equal(chosen.selected, "harness");
  assert.equal(chosen.fellBack, false);
  assert.equal(chosen.backend.constructor.name, "HarnessBackend");
});

test("a missing installation falls back to OpenCode and says why", (t) => {
  const home = fakeInstall(t, null);
  const chosen = selectBackendForModel(FLASH, { harnessHome: home, apiKey: "key" });
  assert.equal(chosen.selected, "opencode");
  assert.equal(chosen.fellBack, true);
  assert.match(chosen.reason, /not installed/);
});

test("a missing key falls back rather than reading one from the ambient environment", (t) => {
  const home = fakeInstall(t, HARNESS_VERSION);
  const chosen = selectBackendForModel(FLASH, { harnessHome: home, apiKey: null });
  assert.equal(chosen.selected, "opencode");
  assert.match(chosen.reason, /no Harness API key/);
});

// The version is pinned because the profile patch names specific plugin ids and the usage reader
// depends on a specific event shape. A different build may honour neither, quietly.
test("a version other than the pinned one falls back rather than hoping", (t) => {
  const home = fakeInstall(t, "0.2.0-rc.1");
  const readiness = harnessReadiness({ harnessHome: home, apiKey: "key" });
  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /pinned to 0\.1\.0-rc\.6 but 0\.2\.0-rc\.1 is installed/);
  assert.equal(selectBackendForModel(FLASH, { harnessHome: home, apiKey: "key" }).selected, "opencode");
});

test("OpenCode can be selected explicitly without being a fallback", (t) => {
  const home = fakeInstall(t, HARNESS_VERSION);
  const chosen = selectBackendForModel(FLASH, { harnessHome: home, apiKey: "key", prefer: "opencode" });
  assert.equal(chosen.selected, "opencode");
  assert.equal(chosen.fellBack, false, "an explicit choice is not a degradation");
});

// OpenCodeBackend is the proven fallback and must remain intact, not hollowed out into a shim.
test("the OpenCode backend is still a working implementation", async () => {
  const { OpenCodeBackend } = await import("../src/backend.js");
  assert.equal(typeof OpenCodeBackend.prototype.run, "function");
});

// A provider key must reach a worker only because a backend passed it deliberately.
test("executor API keys are scrubbed from inherited child environments", () => {
  for (const name of ["DELEGATE_WAVE_EXECUTOR_API_KEY", "OPENCODE_GO_API_KEY"]) {
    assert.ok(CONTROL_AUTHORITY_NAMES.includes(name), `${name} must be scrubbed`);
  }
  const previous = process.env.DELEGATE_WAVE_EXECUTOR_API_KEY;
  process.env.DELEGATE_WAVE_EXECUTOR_API_KEY = "leaked";
  try {
    assert.equal(childEnvironment().DELEGATE_WAVE_EXECUTOR_API_KEY, undefined,
      "a child must not inherit the key merely because the parent holds it");
    assert.equal(childEnvironment({ DELEGATE_WAVE_EXECUTOR_API_KEY: "granted" }).DELEGATE_WAVE_EXECUTOR_API_KEY,
      "granted", "but an explicit grant still reaches the child");
  } finally {
    if (previous === undefined) delete process.env.DELEGATE_WAVE_EXECUTOR_API_KEY;
    else process.env.DELEGATE_WAVE_EXECUTOR_API_KEY = previous;
  }
});

// The declared credential role must be covered by the same machinery as every other role.
test("the executor credential is a declared, scoped role", async () => {
  const { SECRET_RECORDS, REQUIRED_SECRET_ROLES } = await import("../src/supervisor.js");
  assert.ok(SECRET_RECORDS.executor, "executor is a declared role");
  assert.equal(SECRET_RECORDS.executor.required, false,
    "optional, so installations provisioned before it existed keep starting");
  assert.ok(!REQUIRED_SECRET_ROLES.includes("executor"));
});

// The routing regression this round exists to fix.
//
// The product advertises three lanes. Harness routes through the DeepSeek adapter and cannot run the
// review model at all, so a Harness-only server failed every Luna job with "no wire model" after
// creating the attempt. Routing must be per model, decided before the attempt begins.
test("each advertised lane routes to an executor that can actually run it", (t) => {
  const home = fakeInstall(t, HARNESS_VERSION);
  const options = { harnessHome: home, apiKey: "key" };

  assert.equal(selectBackendForModel(FLASH, options).selected, "harness", "ordinary work");
  assert.equal(selectBackendForModel(PRO, options).selected, "harness", "escalation");
  assert.equal(selectBackendForModel(LUNA, options).selected, "opencode", "focused review and debugging");
});

// Luna on OpenCode is the design, not a degradation: reporting it as a fallback would make a healthy
// system look like it was limping.
test("the review lane is a routing decision, not a fallback", (t) => {
  const home = fakeInstall(t, HARNESS_VERSION);
  const chosen = selectBackendForModel(LUNA, { harnessHome: home, apiKey: "key" });
  assert.equal(chosen.fellBack, false);
  assert.match(chosen.reason, /does not route through the Harness DeepSeek adapter/);
});

// A Harness failure that will recur -- a profile that will not compose, a fence the loader refuses --
// happens inside run(), after the attempt has begun. That attempt fails honestly; the NEXT one must
// not repeat a failure already observed.
test("a runtime Harness failure routes later attempts to OpenCode", (t) => {
  const home = fakeInstall(t, HARNESS_VERSION);
  const router = new BackendRouter({ harnessHome: home, apiKey: "key" });

  assert.equal(router.select(FLASH).selected, "harness", "the first attempt tries Harness");
  router.disableHarness("the fenced filesystem is not in the composed Harness profile");

  const next = router.select(FLASH);
  assert.equal(next.selected, "opencode", "the next attempt does not repeat it");
  assert.equal(next.fellBack, true);
  assert.match(next.reason, /runtime failure/);
});

test("the review lane is unaffected by a Harness runtime failure", (t) => {
  const home = fakeInstall(t, HARNESS_VERSION);
  const router = new BackendRouter({ harnessHome: home, apiKey: "key" });
  router.disableHarness("boom");
  assert.equal(router.select(LUNA).selected, "opencode", "it was never using Harness to begin with");
});
