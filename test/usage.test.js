// The executor usage receipt is evidence, never authority. These tests pin the distinctions the
// executor A/B depends on: UNKNOWN is not zero, failed work still costs money, and a receipt can
// never make an attempt succeed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  COST_SOURCE_EXECUTOR, finalizeUsageReceipt, observeOpenCodeArtifact, parseOpenCodeUsage,
  USAGE_COMPLETE, USAGE_PARTIAL, USAGE_UNKNOWN,
} from "../src/usage.js";
import { DEFAULT_PRICING_BASIS, PRICING_BASES, pricedModelName, referenceCostUsd } from "../src/pricing.js";

const stepFinish = (tokens, cost) => JSON.stringify({
  type: "step_finish", part: { type: "step_finish", tokens, cost },
});
const tokens = (input, output, reasoning, read, write = 0) => ({
  input, output, reasoning, cache: { read, write },
});

test("four valid step_finish events sum to one COMPLETE receipt", () => {
  const artifact = [
    stepFinish(tokens(1000, 50, 5, 4000), 0.0001),
    stepFinish(tokens(1100, 60, 6, 5000), 0.00011),
    stepFinish(tokens(1200, 70, 7, 6000), 0.00012),
    stepFinish(tokens(1300, 80, 8, 7000), 0.00013),
    JSON.stringify({ type: "tool_use", part: {} }),
  ].join("\n");

  const usage = parseOpenCodeUsage(artifact);
  assert.equal(usage.status, USAGE_COMPLETE);
  assert.equal(usage.provider_steps, 4);
  assert.equal(usage.input_tokens, 4600);
  assert.equal(usage.output_tokens, 260);
  assert.equal(usage.reasoning_tokens, 26);
  assert.equal(usage.cache_read_tokens, 22000);
  assert.equal(usage.cache_write_tokens, 0);
  assert.ok(Math.abs(usage.reported_cost_usd - 0.00046) < 1e-12);
  assert.equal(usage.malformed_events, 0);
});

test("an explicit zero-usage receipt is COMPLETE with zeroes, not UNKNOWN", () => {
  const usage = parseOpenCodeUsage(stepFinish(tokens(0, 0, 0, 0), 0));
  assert.equal(usage.status, USAGE_COMPLETE);
  assert.equal(usage.input_tokens, 0);
  assert.equal(usage.output_tokens, 0);
  assert.equal(usage.reported_cost_usd, 0);
  assert.equal(usage.provider_steps, 1);
});

test("no usage events yields UNKNOWN with null numeric fields, never zero", () => {
  for (const artifact of ["", "\n\n", JSON.stringify({ type: "tool_use", part: {} })]) {
    const usage = parseOpenCodeUsage(artifact);
    assert.equal(usage.status, USAGE_UNKNOWN);
    assert.equal(usage.input_tokens, null);
    assert.equal(usage.output_tokens, null);
    assert.equal(usage.cache_read_tokens, null);
    assert.equal(usage.reported_cost_usd, null);
    assert.equal(usage.provider_steps, 0);
  }
});

test("valid usage followed by a truncated tail is PARTIAL and keeps what was observed", () => {
  const artifact = [
    stepFinish(tokens(1000, 50, 5, 4000), 0.0001),
    stepFinish(tokens(1000, 50, 5, 4000), 0.0001),
    '{"type":"step_finish","part":{"tokens":{"input":999',
  ].join("\n");

  const usage = parseOpenCodeUsage(artifact);
  assert.equal(usage.status, USAGE_PARTIAL);
  assert.equal(usage.provider_steps, 2);
  assert.equal(usage.input_tokens, 2000, "observed totals must be retained");
  assert.equal(usage.malformed_events, 1);
});

test("a step_finish without a tokens object degrades the receipt rather than counting as zero", () => {
  const artifact = [
    stepFinish(tokens(1000, 50, 5, 4000), 0.0001),
    JSON.stringify({ type: "step_finish", part: { type: "step_finish", cost: 0.5 } }),
  ].join("\n");
  const usage = parseOpenCodeUsage(artifact);
  assert.equal(usage.status, USAGE_PARTIAL);
  assert.equal(usage.provider_steps, 1);
  assert.equal(usage.input_tokens, 1000);
  assert.ok(Math.abs(usage.reported_cost_usd - 0.0001) < 1e-12,
    "cost from an unusable step must not be counted");
});

