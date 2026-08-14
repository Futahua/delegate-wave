import path from "node:path";

export function dataRoot(env = process.env) {
  if (env.DELEGATE_WAVE_DATA_ROOT) return path.resolve(env.DELEGATE_WAVE_DATA_ROOT);
  if (process.platform === "win32") return "D:\\AssistantSystem\\delegate-wave";
  return path.join(env.HOME ?? process.cwd(), ".local", "share", "delegate-wave");
}

export function managedPaths(root = dataRoot()) {
  return {
    root,
    config: path.join(root, "config"),
    state: path.join(root, "state"),
    database: path.join(root, "state", "delegate-wave.sqlite"),
    worktrees: path.join(root, "worktrees"),
    integration: path.join(root, "integration"),
    artifacts: path.join(root, "artifacts"),
    logs: path.join(root, "logs"),
    cache: path.join(root, "cache"),
    tmp: path.join(root, "tmp"),
    backups: path.join(root, "backups"),
  };
}
