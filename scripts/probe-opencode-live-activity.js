import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { normalizeOpenCodeActivity } from "../src/presentation/activity-open-code.js";

const model = process.argv[2] ?? "opencode-go/gpt-5.6-luna";
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-live-probe-"));
const databasePath = path.join(temp, "opencode-state.db");
const eventsPath = path.join(temp, "opencode-events.jsonl");
const stderrPath = path.join(temp, "opencode-stderr.log");
const attempt = { id: "probe-attempt", started_at: new Date().toISOString() };
const opencodeEntry = path.join(process.env.APPDATA ?? "", "npm", "node_modules", "opencode-ai", "bin", "opencode");
assert.ok(fs.existsSync(opencodeEntry), `OpenCode entry not found: ${opencodeEntry}`);

const stdout = fs.createWriteStream(eventsPath);
const stderr = fs.createWriteStream(stderrPath);
const prompt = "Use the bash tool exactly once. Run: node -e \"setTimeout(() => console.log('LIVE_PROBE_DONE'), 8000)\". Wait for it to finish, then answer briefly.";
const child = spawn(process.execPath, [opencodeEntry, "run", prompt, "--format", "json", "--dir", temp, "--model", model], {
  cwd: temp,
  env: { ...process.env, OPENCODE_DB: databasePath },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.pipe(stdout);
child.stderr.pipe(stderr);

let running = null;
const deadline = Date.now() + 120_000;
while (Date.now() < deadline && child.exitCode === null) {
  const projection = normalizeOpenCodeActivity({ attempt, filePath: eventsPath, runtimeDatabasePath: databasePath });
  running = projection.activities.find((item) => item.kind === "command" && ["started", "updated"].includes(item.lifecycle));
  if (running) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
assert.ok(running, "OpenCode never exposed the slow command before it completed");

const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", resolve);
});
await Promise.all([new Promise((resolve) => stdout.end(resolve)), new Promise((resolve) => stderr.end(resolve))]);
assert.equal(exitCode, 0, fs.readFileSync(stderrPath, "utf8"));
const settled = normalizeOpenCodeActivity({ attempt, filePath: eventsPath, runtimeDatabasePath: databasePath })
  .activities.find((item) => item.id === running.id);
assert.equal(settled?.lifecycle, "completed", `same row did not settle: ${JSON.stringify(settled)}`);
console.log(JSON.stringify({ model, running_id: running.id, running_title: running.title, settled: settled.lifecycle, temp }));

// Keep a failed probe for diagnosis, but a successful probe owns no durable product data.
fs.rmSync(temp, { recursive: true, force: true });
