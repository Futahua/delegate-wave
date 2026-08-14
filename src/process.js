import { spawn } from "node:child_process";

export function runProcess(command, args, options = {}) {
  const { cwd, env, timeoutMs = 10 * 60_000, onSpawn, onStdout, onStderr } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      onSpawn?.(child.pid);
    } catch (error) {
      child.kill();
      reject(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
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
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
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
