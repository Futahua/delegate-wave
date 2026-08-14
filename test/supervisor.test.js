import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildTaskXml, SUPERVISOR_TASK_NAME, WindowsSupervisor } from "../src/supervisor.js";

const configuredEnvironment = {
  USERDOMAIN: "MACHINE",
  USERNAME: "john",
  DELEGATE_WAVE_CONTROL_TOKEN: "operator-secret-must-not-leak",
  DELEGATE_WAVE_CONTROL_OBSERVER_TOKEN: "observer-secret-must-not-leak",
};

test("task definition is least privilege, restarts, and contains no credentials", () => {
  const document = buildTaskXml({
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    cliPath: "D:\\Code & Tools\\delegate-wave\\src\\cli.js",
    workingDirectory: "D:\\Code & Tools\\delegate-wave",
    principal: "MACHINE\\john",
    startBoundary: "2026-08-14T17:30:00",
  });
  assert.match(document, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(document, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(document, /<RestartOnFailure>[\s\S]*<Interval>PT1M<\/Interval>[\s\S]*<Count>5<\/Count>/);
  assert.match(document, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(document, /<TimeTrigger>[\s\S]*<Interval>PT1M<\/Interval>[\s\S]*<StartBoundary>2026-08-14T17:30:00<\/StartBoundary>/);
  assert.match(document, /D:\\Code &amp; Tools\\delegate-wave/);
  assert.ok(document.startsWith("<Task "), "schtasks must not be asked to switch XML encoding");
  assert.doesNotMatch(document, /DELEGATE_WAVE_CONTROL|operator-secret|observer-secret/);
});

test("install submits a temporary secret-free task definition then removes it", async () => {
  let submitted;
  const runner = async (args) => {
    assert.deepEqual(args.slice(0, 4), ["/Create", "/TN", SUPERVISOR_TASK_NAME, "/XML"]);
    submitted = fs.readFileSync(args[4], "utf8");
    assert.deepEqual(args.slice(5), ["/F"]);
    return { exitCode: 0, stdout: "SUCCESS", stderr: "" };
  };
  const supervisor = new WindowsSupervisor({ platform: "win32", runner, env: configuredEnvironment });
  assert.deepEqual(await supervisor.install({
    nodePath: "C:\\node.exe", cliPath: "D:\\repo\\src\\cli.js", workingDirectory: "D:\\repo",
  }), { installed: true, task_name: SUPERVISOR_TASK_NAME });
  assert.doesNotMatch(submitted, /operator-secret|observer-secret|DELEGATE_WAVE_CONTROL/);
});

test("install fails closed without a user control credential", async () => {
  let called = false;
  const supervisor = new WindowsSupervisor({
    platform: "win32",
    env: { USERNAME: "john" },
    runner: async () => { called = true; return { exitCode: 0, stdout: "", stderr: "" }; },
  });
  await assert.rejects(supervisor.install(), /CONTROL_TOKEN must be configured/);
  assert.equal(called, false);
});

test("status and lifecycle commands use only the fixed task identity", async () => {
  const calls = [];
  const runner = async (args) => {
    calls.push(args);
    return { exitCode: 0, stdout: "TaskName: delegate-wave-control", stderr: "" };
  };
  const supervisor = new WindowsSupervisor({ platform: "win32", runner, env: configuredEnvironment });
  assert.equal((await supervisor.status()).installed, true);
  await supervisor.start();
  await supervisor.stop();
  await supervisor.uninstall();
  assert.deepEqual(calls, [
    ["/Query", "/TN", SUPERVISOR_TASK_NAME, "/FO", "LIST", "/V"],
    ["/Run", "/TN", SUPERVISOR_TASK_NAME],
    ["/End", "/TN", SUPERVISOR_TASK_NAME],
    ["/Delete", "/TN", SUPERVISOR_TASK_NAME, "/F"],
  ]);
});

test("missing task is reported without guessing lifecycle state", async () => {
  const supervisor = new WindowsSupervisor({
    platform: "win32", env: configuredEnvironment,
    runner: async () => ({ exitCode: 1, stdout: "", stderr: "not found" }),
  });
  assert.deepEqual(await supervisor.status(), { installed: false, task_name: SUPERVISOR_TASK_NAME });
});

test("supervisor fails clearly outside Windows", async () => {
  const supervisor = new WindowsSupervisor({ platform: "linux", env: configuredEnvironment });
  await assert.rejects(supervisor.status(), /only on Windows/);
});

test("supervisor has no scheduler, storage, Control API, or MCP authority imports", () => {
  const sourcePath = fileURLToPath(new URL("../src/supervisor.js", import.meta.url));
  const source = fs.readFileSync(sourcePath, "utf8");
  assert.doesNotMatch(source, /from ["']\.\/(?:service|db|backend|control|mcp)/);
  assert.equal(path.basename(sourcePath), "supervisor.js");
});
