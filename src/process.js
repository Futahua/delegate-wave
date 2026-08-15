import { spawn } from "node:child_process";

// CTL-AUTH-005: executors, validation commands, Git hooks, and any other child process must never
// inherit Control-plane authority.
//
// The list also carries model-provider keys. Those grant no authority over this system, so they are
// a weaker class of secret, but nothing should hold one by accident: a backend passes its key
// explicitly for one attempt, and every other child gets none. Scrubbing them here is what makes
// "passed deliberately" different from "happened to be in the environment".
//
// Declared here rather than in supervisor.js because this is the lowest-level module and must not
// depend on it. supervisor.js asserts that every name it declares for a credential role appears in
// this list, so adding a role cannot silently leave its credential inheritable -- which is exactly
// how the proposal credential first escaped this scrub.
export const CONTROL_AUTHORITY_NAMES = Object.freeze([
  "DELEGATE_WAVE_CONTROL_TOKEN",
  "DELEGATE_WAVE_CONTROL_PRINCIPAL",
  "DELEGATE_WAVE_CONTROL_OBSERVER_TOKEN",
  "DELEGATE_WAVE_CONTROL_OBSERVER_PRINCIPAL",
  "DELEGATE_WAVE_CONTROL_PROPOSER_TOKEN",
  "DELEGATE_WAVE_CONTROL_PROPOSER_PRINCIPAL",
  "DELEGATE_WAVE_HERMES_CONTROL_TOKEN",
  // A model-provider key. It grants no authority over this system, but it is still a secret and it
  // is still scrubbed from the ambient environment: a worker receives it only when a backend passes
  // it explicitly for that one attempt, never by inheritance. Scrubbing it here is what makes that
  // difference real rather than conventional -- an unrelated child process, a validation command, or
  // a Git hook has no reason to hold it.
  "DELEGATE_WAVE_EXECUTOR_API_KEY",
  "OPENCODE_GO_API_KEY",
]);

export function childEnvironment(extra = {}) {
  const environment = { ...process.env };
  for (const name of CONTROL_AUTHORITY_NAMES) delete environment[name];
  return { ...environment, ...extra };
}

export function runProcess(command, args, options = {}) {
  const { cwd, env, timeoutMs = 10 * 60_000, onSpawn, onStdout, onStderr } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: childEnvironment(env),
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("spawn", () => {
      try {
        onSpawn?.(child.pid);
      } catch (error) {
        child.kill();
        reject(error);
      }
    });
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      onStdout?.(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      onStderr?.(text);
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode: exitCode ?? -1, signal, stdout, stderr, timedOut });
    });
  });
}

export async function runShell(command, options = {}) {
  if (process.platform === "win32") {
    return runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], options);
  }
  return runProcess("/bin/sh", ["-lc", command], options);
}
