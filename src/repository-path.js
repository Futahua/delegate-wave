import path from "node:path";

// The caller resolves filesystem aliases with realpath first. realpath alone does
// not case-fold Windows paths. Keep display/storage paths separate from identity.
export function repositoryPathIdentity(value, platform = process.platform) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  let normalized = paths.normalize(value);
  if (platform === "win32") {
    normalized = normalized.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
  }
  const root = paths.parse(normalized).root;
  while (normalized.length > root.length && normalized.endsWith(paths.sep)) normalized = normalized.slice(0, -1);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}
