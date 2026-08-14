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

const CONTROL_SECRET_NAMES = [
  "DELEGATE_WAVE_CONTROL_TOKEN",
  "DELEGATE_WAVE_CONTROL_OBSERVER_TOKEN",
  "DELEGATE_WAVE_CONTROL_PRINCIPAL",
  "DELEGATE_WAVE_CONTROL_OBSERVER_PRINCIPAL",
];

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

  async provision(env = process.env) {
    requireWindows(this.platform);
    if (!env.DELEGATE_WAVE_CONTROL_TOKEN) {
      if (this.exists()) return { provisioned: false, path: this.path };
      throw new Error("DELEGATE_WAVE_CONTROL_TOKEN is required to create the protected supervisor credential bundle");
    }

    const values = Object.fromEntries(CONTROL_SECRET_NAMES
      .filter((name) => env[name])
      .map((name) => [name, env[name]]));
    const protectedResult = await this.processRunner("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command", PROTECT_SCRIPT,
    ], { env: { DELEGATE_WAVE_SECRET_PAYLOAD: JSON.stringify(values) }, timeoutMs: 30_000 });
    if (protectedResult.exitCode !== 0 || !protectedResult.stdout.trim()) {
      throw new Error(`Unable to protect Control API credentials: ${protectedResult.stderr.trim() || "empty DPAPI result"}`);
    }

    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${protectedResult.stdout.trim()}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      fs.copyFileSync(temporary, this.path);
    } finally {
      fs.rmSync(temporary, { force: true });
    }

    const clearResult = await this.processRunner("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command", CLEAR_USER_ENVIRONMENT_SCRIPT,
    ], { timeoutMs: 30_000 });
    if (clearResult.exitCode !== 0) {
      throw new Error(`Protected credentials were written, but persistent user-environment cleanup failed: ${clearResult.stderr.trim()}`);
    }
    for (const name of PERSISTENT_CONTROL_NAMES) delete env[name];
    return { provisioned: true, path: this.path };
  }

  async load() {
    requireWindows(this.platform);
    if (!this.exists()) throw new Error(`Protected supervisor credential bundle is missing: ${this.path}`);
    const blob = fs.readFileSync(this.path, "utf8").trim();
    const result = await this.processRunner("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command", UNPROTECT_SCRIPT,
    ], { env: { DELEGATE_WAVE_SECRET_BLOB: blob }, timeoutMs: 30_000 });
    if (result.exitCode !== 0) {
      throw new Error(`Unable to decrypt Control API credentials: ${result.stderr.trim()}`);
    }
    const values = JSON.parse(result.stdout.trim());
    if (!values.DELEGATE_WAVE_CONTROL_TOKEN) throw new Error("Protected credential bundle has no operator token");
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
  } = {}) {
    this.platform = platform;
    this.runner = runner;
    this.env = env;
    this.secretStore = secretStore;
    this.runtimePidPath = path.join(root, "state", RUNTIME_PID_FILE);
    this.processProbe = processProbe;
    this.delay = delay;
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

  async stop() {
    requireWindows(this.platform);
    const disabled = await this.runner(["/Change", "/TN", SUPERVISOR_TASK_NAME, "/DISABLE"]);
    if (disabled.exitCode !== 0) throw taskError("disable", disabled);
    const result = await this.runner(["/End", "/TN", SUPERVISOR_TASK_NAME]);
    if (result.exitCode !== 0) throw taskError("stop", result);
    await this.waitForRuntimeExit();
    return { stopped: true, task_name: SUPERVISOR_TASK_NAME };
  }

  recordRuntimePid(pid = process.pid) {
    fs.mkdirSync(path.dirname(this.runtimePidPath), { recursive: true });
    fs.writeFileSync(this.runtimePidPath, `${pid}\n`, { encoding: "utf8", mode: 0o600 });
  }

  async waitForRuntimeExit({ timeoutMs = 15_000 } = {}) {
    if (!fs.existsSync(this.runtimePidPath)) return;
    const pid = Number(fs.readFileSync(this.runtimePidPath, "utf8").trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Supervisor runtime PID receipt is malformed");
    const deadline = Date.now() + timeoutMs;
    while (this.processProbe(pid)) {
      if (Date.now() >= deadline) throw new Error(`Supervised Control API PID ${pid} did not exit after task stop`);
      await this.delay(100);
    }
  }

  async runtimeEnvironment() {
    requireWindows(this.platform);
    const values = await this.secretStore.load();
    delete values.DELEGATE_WAVE_HERMES_CONTROL_TOKEN;
    return values;
  }

  async uninstall() {
    requireWindows(this.platform);
    const result = await this.runner(["/Delete", "/TN", SUPERVISOR_TASK_NAME, "/F"]);
    if (result.exitCode !== 0) throw taskError("uninstall", result);
    return { uninstalled: true, task_name: SUPERVISOR_TASK_NAME };
  }
}
