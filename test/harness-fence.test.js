// The `restricted` capability profile, and the capability/authority split it belongs to.
//
// Fencing is NOT a system-wide invariant here. Workers are extensions of their operator, so the
// default profile is `trusted` and a worker keeps its shell, code execution, and machine access.
// `restricted` exists for the case where containment genuinely is the point: the frozen executor
// comparison, whose trusted verifiers live outside the worker repository. A worker that reads them
// passes every task without doing the work -- that destroys the experiment, which is a
// methodological failure rather than a security one.
//
// These tests run against the real @deepseek-ai/dsh-fs-local class, not a stand-in, because the
// property under test is precisely that our subclass constrains THAT implementation. A mock would
// assert only that our own code calls our own fence.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createFencedFileSystemClass } from "../src/harness/fenced-fs.js";

const HARNESS_HOST = "D:/AssistantSystem/delegate-wave/harness/package.json";

function harnessInstalled() {
  try {
    createRequire(HARNESS_HOST)("@deepseek-ai/dsh-fs-local");
    return true;
  } catch {
    return false;
  }
}

// A real Cordis context, not a stand-in: the provider is a Cordis Service and constructing it
// against a hand-rolled object would test the stand-in rather than the provider.
function harnessContext() {
  const { Context } = createRequire(HARNESS_HOST)("@deepseek-ai/cordis");
  return new Context();
}

// Required by fs-local's own config validation; unrelated to confinement.
const BASE_CONFIG = { diffBasisMaxBytes: 1024 * 1024 };

async function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-harness-fence-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const worktree = path.join(temp, "worktree");
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, "inside.txt"), "in the worktree\n");
  // Stands in for the trusted verifiers, which really do live outside the worker's repository.
  const secret = path.join(temp, "verifier-secret.txt");
  fs.writeFileSync(secret, "SECRET\n");

  const FencedFileSystem = await createFencedFileSystemClass({ requireFrom: HARNESS_HOST });
  const provider = new FencedFileSystem(harnessContext(), {
    ...BASE_CONFIG, cwd: worktree, attemptRoot: worktree,
  });
  return { temp, worktree, secret, provider };
}

const denied = (error) => error?.code === "FS_FENCE_DENIED";

test("a path inside the worktree resolves", { skip: !harnessInstalled() && "Harness is not installed" }, async (t) => {
  const { provider } = await fixture(t);
  const target = await provider.resolve("inside.txt");
  assert.ok(target, "a legitimate in-worktree path still resolves");
  assert.equal(await provider.readText(target), "in the worktree\n", "and its contents are readable");
});

test("an absolute path outside the worktree is denied", { skip: !harnessInstalled() && "Harness is not installed" }, async (t) => {
  const { provider, secret } = await fixture(t);
  // The exact escape a live Harness worker performed against the stock configuration.
  await assert.rejects(() => provider.resolve(secret), denied, "the verifier stand-in is unreadable");
});

test("traversal out of the worktree is denied", { skip: !harnessInstalled() && "Harness is not installed" }, async (t) => {
  const { provider } = await fixture(t);
  await assert.rejects(() => provider.resolve("../verifier-secret.txt"), denied);
  await assert.rejects(() => provider.resolve("./nested/../../verifier-secret.txt"), denied);
});

test("a symlink pointing out of the worktree is judged by its destination", { skip: !harnessInstalled() && "Harness is not installed" }, async (t) => {
  const { provider, worktree, secret } = await fixture(t);
  const link = path.join(worktree, "escape.txt");
  try {
    fs.symlinkSync(secret, link, "file");
  } catch {
    // Unelevated Windows refuses file symlinks; the junction test below covers the same property
    // through a link type that does not require elevation.
    t.skip("this environment does not permit creating file symlinks");
    return;
  }
  // The path is lexically inside the worktree; only resolving the link reveals that it is not.
  await assert.rejects(() => provider.resolve("escape.txt"), denied);
});

// The escape that matters most on Windows, and the one an unprivileged worker can actually create:
// a directory junction needs no elevation and grafts an entire outside tree into the worktree, so
// every path beneath it is lexically inside while really being outside.
test("a directory junction into an outside tree is denied", { skip: !harnessInstalled() && "Harness is not installed" }, async (t) => {
  const { provider, worktree, temp } = await fixture(t);
  const outside = path.join(temp, "outside-tree");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "verifier.js"), "module.exports = 'ORACLE';\n");

  const junction = path.join(worktree, "linked");
  try {
    fs.symlinkSync(outside, junction, "junction");
  } catch {
    t.skip("this environment does not permit creating junctions");
    return;
  }

  await assert.rejects(() => provider.resolve("linked/verifier.js"), denied,
    "a file reached through a junction is judged by where it really lives");
  await assert.rejects(() => provider.resolve("linked"), denied, "and so is the junction itself");
});

test("a new file inside the worktree resolves even though it does not exist yet", { skip: !harnessInstalled() && "Harness is not installed" }, async (t) => {
  const { provider } = await fixture(t);
  const target = await provider.resolve("created-later.md");
  assert.ok(target, "workers must be able to create files, so non-existent paths are judged by their parent");
});

