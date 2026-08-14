import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildTaskXml, DpapiSecretStore, PROTECTED_SECRET_FILE, REQUIRED_SECRET_ROLES, SECRET_RECORDS, SUPERVISOR_TASK_NAME,
  WindowsSupervisor,
} from "../src/supervisor.js";
import { CONTROL_AUTHORITY_NAMES } from "../src/process.js";

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

// Records each role's plaintext under its own ciphertext handle so a decrypt of one role can never
// return the other role's value.
function recordingDpapiRunner() {
  const sealed = new Map();
  const decrypted = [];
  let counter = 0;
  const processRunner = async (_command, _args, options) => {
    if (options.env?.DELEGATE_WAVE_SECRET_PAYLOAD) {
      const handle = `ciphertext-${++counter}`;
      sealed.set(handle, options.env.DELEGATE_WAVE_SECRET_PAYLOAD);
      return { exitCode: 0, stdout: handle, stderr: "" };
    }
    if (options.env?.DELEGATE_WAVE_SECRET_BLOB) {
      const handle = options.env.DELEGATE_WAVE_SECRET_BLOB;
      assert.ok(sealed.has(handle), `unknown ciphertext handle ${handle}`);
      decrypted.push(handle);
      return { exitCode: 0, stdout: sealed.get(handle), stderr: "" };
    }
    processRunner.cleared = true;
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  processRunner.cleared = false;
  processRunner.sealed = sealed;
  processRunner.decrypted = decrypted;
  return processRunner;
}

test("DPAPI store writes only ciphertext, clears persistent variables, and restores exact values", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-secret-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const processRunner = recordingDpapiRunner();
  const store = new DpapiSecretStore({ platform: "win32", root, processRunner });
  const environment = { ...configuredEnvironment };
  await store.provision(environment);
  assert.equal(processRunner.cleared, true);
  assert.equal("DELEGATE_WAVE_CONTROL_TOKEN" in environment, false);
  const stored = fs.readFileSync(path.join(root, "config", PROTECTED_SECRET_FILE), "utf8");
  assert.doesNotMatch(stored, /operator-secret|observer-secret|DELEGATE_WAVE/);
  assert.deepEqual(Object.keys(JSON.parse(stored).records).sort(), ["observer", "operator"]);
  assert.deepEqual(await store.load("operator"), {
    DELEGATE_WAVE_CONTROL_TOKEN: "operator-secret-must-not-leak",
  });
  assert.deepEqual(await store.load("observer"), {
    DELEGATE_WAVE_CONTROL_OBSERVER_TOKEN: "observer-secret-must-not-leak",
  });
});

test("each role is a separate blob, so loading one never decrypts the other", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-secret-scope-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const processRunner = recordingDpapiRunner();
  const store = new DpapiSecretStore({ platform: "win32", root, processRunner });
  await store.provision({ ...configuredEnvironment });

  const records = JSON.parse(fs.readFileSync(path.join(root, "config", PROTECTED_SECRET_FILE), "utf8")).records;
  assert.notEqual(records.operator, records.observer, "roles must not share one ciphertext");

  const observer = await store.load("observer");
  assert.deepEqual(processRunner.decrypted, [records.observer]);
  assert.equal(JSON.stringify(observer).includes("operator-secret-must-not-leak"), false);
  assert.equal("DELEGATE_WAVE_CONTROL_TOKEN" in observer, false);

  await assert.rejects(store.load("proposal"), /Unknown protected credential role/);
});

test("MCP startup unseals only the observer record and never the operator record", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-mcp-scope-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const processRunner = recordingDpapiRunner();
  const store = new DpapiSecretStore({ platform: "win32", root, processRunner });
  await store.provision({ ...configuredEnvironment });
  const operatorBlob = JSON.parse(
    fs.readFileSync(path.join(root, "config", PROTECTED_SECRET_FILE), "utf8"),
  ).records.operator;

  // Mirrors the clean-MCP path in cli.js.
  const environment = {};
  const observer = await store.load("observer");
  environment.DELEGATE_WAVE_HERMES_CONTROL_TOKEN = observer.DELEGATE_WAVE_CONTROL_OBSERVER_TOKEN;

  assert.equal(environment.DELEGATE_WAVE_HERMES_CONTROL_TOKEN, "observer-secret-must-not-leak");
  assert.equal(processRunner.decrypted.includes(operatorBlob), false,
    "the operator decrypt path must never be invoked by the MCP process");
  assert.equal("DELEGATE_WAVE_CONTROL_TOKEN" in environment, false);
});

