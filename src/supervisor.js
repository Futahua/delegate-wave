import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataRoot } from "./paths.js";
import { runProcess } from "./process.js";

export const SUPERVISOR_TASK_NAME = "delegate-wave-control";
export const PROTECTED_SECRET_FILE = "control-secrets.dpapi";
export const RUNTIME_PID_FILE = "control-api.pid";

const OPERATOR_SECRET_NAMES = [
  "DELEGATE_WAVE_CONTROL_TOKEN",
  "DELEGATE_WAVE_CONTROL_PRINCIPAL",
];

const OBSERVER_SECRET_NAMES = [
  "DELEGATE_WAVE_CONTROL_OBSERVER_TOKEN",
  "DELEGATE_WAVE_CONTROL_OBSERVER_PRINCIPAL",
];

const PROPOSER_SECRET_NAMES = [
  "DELEGATE_WAVE_CONTROL_PROPOSER_TOKEN",
  "DELEGATE_WAVE_CONTROL_PROPOSER_PRINCIPAL",
];

// Each record is protected as its own DPAPI blob so that a process may decrypt the credential it
// needs without ever materializing the credential it must not hold (SUP-005).
//
// `required: true` means the supervised runtime loads this role unconditionally, so a store without
// it cannot start the API. Provisioning and migration validate the required set up front rather than
// silently skipping a role and deferring the failure to the next launch. Adding a role here — a
// proposal principal, for example — extends that validation automatically.
export const SECRET_RECORDS = {
  operator: { names: OPERATOR_SECRET_NAMES, token: "DELEGATE_WAVE_CONTROL_TOKEN", required: true },
  observer: { names: OBSERVER_SECRET_NAMES, token: "DELEGATE_WAVE_CONTROL_OBSERVER_TOKEN", required: true },
  // Staged deliberately as optional: existing installations were provisioned before this role
  // existed and must keep validating. Flipping this to `required: true` once installs provision a
  // proposal credential is an explicit cutover, not something "optional" silently becomes.
  proposer: { names: PROPOSER_SECRET_NAMES, token: "DELEGATE_WAVE_CONTROL_PROPOSER_TOKEN", required: false },
};

export const REQUIRED_SECRET_ROLES = Object.entries(SECRET_RECORDS)
  .filter(([, record]) => record.required)
  .map(([role]) => role);

// Collects each role's values from a flat credential map, failing closed if a required role is
// missing its token.
function collectRoleRecords(source, describe) {
  const collected = {};
  const missing = [];
  for (const [role, record] of Object.entries(SECRET_RECORDS)) {
    const values = Object.fromEntries(record.names
      .filter((name) => source[name])
      .map((name) => [name, source[name]]));
    if (!values[record.token]) {
      if (record.required) missing.push(`${role} (${record.token})`);
      continue;
    }
    collected[role] = values;
  }
  if (missing.length) throw new Error(`${describe} is missing required credentials: ${missing.join(", ")}`);
  return collected;
}

const CONTROL_SECRET_NAMES = [...OPERATOR_SECRET_NAMES, ...OBSERVER_SECRET_NAMES];

const PERSISTENT_CONTROL_NAMES = [
  ...CONTROL_SECRET_NAMES,
  "DELEGATE_WAVE_HERMES_CONTROL_TOKEN",
];

const PROTECT_SCRIPT = `
Add-Type -AssemblyName System.Security
$bytes = [Text.Encoding]::UTF8.GetBytes($env:DELEGATE_WAVE_SECRET_PAYLOAD)
$protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($protected)
`;

const UNPROTECT_SCRIPT = `
Add-Type -AssemblyName System.Security
$protected = [Convert]::FromBase64String($env:DELEGATE_WAVE_SECRET_BLOB)
$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Text.Encoding]::UTF8.GetString($bytes)
`;