test("a new file outside the worktree is denied before it can be created", { skip: !harnessInstalled() && "Harness is not installed" }, async (t) => {
  const { provider, temp } = await fixture(t);
  await assert.rejects(() => provider.resolve(path.join(temp, "planted.md")), denied);
});

test("the provider advertises confinement rather than offering an escalation", { skip: !harnessInstalled() && "Harness is not installed" }, async (t) => {
  const { provider } = await fixture(t);
  assert.equal(provider.sandboxMode, "workspace-write", "the tool layer must not advertise full access");
});

// The control for every test above. If Harness ever starts confining reads on its own, this test
// fails and tells us the fence may be redundant -- far better than silently keeping a wrapper whose
// justification quietly expired. Today it documents the exact gap the fence exists to close.
test("the unfenced Harness provider does escape the workspace", { skip: !harnessInstalled() && "Harness is not installed" }, async (t) => {
  const { worktree, secret } = await fixture(t);
  const { LocalFileSystem } = createRequire(HARNESS_HOST)("@deepseek-ai/dsh-fs-local");
  const bare = new LocalFileSystem(harnessContext(), { ...BASE_CONFIG, cwd: worktree });

  assert.equal(bare.sandboxMode, undefined, "the bare provider claims no confinement at all");
  const escaped = await bare.resolve(secret);
  assert.equal(await bare.readText(escaped), "SECRET\n",
    "stock Harness reads outside the workspace, which is why the fence is required");
});

