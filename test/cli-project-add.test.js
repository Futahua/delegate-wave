import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseProjectAddArgs } from "../src/cli/project-add.js";
import { initializeDataRoot } from "../src/db.js";
import { Dispatcher } from "../src/service.js";
import { ControlService } from "../src/control/service.js";
import { createControlServer } from "../src/control/server.js";
import { runProcess } from "../src/process.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const base = ["project", "add", "--name", "demo", "--path", "D:\\demo repo"];
const invalid = [
  ["unquoted multiword command", ["--validate", "npm", "test"]],
  ["unquoted command flags", ["--validate", "node", "--test"]],
  ["trailing words", ["--validate", "npm test", "extra"]],
  ["missing validation value", ["--validate"]],
  ["missing value before next option", ["--validate", "--protect", "src/**"]],
  ["empty validation value", ["--validate", ""]],
  ["blank validation value", ["--validate=   "]],
  ["misspelled validation flag", ["--vaidate", "npm test"]],
  ["duplicate scalar", ["--branch", "main", "--branch", "other"]],
  ["extra words after separator", ["--", "npm", "test"]],
];

for (const [label, args] of invalid) {
  test(`project add rejects ${label} with quoting guidance`, () => {
    assert.throws(() => parseProjectAddArgs([...base, ...args]), /Quote each complete validation command/);
  });
}

test("project add retains exact command strings, order, repeated checks, and equals syntax", () => {
  const commands = ["npm test", 'node --test "test/my test.js"', "git diff --exit-code -- public"];
  const parsed = parseProjectAddArgs([...base,
    "--validate", commands[0], `--validate=${commands[1]}`, "--validate", commands[2],
    "--protect", "src/**", "--protect=secrets/**", "--request-id=req-test"]);
  assert.deepEqual(parsed.validate, commands);
  assert.deepEqual(parsed.protect, ["src/**", "secrets/**"]);
  assert.equal(parsed.path, "D:\\demo repo");
  assert.equal(parsed["request-id"], "req-test");
});

test("project add permits no checks or a single executable and rejects missing required fields", () => {
  assert.equal(parseProjectAddArgs(base).validate, undefined);
  assert.deepEqual(parseProjectAddArgs([...base, "--validate", "verify"]).validate, ["verify"]);
  assert.throws(() => parseProjectAddArgs(["project", "add", "--path", "/repo"]), /Missing --name/);
  assert.throws(() => parseProjectAddArgs(["project", "add", "--name", "demo"]), /Missing --path/);
});

test("spawned CLI rejects ambiguous input before HTTP and persists quoted validation exactly", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "dw-cli-registration-"));
  const repo = path.join(temp, "repo with spaces");
  fs.mkdirSync(repo);
  for (const args of [["init", "-b", "main"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"], ["commit", "--allow-empty", "-m", "initial"]]) {
    const result = await runProcess("git", ["-C", repo, ...args]);
    assert.equal(result.exitCode, 0, result.stderr);
  }
  const root = path.join(temp, "data");
  initializeDataRoot(root);
  const dispatcher = new Dispatcher({ root });
  const server = createControlServer({ service: new ControlService({ dispatcher }), token: "test-cli-token", principalId: "test-operator" });
  let requests = 0;
  server.on("request", () => { requests += 1; });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections(); await closed;
    dispatcher.close(); fs.rmSync(temp, { recursive: true, force: true });
  });
  const options = { env: {
    DELEGATE_WAVE_CONTROL_URL: `http://127.0.0.1:${server.address().port}`,
    DELEGATE_WAVE_CONTROL_TOKEN: "test-cli-token",
  }, timeoutMs: 10_000 };
  const argv = [cli, "project", "add", "--name", "demo", "--path", repo];
  for (const [, args] of invalid) {
    const result = await runProcess(process.execPath, [...argv, ...args], options);
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /Quote each complete validation command/);
    assert.doesNotMatch(result.stderr, /request_id:/);
  }
  assert.equal(requests, 0, "ambiguous input must never reach the control server");
  assert.equal(dispatcher.listProjects().length, 0);
  assert.equal(dispatcher.db.prepare("SELECT COUNT(*) n FROM control_request_intents").get().n, 0);

  const commands = ["npm test", 'node --test "test/my test.js"'];
  const args = [...argv, "--validate", commands[0], `--validate=${commands[1]}`, "--request-id", "req-cli-register"];
  const result = await runProcess(process.execPath, args, options);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(requests, 1);
  const project = JSON.parse(result.stdout);
  assert.deepEqual(JSON.parse(project.validation_json), commands);
  assert.deepEqual(JSON.parse(dispatcher.getProject(project.id).validation_json), commands);
  const replay = await runProcess(process.execPath, args, options);
  assert.equal(replay.exitCode, 0, replay.stderr);
  assert.equal(JSON.parse(replay.stdout).id, project.id);
  assert.equal(dispatcher.listProjects().length, 1);
});
