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

// The authoritative changed-file set: the worker's resulting tree compared to the recorded base.
//
// NOT `git status`. A trusted worker may use Git normally, and one that commits its work leaves a
// clean status -- which would read as "changed nothing" and discard real work. Worse, a worker that
// commits A and leaves B uncommitted would show only B, so the protected-path check would inspect
// only B while A rode along invisibly.
//
// Staging the whole tree first is what makes untracked files part of the comparison; the diff is
// then taken against the base commit rather than against HEAD, so whatever history the worker built
// on top of the base is irrelevant to what we believe changed.
export async function changedFilesSince(worktreePath, baseSha) {
  await git(worktreePath, ["add", "--all"]);
  const output = await git(
    worktreePath,
    ["diff", "--cached", "--name-only", "-z", "--find-renames", baseSha],
    { raw: true },
  );
  if (!output) return [];
  return [...new Set(output.split("\0").filter(Boolean).map((file) => file.replaceAll("\\", "/")))];
}

// Builds delegate-wave's own candidate commit: the worker's resulting tree, parented exactly on the
// recorded base.
//
// `commit-tree` rather than `commit`, because `commit` would parent on whatever HEAD the worker left
// behind. The candidate must be one commit containing the complete net change, so integration can
// cherry-pick it and get everything the attempt produced -- not just the part the worker happened to
// leave uncommitted.
//
// The worker's own commits and branches remain in the worktree as evidence of how it worked. They
// are never the integration object.
export async function captureCandidate(worktreePath, baseSha, message) {
  await git(worktreePath, ["add", "--all"]);
  const tree = await git(worktreePath, ["write-tree"]);
  const baseTree = await git(worktreePath, ["rev-parse", `${baseSha}^{tree}`]);
  // Comparing trees, not statuses: identical trees mean the attempt produced nothing, however much
  // Git history the worker created along the way.
  if (tree === baseTree) return null;
  const commit = await git(worktreePath, [
    "-c", "user.name=delegate-wave", "-c", "user.email=delegate-wave@local",
    "commit-tree", tree, "-p", baseSha, "-m", message,
  ], {
    // commit-tree reads identity and timestamps from the environment. Supplied explicitly so the
    // candidate does not inherit whatever the worker configured, and so the commit is attributable
    // to delegate-wave rather than to the worker that produced the tree.
    env: {
      GIT_AUTHOR_NAME: "delegate-wave", GIT_AUTHOR_EMAIL: "delegate-wave@local",
      GIT_COMMITTER_NAME: "delegate-wave", GIT_COMMITTER_EMAIL: "delegate-wave@local",
    },
  });

  // Point the worktree at the candidate. Validation runs here afterwards, and it must see exactly
  // the tree that was captured -- not the worker's HEAD, which may carry a different history and,
  // if the worker committed only part of its work, a different tree.
  await git(worktreePath, ["reset", "--hard", commit]);
  return commit;
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
  const result = await runProcess("git", ["-C", repoPath, "push", "--porcelain",
    "--receive-pack=git -c receive.denyCurrentBranch=refuse receive-pack",
    `--force-with-lease=${ref}:${expectedOldSha}`,
    repoPath, `${newSha}:${ref}`,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`compare-and-swap ${ref} failed (${result.exitCode}): ${result.stderr.trim()}`);
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
