// A trusted attempt-root filesystem fence.
//
// Confines reads as well as writes, because a worker that can read outside its worktree can read the
// trusted verifiers, other repositories, and credential material. Harness's own filesystem sandbox
// restricts writes while reads pass through in every mode, so a delegate-wave-owned fence is
// required before any Harness worker touches a repository.
//
// This is a trusted in-process path fence, not a kernel boundary. It is sufficient only because the
// worker has no shell, no subprocess, and no code execution. Real isolation still needs a separate
// OS identity, container, or VM, and that limit is stated rather than implied.
import fs from "node:fs";
import path from "node:path";

export class FenceViolation extends Error {
  constructor(operation, target, reason) {
    super(`FS_FENCE_DENIED: ${operation} ${target}: ${reason}`);
    this.name = "FenceViolation";
    this.code = "FS_FENCE_DENIED";
    this.operation = operation;
    this.target = target;
  }
}

// Resolves the real location of a path, following symlinks and Windows junctions as far as they
// exist. A path that does not exist yet resolves through its nearest existing ancestor, so a write
// to a new file inside a symlinked directory is still judged by where that directory really points.
function realize(target) {
  let current = path.resolve(target);
  const trailing = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...trailing.reverse());
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      // A root that does not resolve cannot be judged; treat it as outside.
      if (parent === current) return path.resolve(target);
      trailing.push(path.basename(current));
      current = parent;
    }
  }
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  // Empty means the root itself. A relative path that climbs out, or an absolute one, is outside.
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export class AttemptFence {
  constructor(worktreePath) {
    if (!worktreePath) throw new Error("An attempt fence requires a worktree path");
    // The root is realized once: if the worktree itself is reached through a link, everything is
    // judged against where it actually lives.
    this.root = realize(worktreePath);
  }

  // Returns the resolved path, or throws. Every operation goes through here, so there is exactly one
  // place where the boundary is decided.
  resolve(target, operation = "access") {
    if (typeof target !== "string" || !target) {
      throw new FenceViolation(operation, String(target), "path must be a non-empty string");
    }
    // Reject NUL bytes outright: they can truncate a path inside a syscall.
    if (target.includes("\0")) throw new FenceViolation(operation, target, "path contains a NUL byte");

    const absolute = path.isAbsolute(target) ? target : path.join(this.root, target);
    const resolved = realize(absolute);
    if (!isInside(this.root, resolved)) {
      throw new FenceViolation(operation, target, `resolves outside the attempt worktree (${resolved})`);
    }
    return resolved;
  }

  readFile(target, encoding = "utf8") {
    return fs.readFileSync(this.resolve(target, "read"), encoding);
  }

  writeFile(target, contents) {
    const resolved = this.resolve(target, "write");
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, contents);
    return resolved;
  }

  listDir(target = ".") {
    return fs.readdirSync(this.resolve(target, "list"));
  }

  stat(target) {
    return fs.statSync(this.resolve(target, "stat"));
  }

  exists(target) {
    try {
      return fs.existsSync(this.resolve(target, "stat"));
    } catch (error) {
      // A path outside the fence is reported as absent rather than raising: existence itself is
      // information about the world beyond the worktree.
      if (error instanceof FenceViolation) return false;
      throw error;
    }
  }

  remove(target) {
    const resolved = this.resolve(target, "remove");
    if (resolved === this.root) throw new FenceViolation("remove", target, "refusing to remove the worktree root");
    fs.rmSync(resolved, { recursive: true, force: true });
  }

  // Recursive search confined to the fence. Symlinked directories pointing outside are skipped
  // rather than followed, so a link cannot widen the search.
  search(pattern, { target = ".", limit = 200 } = {}) {
    const start = this.resolve(target, "search");
    const matches = [];
    const walk = (directory) => {
      if (matches.length >= limit) return;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (matches.length >= limit) return;
        const full = path.join(directory, entry.name);
        let resolved;
        try {
          resolved = realize(full);
        } catch {
          continue;
        }
        if (!isInside(this.root, resolved)) continue;
        if (entry.isDirectory()) { walk(resolved); continue; }
        let contents;
        try {
          contents = fs.readFileSync(resolved, "utf8");
        } catch {
          continue;
        }
        if (contents.includes(pattern)) {
          matches.push(path.relative(this.root, resolved).split(path.sep).join("/"));
        }
      }
    };
    walk(start);
    return matches;
  }
}