// Seeds a store in the pre-migration format: one DPAPI blob carrying every credential.
function seedLegacyStore(root, processRunner, values) {
  const handle = `ciphertext-legacy`;
  processRunner.sealed.set(handle, JSON.stringify(values));
  const storePath = path.join(root, "config", PROTECTED_SECRET_FILE);
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, `${handle}\n`, "utf8");
  return storePath;
}

const legacyValues = {
  DELEGATE_WAVE_CONTROL_TOKEN: "operator-secret-must-not-leak",
  DELEGATE_WAVE_CONTROL_OBSERVER_TOKEN: "observer-secret-must-not-leak",
};

test("legacy combined bundle migrates to independently protected scoped records", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-migrate-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const processRunner = recordingDpapiRunner();
  const storePath = seedLegacyStore(root, processRunner, legacyValues);
  const store = new DpapiSecretStore({ platform: "win32", root, processRunner });

  assert.equal(store.isLegacyFormat(), true);
  assert.deepEqual(await store.migrateLegacyStore(), {
    migrated: true, path: storePath, roles: ["operator", "observer"],
  });
  assert.equal(store.isLegacyFormat(), false);

  const stored = fs.readFileSync(storePath, "utf8");
  assert.doesNotMatch(stored, /operator-secret|observer-secret|ciphertext-legacy/);
  const records = JSON.parse(stored).records;
  assert.notEqual(records.operator, records.observer);

  assert.deepEqual(await store.load("operator"), {
    DELEGATE_WAVE_CONTROL_TOKEN: "operator-secret-must-not-leak",
  });
  assert.deepEqual(await store.load("observer"), {
    DELEGATE_WAVE_CONTROL_OBSERVER_TOKEN: "observer-secret-must-not-leak",
  });
});

test("migration is idempotent and leaves an already-scoped store untouched", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-migrate-twice-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const processRunner = recordingDpapiRunner();
  const storePath = seedLegacyStore(root, processRunner, legacyValues);
  const store = new DpapiSecretStore({ platform: "win32", root, processRunner });

  await store.migrateLegacyStore();
  const afterFirst = fs.readFileSync(storePath, "utf8");
  assert.deepEqual(await store.migrateLegacyStore(), { migrated: false, path: storePath });
  assert.equal(fs.readFileSync(storePath, "utf8"), afterFirst, "a second migration must not rewrite the store");
});

test("a legacy store never migrates via load, so MCP cannot decrypt the combined bundle", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-migrate-mcp-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const processRunner = recordingDpapiRunner();
  const storePath = seedLegacyStore(root, processRunner, legacyValues);
  const store = new DpapiSecretStore({ platform: "win32", root, processRunner });

  await assert.rejects(store.load("observer"), /legacy combined format[\s\S]*migrate-secrets/);
  assert.deepEqual(processRunner.decrypted, [], "the combined bundle must never be decrypted by a load");
  assert.equal(store.isLegacyFormat(), true, "a refused load must not mutate the store");
  assert.match(fs.readFileSync(storePath, "utf8"), /ciphertext-legacy/);

  await assert.rejects(store.load("operator"), /legacy combined format/);
  assert.deepEqual(processRunner.decrypted, []);
});

test("a failed re-protect leaves the readable legacy store in place", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-migrate-fail-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const processRunner = recordingDpapiRunner();
  const storePath = seedLegacyStore(root, processRunner, legacyValues);
  const failing = async (command, args, options) => {
    if (options.env?.DELEGATE_WAVE_SECRET_PAYLOAD) return { exitCode: 1, stdout: "", stderr: "DPAPI unavailable" };
    return processRunner(command, args, options);
  };
  const store = new DpapiSecretStore({ platform: "win32", root, processRunner: failing });

  await assert.rejects(store.migrateLegacyStore(), /Unable to protect/);
  assert.equal(store.isLegacyFormat(), true);
  assert.match(fs.readFileSync(storePath, "utf8"), /ciphertext-legacy/);
});

