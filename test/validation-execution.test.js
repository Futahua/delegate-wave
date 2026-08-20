// "The tests failed" and "the tests never ran" are different facts about different things.
//
// Dogfood run 5 conflated them and it cost two implementation attempts. The stored plan was one
// shell string joined with `&&`, handed to powershell.exe -- Windows PowerShell 5.1, where `&&` is
// a parse error. Nothing ran, the interpreter exited nonzero, and both candidates were recorded as
// having failed validation. The manager reviewed that evidence faithfully and asked for revisions
// that could not possibly have helped, because the candidate was never what was broken.
//
// A verifier that did not execute produces no evidence about the candidate at all.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeDataRoot } from "../src/db.js";
import { FakeBackend } from "../src/backend.js";
import { Dispatcher } from "../src/service.js";
import { assertNotShellComposed, resolveExecutable, runCommand, tokenizeCommand } from "../src/process.js";

async function command(name, args, cwd) {
  const { runProcess } = await import("../src/process.js");
  const result = await runProcess(name, args, { cwd });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

test("shell composition is refused rather than evaluated", () => {
  // The exact plan run 5 was judged by.
  assert.throws(
    () => assertNotShellComposed("npm ci && npm run build && git diff --exit-code -- public && npm test"),
    /shell syntax/,
  );
  for (const composed of ["a || b", "a | b", "a; b", "a > out", "a < in", "echo `x`", "echo $(x)", "a & b"]) {
    assert.throws(() => assertNotShellComposed(composed), /shell syntax/, `${composed} must be refused`);
  }
  // A plain command with arguments, including git's `--` separator, is not composition.
  assert.doesNotThrow(() => assertNotShellComposed("git diff --exit-code -- public"));
  assert.doesNotThrow(() => assertNotShellComposed("npm run build"));
});

test("commands are split into argv without expansion", () => {
  assert.deepEqual(tokenizeCommand("git diff --exit-code -- public"),
    ["git", "diff", "--exit-code", "--", "public"]);
  assert.deepEqual(tokenizeCommand('npm run "build me"'), ["npm", "run", "build me"]);
  assert.deepEqual(tokenizeCommand("  npm   test  "), ["npm", "test"]);
  // An empty quoted argument is a real argument and must survive.
  assert.deepEqual(tokenizeCommand('tool ""'), ["tool", ""]);
  assert.throws(() => tokenizeCommand('tool "unterminated'), /unterminated/);
});

test("a command that cannot start is not a failing command", async () => {
  const missing = await runCommand("delegate-wave-no-such-tool --version", { cwd: process.cwd() });
  assert.equal(missing.ran, false);
  assert.equal(missing.exitCode, null, "there was no exit status to observe");
  assert.match(missing.reason, /not found on PATH/);

  // And a real one does run, including through a Windows batch shim, which is the case that forced
  // a shell in the first place.
  const real = await runCommand("git --version", { cwd: process.cwd() });
  assert.equal(real.ran, true);
  assert.equal(real.exitCode, 0);
  assert.match(real.stdout, /git version/);
});

test("a check that did not run leaves the candidate unjudged", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-val-"));
  const root = path.join(temp, "data");
  const repo = path.join(temp, "repo");
  fs.mkdirSync(repo);
  await command("git", ["init", "-b", "main"], repo);
  await command("git", ["config", "user.name", "Test"], repo);
  await command("git", ["config", "user.email", "test@example.invalid"], repo);
  fs.writeFileSync(path.join(repo, "input.txt"), "before\n");
  await command("git", ["add", "."], repo);
  await command("git", ["commit", "-m", "initial"], repo);
  initializeDataRoot(root);

  const dispatcher = new Dispatcher({
    root,
    backend: new FakeBackend(async ({ artifactDir, worktreePath }) => {
      fs.mkdirSync(artifactDir, { recursive: true });
      const events = path.join(artifactDir, "opencode-events.jsonl");
      fs.writeFileSync(events, JSON.stringify({ type: "step_finish", part: { reason: "stop" } }));
      fs.writeFileSync(path.join(worktreePath, "out.txt"), "done\n");
      return { exitCode: 0, stdout: "ok", stderr: "", stdoutPath: events };
    }),
  });
  t.after(async () => {
    dispatcher.close();
    const { runProcess } = await import("../src/process.js");
    const listed = await runProcess("git", ["-C", repo, "worktree", "list", "--porcelain"]);
    for (const worktree of listed.stdout.split(/\r?\n/)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length))
      .filter((worktree) => path.resolve(worktree) !== path.resolve(repo))) {
      await runProcess("git", ["-C", repo, "worktree", "unlock", worktree]);
      await runProcess("git", ["-C", repo, "worktree", "remove", "--force", worktree]);
    }
    fs.rmSync(temp, { recursive: true, force: true });
  });

  // A plan naming a tool this machine does not have: the check cannot run.
  const project = await dispatcher.addProject({
    name: "Unrunnable", repoPath: repo, validation: ["delegate-wave-no-such-tool check"],
  });
  const job = await dispatcher.createJob({ projectId: project.id, goal: "do a thing", maxAttempts: 1 });
  await dispatcher.runJob(job.id, { model: "opencode-go/deepseek-v4-flash" });

  const attempt = dispatcher.db.prepare(
    "SELECT * FROM attempts WHERE job_id = ? ORDER BY ordinal DESC LIMIT 1",
  ).get(job.id);
  const run = dispatcher.db.prepare("SELECT * FROM validation_runs WHERE attempt_id = ?").get(attempt.id);

  assert.equal(run.outcome, "CHECK_DID_NOT_RUN");
  assert.equal(run.exit_code, null, "no exit status was observed, so none is recorded");
  assert.match(run.did_not_run_reason, /not found on PATH/);
  // The point of the whole change: the candidate was never judged.
  assert.notEqual(attempt.validation_state, "FAILED",
    "a verifier that never started must not read as the candidate failing its tests");
});

