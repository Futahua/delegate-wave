// Codex reports five figures and documents none of their relationships:
//
//   { cachedInputTokens, inputTokens, outputTokens, reasoningOutputTokens, totalTokens }
//
// Whether cachedInputTokens sits inside inputTokens, and whether reasoningOutputTokens sits inside
// outputTokens, are INDEPENDENTLY unknown -- which is four combinations, not three. Guessing one
// double-counts every reasoning token, exactly the error the DeepSeek path had to fix once already.
//
// So the nesting is determined against totalTokens as a checksum rather than assumed, and the
// provider's own total is preserved separately from the split, because the total is unambiguous even
// when the split is not.
import assert from "node:assert/strict";
import test from "node:test";
import { observeCodexUsage, summarizeManagerUsage, unknownManagerUsage } from "../src/manager/usage.js";

const base = { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 300, reasoningOutputTokens: 90 };

test("cache nested and reasoning nested is read from its total", () => {
  // total = input + output, so both are inside.
  const usage = observeCodexUsage({ ...base, totalTokens: 1300 });
  assert.equal(usage.status, "COMPLETE");
  assert.equal(usage.input_tokens, 800, "cached is subtracted out of input");
  assert.equal(usage.cache_read_tokens, 200);
  assert.equal(usage.output_tokens, 210, "reasoning is subtracted out of output");
  assert.equal(usage.reasoning_tokens, 90);
  // The dimensions are disjoint, so they must reconstruct the reported total.
  assert.equal(
    usage.input_tokens + usage.cache_read_tokens + usage.output_tokens + usage.reasoning_tokens,
    1300,
  );
});

test("all four dimensions disjoint is read from its total", () => {
  const usage = observeCodexUsage({ ...base, totalTokens: 1590 });
  assert.equal(usage.status, "COMPLETE");
  assert.equal(usage.input_tokens, 1000);
  assert.equal(usage.cache_read_tokens, 200);
  assert.equal(usage.output_tokens, 300);
  assert.equal(usage.reasoning_tokens, 90);
});

test("cache nested with reasoning disjoint is read from its total", () => {
  // total = input + output + reasoning: cached is inside input, reasoning is not inside output.
  const usage = observeCodexUsage({ ...base, totalTokens: 1390 });
  assert.equal(usage.status, "COMPLETE");
  assert.equal(usage.input_tokens, 800);
  assert.equal(usage.output_tokens, 300);
  assert.equal(usage.reasoning_tokens, 90);
});

test("cache disjoint with reasoning nested is read from its total", () => {
  // The fourth corner. Enumerating only three readings silently assumed the two nestings were
  // correlated, and this combination would have fallen through to PARTIAL despite being resolvable.
  const usage = observeCodexUsage({ ...base, totalTokens: 1500 });
  assert.equal(usage.status, "COMPLETE", "the fourth combination must be resolvable, not PARTIAL");
  assert.equal(usage.input_tokens, 1000);
  assert.equal(usage.cache_read_tokens, 200);
  assert.equal(usage.output_tokens, 210);
  assert.equal(usage.reasoning_tokens, 90);
});

test("a total matching no reading degrades to PARTIAL but keeps the exact total", () => {
  const usage = observeCodexUsage({ ...base, totalTokens: 9999 });
  assert.equal(usage.status, "PARTIAL");
  // The split is unresolved, so the raw figures are kept for forensics and flagged as ambiguous.
  assert.equal(usage.input_tokens, 1000);
  // The total is not ambiguous, and the primary metric depends on it.
  assert.equal(usage.total_tokens, 9999);
});

test("zeroed cache and reasoning make the ambiguity vacuous rather than fatal", () => {
  // Several readings survive, but they agree, so the observation is complete.
  const usage = observeCodexUsage({
    inputTokens: 1000, cachedInputTokens: 0, outputTokens: 300, reasoningOutputTokens: 0, totalTokens: 1300,
  });
  assert.equal(usage.status, "COMPLETE");
  assert.equal(usage.input_tokens, 1000);
  assert.equal(usage.output_tokens, 300);
});

test("a missing dimension is UNKNOWN, never zero", () => {
  const usage = observeCodexUsage({ inputTokens: 1000, outputTokens: 300, totalTokens: 1300 });
  assert.equal(usage.status, "UNKNOWN");
  assert.equal(usage.input_tokens, null);
  assert.equal(usage.total_tokens, null);
});

test("a reading that would need a negative dimension is rejected before the checksum", () => {
  // More cache than input cannot mean cache is nested inside it.
  const usage = observeCodexUsage({
    inputTokens: 100, cachedInputTokens: 500, outputTokens: 300, reasoningOutputTokens: 0, totalTokens: 900,
  });
  assert.equal(usage.status, "COMPLETE");
  assert.equal(usage.input_tokens, 100, "the disjoint reading is the only viable one");
  assert.equal(usage.cache_read_tokens, 500);
});

test("ambiguous turns are counted, never summed into the component totals", () => {
  // The failure this prevents: a PARTIAL receipt keeps raw figures that may OVERLAP -- that is why
  // its split could not be resolved -- so adding them to canonicalized figures re-creates the
  // double-counting one abstraction layer up, and the result looks precise.
  const complete = observeCodexUsage({ ...base, totalTokens: 1300 });
  const ambiguous = observeCodexUsage({ ...base, totalTokens: 9999 });
  const summary = summarizeManagerUsage([complete, ambiguous]);

  assert.equal(summary.turns, 2);
  assert.equal(summary.ambiguous_turns, 1);
  assert.equal(summary.components_complete, false);
  // Only the COMPLETE receipt contributed components.
  assert.equal(summary.input_tokens, 800);
  assert.equal(summary.output_tokens, 210);
  // But both contributed their provider-reported totals, and that figure is still exact.
  assert.equal(summary.total_tokens, 1300 + 9999);
  assert.equal(summary.total_complete, true);
});

test("an unmeasured turn breaks total completeness rather than counting as zero", () => {
  const summary = summarizeManagerUsage([
    observeCodexUsage({ ...base, totalTokens: 1300 }),
    unknownManagerUsage("codex"),
  ]);
  assert.equal(summary.unmeasured_turns, 1);
  assert.equal(summary.total_complete, false, "a turn with no total makes the run's total incomplete");
  assert.equal(summary.components_complete, false);
  assert.equal(summary.total_tokens, 1300, "what was reported is still reported");
});