test("provisioning refuses to create a store missing a required role", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-partial-install-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const processRunner = recordingDpapiRunner();
  const store = new DpapiSecretStore({ platform: "win32", root, processRunner });

  await assert.rejects(
    store.provision({ DELEGATE_WAVE_CONTROL_TOKEN: "operator-secret-must-not-leak" }),
    /missing required credentials: observer \(DELEGATE_WAVE_CONTROL_OBSERVER_TOKEN\)/,
  );
  assert.equal(store.exists(), false, "a refused install must not leave a partial store");
  assert.deepEqual(processRunner.sealed.size, 0, "validation must precede any DPAPI work");
});

test("an operator-only install cannot report success and then fail at supervised start", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-deferred-fail-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const processRunner = recordingDpapiRunner();
  const store = new DpapiSecretStore({ platform: "win32", root, processRunner });
  const supervisor = new WindowsSupervisor({ platform: "win32", root, secretStore: store });

  // The failure must surface at install, not be deferred to the next launch.
  await assert.rejects(store.provision({ DELEGATE_WAVE_CONTROL_TOKEN: "operator-only" }), /missing required credentials/);
  await assert.rejects(supervisor.runtimeEnvironment(), /store is missing/);

  // A complete install starts cleanly.
  await store.provision({ ...configuredEnvironment });
  assert.deepEqual(await supervisor.runtimeEnvironment(), {
    DELEGATE_WAVE_CONTROL_TOKEN: "operator-secret-must-not-leak",
    DELEGATE_WAVE_CONTROL_OBSERVER_TOKEN: "observer-secret-must-not-leak",
  });
});

test("reusing an existing store missing a required role fails before the task is created", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-partial-reuse-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storePath = path.join(root, "config", PROTECTED_SECRET_FILE);
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const seeded = `${JSON.stringify({ version: 1, records: { operator: "ciphertext-operator" } }, null, 2)}\n`;
  fs.writeFileSync(storePath, seeded, "utf8");

  const calls = [];
  const store = new DpapiSecretStore({ platform: "win32", root, processRunner: async () => {
    assert.fail("reuse validation must not decrypt or re-protect anything");
  } });
  const supervisor = new WindowsSupervisor({
    platform: "win32", root, secretStore: store,
    env: { USERDOMAIN: "MACHINE", USERNAME: "john" },
    runner: async (args) => { calls.push(args[0]); return { exitCode: 0, stdout: "", stderr: "" }; },
  });

  // A clean reinstall environment carries no plaintext operator token.
  await assert.rejects(
    supervisor.install({ nodePath: "C:\\node.exe", cliPath: "D:\\repo\\src\\cli.js", workingDirectory: "D:\\repo" }),
    /missing required roles: observer/,
  );
  assert.deepEqual(calls, [], "the task must not be created when the store cannot start the API");
  assert.equal(fs.readFileSync(storePath, "utf8"), seeded, "a refused install must not mutate the store");
});

test("reusing a complete existing store still succeeds without re-encrypting", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-complete-reuse-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const processRunner = recordingDpapiRunner();
  const store = new DpapiSecretStore({ platform: "win32", root, processRunner });
  await store.provision({ ...configuredEnvironment });
  const before = fs.readFileSync(store.path, "utf8");

  assert.deepEqual(await store.provision({}), { provisioned: false, path: store.path });
  assert.equal(fs.readFileSync(store.path, "utf8"), before, "reuse must leave a complete store untouched");
});

test("a legacy store is left to the entitled migration path rather than refused on reuse", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-legacy-reuse-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const processRunner = recordingDpapiRunner();
  const storePath = seedLegacyStore(root, processRunner, legacyValues);
  const store = new DpapiSecretStore({ platform: "win32", root, processRunner });

  assert.deepEqual(await store.provision({}), { provisioned: false, path: storePath });
  assert.deepEqual(processRunner.decrypted, [], "reuse must not decrypt a legacy bundle to inspect it");
  assert.equal(store.isLegacyFormat(), true);
});

