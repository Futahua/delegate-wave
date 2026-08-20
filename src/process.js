import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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

// Shell grammar that composes or redirects. A validation plan entry containing any of it is a
// category error, not a command.
//
// Dogfood run 5 spent two implementation attempts being judged by a check that never executed. The
// stored plan was a single string -- "npm ci && npm run build && git diff --exit-code -- public &&
// npm test" -- handed to powershell.exe, which is Windows PowerShell 5.1, where && is a parse
// error. Nothing ran, the interpreter exited nonzero, and delegate-wave recorded "validation
// failed". The manager read that evidence correctly and asked for a revision that could not have
// helped, because the candidate was never the problem.
//
// The lesson is not "support && on PowerShell". It is that shell grammar has no business deciding
// whether a candidate is correct. One entry is one command; sequencing belongs to the plan.
// Scanned OUTSIDE quotes only. A quoted argument may legitimately contain any of these characters
// and mean nothing by them: `node -e "setTimeout(()=>{},60000)"` is one command whose payload
// happens to hold `=>`, and rejecting it would break honest plans in the name of safety.
const COMPOSITION_CHARACTERS = new Set(["|", ";", "<", ">", "&", "`"]);

export function findShellComposition(command) {
  let quote = null;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (COMPOSITION_CHARACTERS.has(character)) {
      // Report the operator as written, so `&&` does not come back as `&`.
      const next = command[index + 1];
      return next === character && (character === "&" || character === "|")
        ? character + next
        : character;
    }
    if (character === "$" && command[index + 1] === "(") return "$(";
  }
  return null;
}

export function assertNotShellComposed(command) {
  const found = findShellComposition(command);
  if (found) {
    throw new Error(
      `validation command uses shell syntax ${JSON.stringify(found)}, which is not portable and `
      + `is not evaluated here: list each step as its own command instead -- ${JSON.stringify(command)}`,
    );
  }
}

// Splits one command line into argv, honouring quotes and nothing else. No expansion, no globbing,
// no substitution: what is written is what is executed.
export function tokenizeCommand(command) {
  const argv = [];
  let current = "";
  let quote = null;
  let quoted = false;
  for (const character of command.trim()) {
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; quoted = true; continue; }
    if (/\s/.test(character)) {
      if (quoted || current) { argv.push(current); current = ""; quoted = false; }
      continue;
    }
    current += character;
  }
  if (quote) throw new Error(`validation command has an unterminated ${quote} quote: ${command}`);
  if (quoted || current) argv.push(current);
  return argv;
}

// Finds what a bare name actually refers to on this machine.
//
// Windows dresses most tooling in batch shims -- npm is npm.cmd, not an executable -- and Node
// refuses to spawn .cmd/.bat without a shell. Resolving the file explicitly preserves the no-shell
// guarantee while still being able to run them: cmd.exe receives one program and its arguments,
// never a command line it has to scan for operators.
export function resolveExecutable(name, { platform = process.platform, env = process.env } = {}) {
  if (name.includes("/") || name.includes("\\")) return path.resolve(name);
  const directories = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  const extensions = platform === "win32"
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, name + extension);
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
    }
  }
  return null;
}

// Quotes one argument for cmd's re-parse.
//
// Always quoted, not only when a space is present: a bare argument is also cmd's opportunity to see
// its own metacharacters. Embedded quotes are escaped so an argument cannot close its own quoting
// and let the remainder be read as command text. This narrows the surface cmd gets to interpret; it
// does not eliminate it, because a batch file necessarily goes through cmd at all.
function quoteForCmd(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

// Runs ONE command from an explicit argument vector. No shell, so no operator is ever interpreted.
//
// Returns `ran: false` when the command could not be started at all. That is a different fact from a
// command that started and reported failure, and conflating the two is what let a broken invocation
// masquerade as a failing candidate.
export async function runCommand(command, options = {}) {
  assertNotShellComposed(command);
  const argv = tokenizeCommand(command);
  if (!argv.length) {
    return { ran: false, reason: "the command is empty", exitCode: null, stdout: "", stderr: "" };
  }

  const resolved = resolveExecutable(argv[0], options);
  if (!resolved) {
    return {
      ran: false,
      reason: `${argv[0]} was not found on PATH`,
      exitCode: null, stdout: "", stderr: "",
    };
  }

  const isBatch = /\.(cmd|bat)$/i.test(resolved);
  // /d skips AutoRun, so a machine-local registry setting cannot inject work into a validation run.
  //
  // The quoting is not decoration. cmd re-parses everything after /c, so an unquoted program path
  // splits on its first space: npm resolves to "C:\Program Files\nodejs\npm.CMD", and dogfood run 7
  // died on `'C:\Program' is not recognized as an internal or external command`. Under /s, cmd strips
  // one outer pair of quotes from the whole payload and treats the rest literally, so the payload is
  // wrapped once more than looks necessary -- ""C:\path with spaces\npm.CMD" arg" -- and handed over
  // verbatim so Node does not re-escape what cmd is about to re-parse.
  const spawned = isBatch
    ? {
      file: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", `"${quoteForCmd(resolved)} ${argv.slice(1).map(quoteForCmd).join(" ")}"`],
      verbatim: true,
    }
    : { file: resolved, args: argv.slice(1) };

  try {
    const result = await runProcess(spawned.file, spawned.args, {
      ...options,
      ...(spawned.verbatim ? { windowsVerbatimArguments: true } : {}),
    });
    return { ...result, ran: true, reason: null };
  } catch (error) {
    return {
      ran: false,
      reason: `${argv[0]} could not be started: ${error?.message ?? error}`,
      exitCode: null, stdout: "", stderr: String(error?.message ?? error),
    };
  }
}

export function runProcess(command, args, options = {}) {
  const {
    cwd, env, timeoutMs = 10 * 60_000, onSpawn, onStdout, onStderr,
    // Hands the argument string to the child exactly as written. Needed only for cmd.exe, which
    // re-parses its own /c payload and must receive the quoting it expects rather than Node's.
    windowsVerbatimArguments = false,
  } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: childEnvironment(env),
      windowsHide: true,
      shell: false,
      ...(windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
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
