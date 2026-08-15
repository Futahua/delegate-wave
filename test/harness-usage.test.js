// Usage accounting for the Harness backend.
//
// The rules here are the same ones every backend answers to (WRK-010/011): absence is not zero, a
// partial measurement says so, and the five token dimensions are disjoint so nothing is priced
// twice. What differs is the wire format, and specifically that Harness reports DeepSeek's
// `completion_tokens` as `outputTokens` -- a figure that INCLUDES reasoning.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseHarnessUsage, observeHarnessArtifact, readHarnessUsage, HARNESS_USAGE_FORMAT,
} from "../src/harness/usage.js";
import { assertValidObservation, finalizeUsageReceipt, USAGE_COMPLETE, USAGE_PARTIAL, USAGE_UNKNOWN } from "../src/usage.js";
import { DEFAULT_PRICING_BASIS } from "../src/pricing.js";

const message = (usage) => JSON.stringify({ type: "assistant/message", data: usage ? { usage } : {} });
const log = (...lines) => lines.join("\n");

// The three model calls from a real restricted-profile Harness run against the Go route.
const OBSERVED_RUN = log(
  JSON.stringify({ type: "session", id: "session-probe" }),
  JSON.stringify({ type: "turn/start" }),
  message({ inputTokens: 140, outputTokens: 77, cacheReadTokens: 6528, reasoningTokens: 14 }),
  JSON.stringify({ type: "tool/call" }),
  message({ inputTokens: 160, outputTokens: 141, cacheReadTokens: 6656, reasoningTokens: 42 }),
  message({ inputTokens: 97, outputTokens: 47, cacheReadTokens: 6912, reasoningTokens: 0 }),
  JSON.stringify({ type: "turn/end" }),
);

test("a real Harness session yields a COMPLETE observation", () => {
  const observed = parseHarnessUsage(OBSERVED_RUN);
  assert.equal(observed.status, USAGE_COMPLETE);
  assert.equal(observed.provider_steps, 3, "one step per model call, not per log record");
  assert.equal(observed.input_tokens, 397);
  assert.equal(observed.cache_read_tokens, 20096);
  assert.equal(observed.malformed_events, 0);
  assertValidObservation(observed);
});

// The central accounting property. Harness's own adapter leaves reasoning nested inside
// outputTokens; a backend copying both fields across would bill those tokens twice and make the
// Harness arm look more expensive than it is.
test("reasoning tokens are subtracted from output rather than counted twice", () => {
  const observed = parseHarnessUsage(OBSERVED_RUN);
  assert.equal(observed.reasoning_tokens, 56, "14 + 42 + 0");
  assert.equal(observed.output_tokens, 209, "265 completion tokens minus the 56 that were reasoning");
  assert.equal(
    observed.output_tokens + observed.reasoning_tokens, 265,
    "the two dimensions must partition completion_tokens exactly",
  );
});

test("the reference cost matches a hand computation against the pinned basis", () => {
  const receipt = finalizeUsageReceipt({
    attemptId: "attempt-probe",
    backend: "harness",
    model: "deepseek-v4-flash",
    observation: parseHarnessUsage(OBSERVED_RUN),
    basisId: DEFAULT_PRICING_BASIS,
  });
  // 397 cache-miss input @ $0.14/Mtok + 20096 cache-hit @ $0.0028 + 265 output @ $0.28.
  const expected = (397 / 1e6) * 0.14 + (20096 / 1e6) * 0.0028 + (265 / 1e6) * 0.28;
  assert.ok(
    Math.abs(receipt.reference_cost_usd - expected) < 1e-12,
    `expected ${expected}, got ${receipt.reference_cost_usd}`,
  );
});

test("an explicitly reported zero is a measurement, not a missing figure", () => {
  const observed = parseHarnessUsage(message({ inputTokens: 10, outputTokens: 5, reasoningTokens: 0 }));
  assert.equal(observed.status, USAGE_COMPLETE, "a call that genuinely did no reasoning is fully measured");
  assert.equal(observed.reasoning_tokens, 0);
});

// The counterpart, and the error this codebase has made before: a model call whose usage was never
// reported must not be silently skipped, because skipping it presents a partial sum as the whole.
test("a model call reporting no usage degrades the observation to PARTIAL", () => {
  const observed = parseHarnessUsage(log(
    message({ inputTokens: 100, outputTokens: 50, reasoningTokens: 0 }),
    message(null),
  ));
  assert.equal(observed.status, USAGE_PARTIAL);
  assert.equal(observed.provider_steps, 1, "only the measured call counts as a step");
  assert.equal(observed.malformed_events, 1, "and the unmeasured one is recorded, not discarded");
});

test("a session with no model calls at all is UNKNOWN, not zero", () => {
  const observed = parseHarnessUsage(log(
    JSON.stringify({ type: "session" }),
    JSON.stringify({ type: "turn/end" }),
  ));
  assert.equal(observed.status, USAGE_UNKNOWN);
  assert.equal(observed.input_tokens, null, "UNKNOWN carries no token figures at all");
  assert.equal(observed.provider_steps, 0);
  assertValidObservation(observed);
});

