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

// One authoritative snapshot of what the attempt actually produced.
//
// The worker's Git index is NOT authoritative, and neither is its HEAD. A trusted worker may use Git
// freely, which includes index flags that make real filesystem changes invisible to the index it
// owns:
//
//   git update-index --assume-unchanged <path>
//   git update-index --skip-worktree    <path>
//
// Under either flag `git add --all` in the worker's own index picks the change up as nothing at all.
// Verified directly: a modified protected file and a modified allowed file both vanish, so policy
// sees an empty delta and the candidate omits real work. That is both a protected-path bypass and a
// silent candidate truncation.
//
// So the snapshot is taken through a delegate-wave-owned temporary index, seeded from the recorded
// base and populated from the filesystem. The index lives OUTSIDE the worktree, or `git add --all`
// would capture the index file itself. `.gitignore` still applies, because ignore rules are trusted
// project configuration describing what is not source.
//
// The tree returned here is immutable and is the single source for everything downstream: the
// changed-path set that policy judges, the commit that becomes the candidate, and the tree that
// validation runs against. There is deliberately no second `add` between policy and commit -- a
// re-snapshot could admit content the policy check never saw.
export async function snapshotCandidate(worktreePath, baseSha, indexDirectory) {
  fs.mkdirSync(indexDirectory, { recursive: true });
  const indexFile = path.join(indexDirectory, `candidate-index-${process.pid}`);
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    // Seeded from the base rather than from the worker's index, so nothing the worker marked is
    // carried over and every path is judged against the recorded starting point.
    await git(worktreePath, ["read-tree", baseSha], { env });
    await git(worktreePath, ["add", "--all"], { env });
    const tree = await git(worktreePath, ["write-tree"], { env });

    // `--no-renames` is load-bearing. Rename detection reports a move as one entry naming only the
    // destination, which would hide a protected SOURCE path from the policy check: a worker could
    // move a protected file out of its protected directory and have it accepted.
    const output = await git(
      worktreePath,
      ["diff", "--name-only", "-z", "--no-renames", baseSha, tree],
      { raw: true },
    );
    const files = output
      ? [...new Set(output.split("\0").filter(Boolean).map((file) => file.replaceAll("\\", "/")))]
      : [];
    return { tree, files };
  } finally {
    // Removed on every path: a leaked index file would be captured by a later attempt.
    fs.rmSync(indexFile, { force: true });
    fs.rmSync(`${indexFile}.lock`, { force: true });
  }
}

// Files the worker created that the project's own ignore rules exclude from the candidate.
//
// An attempt worktree is created fresh from the base commit, so anything ignored-and-present was
// produced by this worker. Excluding them is correct -- `.gitignore` is trusted project
// configuration declaring what is not source, and force-adding would sweep `node_modules` into
// candidates. But the exclusion must not be SILENT when it is the whole story: telling someone
// "the worker changed nothing" while its output sits in the worktree is false.
//
// Only called on the empty-candidate path, so the listing cost does not matter.
export async function ignoredWorkerOutput(worktreePath, limit = 10) {
  const output = await git(
    worktreePath,
    ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
    { raw: true },
  );
  if (!output) return [];
  const files = output.split("\0").filter(Boolean).map((file) => file.replaceAll("\\", "/"));
  return files.slice(0, limit);
}

// Turns the already-captured tree into delegate-wave's candidate commit.
//
// Takes the tree rather than re-reading the worktree, so the object committed is exactly the one
// policy judged. `commit-tree` rather than `commit`, because `commit` would parent on whatever HEAD
// the worker left behind; the candidate must be one commit on the recorded base carrying the
// complete net change.
export async function commitCandidateTree(worktreePath, tree, baseSha, message) {
  const baseTree = await git(worktreePath, ["rev-parse", `${baseSha}^{tree}`]);
  // Comparing trees, not statuses: identical trees mean the attempt produced nothing, however much
  // Git history the worker created along the way.
  if (tree === baseTree) return null;
  const commit = await git(worktreePath, [
    "-c", "user.name=delegate-wave", "-c", "user.email=delegate-wave@local",
    "commit-tree", tree, "-p", baseSha, "-m", message,
  ], {
    // commit-tree reads identity from the environment. Supplied explicitly so the candidate does not
    // inherit whatever the worker configured, and is attributable to delegate-wave.
    env: {
      GIT_AUTHOR_NAME: "delegate-wave", GIT_AUTHOR_EMAIL: "delegate-wave@local",
      GIT_COMMITTER_NAME: "delegate-wave", GIT_COMMITTER_EMAIL: "delegate-wave@local",
    },
  });

  // Point the worktree at the candidate. Validation runs here afterwards and must see exactly the
  // tree that was captured -- not the worker's HEAD, and not a later filesystem state.
  //
  // The worker's index is discarded first rather than reset through. `assume-unchanged` and
  // `skip-worktree` entries make `git reset --hard` refuse with "Entry 'x' not uptodate. Cannot
  // merge.", so a worker could otherwise block delegate-wave from establishing the canonical tree
  // simply by having marked a file. That index is not authoritative for anything, and Git rebuilds
  // it from the commit being reset to, which also clears the stale bits.
  const indexPath = await git(worktreePath, ["rev-parse", "--git-path", "index"]);
  fs.rmSync(path.resolve(worktreePath, indexPath), { force: true });
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
