// Scarce-manager usage, normalized into the same disjoint dimensions the executor receipts use.
//
// This is the ledger the whole project is optimizing against and it did not exist. delegate-wave
// measured cheap-worker tokens to four decimal places and measured the expensive side not at all,
// which made "maximize inexpensive work per unit of scarce usage" a ratio with an unmeasured
// denominator.
//
// No reference cost is computed here, and that is deliberate. The pricing bases exist so two cheap
// executors on different commercial arrangements can be compared on one basis. A plan-authenticated
// manager has no marginal token price at all; inventing dollars for it would be exactly the
// fabrication the executor receipts refuse to make. Tokens and turns are what can honestly be
// reported, so tokens and turns are what is stored.
import { USAGE_COMPLETE, USAGE_PARTIAL, USAGE_UNKNOWN } from "../usage.js";

export function unknownManagerUsage(source = "unknown") {
  return {
    status: USAGE_UNKNOWN,
    input_tokens: null,
    output_tokens: null,
    reasoning_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    source,
  };
}

const whole = (value) => Number.isInteger(value) && value >= 0;

// Codex reports `{ cachedInputTokens, inputTokens, outputTokens, reasoningOutputTokens, totalTokens }`
// and does not document whether the first is inside the second, or the fourth inside the third.
//
// That ambiguity is not guessable and it is not harmless: copying a nested `outputTokens` across
// while also recording `reasoningOutputTokens` double-counts every reasoning token, which is exactly
// the error the executor path already had to fix once for DeepSeek.
//
// So it is DETERMINED rather than assumed. `totalTokens` is a checksum: each candidate reading
// predicts a total, and only a reading whose prediction matches the reported total can be correct.
// When several readings survive they are compared -- if they yield identical disjoint figures the
// ambiguity was vacuous (usually because cache and reasoning were both zero) and the observation is
// COMPLETE. When they disagree, or when nothing matches, the report is recorded as PARTIAL with what
// was observed, because a plausible-but-unverified split is worse than an admitted gap.
const READINGS = Object.freeze([
  {
    id: "both-nested",
    // cachedInputTokens counted inside inputTokens; reasoningOutputTokens inside outputTokens.
    predict: (u) => u.inputTokens + u.outputTokens,
    split: (u) => ({
      input_tokens: u.inputTokens - u.cachedInputTokens,
      cache_read_tokens: u.cachedInputTokens,
      output_tokens: u.outputTokens - u.reasoningOutputTokens,
      reasoning_tokens: u.reasoningOutputTokens,
    }),
  },
  {
    id: "all-disjoint",
    predict: (u) => u.inputTokens + u.cachedInputTokens + u.outputTokens + u.reasoningOutputTokens,
    split: (u) => ({
      input_tokens: u.inputTokens,
      cache_read_tokens: u.cachedInputTokens,
      output_tokens: u.outputTokens,
      reasoning_tokens: u.reasoningOutputTokens,
    }),
  },
  {
    id: "cache-nested-reasoning-disjoint",
    predict: (u) => u.inputTokens + u.outputTokens + u.reasoningOutputTokens,
    split: (u) => ({
      input_tokens: u.inputTokens - u.cachedInputTokens,
      cache_read_tokens: u.cachedInputTokens,
      output_tokens: u.outputTokens,
      reasoning_tokens: u.reasoningOutputTokens,
    }),
  },
]);

export function observeCodexUsage(usage, source = "codex") {
  if (!usage || typeof usage !== "object") return unknownManagerUsage(source);

  const required = ["inputTokens", "outputTokens", "cachedInputTokens", "reasoningOutputTokens"];
  for (const field of required) {
    // A missing dimension is not a zero. Codex reports all four on every turn it accounts for, so an
    // absent one means the report is malformed or the wire contract moved.
    if (!whole(usage[field])) return unknownManagerUsage(source);
  }

  const base = {
    status: USAGE_COMPLETE,
    cache_write_tokens: 0,
    source,
  };

  const viable = READINGS
    .filter((reading) => {
      const split = reading.split(usage);
      // A reading that produces a negative dimension has misread the nesting and is discarded before
      // the checksum is even consulted.
      if (Object.values(split).some((value) => value < 0)) return false;
      return whole(usage.totalTokens) ? reading.predict(usage) === usage.totalTokens : false;
    })
    .map((reading) => ({ id: reading.id, split: reading.split(usage) }));

  if (viable.length === 0) {
    // Observed, but not canonicalizable. Everything that was reported is kept; the status says the
    // accounting is known to be incomplete rather than pretending a split.
    return {
      ...base,
      status: USAGE_PARTIAL,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      reasoning_tokens: usage.reasoningOutputTokens,
      cache_read_tokens: usage.cachedInputTokens,
    };
  }

  const first = viable[0].split;
  const agree = viable.every((reading) => (
    reading.split.input_tokens === first.input_tokens
    && reading.split.output_tokens === first.output_tokens
    && reading.split.reasoning_tokens === first.reasoning_tokens
    && reading.split.cache_read_tokens === first.cache_read_tokens
  ));

  return { ...base, ...first, status: agree ? USAGE_COMPLETE : USAGE_PARTIAL };
}

// Totals across a manager run, carrying the same honesty forward: a run containing any UNKNOWN or
// PARTIAL turn cannot report a complete figure, however precise the turns that did report look.
export function summarizeManagerUsage(receipts) {
  const totals = {
    turns: receipts.length,
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cache_read_tokens: 0,
    complete: true,
    unmeasured_turns: 0,
  };
  for (const receipt of receipts) {
    if (receipt.status === USAGE_UNKNOWN) {
      totals.unmeasured_turns += 1;
      totals.complete = false;
      continue;
    }
    if (receipt.status === USAGE_PARTIAL) {
      totals.unmeasured_turns += 1;
      totals.complete = false;
    }
    totals.input_tokens += receipt.input_tokens ?? 0;
    totals.output_tokens += receipt.output_tokens ?? 0;
    totals.reasoning_tokens += receipt.reasoning_tokens ?? 0;
    totals.cache_read_tokens += receipt.cache_read_tokens ?? 0;
  }
  return totals;
}
