import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildTaskXml, DpapiSecretStore, PROTECTED_SECRET_FILE, SUPERVISOR_TASK_NAME, WindowsSupervisor,
} from "../src/supervisor.js";

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
  assert.match(document, /cli\.js&quot; supervisor run/);
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
  const secretStore = { provision: async () => ({ provisioned: true }) };
  const supervisor = new WindowsSupervisor({ platform: "win32", runner, env: configuredEnvironment, secretStore });
  assert.deepEqual(await supervisor.install({
    nodePath: "C:\\node.exe", cliPath: "D:\\repo\\src\\cli.js", workingDirectory: "D:\\repo",
  }), { installed: true, task_name: SUPERVISOR_TASK_NAME });
  assert.doesNotMatch(submitted, /operator-secret|observer-secret|DELEGATE_WAVE_CONTROL/);
});

test("protected store fails closed without a credential or existing bundle", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-secret-missing-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new DpapiSecretStore({ platform: "win32", root, processRunner: async () => {
    throw new Error("must not run");
  } });
  await assert.rejects(store.provision({}), /CONTROL_TOKEN is required/);
});

test("DPAPI store writes only ciphertext, clears persistent variables, and restores exact values", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-secret-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let protectedPayload;
  let cleared = false;
  const processRunner = async (_command, _args, options) => {
    if (options.env?.DELEGATE_WAVE_SECRET_PAYLOAD) {
      protectedPayload = options.env.DELEGATE_WAVE_SECRET_PAYLOAD;
      return { exitCode: 0, stdout: "ciphertext-only", stderr: "" };
    }
    if (options.env?.DELEGATE_WAVE_SECRET_BLOB) {
      assert.equal(options.env.DELEGATE_WAVE_SECRET_BLOB, "ciphertext-only");
      return { exitCode: 0, stdout: protectedPayload, stderr: "" };
    }
    cleared = true;
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const store = new DpapiSecretStore({ platform: "win32", root, processRunner });
  const environment = { ...configuredEnvironment };
  await store.provision(environment);
  assert.equal(cleared, true);
  assert.equal("DELEGATE_WAVE_CONTROL_TOKEN" in environment, false);
  const stored = fs.readFileSync(path.join(root, "config", PROTECTED_SECRET_FILE), "utf8");
  assert.equal(stored.trim(), "ciphertext-only");
  assert.doesNotMatch(stored, /operator-secret|observer-secret|DELEGATE_WAVE/);
  assert.deepEqual(await store.load(), {
    DELEGATE_WAVE_CONTROL_TOKEN: "operator-secret-must-not-leak",
    DELEGATE_WAVE_CONTROL_OBSERVER_TOKEN: "observer-secret-must-not-leak",
  });
});

test("status and lifecycle commands use only the fixed task identity", async () => {
  const calls = [];
  const runner = async (args) => {
    calls.push(args);
    return { exitCode: 0, stdout: "TaskName: delegate-wave-control", stderr: "" };
  };
  const secretStore = { provision: async () => ({ provisioned: true }) };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-supervisor-lifecycle-"));
  const supervisor = new WindowsSupervisor({ platform: "win32", runner, env: configuredEnvironment, secretStore, root });
  assert.equal((await supervisor.status()).installed, true);
  await supervisor.start();
  await supervisor.stop();
  await supervisor.uninstall();
  assert.deepEqual(calls, [
    ["/Query", "/TN", SUPERVISOR_TASK_NAME, "/FO", "LIST", "/V"],
    ["/Change", "/TN", SUPERVISOR_TASK_NAME, "/ENABLE"],
    ["/Run", "/TN", SUPERVISOR_TASK_NAME],
    ["/Change", "/TN", SUPERVISOR_TASK_NAME, "/DISABLE"],
    ["/End", "/TN", SUPERVISOR_TASK_NAME],
    ["/Delete", "/TN", SUPERVISOR_TASK_NAME, "/F"],
  ]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("stop waits for the exact recorded runtime PID to exit", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-supervisor-pid-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const probes = [];
  let remainingAliveChecks = 2;
  const supervisor = new WindowsSupervisor({
    platform: "win32", root,
    runner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    processProbe: (pid) => { probes.push(pid); return remainingAliveChecks-- > 0; },
    delay: async () => {},
  });
  supervisor.recordRuntimePid(12345);
  await supervisor.stop();
  assert.deepEqual(probes, [12345, 12345, 12345]);
});

test("missing task is reported without guessing lifecycle state", async () => {
  const supervisor = new WindowsSupervisor({
    platform: "win32", env: configuredEnvironment,
    runner: async () => ({ exitCode: 1, stdout: "", stderr: "not found" }),
  });
  assert.deepEqual(await supervisor.status(), { installed: false, task_name: SUPERVISOR_TASK_NAME });
});

test("supervisor runtime excludes the Hermes client-only credential", async () => {
  const supervisor = new WindowsSupervisor({
    platform: "win32",
    env: configuredEnvironment,
    secretStore: { load: async () => ({
      DELEGATE_WAVE_CONTROL_TOKEN: "operator",
      DELEGATE_WAVE_CONTROL_OBSERVER_TOKEN: "observer",
      DELEGATE_WAVE_HERMES_CONTROL_TOKEN: "observer",
    }) },
  });
  assert.deepEqual(await supervisor.runtimeEnvironment(), {
    DELEGATE_WAVE_CONTROL_TOKEN: "operator",
    DELEGATE_WAVE_CONTROL_OBSERVER_TOKEN: "observer",
  });
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