test("migration refuses a legacy bundle missing a required role", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-partial-migrate-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const processRunner = recordingDpapiRunner();
  const storePath = seedLegacyStore(root, processRunner, {
    DELEGATE_WAVE_CONTROL_TOKEN: "operator-secret-must-not-leak",
  });
  const store = new DpapiSecretStore({ platform: "win32", root, processRunner });

  await assert.rejects(store.migrateLegacyStore(), /missing required credentials: observer/);
  assert.equal(store.isLegacyFormat(), true, "a refused migration must leave the legacy store readable");
  assert.match(fs.readFileSync(storePath, "utf8"), /ciphertext-legacy/);
});

test("the runtime loads exactly the roles declared required", async () => {
  const loaded = [];
  const supervisor = new WindowsSupervisor({
    platform: "win32", env: configuredEnvironment,
    secretStore: { load: async (role) => { loaded.push(role); return { [`TOKEN_${role}`]: role }; } },
  });
  await supervisor.runtimeEnvironment();
  assert.deepEqual(loaded, REQUIRED_SECRET_ROLES);
  assert.deepEqual(REQUIRED_SECRET_ROLES, ["operator", "observer"]);
});

test("store replacement leaves no temporary residue and never truncates the live path", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-store-atomic-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const processRunner = recordingDpapiRunner();
  const store = new DpapiSecretStore({ platform: "win32", root, processRunner });
  const configDirectory = path.join(root, "config");

  await store.provision({ ...configuredEnvironment });
  const first = fs.readFileSync(store.path, "utf8");

  // Replacing an existing store must succeed and must not leave a .tmp sibling behind.
  store.writeStore({ operator: "ciphertext-replacement" });
  assert.deepEqual(fs.readdirSync(configDirectory), [PROTECTED_SECRET_FILE]);
  assert.equal(JSON.parse(fs.readFileSync(store.path, "utf8")).records.operator, "ciphertext-replacement");
  assert.notEqual(fs.readFileSync(store.path, "utf8"), first);

  // A store is always parseable: the live path is never observed mid-write.
  assert.equal(JSON.parse(fs.readFileSync(store.path, "utf8")).version, 1);
});

test("a failed store write preserves the previous credential store", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-store-preserve-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const processRunner = recordingDpapiRunner();
  const store = new DpapiSecretStore({ platform: "win32", root, processRunner });

  await store.provision({ ...configuredEnvironment });
  const before = fs.readFileSync(store.path, "utf8");

  const originalRename = fs.renameSync;
  fs.renameSync = () => { throw new Error("simulated volume failure"); };
  t.after(() => { fs.renameSync = originalRename; });

  assert.throws(() => store.writeStore({ operator: "never-lands" }), /simulated volume failure/);
  assert.equal(fs.readFileSync(store.path, "utf8"), before, "the previous store must survive a failed replacement");
  assert.deepEqual(fs.readdirSync(path.join(root, "config")), [PROTECTED_SECRET_FILE]);
});

