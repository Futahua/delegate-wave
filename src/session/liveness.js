// Whether a process that claimed something is still there to finish it.
//
// This exists because time is not evidence. A delivery that has been running for an hour and a
// delivery whose owner died an hour ago look identical from a clock, and only one of them may be
// taken away. Reclaiming the first is how a wake gets delivered twice; refusing to reclaim the
// second is how a queue stops forever. So the question has to be asked of the operating system,
// not of a timestamp.
//
// PID ALONE IS NOT IDENTITY.
//
// Process ids are reused, and on a busy machine they are reused quickly. "Is pid 47321 alive" can
// answer yes about a completely unrelated program -- which is the same defect already recorded
// against the supervisor's port receipt. Identity here is the pair (pid, start time): a reused pid
// carries a different start time, and the comparison catches it.
//
// UNKNOWN IS NOT DEAD.
//
// Every failure to establish an answer -- an unreadable /proc, a PowerShell that would not run, a
// permission refusal -- returns UNKNOWN, and UNKNOWN never authorises anything. The only outcome
// that permits taking work away from another process is a positive, specific DEAD.
import { runProcess } from "../process.js";

export const ALIVE = "ALIVE";
export const DEAD = "DEAD";
export const UNKNOWN = "UNKNOWN";

// The OS-reported start time for a pid, as an opaque string, or null when it cannot be established.
//
// Opaque on purpose: it is only ever compared for exact equality against a value this same function
// produced, so its format is nobody's business. Parsing it into a date would invite a timezone bug
// into the one comparison that decides whether work may be stolen.
export async function processStartedAt(pid, { platform = process.platform, run = runProcess } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (platform === "win32") {
      // -NoProfile because a user profile can print banners, and Stop on the error action so a
      // missing process is an exit code rather than an empty string that reads as "no start time".
      const result = await run("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc()`,
      ], { timeoutMs: 15_000 });
      if (result.exitCode !== 0) return null;
      const value = result.stdout.trim();
      return /^\d+$/.test(value) ? value : null;
    }
    if (platform === "linux") {
      const { readFileSync } = await import("node:fs");
      // Field 22 of /proc/<pid>/stat, counted after the comm field -- which may itself contain
      // spaces and parentheses, so it is cut at the LAST ')' rather than split naively.
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const tail = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const started = tail[19];
      return /^\d+$/.test(started) ? started : null;
    }
    const result = await run("ps", ["-o", "lstart=", "-p", String(pid)], { timeoutMs: 15_000 });
    if (result.exitCode !== 0) return null;
    const value = result.stdout.trim();
    return value || null;
  } catch {
    return null;
  }
}

// This process, in the same terms a later process will ask about it.
//
// Deliberately measured through the SAME query that will later be used to check it. Deriving our own
// start time from process.uptime() would produce a number the probe could never reproduce, and the
// comparison would fail for every row -- every claim permanently unreclaimable, which is a
// stuck queue that looks exactly like a working one.
export async function selfIdentity(options = {}) {
  return { pid: process.pid, startedAt: await processStartedAt(process.pid, options) };
}

// ALIVE, DEAD or UNKNOWN for a recorded (pid, startedAt) pair.
export async function probeProcess(pid, startedAt, options = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return UNKNOWN;
  const observed = await processStartedAt(pid, options);
  // No process answers to that id. This is the one positive DEAD: the pid is gone, so whatever held
  // it is gone with it.
  if (observed === null) return exists(pid) ? UNKNOWN : DEAD;
  // A start time we cannot compare against proves nothing either way.
  if (!startedAt) return UNKNOWN;
  // Same pid, different start time: the original process ended and something else was given its
  // number. Also a positive DEAD, and the case a pid-only probe gets wrong.
  return observed === startedAt ? ALIVE : DEAD;
}

// A cheap second opinion, used only to keep a permission failure from being read as death.
//
// signal 0 raises EPERM when the process exists but belongs to somebody else, and ESRCH when it
// genuinely does not exist. Without this distinction a probe running with fewer rights than the
// process it is asking about would call a live owner dead.
function exists(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}
