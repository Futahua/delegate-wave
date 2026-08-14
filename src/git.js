import fs from "node:fs";
import path from "node:path";
import { runProcess } from "./process.js";

export async function git(repoPath, args, options = {}) {
  const result = await runProcess("git", ["-C", repoPath, ...args], options);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.exitCode}): ${result.stderr.trim()}`);
  }
  return options.raw ? result.stdout : result.stdout.trim();
}

export async function assertRepository(repoPath) {
  const inside = await git(repoPath, ["rev-parse", "--is-inside-work-tree"]);
  if (inside !== "true") throw new Error(`${repoPath} is not a Git working tree`);
}

export async function resolveRevision(repoPath, revision) {
  return git(repoPath, ["rev-parse", "--verify", `${revision}^{commit}`]);
}

export async function createDetachedWorktree(repoPath, targetPath, baseSha) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  if (fs.existsSync(targetPath)) throw new Error(`Worktree path already exists: ${targetPath}`);
  await git(repoPath, ["worktree", "add", "--detach", "--lock", targetPath, baseSha]);
}

export async function lockWorktree(repoPath, targetPath, reason) {
  await git(repoPath, ["worktree", "lock", "--reason", reason, targetPath]);
}

export async function changedFiles(worktreePath) {
  const output = await git(worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { raw: true });
  if (!output) return [];
  const records = output.split("\0").filter(Boolean);
  const files = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const status = record.slice(0, 2);
    files.push(record.slice(3).replaceAll("\\", "/"));
    if (/[RC]/.test(status) && records[index + 1]) {
      files.push(records[++index].replaceAll("\\", "/"));
    }
  }
  return [...new Set(files)];
}

export async function commitAll(worktreePath, message) {
  await git(worktreePath, ["add", "--all"]);
  const staged = await git(worktreePath, ["diff", "--cached", "--name-only"]);
  if (!staged) return null;
  await git(worktreePath, ["-c", "user.name=delegate-wave", "-c", "user.email=delegate-wave@local", "commit", "-m", message]);
  return resolveRevision(worktreePath, "HEAD");
}