test("provider-reported cost is null when absent, never zero", () => {
  const artifact = JSON.stringify({
    type: "step_finish", part: { type: "step_finish", tokens: tokens(100, 10, 0, 0) },
  });
  const usage = parseOpenCodeUsage(artifact);
  assert.equal(usage.status, USAGE_COMPLETE);
  assert.equal(usage.input_tokens, 100);
  assert.equal(usage.reported_cost_usd, null, "absent cost must stay distinct from 0");
});

test("the same raw artifact parsed twice yields the same receipt", () => {
  const artifact = [
    stepFinish(tokens(1000, 50, 5, 4000), 0.0001),
    stepFinish(tokens(2000, 60, 6, 5000), 0.0002),
  ].join("\n");
  const first = parseOpenCodeUsage(artifact);
  const second = parseOpenCodeUsage(artifact);
  assert.deepEqual(first, second, "normalization must be deterministic");
});

test("reference cost is derived from a pinned basis and prices by model, not route", () => {
  const usage = {
    input_tokens: 1_000_000, output_tokens: 1_000_000, reasoning_tokens: 0,
    cache_read_tokens: 0, cache_write_tokens: 0,
  };
  const rates = PRICING_BASES[DEFAULT_PRICING_BASIS].models["deepseek-v4-flash"];

  const viaGo = referenceCostUsd(usage, { model: "opencode-go/deepseek-v4-flash" });
  const viaDirect = referenceCostUsd(usage, { model: "deepseek-official/deepseek-v4-flash" });
  assert.equal(viaGo.reference_cost_usd, viaDirect.reference_cost_usd,
    "the same model must price identically regardless of route");
  assert.equal(viaGo.pricing_basis_id, DEFAULT_PRICING_BASIS);
  assert.ok(Math.abs(viaGo.reference_cost_usd - (rates.input_per_mtok + rates.output_per_mtok)) < 1e-12);
  assert.equal(rates.input_per_mtok, 0.14, "cache-miss input rate");
  assert.equal(rates.cache_read_per_mtok, 0.0028, "cache-hit input rate");
  assert.equal(rates.output_per_mtok, 0.28, "output rate");
  assert.equal(pricedModelName("a/b/deepseek-v4-pro"), "deepseek-v4-pro");
});

test("an unknown model or basis yields a null reference cost rather than a guess", () => {
  const usage = { input_tokens: 1000, output_tokens: 10, reasoning_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
  assert.deepEqual(referenceCostUsd(usage, { model: "opencode-go/some-unknown-model" }),
    { reference_cost_usd: null, pricing_basis_id: null });
  assert.deepEqual(referenceCostUsd(usage, { model: "deepseek-v4-flash", basisId: "no-such-basis" }),
    { reference_cost_usd: null, pricing_basis_id: null });
  // An UNKNOWN receipt has no tokens to price.
  assert.deepEqual(referenceCostUsd({ input_tokens: null }, { model: "deepseek-v4-flash" }),
    { reference_cost_usd: null, pricing_basis_id: null });
});

test("a missing artifact produces an UNKNOWN receipt that preserves its provenance", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-usage-missing-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const receipt = finalizeUsageReceipt({
    attemptId: "attempt-1", backend: "OpenCodeBackend", model: "opencode-go/deepseek-v4-flash",
    observation: observeOpenCodeArtifact(path.join(root, "absent.jsonl")),
    now: "2026-08-14T00:00:00.000Z",
  });
  assert.equal(receipt.status, USAGE_UNKNOWN);
  assert.equal(receipt.input_tokens, null);
  assert.equal(receipt.reference_cost_usd, null);
  assert.equal(receipt.pricing_basis_id, null);
  assert.equal(receipt.source_backend, "OpenCodeBackend");
  assert.match(receipt.source_artifact, /absent\.jsonl$/);
  assert.equal(receipt.source_format, "opencode-events-jsonl");
});

