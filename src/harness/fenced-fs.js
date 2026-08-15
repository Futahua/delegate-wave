// A Harness filesystem provider confined to one attempt worktree.
//
// Harness's own sandbox is explicit that it fences mutations only: "Reads pass through untouched:
// every mode permits reading." That was verified operationally, not taken on faith -- a restricted
// worker asked for an absolute path outside its workspace returned the file's exact contents.
//
// That is unacceptable here for a specific reason: the trusted verifiers for the frozen task corpus
// deliberately live outside the worker's repository, and a worker that can read them can pass every
// task without doing the work. It would also hand the Harness arm a capability the OpenCode arm does
// not have, which would quietly invalidate any comparison between them.
//
// So this replaces the filesystem service rather than configuring the sandbox. It subclasses the
// local provider and gates `resolve`, which is the single chokepoint: every other operation --
// stat, lstat, readText, streamText, readBytes, listDir, writeText, editText -- consumes a target
// that resolve produced. Fencing there covers reads and writes together, and cannot drift as new
// operations are added, because a target that was never resolved cannot exist.
//
// Like the fence it wraps, this is a trusted in-process path check, not a kernel boundary. It holds
// only because this worker has no shell, no subprocess, and no code runtime. That limit is stated
// rather than implied.
import { AttemptFence, FenceViolation } from "../fence.js";

function loadBase(require) {
  const localModule = require("@deepseek-ai/dsh-fs-local");
  const fsModule = require("@deepseek-ai/dsh-fs");
  const LocalFileSystem = localModule.LocalFileSystem ?? localModule.default;
  const FsError = fsModule.FsError ?? fsModule.default?.FsError;
  if (typeof LocalFileSystem !== "function") {
    throw new Error("@deepseek-ai/dsh-fs-local did not export a LocalFileSystem class");
  }
  if (typeof FsError !== "function") {
    throw new Error("@deepseek-ai/dsh-fs did not export FsError");
  }
  return { LocalFileSystem, FsError };
}

// Builds the fenced provider class against the installed Harness base classes.
//
// Synchronous because the Cordis loader instantiates a plugin module's default export as the
// service class, so the class must exist when the module finishes evaluating.
export function createFencedFileSystemClassSync({ require }) {
  const { LocalFileSystem, FsError } = loadBase(require);

  return class FencedFileSystem extends LocalFileSystem {
    constructor(ctx, config) {
      super(ctx, config);
      const root = config?.attemptRoot ?? config?.cwd;
      // Failing closed is essential. A fence that quietly fell back to the unfenced provider would
      // leave reads escaping at exactly the moment it appeared to be preventing them, so a missing
      // root refuses to boot rather than running unconfined.
      if (!root) throw new Error("FencedFileSystem requires an attemptRoot; refusing to run unfenced");
      this.fence = new AttemptFence(root);
    }

    // Reported so the tool layer advertises confinement honestly rather than offering an escalation
    // that does not exist. There is no wider mode to escalate to: this provider has exactly one.
    get sandboxMode() {
      return "workspace-write";
    }

    async resolve(pathish, opts) {
      const target = await super.resolve(pathish, opts);
      // Judge the path the provider actually resolved to, not the string the model supplied, so
      // aliases, symlinks, junctions and traversal are all decided on the real location.
      const processPath = this.processPath(target);
      try {
        this.fence.resolve(processPath, "resolve");
      } catch (error) {
        if (error instanceof FenceViolation) {
          // Raised as the filesystem service's own structured error so the tool layer reports a
          // clean denial instead of an unrecognized crash.
          throw new FsError(
            `path is outside the attempt worktree: ${target.displayPath ?? processPath}`,
            "FS_FENCE_DENIED",
          );
        }
        throw error;
      }
      return target;
    }
  };
}

// Convenience wrapper for callers that hold a path rather than a require function -- notably the
// tests, which build the class against the Harness installation from outside the Harness process.
export async function createFencedFileSystemClass({ requireFrom }) {
  const { createRequire } = await import("node:module");
  return createFencedFileSystemClassSync({ require: createRequire(requireFrom) });
}
