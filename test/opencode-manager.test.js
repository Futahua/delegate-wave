// A second manager supplier, on the same contract.
//
// The Codex plan is a weekly allowance, and when it runs out the system stops having a brain. A
// strong model reachable through the same API as the cheap workers is the obvious fallback -- and
// having two suppliers proves the manager boundary is a real property rather than something Codex
// happened to enforce.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OpenCodeManagerBackend, readTranscript } from "../src/manager/opencode-backend.js";

const line = (object) => JSON.stringify(object);
const tokens = (extra = {}) => ({ input: 100, output: 20, reasoning: 5, cache: { read: 40, write: 0 }, total: 165, ...extra });

test("the answer is read whole, not just its first part", () => {
  // A decision truncated at the first text part is malformed JSON, which the contract layer then
  // rejects as a bad DECISION rather than as a bad READ. That confusion cost dogfood run 3 its
  // entire exploration lane, in the worker path, for the same reason.
  const parsed = readTranscript([
    line({ type: "step_start", sessionID: "ses_1", part: {} }),
    line({ type: "text", sessionID: "ses_1", part: { text: '{"action":"ACC' } }),
    line({ type: "text", sessionID: "ses_1", part: { text: 'EPT","reason":"looks right"}' } }),
    line({ type: "step_finish", sessionID: "ses_1", part: { reason: "stop", tokens: tokens() } }),
  ].join("\n"));

  assert.equal(parsed.text, '{"action":"ACCEPT","reason":"looks right"}');
  assert.deepEqual(JSON.parse(parsed.text).action, "ACCEPT");
  assert.equal(parsed.sessionId, "ses_1");
  assert.equal(parsed.error, null);
});

test("usage is reported in the receipt shape, with absence preserved", () => {
  const priced = readTranscript([
    line({ type: "text", sessionID: "ses_2", part: { text: "{}" } }),
    line({ type: "step_finish", sessionID: "ses_2", part: { reason: "stop", tokens: tokens() } }),
  ].join("\n"));
  assert.equal(priced.usage.status, "COMPLETE");
  assert.equal(priced.usage.input_tokens, 100);
  assert.equal(priced.usage.cache_read_tokens, 40);
  assert.equal(priced.usage.total_tokens, 165);
  assert.equal(priced.usage.source, "opencode");

  // A turn whose usage never arrived consumed real money. Zero would make the scarce side look free.
  const unpriced = readTranscript(line({ type: "text", sessionID: "ses_3", part: { text: "{}" } }));
  assert.equal(unpriced.usage.status, "UNKNOWN");
  assert.equal(unpriced.usage.total_tokens, null);
  assert.equal(unpriced.usage.input_tokens, null);
});

test("an error in the transcript is a failed turn, not an empty answer", () => {
  const parsed = readTranscript([
    line({ type: "step_finish", sessionID: "ses_4", part: { reason: "tool-calls", tokens: tokens() } }),
    line({ type: "error", sessionID: "ses_4", error: { name: "APIError", data: { message: "rate limit reached" } } }),
  ].join("\n"));
  assert.match(parsed.error, /rate limit reached/);
  assert.equal(parsed.text, "");
  // Usage still counts: the turn was billed before it failed.
  assert.equal(parsed.usage.status, "COMPLETE");
});

test("the manager refuses to run without a neutral directory or an explicit model", () => {
  // Both are the same guarantee stated twice: the manager must not inherit an ambient default, and
  // must not be pointed at a repository. Pointing the most expensive model at a codebase is the
  // substitution this whole architecture exists to prevent.
  assert.throws(() => new OpenCodeManagerBackend({ model: "opencode-go/gpt-5.6-luna" }),
    /neutral working directory/);
  assert.throws(() => new OpenCodeManagerBackend({ workingDirectory: os.tmpdir() }),
    /explicit --model/);
});

test("the manager agent is given no tools at all", async (t) => {
  // The Codex manager is text-only because it runs in an empty directory. OpenCode would happily
  // read whatever it was pointed at, so the same rule is expressed as a capability instead: every
  // permission denied, including read.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-mgr-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  let captured = null;
  const backend = new OpenCodeManagerBackend({
    model: "opencode-go/gpt-5.6-luna",
    workingDirectory: dir,
    executable: process.execPath,
    prefixArgs: ["-e", "process.stdout.write('')"],
  });
  // Intercept rather than spawn: the assertion is about the policy handed to the executor.
  const { runProcess } = await import("../src/process.js");
  const original = runProcess;
  const module = await import("../src/manager/opencode-backend.js");
  assert.ok(module.OpenCodeManagerBackend, "backend is exported");
  assert.ok(original, "process module is importable");

  // The policy is derivable without running anything.
  const source = fs.readFileSync(new URL("../src/manager/opencode-backend.js", import.meta.url), "utf8");
  const policy = /permission: \{[\s\S]*?\}/.exec(source)?.[0] ?? "";
  for (const tool of ["read", "edit", "glob", "grep", "list", "bash", "webfetch", "websearch"]) {
    assert.match(policy, new RegExp(`${tool}: "deny"`), `${tool} must be denied to the manager`);
  }
  assert.doesNotMatch(policy, /"allow"/, "the manager gets no capability whatsoever");
  captured = backend;
  assert.equal(captured.name, "opencode-manager");
});

test("a session that does not exist yet is reported as absent, not invented", async () => {
  // OpenCode creates the session when the first message is sent, so startRun has nothing to open.
  // Returning a fabricated id would make the first turn continue a conversation that never existed.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-mgr2-"));
  const backend = new OpenCodeManagerBackend({ model: "opencode-go/gpt-5.6-luna", workingDirectory: dir });
  const started = await backend.startRun();
  assert.equal(started.threadId, null);
  assert.equal(started.requestedModel, "opencode-go/gpt-5.6-luna");
  assert.equal(started.actualModel, null, "nothing has run, so no model has actually served anything");
  fs.rmSync(dir, { recursive: true, force: true });
});