test("supervisor migrate-secrets is explicit and refuses outside Windows", async () => {
  const supervisor = new WindowsSupervisor({
    platform: "linux", env: configuredEnvironment,
    secretStore: { migrateLegacyStore: async () => assert.fail("must not run off Windows") },
  });
  await assert.rejects(supervisor.migrateSecrets(), /only on Windows/);
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
    ["/Change", "/TN", SUPERVISOR_TASK_NAME, "/DISABLE"],
    ["/End", "/TN", SUPERVISOR_TASK_NAME],
    ["/Delete", "/TN", SUPERVISOR_TASK_NAME, "/F"],
  ]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("uninstall stops the supervised runtime before deleting the task", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-uninstall-orphan-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  let alive = true;
  let aliveAtDelete = null;
  const supervisor = new WindowsSupervisor({
    platform: "win32", root, env: configuredEnvironment,
    runner: async (args) => {
      calls.push(args[0]);
      if (args[0] === "/End") alive = false;
      if (args[0] === "/Delete") aliveAtDelete = alive;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    processProbe: () => alive,
    delay: async () => {},
  });
  supervisor.recordRuntimePid(47321);

  assert.deepEqual(await supervisor.uninstall(), { uninstalled: true, task_name: SUPERVISOR_TASK_NAME });
  assert.deepEqual(calls, ["/Change", "/End", "/Delete"]);
  assert.equal(aliveAtDelete, false, "the API must be dead before the task is deleted");
});

test("uninstall refuses to delete the task while the recorded API is still alive", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-uninstall-stuck-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const supervisor = new WindowsSupervisor({
    platform: "win32", root, env: configuredEnvironment,
    runner: async (args) => { calls.push(args[0]); return { exitCode: 0, stdout: "", stderr: "" }; },
    processProbe: () => true,
    delay: async () => {},
    stopTimeoutMs: 50,
  });
  supervisor.recordRuntimePid(47321);

  await assert.rejects(supervisor.uninstall(), /PID 47321 did not exit/);
  assert.equal(calls.includes("/Delete"), false, "an orphan API must not be abandoned by deleting the task");
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

test("supervisor runtime loads both roles by scoped record and excludes the Hermes client credential", async () => {
  const roles = [];
  const supervisor = new WindowsSupervisor({
    platform: "win32",
    env: configuredEnvironment,
    secretStore: { load: async (role) => {
      roles.push(role);
      if (role === "operator") return { DELEGATE_WAVE_CONTROL_TOKEN: "operator" };
      return {
        DELEGATE_WAVE_CONTROL_OBSERVER_TOKEN: "observer",
        DELEGATE_WAVE_HERMES_CONTROL_TOKEN: "observer",
      };
    } },
  });
  assert.deepEqual(await supervisor.runtimeEnvironment(), {
    DELEGATE_WAVE_CONTROL_TOKEN: "operator",
    DELEGATE_WAVE_CONTROL_OBSERVER_TOKEN: "observer",
  });
  assert.deepEqual(roles, ["operator", "observer"]);
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

test("clean MCP startup prefers the proposer record and decrypts only it", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-mcp-proposer-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const processRunner = recordingDpapiRunner();
  const store = new DpapiSecretStore({ platform: "win32", root, processRunner });
  await store.provision({
    ...configuredEnvironment,
    DELEGATE_WAVE_CONTROL_PROPOSER_TOKEN: "proposer-secret-must-not-leak",
  });
  const records = JSON.parse(fs.readFileSync(store.path, "utf8")).records;
  assert.deepEqual(Object.keys(records).sort(), ["observer", "operator", "proposer"]);

  // Mirrors the clean-MCP path in cli.js once a proposal credential is provisioned.
  assert.equal(store.hasRecord("proposer"), true);
  const environment = {};
  const proposer = await store.load("proposer");
  environment.DELEGATE_WAVE_HERMES_CONTROL_TOKEN = proposer.DELEGATE_WAVE_CONTROL_PROPOSER_TOKEN;

  assert.equal(environment.DELEGATE_WAVE_HERMES_CONTROL_TOKEN, "proposer-secret-must-not-leak");
  assert.deepEqual(processRunner.decrypted, [records.proposer]);
  assert.equal(processRunner.decrypted.includes(records.operator), false);
  assert.equal(processRunner.decrypted.includes(records.observer), false);
});

test("an installation without a proposer record keeps Hermes read-only", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-mcp-no-proposer-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const processRunner = recordingDpapiRunner();
  const store = new DpapiSecretStore({ platform: "win32", root, processRunner });
  await store.provision({ ...configuredEnvironment });

  assert.equal(store.hasRecord("proposer"), false);
  const observer = await store.load("observer");
  assert.equal(observer.DELEGATE_WAVE_CONTROL_OBSERVER_TOKEN, "observer-secret-must-not-leak");
  const records = JSON.parse(fs.readFileSync(store.path, "utf8")).records;
  assert.equal(processRunner.decrypted.includes(records.operator), false);
});

test("provisioning still succeeds without the optional proposer credential", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-optional-role-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new DpapiSecretStore({ platform: "win32", root, processRunner: recordingDpapiRunner() });
  const result = await store.provision({ ...configuredEnvironment });
  assert.equal(result.provisioned, true);
  assert.deepEqual(store.missingRequiredRecords(), []);
});

test("adding a role seals it without decrypting the existing credentials", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-add-role-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const processRunner = recordingDpapiRunner();
  const store = new DpapiSecretStore({ platform: "win32", root, processRunner });
  await store.provision({ ...configuredEnvironment });
  const before = JSON.parse(fs.readFileSync(store.path, "utf8")).records;

  const environment = { DELEGATE_WAVE_CONTROL_PROPOSER_TOKEN: "proposer-secret-must-not-leak" };
  assert.deepEqual(await store.addRole("proposer", environment), {
    added: true, role: "proposer", path: store.path,
  });

  // Nothing was decrypted: the operator and observer ciphertexts were carried across untouched.
  assert.deepEqual(processRunner.decrypted, []);
  const after = JSON.parse(fs.readFileSync(store.path, "utf8")).records;
  assert.equal(after.operator, before.operator);
  assert.equal(after.observer, before.observer);
  assert.ok(after.proposer);
  assert.equal("DELEGATE_WAVE_CONTROL_PROPOSER_TOKEN" in environment, false, "plaintext must be cleared");

  assert.deepEqual(await store.load("proposer"), {
    DELEGATE_WAVE_CONTROL_PROPOSER_TOKEN: "proposer-secret-must-not-leak",
  });
  assert.equal(store.hasRecord("proposer"), true);
});

