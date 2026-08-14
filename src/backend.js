import fs from "node:fs";
import path from "node:path";
import { runProcess } from "./process.js";

const INLINE_POLICY = {
  $schema: "https://opencode.ai/config.json",
  agent: {
    "delegate-wave-reader": {
      description: "Bounded read-only repository investigator confined to one attempt worktree",
      mode: "primary",
      steps: 16,
      permission: {
        read: "allow",
        edit: "deny",
        glob: "allow",
        grep: "allow",
        list: "allow",
        lsp: "deny",
        bash: "deny",
        external_directory: "deny",
        task: "deny",
        skill: "deny",
        webfetch: "deny",
        websearch: "deny",
        question: "deny",
      },
    },
    "delegate-wave-worker": {
      description: "Bounded implementation worker confined to one disposable attempt worktree",
      mode: "primary",
      steps: 24,
      permission: {
        read: "allow",
        edit: "allow",
        glob: "allow",
        grep: "allow",
        list: "allow",
        lsp: "deny",
        bash: "deny",
        external_directory: "deny",
        task: "deny",
        skill: "deny",
        webfetch: "deny",
        websearch: "deny",
        question: "deny",
      },
    },
  },
};

export class FakeBackend {
  constructor(handler = async () => ({ exitCode: 0, stdout: "fake success", stderr: "" })) {
    this.handler = handler;
  }

  async run(context) {
    return this.handler(context);
  }
}

export class OpenCodeBackend {
  constructor({ executable, prefixArgs, attach, timeoutMs = 30 * 60_000, launchResolver = defaultOpenCodeLaunch } = {}) {
    if (executable) {
      this.executable = executable;
      this.prefixArgs = prefixArgs ?? [];
    } else {
      const launch = launchResolver();
      this.executable = launch.executable;
      this.prefixArgs = prefixArgs ?? launch.prefixArgs;
    }
    this.attach = attach;
    this.timeoutMs = timeoutMs;
  }

  async run({ attemptId, worktreePath, goal, model, artifactDir, mode, onSpawn }) {
    fs.mkdirSync(artifactDir, { recursive: true });
    const stdoutPath = path.join(artifactDir, "opencode-events.jsonl");
    const stderrPath = path.join(artifactDir, "opencode-stderr.log");
    const stdoutStream = fs.createWriteStream(stdoutPath, { flags: "wx" });
    const stderrStream = fs.createWriteStream(stderrPath, { flags: "wx" });
    const prompt = mode === "read"
      ? `Investigate this task without modifying files. Return concise findings with exact file paths and evidence.\n\nTask: ${goal}`
      : `Implement this bounded task in the current worktree. Do not commit, push, modify Git metadata, or access files outside this worktree. Shell access is intentionally disabled; edit only the necessary files.\n\nTask: ${goal}`;
    const args = [...this.prefixArgs,
      "run", prompt,
      "--agent", mode === "read" ? "delegate-wave-reader" : "delegate-wave-worker",
      "--format", "json",
      "--dir", worktreePath,
      "--title", `delegate-wave ${attemptId}`,
    ];
    if (model) args.push("--model", model);
    if (this.attach) args.push("--attach", this.attach);
    const result = await runProcess(this.executable, args, {
      cwd: worktreePath,
      timeoutMs: this.timeoutMs,
      env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(INLINE_POLICY) },
      onSpawn,
      onStdout: (text) => stdoutStream.write(text),
      onStderr: (text) => stderrStream.write(text),
    });
    await Promise.all([
      new Promise((resolve) => stdoutStream.end(resolve)),
      new Promise((resolve) => stderrStream.end(resolve)),
    ]);
    return { ...result, stdoutPath, stderrPath };
  }
}

function defaultOpenCodeLaunch() {
  if (process.platform !== "win32") return { executable: "opencode", prefixArgs: [] };
  const configuredEntry = process.env.OPENCODE_NODE_ENTRY;
  if (!configuredEntry && !process.env.APPDATA) {
    throw new Error("APPDATA is unavailable; set OPENCODE_NODE_ENTRY or pass an executable explicitly");
  }
  const entry = configuredEntry
    ?? path.join(process.env.APPDATA, "npm", "node_modules", "opencode-ai", "bin", "opencode");
  if (!fs.existsSync(entry)) {
    throw new Error("OpenCode Node entry was not found; set OPENCODE_NODE_ENTRY or pass an executable explicitly");
  }
  return { executable: process.execPath, prefixArgs: [entry] };
}