// The per-attempt profile patch must actually take effect.
//
// This is the bug that nearly shipped: pointing the existing `fs-sandbox` entry at a different
// module looks like a substitution, but the loader treats `name` on an existing id as an assertion,
// logs "name mismatch ... skipping", and carries on with the stock provider. Every visible signal
// said the worker was fenced; a live worker then read a file outside its worktree and reported the
// contents. So the shape of the patch is pinned here.
test("the profile patch replaces the filesystem provider rather than renaming the stock one", async () => {
  const { buildAttemptPatch } = await import("../src/harness/backend.js");
  const patch = buildAttemptPatch({
    worktreePath: "D:/wt",
    artifactDir: "D:/art",
    model: "deepseek-v4-flash",
    baseUrl: "https://example.invalid/v1",
    apiKeyEnv: "SOME_KEY",
    reasoningEffort: "high",
    profile: "restricted",
  });

  assert.match(patch, /- id: fs-sandbox\n\s+name: '@deepseek-ai\/dsh-fs-sandbox'\n\s+disabled: true/,
    "the stock sandbox is disabled under its own real name, so the loader accepts the entry");
  assert.match(patch, /- insert:\n\s+- id: delegate-wave-fenced-fs/,
    "and the fence is inserted as a new entry rather than renaming an existing one");
  assert.ok(!/- id: fs-sandbox\n\s+name: (?!'@deepseek-ai)/.test(patch),
    "the fs-sandbox entry must never be pointed at another module: that is silently skipped");
  assert.match(patch, /name: "file:\/\/\//,
    "the plugin is named by file:// URL; a bare Windows path is rejected as an unknown URL scheme");
});

test("the restricted profile disables every capability that profile forbids", async () => {
  const { buildAttemptPatch } = await import("../src/harness/backend.js");
  const patch = buildAttemptPatch({
    worktreePath: "D:/wt", artifactDir: "D:/art", model: "m",
    baseUrl: "https://example.invalid/v1", apiKeyEnv: "K", reasoningEffort: "high",
    profile: "restricted",
  });
  // code-runtime is included deliberately: it IS present in stock headless, and Harness documents
  // it as containment rather than a security boundary, with authority comparable to a shell.
  for (const id of ["tool-bash", "tool-pwsh", "bash-sandbox", "pwsh-sandbox", "shell-env",
    "permission", "tool-skill", "skill", "skill-filesystem", "skill-badge", "user-questions",
    "code-runtime"]) {
    assert.match(patch, new RegExp(`- id: ${id}\\n\\s*disabled: true`), `${id} must be disabled`);
  }
});

test("reasoning effort is pinned rather than left to the route default", async () => {
  const { buildAttemptPatch } = await import("../src/harness/backend.js");
  const patch = buildAttemptPatch({
    worktreePath: "D:/wt", artifactDir: "D:/art", model: "m",
    baseUrl: "https://example.invalid/v1", apiKeyEnv: "K", reasoningEffort: "high",
  });
  assert.match(patch, /thinking: enabled/);
  assert.match(patch, /reasoningEffort: high/);
});

// Evidence must be durable, or a run that exits promptly discards the events proving what it cost.
test("session persistence is configured to flush into the attempt's own artifact directory", async () => {
  const { buildAttemptPatch } = await import("../src/harness/backend.js");
  const patch = buildAttemptPatch({
    worktreePath: "D:/wt", artifactDir: "D:/art", model: "m",
    baseUrl: "https://example.invalid/v1", apiKeyEnv: "K", reasoningEffort: "high",
  });
  assert.match(patch, /root: "D:\/art\/sessions"/, "one attempt's log must not land in another's evidence");
  assert.match(patch, /compression: none/);
  assert.match(patch, /writeBatchMaxDelayMs: 1/, "headless exits before a batched write drains");
});

// Capability is a policy choice; authority is not. These pin the split.
test("the trusted profile keeps shell, code execution, and machine access", async () => {
  const { buildAttemptPatch } = await import("../src/harness/backend.js");
  const patch = buildAttemptPatch({
    worktreePath: "D:/wt", artifactDir: "D:/art", model: "m",
    baseUrl: "https://example.invalid/v1", apiKeyEnv: "K", reasoningEffort: "high",
    profile: "trusted",
  });
  // A coding agent without a shell is simply worse at the job, and delegate-wave's guarantees never
  // rested on the worker being unable to run one.
  for (const id of ["tool-bash", "tool-pwsh", "shell-env", "code-runtime", "skill", "permission"]) {
    assert.ok(!patch.includes(`- id: ${id}\n  disabled: true`), `${id} must remain available`);
  }
  assert.ok(!patch.includes("delegate-wave-fenced-fs"), "and the filesystem is not fenced");
  // The one exclusion that is not about containment: an unattended worker asking a question hangs.
  assert.match(patch, /- id: user-questions\n\s*disabled: true/);
});

// Evidence must still be durable and effort still pinned, whichever profile is in force -- those are
// measurement properties, not capability policy.
test("both profiles pin reasoning effort and durable usage evidence", async () => {
  const { buildAttemptPatch, CAPABILITY_PROFILES } = await import("../src/harness/backend.js");
  for (const profile of Object.keys(CAPABILITY_PROFILES)) {
    const patch = buildAttemptPatch({
      worktreePath: "D:/wt", artifactDir: "D:/art", model: "m",
      baseUrl: "https://example.invalid/v1", apiKeyEnv: "K", reasoningEffort: "high", profile,
    });
    assert.match(patch, /reasoningEffort: high/, `${profile} pins effort`);
    assert.match(patch, /writeBatchMaxDelayMs: 1/, `${profile} keeps durable evidence`);
  }
});

test("the default profile is trusted, and an unknown one is refused", async () => {
  const { DEFAULT_CAPABILITY_PROFILE, capabilityProfile } = await import("../src/harness/backend.js");
  assert.equal(DEFAULT_CAPABILITY_PROFILE, "trusted",
    "workers are extensions of their operator, not adversaries");
  assert.equal(capabilityProfile("restricted").fenced, true, "restricted still fences reads");
  assert.throws(() => capabilityProfile("bounded"), /Unknown capability profile/,
    "no silent fallback to a profile that was not asked for");
});

// The prompt must match the capability the worker was actually granted.
//
// A trusted worker configured with a shell but told "shell access is intentionally disabled" will
// usually obey the instruction. The config would say trusted while the behaviour stayed restricted,
// and the whole point of the default would be lost silently -- no error, just a weaker worker.
test("the trusted prompt grants the tools the trusted profile actually enables", async () => {
  const { workerPrompt } = await import("../src/harness/backend.js");
  const prompt = workerPrompt({ goal: "add a totals file", mode: "write", profile: "trusted" });

  assert.ok(!/shell access is intentionally disabled/i.test(prompt),
    "a worker holding a shell must not be told it has none");
  assert.ok(!/outside this worktree/i.test(prompt),
    "an unfenced worker must not be told the filesystem is fenced");
  assert.match(prompt, /shell/i, "and the tools it has are named, so it knows to use them");
  assert.match(prompt, /code execution/i);
});

test("the restricted prompt still states the confinement it really has", async () => {
  const { workerPrompt } = await import("../src/harness/backend.js");
  const prompt = workerPrompt({ goal: "add a totals file", mode: "write", profile: "restricted" });
  assert.match(prompt, /shell access is intentionally disabled/i);
  assert.match(prompt, /outside this worktree/i);
});

// The one instruction that belongs in every write prompt: capability is broad, authority is not.
test("both write prompts tell the worker its claims are not acceptance", async () => {
  const { workerPrompt, CAPABILITY_PROFILES } = await import("../src/harness/backend.js");
  for (const profile of Object.keys(CAPABILITY_PROFILES)) {
    const prompt = workerPrompt({ goal: "x", mode: "write", profile });
    assert.match(prompt, /not treat your own claims as acceptance/i, `${profile} states the invariant`);
    assert.ok(!/\bgit (commit|push)\b/i.test(prompt.replace(/Do not commit[^.]*\./i, "")),
      `${profile} does not invite the worker to commit`);
  }
});

// Read mode changes nothing about capability; it changes what the worker is asked to produce.
test("read mode is unchanged by the capability profile", async () => {
  const { workerPrompt } = await import("../src/harness/backend.js");
  assert.equal(
    workerPrompt({ goal: "x", mode: "read", profile: "trusted" }),
    workerPrompt({ goal: "x", mode: "read", profile: "restricted" }),
  );
});
