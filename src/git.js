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

export async function listWorktrees(repoPath) {
  const output = await git(repoPath, ["worktree", "list", "--porcelain"], { raw: true });
  const entries = [];
  for (const block of output.split(/\r?\n\r?\n/)) {
    const entry = { path: null, branch: null, detached: false, head: null };
    for (const line of block.split(/\r?\n/).filter(Boolean)) {
      if (line.startsWith("worktree ")) entry.path = line.slice("worktree ".length);
      else if (line.startsWith("branch ")) entry.branch = line.slice("branch ".length);
      else if (line === "detached") entry.detached = true;
      else if (line.startsWith("HEAD ")) entry.head = line.slice("HEAD ".length);
    }
    if (entry.path) entries.push(entry);
  }
  return entries;
}

export async function removeWorktree(repoPath, targetPath) {
  if (!fs.existsSync(targetPath)) return false;
  try { await git(repoPath, ["worktree", "unlock", targetPath]); } catch { /* unlocked already */ }
  await git(repoPath, ["worktree", "remove", "--force", targetPath]);
  return true;
}

export async function isAncestor(repoPath, ancestor, descendant) {
  const result = await runProcess("git", ["-C", repoPath, "merge-base", "--is-ancestor", ancestor, descendant]);
  return result.exitCode === 0;
}

export async function updateRefCas(repoPath, ref, newSha, expectedOldSha) {
  const result = await runProcess("git", ["-C", repoPath, "update-ref", ref, newSha, expectedOldSha]);
  if (result.exitCode !== 0) {
    throw new Error(`update-ref ${ref} failed (${result.exitCode}): ${result.stderr.trim()}`);
  }
  return newSha;
}

export async function cherryPick(worktreePath, commit) {
  const result = await runProcess("git", ["-C", worktreePath,
    "-c", "user.name=delegate-wave", "-c", "user.email=delegate-wave@local",
    "cherry-pick", commit,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`cherry-pick ${commit} failed (${result.exitCode}): ${result.stderr.trim()}`);
  }
  return resolveRevision(worktreePath, "HEAD");
}
