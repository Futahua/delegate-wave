// The fence confines reads as well as writes.
//
// The case that matters most: the trusted verifiers live outside the worker's repository, so a
// worker able to read by absolute path would regain exactly the capability PR #13 removed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AttemptFence, FenceViolation } from "../src/fence.js";
import { runProcess } from "../src/process.js";

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-fence-"));
  const worktree = path.join(temp, "worktree");
  const outside = path.join(temp, "outside");
  fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(worktree, "inside.txt"), "candidate content\n");
  fs.writeFileSync(path.join(worktree, "src", "lib.js"), "export const answer = 42;\n");
  // Stands in for the trusted verifier the worker must never read.
  fs.writeFileSync(path.join(outside, "verifier.js"), "the acceptance criteria\n");
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  return { temp, worktree, outside, fence: new AttemptFence(worktree) };
}

test("ordinary work inside the worktree is permitted", (t) => {
  const { fence } = fixture(t);
  assert.match(fence.readFile("inside.txt"), /candidate content/);
  assert.match(fence.readFile("src/lib.js"), /answer = 42/);
  fence.writeFile("new/nested.txt", "written\n");
  assert.equal(fence.readFile("new/nested.txt"), "written\n");
  assert.ok(fence.listDir(".").includes("inside.txt"));
  assert.ok(fence.stat("inside.txt").size > 0);
  assert.deepEqual(fence.search("answer"), ["src/lib.js"]);
});

test("an absolute path outside the worktree is denied for every operation", (t) => {
  const { fence, outside } = fixture(t);
  const verifier = path.join(outside, "verifier.js");
  for (const [label, run] of [
    ["read", () => fence.readFile(verifier)],
    ["write", () => fence.writeFile(verifier, "tampered")],
    ["list", () => fence.listDir(outside)],
    ["stat", () => fence.stat(verifier)],
    ["remove", () => fence.remove(verifier)],
    ["search", () => fence.search("criteria", { target: outside })],
  ]) {
    assert.throws(run, FenceViolation, `${label} must be denied`);
  }
  // The file is untouched.
  assert.equal(fs.readFileSync(verifier, "utf8"), "the acceptance criteria\n");
  // Existence outside is reported as absent rather than raising: existence is itself information.
  assert.equal(fence.exists(verifier), false);
});

test("a relative escape is denied however it is spelled", (t) => {
  const { fence } = fixture(t);
  for (const attempt of [
    "../outside/verifier.js",
    "src/../../outside/verifier.js",
    "./src/../../outside/verifier.js",
    "..",
    "../..",
  ]) {
    assert.throws(() => fence.readFile(attempt), FenceViolation, `${attempt} must be denied`);
  }
});

test("a symlink pointing outside cannot be used to read or write through", async (t) => {
  const { fence, worktree, outside } = fixture(t);
  const link = path.join(worktree, "escape");
  try {
    fs.symlinkSync(outside, link, "junction");
  } catch {
    t.skip("this environment cannot create links");
    return;
  }

  // Reading through the link resolves outside and is denied.
  assert.throws(() => fence.readFile("escape/verifier.js"), FenceViolation);
  assert.throws(() => fence.writeFile("escape/planted.txt", "x"), FenceViolation);
  assert.throws(() => fence.listDir("escape"), FenceViolation);
  // Search must not follow it either.
  fs.writeFileSync(path.join(outside, "secret.txt"), "criteria marker\n");
  assert.deepEqual(fence.search("criteria marker"), [], "search must not traverse a link out");
  assert.equal(fs.existsSync(path.join(outside, "planted.txt")), false);
});

test("a Windows junction is treated exactly like a symlink", async (t) => {
  const { fence, worktree, outside } = fixture(t);
  if (process.platform !== "win32") { t.skip("junctions are Windows-specific"); return; }
  const junction = path.join(worktree, "junction");
  const made = await runProcess("cmd.exe", ["/c", "mklink", "/J", junction, outside]);
  if (made.exitCode !== 0) { t.skip(`mklink unavailable: ${made.stderr.trim()}`); return; }

  assert.throws(() => fence.readFile("junction/verifier.js"), FenceViolation);
  assert.throws(() => fence.writeFile("junction/planted.txt", "x"), FenceViolation);
  assert.deepEqual(fence.search("acceptance criteria"), [], "search must not traverse a junction out");
  assert.equal(fs.existsSync(path.join(outside, "planted.txt")), false);
});

test("a new file inside a symlinked directory is judged by where the link really points", async (t) => {
  const { fence, worktree, outside } = fixture(t);
  const link = path.join(worktree, "linked");
  try {
    fs.symlinkSync(outside, link, "junction");
  } catch {
    t.skip("this environment cannot create links");
    return;
  }
  // The target does not exist yet, so resolution must walk up to the nearest existing ancestor --
  // the link -- rather than concluding the path is fine because it is absent.
  assert.throws(() => fence.writeFile("linked/brand-new.txt", "x"), FenceViolation);
  assert.equal(fs.existsSync(path.join(outside, "brand-new.txt")), false);
});

test("the worktree root itself cannot be removed", (t) => {
  const { fence } = fixture(t);
  assert.throws(() => fence.remove("."), /refusing to remove the worktree root/);
});

test("a NUL byte in a path is rejected rather than truncated", (t) => {
  const { fence } = fixture(t);
  assert.throws(() => fence.readFile("inside.txt\0../../outside/verifier.js"), /NUL byte/);
});
