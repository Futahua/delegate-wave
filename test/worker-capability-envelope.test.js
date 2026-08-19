// The manager must not assign work the worker cannot do.
//
// Dogfood run 6 lost both implementation attempts to this. The manager, now well informed by three
// good investigations, wrote a brief instructing the worker to "run npm ci if needed before
// build/test" with acceptance criteria "npm run build succeeds" and "npm test succeeds". The
// OpenCode implementation worker has no shell. It read fifteen files, tried to call `bash`, was
// refused -- "Model tried to call unavailable tool 'bash'" -- and then reasoned to exactly its
// 32,000-token cap with zero output and no edit. Twice.
//
// The envelope travels as EVIDENCE, not as a rule in the standing instructions, because it is not
// an invariant of delegate-wave: the Harness `trusted` profile has a shell and the OpenCode reader
// does not. A manager taught one executor's limits would be confidently wrong the moment the router
// chose another.
import assert from "node:assert/strict";
import test from "node:test";
import { openCodeCapabilities } from "../src/backend.js";
import { buildPlanEvidence, renderEvidence } from "../src/manager/evidence.js";
import { MANAGER_SYSTEM_INSTRUCTIONS } from "../src/manager/backend.js";

const pack = (extra = {}) => buildPlanEvidence({
  objective: "build the dashboard",
  baseSha: "abc123",
  validationCommands: ["npm ci", "npm run build", "git diff --exit-code -- public", "npm test"],
  protectedPaths: [],
  ...extra,
});

test("the evidence states what the worker can and cannot do", () => {
  const rendered = renderEvidence(pack({ workerCapabilities: openCodeCapabilities("write") }));

  // Present as a capability envelope, with the denials named.
  assert.match(rendered, /Worker capability envelope/);
  assert.match(rendered, /CAN\s+edit_files/);
  assert.match(rendered, /CANNOT\s+shell/);
  assert.match(rendered, /CANNOT\s+run_build/);
  assert.match(rendered, /CANNOT\s+run_tests/);
  // And stated as a prohibition on the brief, not merely as a fact to notice.
  assert.match(rendered, /Do not write instructions or acceptance steps that require: .*shell/);
});

test("a capable worker is described as capable", () => {
  // The same renderer must not encode one executor's limits. A trusted profile says CAN.
  const rendered = renderEvidence(pack({
    workerCapabilities: { read_files: true, edit_files: true, shell: true, run_build: true, run_tests: true, git: true },
  }));
  assert.match(rendered, /CAN\s+shell/);
  assert.match(rendered, /CAN\s+run_build/);
  assert.doesNotMatch(rendered, /Do not write instructions or acceptance steps that require/,
    "nothing is denied, so nothing is prohibited");
});

test("an unknown envelope is stated as unknown, not assumed capable", () => {
  const rendered = renderEvidence(pack({ workerCapabilities: null }));
  assert.match(rendered, /UNKNOWN/);
  assert.match(rendered, /Do not assume a shell/);
});

test("deterministic checks are listed, never joined into a shell command line", () => {
  const rendered = renderEvidence(pack({ workerCapabilities: openCodeCapabilities("write") }));

  // The specific defect: joining the plan with "&&" produced a command line nothing ever runs, and
  // run 5's manager read it as one -- concluding "the harness used an invalid PowerShell command
  // with && before npm ran" and spending two revisions on a build no worker could attempt.
  assert.doesNotMatch(rendered, /npm ci && npm run build/,
    "the plan must never be rendered as a composed shell line");
  assert.match(rendered, /- npm ci/);
  assert.match(rendered, /- npm run build/);
  assert.match(rendered, /- npm test/);

  // Ownership is stated, so the manager cannot conclude the worker ran them.
  assert.match(rendered, /delegate-wave will run after the worker finishes/);
  assert.match(rendered, /NOT instructions for the worker/);
});

test("the standing instructions state the invariant, not one executor's tool list", () => {
  // The rule has to survive a change of executor. Naming today's OpenCode tools would become false
  // the moment a Harness `trusted` worker runs, and a manager reasoning from a stale rule is worse
  // than one reasoning from supplied evidence.
  assert.match(MANAGER_SYSTEM_INSTRUCTIONS, /capability envelope is supplied with\s*\n?the evidence/);
  assert.match(MANAGER_SYSTEM_INSTRUCTIONS, /Never instruct a worker to run commands, tests, builds, or Git/);
  assert.match(MANAGER_SYSTEM_INSTRUCTIONS, /Deterministic validation belongs to delegate-wave and runs AFTER/);
  assert.match(MANAGER_SYSTEM_INSTRUCTIONS, /never\s*\n?steps for the worker unless the envelope says/);

  for (const leaked of ["todowrite", "glob", "opencode", "OpenCode"]) {
    assert.doesNotMatch(MANAGER_SYSTEM_INSTRUCTIONS, new RegExp(leaked),
      `${leaked} is one executor's detail and must not be a standing rule`);
  }
});

test("the envelope is derived from the policy in force, not hand-written", () => {
  // A hand-maintained copy drifts, and a lying envelope is worse than none because the manager
  // trusts it. Read mode and write mode must differ exactly as their permissions do.
  const write = openCodeCapabilities("write");
  const read = openCodeCapabilities("read");
  assert.equal(write.edit_files, true);
  assert.equal(read.edit_files, false, "the reader is read-only, and the envelope must say so");
  assert.equal(write.shell, false);
  // Everything requiring a shell under this executor follows the shell, rather than being asserted
  // independently and drifting away from it.
  assert.equal(write.run_build, write.shell);
  assert.equal(write.run_tests, write.shell);
  assert.equal(write.git, write.shell);
});