test("a complete receipt carries both provider-reported and reference cost as separate facts", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-usage-both-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifactPath = path.join(root, "opencode-events.jsonl");
  fs.writeFileSync(artifactPath, [
    stepFinish(tokens(1000, 100, 10, 5000), 0.000123),
    stepFinish(tokens(1000, 100, 10, 5000), 0.000123),
  ].join("\n"));

  const receipt = finalizeUsageReceipt({
    attemptId: "attempt-2", backend: "OpenCodeBackend", model: "opencode-go/deepseek-v4-flash",
    observation: observeOpenCodeArtifact(artifactPath), now: "2026-08-14T00:00:00.000Z",
  });
  assert.equal(receipt.status, USAGE_COMPLETE);
  assert.equal(receipt.provider_steps, 2);
  assert.ok(Math.abs(receipt.reported_cost_usd - 0.000246) < 1e-12);
  assert.ok(receipt.reference_cost_usd > 0);
  assert.notEqual(receipt.reference_cost_usd, receipt.reported_cost_usd,
    "reference cost must be its own fact, not a copy of the provider figure");
  assert.equal(receipt.pricing_basis_id, DEFAULT_PRICING_BASIS);
});

test("cost provenance marks the figure as executor-computed, not a provider bill", () => {
  const usage = parseOpenCodeUsage(stepFinish(tokens(100, 10, 0, 0), 0.00002));
  assert.equal(usage.reported_cost_source, COST_SOURCE_EXECUTOR,
    "OpenCode derives cost locally; it must not be labelled as provider-billed");
  const absent = parseOpenCodeUsage(JSON.stringify({
    type: "step_finish", part: { type: "step_finish", tokens: tokens(100, 10, 0, 0) },
  }));
  assert.equal(absent.reported_cost_source, null);
});

test("a missing individual token dimension degrades to PARTIAL rather than counting as zero", () => {
  // `cache.write` absent: version drift or truncation, not an explicit zero.
  const artifact = [
    stepFinish(tokens(1000, 50, 5, 4000), 0.0001),
    JSON.stringify({
      type: "step_finish",
      part: { type: "step_finish", tokens: { input: 500, output: 20, reasoning: 1, cache: { read: 100 } }, cost: 0.00005 },
    }),
  ].join("\n");
  const usage = parseOpenCodeUsage(artifact);
  assert.equal(usage.status, USAGE_PARTIAL);
  assert.equal(usage.provider_steps, 1, "the incomplete step must not contribute");
  assert.equal(usage.input_tokens, 1000);
  assert.equal(usage.malformed_events, 1);
});

test("a negative token value is treated as malformed, not summed", () => {
  const usage = parseOpenCodeUsage([
    stepFinish(tokens(1000, 50, 5, 4000), 0.0001),
    stepFinish(tokens(-5, 50, 5, 4000), 0.0001),
  ].join("\n"));
  assert.equal(usage.status, USAGE_PARTIAL);
  assert.equal(usage.provider_steps, 1);
  assert.equal(usage.input_tokens, 1000);
});

test("duplicated step events are counted once", () => {
  const step = JSON.stringify({
    type: "step_finish",
    part: { id: "prt_stable", type: "step_finish", tokens: tokens(1000, 50, 5, 4000), cost: 0.0001 },
  });
  const usage = parseOpenCodeUsage([step, step, step].join("\n"));
  assert.equal(usage.provider_steps, 1, "a replayed artifact must not double-count");
  assert.equal(usage.input_tokens, 1000);
  assert.ok(Math.abs(usage.reported_cost_usd - 0.0001) < 1e-12);
});

test("a basis with no cache-write tariff refuses to price cache-write tokens", () => {
  const withWrites = {
    input_tokens: 1000, output_tokens: 10, reasoning_tokens: 0,
    cache_read_tokens: 0, cache_write_tokens: 25,
  };
  assert.deepEqual(referenceCostUsd(withWrites, { model: "deepseek-v4-flash" }),
    { reference_cost_usd: null, pricing_basis_id: null },
    "an unpriced dimension must yield null rather than an invented rate");

  const withoutWrites = { ...withWrites, cache_write_tokens: 0 };
  assert.ok(referenceCostUsd(withoutWrites, { model: "deepseek-v4-flash" }).reference_cost_usd > 0);
});