const CLEAR_USER_ENVIRONMENT_SCRIPT = `
$names = @(
  'DELEGATE_WAVE_CONTROL_TOKEN',
  'DELEGATE_WAVE_CONTROL_OBSERVER_TOKEN',
  'DELEGATE_WAVE_HERMES_CONTROL_TOKEN',
  'DELEGATE_WAVE_CONTROL_PRINCIPAL',
  'DELEGATE_WAVE_CONTROL_OBSERVER_PRINCIPAL'
)
foreach ($name in $names) {
  [Environment]::SetEnvironmentVariable($name, $null, [EnvironmentVariableTarget]::User)
}
`;

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function supervisorPaths() {
  const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
  return { cliPath, workingDirectory: path.dirname(path.dirname(cliPath)) };
}

export function currentWindowsPrincipal(env = process.env) {
  if (!env.USERNAME) throw new Error("Windows user identity is unavailable");
  return env.USERDOMAIN ? `${env.USERDOMAIN}\\${env.USERNAME}` : env.USERNAME;
}

function localStartBoundary(now = new Date()) {
  const local = new Date(now.getTime() - (now.getTimezoneOffset() * 60_000));
  return local.toISOString().slice(0, 19);
}

export function buildTaskXml({
  nodePath = process.execPath,
  cliPath = supervisorPaths().cliPath,
  workingDirectory = supervisorPaths().workingDirectory,
  principal = currentWindowsPrincipal(),
  startBoundary = localStartBoundary(),
} = {}) {
  return `<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Runs the delegate-wave loopback Control API for the interactive user.</Description>
    <URI>\\${SUPERVISOR_TASK_NAME}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xml(principal)}</UserId>
    </LogonTrigger>
    <TimeTrigger>
      <Repetition>
        <Interval>PT1M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>${xml(startBoundary)}</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(principal)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>5</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(nodePath)}</Command>
      <Arguments>&quot;${xml(cliPath)}&quot; supervisor run</Arguments>
      <WorkingDirectory>${xml(workingDirectory)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

async function defaultRunner(args) {
  return runProcess("schtasks.exe", args, { timeoutMs: 30_000 });
}

async function defaultProcessRunner(command, args, options) {
  return runProcess(command, args, options);
}

function defaultProcessProbe(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

const defaultDelay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function requireWindows(platform) {
  if (platform !== "win32") throw new Error("The delegate-wave supervisor is available only on Windows");
}

function taskError(action, result) {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
  return new Error(`Unable to ${action} Windows task ${SUPERVISOR_TASK_NAME}: ${detail}`);
}

export class DpapiSecretStore {
  constructor({ platform = process.platform, root = dataRoot(), processRunner = defaultProcessRunner } = {}) {
    this.platform = platform;
    this.path = path.join(root, "config", PROTECTED_SECRET_FILE);
    this.processRunner = processRunner;
  }

  exists() {
    return fs.existsSync(this.path);
  }

  // A legacy store is a bare DPAPI base64 blob holding every credential in one payload. The scoped
  // format is a JSON envelope of independently protected per-role blobs.
  isLegacyFormat() {
    if (!this.exists()) return false;
    const raw = fs.readFileSync(this.path, "utf8").trim();
    if (!raw.startsWith("{")) return true;
    try {
      const parsed = JSON.parse(raw);
      return !(parsed && parsed.version === 1 && parsed.records);
    } catch {
      return true;
    }
  }

  readRecords() {
    const parsed = JSON.parse(fs.readFileSync(this.path, "utf8"));
    if (!parsed || typeof parsed !== "object" || parsed.version !== 1 || !parsed.records) {
      throw new Error(`Protected supervisor credential store is malformed: ${this.path}`);
    }
    return parsed.records;
  }

  // This file gates reboot recovery, so the live path must never be observable in a truncated or
  // half-written state. Write to a sibling temporary on the same filesystem, flush it to disk, then
  // replace by rename -- a same-volume rename is atomic, whereas copying over the live path would
  // truncate it first and lose the credentials if the process died mid-write.
  writeStore(records) {
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    let handle;
    try {
      handle = fs.openSync(temporary, "wx", 0o600);
      fs.writeSync(handle, `${JSON.stringify({ version: 1, records }, null, 2)}\n`);
      fs.fsyncSync(handle);
      fs.closeSync(handle);
      handle = undefined;
      fs.renameSync(temporary, this.path);
    } finally {
      if (handle !== undefined) fs.closeSync(handle);
      fs.rmSync(temporary, { force: true });
    }
  }

  // One-time upgrade of a legacy combined bundle. This is the ONLY code path permitted to decrypt
  // every credential at once, so it MUST be invoked explicitly and only by a process already
  // entitled to all roles (the supervisor). It is deliberately NOT reachable from load(), because a
  // lazy migration inside load() would let the Hermes MCP process decrypt the operator credential —
  // exactly the exposure the scoped format exists to prevent.
  async migrateLegacyStore() {
    requireWindows(this.platform);
    if (!this.exists()) throw new Error(`Protected supervisor credential store is missing: ${this.path}`);
    if (!this.isLegacyFormat()) return { migrated: false, path: this.path };

    const blob = fs.readFileSync(this.path, "utf8").trim();
    const result = await this.processRunner("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command", UNPROTECT_SCRIPT,
    ], { env: { DELEGATE_WAVE_SECRET_BLOB: blob }, timeoutMs: 30_000 });
    if (result.exitCode !== 0) {
      throw new Error(`Unable to decrypt the legacy credential bundle: ${result.stderr.trim()}`);
    }

    let combined = JSON.parse(result.stdout.trim());
    try {
      // A legacy bundle lacking a required role cannot produce a startable store, so refuse rather
      // than migrate to something that fails at the next launch.
      const collected = collectRoleRecords(combined, "Legacy credential bundle");
      const records = {};
      const roles = [];
      for (const [role, values] of Object.entries(collected)) {
        records[role] = await this.protect(values);
        roles.push(role);
      }
      // Replace only after every role re-protected successfully, so a mid-migration failure leaves
      // the readable legacy store intact rather than a partial one.
      this.writeStore(records);
      return { migrated: true, path: this.path, roles };
    } finally {
      // Discard the combined plaintext; it must not outlive the migration.
      for (const name of Object.keys(combined)) delete combined[name];
      combined = null;
    }
  }

  async protect(values) {
    const result = await this.processRunner("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command", PROTECT_SCRIPT,
    ], { env: { DELEGATE_WAVE_SECRET_PAYLOAD: JSON.stringify(values) }, timeoutMs: 30_000 });
    if (result.exitCode !== 0 || !result.stdout.trim()) {
      throw new Error(`Unable to protect Control API credentials: ${result.stderr.trim() || "empty DPAPI result"}`);
    }
    return result.stdout.trim();
  }

  // Structural check on an existing scoped store: which roles have records, without decrypting any
  // of them. Record presence is all SUP-005d needs to know an install can produce a startable store.
  missingRequiredRecords() {
    const records = this.readRecords();
    return REQUIRED_SECRET_ROLES.filter((role) => !records[role]);
  }

  // Structural presence check for an optional role; never decrypts.
  hasRecord(role) {
    if (!this.exists() || this.isLegacyFormat()) return false;
    return Boolean(this.readRecords()[role]);
  }

  async provision(env = process.env) {
    requireWindows(this.platform);
    if (!env.DELEGATE_WAVE_CONTROL_TOKEN) {
      if (this.exists()) {
        // Reusing an existing store still has to satisfy SUP-005d, or an install that cannot start
        // would report success here and fail at the next supervised start. A legacy bundle is left
        // to the entitled migration path, since its roles cannot be inspected without decrypting it.
        if (!this.isLegacyFormat()) {
          const missing = this.missingRequiredRecords();
          if (missing.length) {
            throw new Error(
              `Protected credential store at ${this.path} is missing required roles: ${missing.join(", ")}. `
              + "Reinstall with the full credential set to rewrite the store.",
            );
          }
        }
        return { provisioned: false, path: this.path };
      }
      throw new Error("DELEGATE_WAVE_CONTROL_TOKEN is required to create the protected supervisor credential store");
    }

    // Validate before any DPAPI work, so an under-specified install fails immediately instead of
    // reporting success and then failing at the next supervised start.
    const collected = collectRoleRecords(env, "Supervisor installation environment");
    const records = {};
    for (const [role, values] of Object.entries(collected)) {
      records[role] = await this.protect(values);
    }

    this.writeStore(records);

    const clearResult = await this.processRunner("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command", CLEAR_USER_ENVIRONMENT_SCRIPT,
    ], { timeoutMs: 30_000 });
    if (clearResult.exitCode !== 0) {
      throw new Error(`Protected credentials were written, but persistent user-environment cleanup failed: ${clearResult.stderr.trim()}`);
    }
    for (const name of PERSISTENT_CONTROL_NAMES) delete env[name];
    return { provisioned: true, path: this.path };
  }

  // Decrypts exactly one role's record. A process that loads the observer credential never holds
  // ciphertext-to-plaintext authority over the operator credential.
  async load(role) {
    requireWindows(this.platform);
    const record = SECRET_RECORDS[role];
    if (!record) throw new Error(`Unknown protected credential role: ${role}`);
    if (!this.exists()) throw new Error(`Protected supervisor credential store is missing: ${this.path}`);
    // Fail closed with an actionable directive. Migration is never performed here: this call may be
    // running inside the Hermes MCP process, which must never decrypt the combined legacy bundle.
    if (this.isLegacyFormat()) {
      throw new Error(
        `Protected credential store at ${this.path} is in the legacy combined format. `
        + "Run 'delegate-wave supervisor migrate-secrets' as the owning user to upgrade it to scoped records.",
      );
    }
    const blob = this.readRecords()[role];
    if (!blob) throw new Error(`Protected credential store has no ${role} record`);
    const result = await this.processRunner("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command", UNPROTECT_SCRIPT,
    ], { env: { DELEGATE_WAVE_SECRET_BLOB: blob }, timeoutMs: 30_000 });
    if (result.exitCode !== 0) {
      throw new Error(`Unable to decrypt the ${role} Control API credential: ${result.stderr.trim()}`);
    }
    const values = JSON.parse(result.stdout.trim());
    if (!values[record.token]) throw new Error(`Protected ${role} record has no ${record.token}`);
    return values;
  }
}

export class WindowsSupervisor {
  constructor({
    platform = process.platform,
    runner = defaultRunner,
    env = process.env,
    root = dataRoot(),
    secretStore = new DpapiSecretStore({ platform, root }),
    processProbe = defaultProcessProbe,
    delay = defaultDelay,
    stopTimeoutMs = 15_000,
  } = {}) {
    this.platform = platform;
    this.runner = runner;
    this.env = env;
    this.secretStore = secretStore;
    this.runtimePidPath = path.join(root, "state", RUNTIME_PID_FILE);
    this.processProbe = processProbe;
    this.delay = delay;
    this.stopTimeoutMs = stopTimeoutMs;
  }

  async install(options = {}) {
    requireWindows(this.platform);
    await this.secretStore.provision(this.env);
    const taskXml = buildTaskXml({ principal: currentWindowsPrincipal(this.env), ...options });
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-task-"));
    const taskFile = path.join(tempDirectory, "task.xml");
    try {
      fs.writeFileSync(taskFile, taskXml, { encoding: "utf8", flag: "wx" });
      const result = await this.runner(["/Create", "/TN", SUPERVISOR_TASK_NAME, "/XML", taskFile, "/F"]);
      if (result.exitCode !== 0) throw taskError("install", result);
      return { installed: true, task_name: SUPERVISOR_TASK_NAME };
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  }

  async status() {
    requireWindows(this.platform);
    const result = await this.runner(["/Query", "/TN", SUPERVISOR_TASK_NAME, "/FO", "LIST", "/V"]);
    if (result.exitCode !== 0) {
      return { installed: false, task_name: SUPERVISOR_TASK_NAME };
    }
    return {
      installed: true,
      task_name: SUPERVISOR_TASK_NAME,
      scheduler_report: result.stdout.trim().slice(0, 4096),
    };
  }

  async start() {
    requireWindows(this.platform);
    const enabled = await this.runner(["/Change", "/TN", SUPERVISOR_TASK_NAME, "/ENABLE"]);
    if (enabled.exitCode !== 0) throw taskError("enable", enabled);
    const result = await this.runner(["/Run", "/TN", SUPERVISOR_TASK_NAME]);
    if (result.exitCode !== 0) throw taskError("start", result);
    return { started: true, task_name: SUPERVISOR_TASK_NAME };
  }

  // Disable future triggers, end the current instance, then prove the recorded runtime is gone
  // before the caller may treat the API as stopped (SUP-010).
  async stopSupervisedRuntime() {
    const disabled = await this.runner(["/Change", "/TN", SUPERVISOR_TASK_NAME, "/DISABLE"]);
    if (disabled.exitCode !== 0) throw taskError("disable", disabled);
    const result = await this.runner(["/End", "/TN", SUPERVISOR_TASK_NAME]);
    if (result.exitCode !== 0) throw taskError("stop", result);
    await this.waitForRuntimeExit();
  }

  async stop() {
    requireWindows(this.platform);
    await this.stopSupervisedRuntime();
    return { stopped: true, task_name: SUPERVISOR_TASK_NAME };
  }

  recordRuntimePid(pid = process.pid) {
    fs.mkdirSync(path.dirname(this.runtimePidPath), { recursive: true });
    fs.writeFileSync(this.runtimePidPath, `${pid}\n`, { encoding: "utf8", mode: 0o600 });
  }

  async waitForRuntimeExit({ timeoutMs = this.stopTimeoutMs } = {}) {
    if (!fs.existsSync(this.runtimePidPath)) return;
    const pid = Number(fs.readFileSync(this.runtimePidPath, "utf8").trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Supervisor runtime PID receipt is malformed");
    const deadline = Date.now() + timeoutMs;
    while (this.processProbe(pid)) {
      if (Date.now() >= deadline) throw new Error(`Supervised Control API PID ${pid} did not exit after task stop`);
      await this.delay(100);
    }
  }

  // Explicit, operator-invoked upgrade of a legacy combined bundle to scoped records.
  async migrateSecrets() {
    requireWindows(this.platform);
    return this.secretStore.migrateLegacyStore();
  }

  // The supervised API serves both principals, so it is the one process entitled to decrypt both
  // records. Each is still unsealed by a separate scoped call.
  async runtimeEnvironment() {
    requireWindows(this.platform);
    const values = {};
    for (const role of Object.keys(SECRET_RECORDS)) {
      // Required roles must load; optional ones are used when the store actually carries them, so a
      // pre-existing installation keeps starting without a proposal credential.
      if (!SECRET_RECORDS[role].required && !this.secretStore.hasRecord?.(role)) continue;
      Object.assign(values, await this.secretStore.load(role));
    }
    delete values.DELEGATE_WAVE_HERMES_CONTROL_TOKEN;
    return values;
  }

  // Deleting a scheduled task does not interrupt a program already started by it, so the running
  // API must be stopped first or uninstall would leave an unmanaged orphan holding :47321.
  // Credentials are deliberately retained; removal is a separate purge operation (SUP-009).
  async uninstall() {
    requireWindows(this.platform);
    await this.stopSupervisedRuntime();
    const result = await this.runner(["/Delete", "/TN", SUPERVISOR_TASK_NAME, "/F"]);
    if (result.exitCode !== 0) throw taskError("uninstall", result);
    return { uninstalled: true, task_name: SUPERVISOR_TASK_NAME };
  }
}
