// Proves the Harness filesystem provider is actually confined to one attempt worktree.
//
// These tests run against the real @deepseek-ai/dsh-fs-local class, not a stand-in, because the
// property under test is precisely that our subclass constrains THAT implementation. A mock would
// assert only that our own code calls our own fence.
//
// Harness's shipped sandbox fences mutations only and documents that reads pass through in every
// mode; a live worker demonstrated the escape by reading an absolute path outside its workspace. The
// verifiers for the frozen corpus live outside the worker repository, so an unfenced read is a
// correctness failure, not a hardening nicety.
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
