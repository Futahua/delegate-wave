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
import { readFileSync } from "node:fs";
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
  // A fabricated envelope, deliberately not the live one. This asserts how a restriction is
  // RENDERED; tying it to whatever the current policy happens to be would make the test flip
  // whenever the policy does, which is exactly the coupling the envelope exists to remove.
  const rendered = renderEvidence(pack({
    workerCapabilities: {
      read_files: true, edit_files: true, shell: false, run_build: false, run_tests: false, git: false,
    },
  }));

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
  // Asserted as a RELATIONSHIP, not as today's value. Whether the shell is granted is a policy
  // decision that may change; that everything requiring one follows it is the invariant, and it is
  // what stops the envelope drifting into a lie when the policy is next edited.
  for (const derived of ["run_build", "run_tests", "git"]) {
    assert.equal(write[derived], write.shell,
      `${derived} needs a shell under this executor and must track it`);
    assert.equal(read[derived], read.shell, `${derived} must track the shell in read mode too`);
  }
});

test("the implementation worker can build; the investigator still cannot", () => {
  // Withholding a shell never protected anything that mattered. delegate-wave's guarantees rest on
  // capturing the candidate through its OWN Git index, validating independently afterwards, and
  // requiring a human before anything integrates -- not on what the worker could reach. What the
  // worker CLAIMS is still worth nothing; what it can REACH was never the control.
  const write = openCodeCapabilities("write");
  assert.equal(write.shell, true, "an implementation worker that cannot build cannot do its job");
  assert.equal(write.run_build, true);
  assert.equal(write.run_tests, true);

  // The reader keeps its denial: an investigation has nothing to build, and the frozen executor
  // comparison depends on it not reaching verifiers outside its worktree.
  const read = openCodeCapabilities("read");
  assert.equal(read.shell, false, "investigation stays contained");
  assert.equal(read.edit_files, false);
});

test("the worker's prompt agrees with the policy it runs under", () => {
  // A prompt saying "shell access is intentionally disabled" while the policy allows bash is a
  // contradiction the model resolves by guessing -- and in run 6 the guess cost two attempts.
  const source = readFileSync(new URL("../src/backend.js", import.meta.url), "utf8");
  const prompt = /Implement this bounded task[^`]*/.exec(source)?.[0] ?? "";
  assert.ok(prompt, "the write-mode prompt is still findable");
  assert.equal(openCodeCapabilities("write").shell, true);
  assert.doesNotMatch(prompt, /[Ss]hell access is intentionally disabled/);
  assert.match(prompt, /You may run commands/);
  // Git stays delegate-wave's, regardless of what the worker is able to run.
  assert.match(prompt, /Do not commit, push, or modify Git metadata/);
});

test("the manager is told which actions each turn accepts", () => {
  // Run 7 ended here, and the manager's reasoning was right: it saw a truncated diff and a failed
  // npm ci, said "I cannot accept or revise based on a partial diff", and asked for more evidence.
  // Correct instinct, unavailable action -- a REVIEW turn refuses EXPLORE, and nothing had ever told
  // it so. A manager punished for a rule it was never given is a documentation defect, not a
  // reasoning one.
  assert.match(MANAGER_SYSTEM_INSTRUCTIONS, /ACCEPT, REVISE, RETHINK, ESCALATE\s+--\s+and NOT EXPLORE/);
  assert.match(MANAGER_SYSTEM_INSTRUCTIONS, /EXPLORE, IMPLEMENT, ESCALATE/);
  // And the route it should have taken, named where the refusal is explained.
  assert.match(MANAGER_SYSTEM_INSTRUCTIONS, /use RETHINK, which carries "explorations" for exactly this/);
  assert.match(MANAGER_SYSTEM_INSTRUCTIONS, /Refusing to judge on evidence you consider insufficient is correct/);
});