test("adding a role is idempotent and validates its inputs", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-add-role-guard-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const processRunner = recordingDpapiRunner();
  const store = new DpapiSecretStore({ platform: "win32", root, processRunner });
  await store.provision({ ...configuredEnvironment });

  await assert.rejects(store.addRole("proposer", {}), /DELEGATE_WAVE_CONTROL_PROPOSER_TOKEN is required/);
  await assert.rejects(store.addRole("nonsense", {}), /Unknown protected credential role/);

  await store.addRole("proposer", { DELEGATE_WAVE_CONTROL_PROPOSER_TOKEN: "first" });
  const sealed = fs.readFileSync(store.path, "utf8");
  assert.deepEqual(await store.addRole("proposer", { DELEGATE_WAVE_CONTROL_PROPOSER_TOKEN: "second" }), {
    added: false, role: "proposer", path: store.path,
  });
  assert.equal(fs.readFileSync(store.path, "utf8"), sealed, "an existing role must not be silently replaced");
});

test("add-role clears supplied credential material on the no-op path too", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-add-role-hygiene-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cleared = [];
  const base = recordingDpapiRunner();
  const processRunner = async (command, args, options) => {
    if (!options.env?.DELEGATE_WAVE_SECRET_PAYLOAD && !options.env?.DELEGATE_WAVE_SECRET_BLOB) {
      cleared.push(String(args.at(-1)));
    }
    return base(command, args, options);
  };
  const store = new DpapiSecretStore({ platform: "win32", root, processRunner });
  await store.provision({ ...configuredEnvironment });
  cleared.length = 0;

  const first = { DELEGATE_WAVE_CONTROL_PROPOSER_TOKEN: "seal-me" };
  assert.equal((await store.addRole("proposer", first)).added, true);
  assert.equal("DELEGATE_WAVE_CONTROL_PROPOSER_TOKEN" in first, false);
  assert.equal(cleared.length, 1, "a successful add must clear persistent values");
  assert.match(cleared[0], /DELEGATE_WAVE_CONTROL_PROPOSER_TOKEN/);
  assert.match(cleared[0], /DELEGATE_WAVE_CONTROL_PROPOSER_PRINCIPAL/);

  // The no-op path must not leave the supplied plaintext behind either.
  const second = { DELEGATE_WAVE_CONTROL_PROPOSER_TOKEN: "already-present" };
  assert.equal((await store.addRole("proposer", second)).added, false);
  assert.equal("DELEGATE_WAVE_CONTROL_PROPOSER_TOKEN" in second, false, "a no-op add must still clear plaintext");
  assert.equal(cleared.length, 2, "a no-op add must still clear persistent values");
});

test("every declared credential role is scrubbed from child processes", () => {
  // Guards CTL-AUTH-005 structurally: a role declared without child scrubbing must be impossible.
  for (const record of Object.values(SECRET_RECORDS)) {
    for (const name of record.names) {
      assert.ok(
        CONTROL_AUTHORITY_NAMES.includes(name),
        `${name} is a credential variable but is not scrubbed from child processes`,
      );
    }
  }
  assert.ok(CONTROL_AUTHORITY_NAMES.includes("DELEGATE_WAVE_HERMES_CONTROL_TOKEN"));
});
