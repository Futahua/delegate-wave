// A clean exit is not a claim that the agent did anything.
//
// Dogfood run 5: two investigations hit a non-retryable provider 400, emitted an `error` event,
// produced no answer -- and OpenCode exited 0. Both were recorded SUCCEEDED. The manager then spent
// two strong turns reasoning around evidence that did not exist, which is the expensive half: an
// honest failure would have been retried for fractions of a cent, while a false success is paid for
// in the scarce resource.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeDataRoot } from "../src/db.js";
import { FakeBackend, assessOpenCodeTranscript } from "../src/backend.js";
import { Dispatcher } from "../src/service.js";
import { runProcess } from "../src/process.js";

async function command(name, args, cwd) {
  const result = await runProcess(name, args, { cwd });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

const step = (reason) => JSON.stringify({ type: "step_finish", part: { reason, tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.0001 } });
const text = (body) => JSON.stringify({ type: "text", part: { text: body } });
// The shape run 5 actually produced: a provider rejection, mid-turn, after several tool calls.
const providerError = JSON.stringify({
  type: "error",
  error: {
    name: "APIError",
    data: {
      message: "Error from provider (Console Go): Upstream request failed: [unsupported_tool_schema] "
        + "The tool schema is not supported (unsupported_keyword).",
      statusCode: 400,
      isRetryable: false,
    },
  },
});

function transcript(...lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-outcome-"));
  const file = path.join(dir, "opencode-events.jsonl");
  fs.writeFileSync(file, lines.join("\n"));
  return file;
}

test("the transcript, not the exit code, decides whether the agent completed", () => {
  // Normal completion: the model concluded its own turn.
  assert.equal(assessOpenCodeTranscript(transcript(
    step("tool-calls"), text("here is what I found"), step("stop"),
  )).state, "SUCCEEDED");

  // Success is NOT tied to a report existing. A worker may legitimately finish with nothing to say,
  // and failing that run would punish honesty.
  assert.equal(assessOpenCodeTranscript(transcript(step("stop"))).state, "SUCCEEDED");

  // The run 5 failure: work happened, then the provider refused, and OpenCode exited 0 anyway.
  const errored = assessOpenCodeTranscript(transcript(
    step("tool-calls"), step("tool-calls"), providerError,
  ));
  assert.equal(errored.state, "FAILED");
  assert.match(errored.reason, /unsupported_tool_schema/);

  // An error anywhere condemns the turn, even when a terminal step also appears: the transcript is
  // then self-contradictory, and success is the one reading that must not be chosen.
  assert.equal(assessOpenCodeTranscript(transcript(
    step("tool-calls"), providerError, step("stop"),
  )).state, "FAILED");

  // Ambiguity resolves to failure in every direction.
  assert.equal(assessOpenCodeTranscript(transcript(step("tool-calls"))).state, "FAILED",
    "a turn that only ever continued never concluded");
  assert.equal(assessOpenCodeTranscript(transcript("")).state, "FAILED", "empty transcript");
  assert.equal(assessOpenCodeTranscript(transcript("{not json")).state, "FAILED", "unparseable transcript");
  assert.equal(assessOpenCodeTranscript(path.join(os.tmpdir(), "definitely-absent.jsonl")).state, "FAILED",
    "missing transcript");

  // Truncation is a completion of the request but not of the answer, so it is not success.
  assert.equal(assessOpenCodeTranscript(transcript(step("length"))).state, "FAILED",
    "a turn cut off by a token limit produced an answer nobody can trust");
});

test("a worker whose turn died at the provider is not recorded as SUCCEEDED", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-wo-"));
  const root = path.join(temp, "data");
  const repo = path.join(temp, "repo");
  fs.mkdirSync(repo);
  await command("git", ["init", "-b", "main"], repo);
  await command("git", ["config", "user.name", "Test"], repo);
  await command("git", ["config", "user.email", "test@example.invalid"], repo);
  fs.writeFileSync(path.join(repo, "input.txt"), "before\n");
  await command("git", ["add", "."], repo);
  await command("git", ["commit", "-m", "initial"], repo);
  initializeDataRoot(root);

  // Exits 0, like the real thing did.
  const dispatcher = new Dispatcher({
    root,
    backend: new FakeBackend(async ({ artifactDir }) => {
      fs.mkdirSync(artifactDir, { recursive: true });
      const stdoutPath = path.join(artifactDir, "opencode-events.jsonl");
      fs.writeFileSync(stdoutPath, [step("tool-calls"), providerError].join("\n"));
      return {
        exitCode: 0, stdout: "", stderr: "", stdoutPath,
        outcome: assessOpenCodeTranscript(stdoutPath),
      };
    }),
  });
  t.after(async () => {
    dispatcher.close();
    const listed = await runProcess("git", ["-C", repo, "worktree", "list", "--porcelain"]);
    for (const worktree of listed.stdout.split(/\r?\n/)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length))
      .filter((worktree) => path.resolve(worktree) !== path.resolve(repo))) {
      await runProcess("git", ["-C", repo, "worktree", "unlock", worktree]);
      await runProcess("git", ["-C", repo, "worktree", "remove", "--force", worktree]);
    }
    fs.rmSync(temp, { recursive: true, force: true });
  });

  const project = await dispatcher.addProject({ name: "Outcome", repoPath: repo, validation: [] });
  const job = await dispatcher.createJob({
    projectId: project.id, goal: "investigate something", mode: "read", maxAttempts: 1,
  });
  await dispatcher.runJob(job.id, { model: "opencode-go/deepseek-v4-flash" });

  const attempt = dispatcher.db.prepare(
    "SELECT * FROM attempts WHERE job_id = ? ORDER BY ordinal DESC LIMIT 1",
  ).get(job.id);
  assert.equal(attempt.terminal_state, "FAILED",
    "exit 0 must not override the transcript's account of what happened");
});