test("a missing input or output figure makes the call unusable rather than zero", () => {
  assert.equal(readHarnessUsage({ outputTokens: 5 }), null, "no input reported");
  assert.equal(readHarnessUsage({ inputTokens: 5 }), null, "no output reported");
  assert.equal(readHarnessUsage(null), null);
});

test("malformed values are rejected rather than coerced", () => {
  assert.equal(readHarnessUsage({ inputTokens: 1.5, outputTokens: 5 }), null, "fractional");
  assert.equal(readHarnessUsage({ inputTokens: -1, outputTokens: 5 }), null, "negative");
  assert.equal(readHarnessUsage({ inputTokens: "10", outputTokens: 5 }), null, "string");
});

// If this ever held, the wire contract would have changed and subtraction would be wrong. Better to
// refuse the figure than to emit a negative output count that prices as a discount.
test("reasoning exceeding output is refused, not subtracted into a negative", () => {
  assert.equal(readHarnessUsage({ inputTokens: 10, outputTokens: 5, reasoningTokens: 9 }), null);
});

test("an unparseable line is counted as malformed", () => {
  const observed = parseHarnessUsage(log(
    message({ inputTokens: 10, outputTokens: 5, reasoningTokens: 0 }),
    "{ this is not json",
  ));
  assert.equal(observed.status, USAGE_PARTIAL);
  assert.equal(observed.malformed_events, 1);
});

test("a missing artifact is UNKNOWN and keeps its provenance", () => {
  const observed = observeHarnessArtifact("D:/nonexistent/session.jsonl");
  assert.equal(observed.status, USAGE_UNKNOWN);
  assert.equal(observed.source_format, HARNESS_USAGE_FORMAT);
  assert.equal(observed.source_artifact, "D:/nonexistent/session.jsonl");
  assertValidObservation(observed);
});

test("Harness reports tokens, never a price", () => {
  const observed = parseHarnessUsage(OBSERVED_RUN);
  assert.equal(observed.reported_cost_usd, null, "a backend must not compute the comparator");
  assert.equal(observed.reported_cost_source, null);
});

test("an artifact on disk reads the same as its text", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-harness-usage-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const file = path.join(temp, "session.jsonl");
  fs.writeFileSync(file, `${OBSERVED_RUN}\n`);
  const observed = observeHarnessArtifact(file);
  assert.equal(observed.status, USAGE_COMPLETE);
  assert.equal(observed.output_tokens, 209);
  assert.equal(observed.source_artifact, file);
});

// Pricing must be backend-independent: the same real usage costs the same whichever executor
// reported it, or a cost comparison between them measures the adapter instead of the work.
test("the same real usage prices identically from either backend", async () => {
  const { parseOpenCodeUsage } = await import("../src/usage.js");
  const harness = parseHarnessUsage(message({
    inputTokens: 1000, outputTokens: 300, cacheReadTokens: 500, reasoningTokens: 100,
  }));
  // OpenCode reports the same real usage with reasoning already disjoint from output.
  const opencode = parseOpenCodeUsage(JSON.stringify({
    type: "step_finish",
    id: "step-1",
    tokens: { input: 1000, output: 200, reasoning: 100, cache: { read: 500, write: 0 } },
  }));
  const price = (observation, backend) => finalizeUsageReceipt({
    attemptId: "attempt-compare", backend, model: "deepseek-v4-flash", observation,
    basisId: DEFAULT_PRICING_BASIS,
  }).reference_cost_usd;
  assert.equal(price(harness, "harness"), price(opencode, "opencode"));
});

// The dispatcher names models by route (`provider/model`); Harness's adapter wants the bare wire
// model, with the route carried separately by baseURL. Passing the qualified id straight through
// produced "Model opencode-go/deepseek-v4-flash is not supported" from an otherwise correct run.
test("route-qualified model ids are translated to wire models", async () => {
  const { wireModel } = await import("../src/harness/backend.js");
  assert.equal(wireModel("opencode-go/deepseek-v4-flash"), "deepseek-v4-flash");
  assert.equal(wireModel("opencode-go/deepseek-v4-pro"), "deepseek-v4-pro");
  assert.equal(wireModel("deepseek-v4-flash"), "deepseek-v4-flash", "an already-bare id passes through");
});

// Guessing by stripping any prefix would turn a typo, or a model this route does not carry, into a
// confusing auth failure deep inside the worker instead of a clear refusal before it starts.
test("an unknown model is refused rather than guessed", async () => {
  const { wireModel } = await import("../src/harness/backend.js");
  assert.throws(() => wireModel("some-other-provider/gpt-9"), /no wire model/);
  assert.throws(() => wireModel("deepseek-v9-imaginary"), /no wire model/);
});