test("a plan with shell composition is refused at registration", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-plan-"));
  const root = path.join(temp, "data");
  const repo = path.join(temp, "repo");
  fs.mkdirSync(repo);
  await command("git", ["init", "-b", "main"], repo);
  await command("git", ["config", "user.name", "Test"], repo);
  await command("git", ["config", "user.email", "test@example.invalid"], repo);
  fs.writeFileSync(path.join(repo, "input.txt"), "before\n");
  await command("git", ["add", "."], repo);
  await command("git", ["commit", "-m", "initial"], repo);
  initializeDataRoot(root);
  const dispatcher = new Dispatcher({ root });
  t.after(() => { dispatcher.close(); fs.rmSync(temp, { recursive: true, force: true }); });

  // Caught where the plan is accepted, not mid-run against a candidate it would appear to condemn.
  await assert.rejects(
    dispatcher.addProject({
      name: "Composed", repoPath: repo,
      validation: ["npm ci && npm run build && git diff --exit-code -- public && npm test"],
    }),
    /shell syntax/,
  );
});

test("resolveExecutable finds Windows batch shims", () => {
  // npm is npm.cmd on Windows and Node refuses to spawn .cmd without a shell. Resolving it
  // explicitly is what lets the no-shell guarantee hold while still running real tooling.
  const npm = resolveExecutable("npm");
  if (npm === null) return; // npm genuinely absent; nothing to assert
  assert.ok(path.isAbsolute(npm));
  if (process.platform === "win32") assert.match(npm, /\.(cmd|bat|exe)$/i);
});

test("a batch shim at a path containing spaces still runs", async () => {
  // Dogfood run 7 died here. npm resolves to "C:\Program Files\nodejs\npm.CMD"; cmd re-parses
  // everything after /c, split on the first space, and reported
  //
  //   'C:\Program' is not recognized as an internal or external command
  //
  // so `npm ci` was recorded CHECK_FAILED -- a truthful record of a command that was invoked wrong.
  // The distinction the previous commit added worked exactly as designed and still could not save a
  // candidate from a broken invocation, because the invocation itself was the defect.
  if (process.platform !== "win32") return;

  const base = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave path with spaces-"));
  const shim = path.join(base, "echo tool.cmd");
  fs.writeFileSync(shim, "@echo off\r\necho ARG=%1\r\nexit /b 0\r\n");

  const result = await runCommand(`"${shim}" hello`, { cwd: base });
  assert.equal(result.ran, true, "a quoted path with spaces must reach cmd intact");
  assert.equal(result.exitCode, 0);
  // %1 carries the quoting cmd was handed, so the argument arrives as "hello" rather than hello.
  // What matters is that the shim executed and received the argument, not how cmd renders it.
  assert.match(result.stdout, /ARG="?hello"?/);
  assert.doesNotMatch(result.stdout, /is not recognized/);

  // And the real thing, which is what actually broke.
  const npm = await runCommand("npm --version", { cwd: process.cwd() });
  if (npm.ran) {
    assert.equal(npm.exitCode, 0, `npm must run through its shim: ${npm.stderr}`);
    assert.doesNotMatch(npm.stderr, /is not recognized as an internal or external command/);
    assert.match(npm.stdout, /\d+\.\d+\.\d+/);
  }

  fs.rmSync(base, { recursive: true, force: true });
});