test("the superseded pricing basis is retained but is not the default", () => {
  assert.equal(DEFAULT_PRICING_BASIS, "deepseek-direct-2026-08-14-v2");
  const old = PRICING_BASES["deepseek-direct-2026-08-14-v1"];
  assert.ok(old, "bases are append-only: a historical receipt may still name the old basis");
  assert.equal(old.superseded_by, DEFAULT_PRICING_BASIS);
});

test("reference cost matches DeepSeek published rates for a known observation", () => {
  // baseline #1 SUMMARY, from the recorded historical artifact.
  const usage = {
    input_tokens: 4531, output_tokens: 324, reasoning_tokens: 107,
    cache_read_tokens: 21376, cache_write_tokens: 0,
  };
  const { reference_cost_usd } = referenceCostUsd(usage, { model: "opencode-go/deepseek-v4-flash" });
  const expected = (4531 * 0.14 + 21376 * 0.0028 + (324 + 107) * 0.28) / 1e6;
  assert.ok(Math.abs(reference_cost_usd - expected) < 1e-12);
  assert.ok(Math.abs(reference_cost_usd - 0.000814873) < 1e-9, "matches the hand-checked figure");
});

test("the finalizer rejects observations SQLite alone would accept", () => {
  const valid = {
    status: USAGE_COMPLETE,
    input_tokens: 100, output_tokens: 10, reasoning_tokens: 0,
    cache_read_tokens: 0, cache_write_tokens: 0,
    provider_steps: 1, reported_cost_usd: 0.001, reported_cost_source: COST_SOURCE_EXECUTOR,
    malformed_events: 0,
  };
  const finalize = (observation) => finalizeUsageReceipt({
    attemptId: "a", backend: "TestBackend", model: "deepseek-v4-flash", observation,
  });
  assert.ok(finalize(valid).reference_cost_usd > 0);

  // Cost and provenance are one fact.
  assert.throws(() => finalize({ ...valid, reported_cost_source: null }), /must agree/);
  assert.throws(() => finalize({ ...valid, reported_cost_usd: null }), /must agree/);
  // Fractional token counts pass INTEGER affinity but are not observations.
  assert.throws(() => finalize({ ...valid, input_tokens: 1.5 }), /non-negative integer/);
  assert.throws(() => finalize({ ...valid, provider_steps: 0 }), /positive integer/);
  assert.throws(() => finalize({ ...valid, input_tokens: -1 }), /non-negative integer/);
  assert.throws(() => finalize({ ...valid, reported_cost_usd: -0.5 }), /non-negative number/);
  assert.throws(() => finalize({ ...valid, status: "GUESSED" }), /unknown status/);
  // An UNKNOWN observation may not smuggle numbers through.
  assert.throws(
    () => finalize({ ...valid, status: USAGE_UNKNOWN }),
    /set under UNKNOWN/,
  );
});

test("duplicate step ids with conflicting usage degrade the observation", () => {
  const one = JSON.stringify({
    type: "step_finish",
    part: { id: "prt_x", type: "step_finish", tokens: tokens(1000, 50, 5, 4000), cost: 0.0001 },
  });
  const conflicting = JSON.stringify({
    type: "step_finish",
    part: { id: "prt_x", type: "step_finish", tokens: tokens(9999, 50, 5, 4000), cost: 0.0001 },
  });
  const usage = parseOpenCodeUsage([one, conflicting].join("\n"));
  assert.equal(usage.status, USAGE_PARTIAL, "an inconsistent audit stream is not an ordinary replay");
  assert.equal(usage.provider_steps, 1);
  assert.equal(usage.input_tokens, 1000);
  assert.equal(usage.malformed_events, 1);

  // An identical replay stays COMPLETE.
  assert.equal(parseOpenCodeUsage([one, one].join("\n")).status, USAGE_COMPLETE);
});
