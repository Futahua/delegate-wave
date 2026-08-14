import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "./process.js";

export const SUPERVISOR_TASK_NAME = "delegate-wave-control";

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
      <Arguments>&quot;${xml(cliPath)}&quot; serve</Arguments>
      <WorkingDirectory>${xml(workingDirectory)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

async function defaultRunner(args) {
  return runProcess("schtasks.exe", args, { timeoutMs: 30_000 });
}

function requireWindows(platform) {
  if (platform !== "win32") throw new Error("The delegate-wave supervisor is available only on Windows");
}

function taskError(action, result) {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
  return new Error(`Unable to ${action} Windows task ${SUPERVISOR_TASK_NAME}: ${detail}`);
}

export class WindowsSupervisor {
  constructor({ platform = process.platform, runner = defaultRunner, env = process.env } = {}) {
    this.platform = platform;
    this.runner = runner;
    this.env = env;
  }

  async install(options = {}) {
    requireWindows(this.platform);
    if (!this.env.DELEGATE_WAVE_CONTROL_TOKEN) {
      throw new Error("DELEGATE_WAVE_CONTROL_TOKEN must be configured in the user environment before installing the supervisor");
    }
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
    const result = await this.runner(["/Run", "/TN", SUPERVISOR_TASK_NAME]);
    if (result.exitCode !== 0) throw taskError("start", result);
    return { started: true, task_name: SUPERVISOR_TASK_NAME };
  }

  async stop() {
    requireWindows(this.platform);
    const result = await this.runner(["/End", "/TN", SUPERVISOR_TASK_NAME]);
    if (result.exitCode !== 0) throw taskError("stop", result);
    return { stopped: true, task_name: SUPERVISOR_TASK_NAME };
  }

  async uninstall() {
    requireWindows(this.platform);
    const result = await this.runner(["/Delete", "/TN", SUPERVISOR_TASK_NAME, "/F"]);
    if (result.exitCode !== 0) throw taskError("uninstall", result);
    return { uninstalled: true, task_name: SUPERVISOR_TASK_NAME };
  }
}
