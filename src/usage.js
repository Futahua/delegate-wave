// Normalizes executor artifacts into one usage receipt per attempt.
//
// This is an observation, never authority. A receipt cannot make an attempt succeed, prove
// validation, or authorize integration. The raw artifact remains the audit source; this projection
// exists so usage can be queried and compared across backends.
import fs from "node:fs";
import { referenceCostUsd } from "./pricing.js";

export const USAGE_UNKNOWN = "UNKNOWN";
export const USAGE_PARTIAL = "PARTIAL";
export const USAGE_COMPLETE = "COMPLETE";

const EMPTY_TOKENS = Object.freeze({
  input_tokens: null,
  output_tokens: null,
  reasoning_tokens: null,
  cache_read_tokens: null,
  cache_write_tokens: null,
});

// Cost provenance. An executor-computed figure is not a provider bill: OpenCode derives its `cost`
// locally from its own model-cost metadata, so a divergence from a pricing basis may be stale
// executor metadata rather than a commercial difference.
export const COST_SOURCE_EXECUTOR = "executor-computed";

const TOKEN_DIMENSIONS = Object.freeze(["input", "output", "reasoning", "cache_read", "cache_write"]);

// Integral, not merely finite: truncating a fractional count would launder malformed evidence past
// the finalizer's validation, making WRK-010 true only for backend-supplied observations.
function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

// Every expected dimension must be present and valid. A missing field is evidence of malformed or
// version-drifted input, not an implicit zero -- the same class of error as UNKNOWN-versus-zero, one
// level down.
function readStepTokens(tokens) {
  if (!tokens || typeof tokens !== "object") return null;
  const read = {
    input: nonNegativeInteger(tokens.input),
    output: nonNegativeInteger(tokens.output),
    reasoning: nonNegativeInteger(tokens.reasoning),
    cache_read: nonNegativeInteger(tokens.cache?.read),
    cache_write: nonNegativeInteger(tokens.cache?.write),
  };
  return TOKEN_DIMENSIONS.every((dimension) => read[dimension] !== null) ? read : null;
}

// Sums every step_finish event in one OpenCode session artifact.
//
// Conservative by construction: a truncated or unparseable tail is counted as malformed and degrades
// the receipt to PARTIAL rather than being silently dropped, and the number of contributing provider
// steps is recorded so a parser that accidentally reads only the last event is detectable.
export function parseOpenCodeUsage(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  let malformed = 0;
  const steps = [];
  const seen = new Map();
  for (const line of lines) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    if (event?.type !== "step_finish") continue;
    const step = event.part ?? event;
    // Deduplicate by stable identity so a replayed or duplicated artifact cannot double-count. Two
    // events sharing an id but reporting different usage are an inconsistent audit stream rather
    // than an ordinary replay, so they degrade the observation instead of silently keeping the first.
    const identity = step?.id ?? event?.id ?? null;
    if (identity !== null) {
      // The signature covers every usage-relevant field, cost included: two events sharing an id
      // but reporting different cost disagree about the accounting just as surely as differing
      // token counts do.
      const signature = JSON.stringify({ tokens: step?.tokens ?? null, cost: step?.cost ?? null });
      const previous = seen.get(identity);
      if (previous !== undefined) {
        if (previous !== signature) malformed += 1;
        continue;
      }
      seen.set(identity, signature);
    }
    steps.push(step);
  }

  if (!steps.length) {
    return {
      status: USAGE_UNKNOWN,
      ...EMPTY_TOKENS,
      provider_steps: 0,
      reported_cost_usd: null,
      reported_cost_source: null,
      malformed_events: malformed,
    };
  }

  let cost = null;
  const totals = { input: 0, output: 0, reasoning: 0, read: 0, write: 0 };
  let usable = 0;
  for (const step of steps) {
    const tokens = readStepTokens(step?.tokens);
    if (!tokens) { malformed += 1; continue; }
    usable += 1;
    totals.input += tokens.input;
    totals.output += tokens.output;
    totals.reasoning += tokens.reasoning;
    totals.read += tokens.cache_read;
    totals.write += tokens.cache_write;
    if (Number.isFinite(step.cost) && step.cost >= 0) cost = (cost ?? 0) + step.cost;
  }

  if (!usable) {
    return {
      status: USAGE_UNKNOWN,
      ...EMPTY_TOKENS,
      provider_steps: 0,
      reported_cost_usd: null,
      reported_cost_source: null,
      malformed_events: malformed,
    };
  }

  return {
    // Any malformed line means the accounting is known to be incomplete, so the totals are reported
    // as observed-so-far rather than as a full account.
    status: malformed > 0 ? USAGE_PARTIAL : USAGE_COMPLETE,
    input_tokens: totals.input,
    output_tokens: totals.output,
    reasoning_tokens: totals.reasoning,
    cache_read_tokens: totals.read,
    cache_write_tokens: totals.write,
    provider_steps: usable,
    reported_cost_usd: cost,
    reported_cost_source: cost === null ? null : COST_SOURCE_EXECUTOR,
    malformed_events: malformed,
  };
}

// An observation carrying no usable evidence. Used whenever a backend supplies nothing.
export function unknownObservation({ artifact = null, format = "none", malformed = 0 } = {}) {
  return {
    status: USAGE_UNKNOWN,
    ...EMPTY_TOKENS,
    provider_steps: 0,
    reported_cost_usd: null,
    reported_cost_source: null,
    malformed_events: malformed,
    source_artifact: artifact,
    source_format: format,
  };
}

// Reads an OpenCode session artifact into a neutral observation. Absence of evidence is itself
// evidence, so a missing or unreadable artifact yields UNKNOWN rather than throwing.
export function observeOpenCodeArtifact(artifactPath) {
  const format = "opencode-events-jsonl";
  if (!artifactPath || !fs.existsSync(artifactPath)) {
    return unknownObservation({ artifact: artifactPath ?? null, format });
  }
  try {
    const parsed = parseOpenCodeUsage(fs.readFileSync(artifactPath, "utf8"));
    return { ...parsed, source_artifact: artifactPath, source_format: format };
  } catch {
    return unknownObservation({ artifact: artifactPath, format });
  }
}

const TOKEN_FIELDS = Object.freeze([
  "input_tokens", "output_tokens", "reasoning_tokens", "cache_read_tokens", "cache_write_tokens",
]);

// Validates a backend-supplied observation before it can become a receipt.
//
// The finalizer is the mechanical boundary, not just the pricing step: a backend is untrusted for
// measurement exactly as it is untrusted for success. Throwing here routes the failure through the
// dispatcher's USAGE_RECEIPT_FAILED path, so an invalid observation becomes visible missing evidence
// rather than a plausible but corrupt receipt.
export function assertValidObservation(observed) {
  const fail = (reason) => { throw new Error(`Invalid usage observation: ${reason}`); };
  if (!observed || typeof observed !== "object") fail("not an object");
  if (![USAGE_COMPLETE, USAGE_PARTIAL, USAGE_UNKNOWN].includes(observed.status)) {
    fail(`unknown status ${observed.status}`);
  }

  const wholeNonNegative = (value) => Number.isInteger(value) && value >= 0;
  const costOk = (value) => value === null || value === undefined
    || (Number.isFinite(value) && value >= 0);

  if (observed.status === USAGE_UNKNOWN) {
    for (const field of TOKEN_FIELDS) {
      if (observed[field] !== null && observed[field] !== undefined) fail(`${field} set under UNKNOWN`);
    }
    if (observed.provider_steps) fail("provider_steps set under UNKNOWN");
    if (observed.reported_cost_usd !== null && observed.reported_cost_usd !== undefined) {
      fail("reported_cost_usd set under UNKNOWN");
    }
  } else {
    for (const field of TOKEN_FIELDS) {
      if (!wholeNonNegative(observed[field])) fail(`${field} must be a non-negative integer`);
    }
    if (!wholeNonNegative(observed.provider_steps) || observed.provider_steps < 1) {
      fail("provider_steps must be a positive integer");
    }
  }

  if (!costOk(observed.reported_cost_usd)) fail("reported_cost_usd must be a non-negative number");
  if (observed.malformed_events !== undefined && !wholeNonNegative(observed.malformed_events)) {
    fail("malformed_events must be a non-negative integer");
  }

  // Cost and its provenance are one fact: neither is meaningful without the other. Provenance must
  // actually name a source, so an empty string or a number cannot stand in for one.
  const hasCost = observed.reported_cost_usd !== null && observed.reported_cost_usd !== undefined;
  const source = observed.reported_cost_source;
  const hasSource = source !== null && source !== undefined;
  if (hasCost !== hasSource) fail("reported_cost_usd and reported_cost_source must agree");
  if (hasSource && (typeof source !== "string" || !source.trim())) {
    fail("reported_cost_source must be a non-empty string");
  }
}

// The single place a receipt is finalized, for every backend.
//
// Pricing is applied here rather than in any backend: an executor must never compute delegate-wave's
// comparator, or measurement policy leaks back into the thing being measured. A backend's only job
// is to produce a neutral observation of what its provider reported.
export function finalizeUsageReceipt({
  attemptId, backend, model, observation, basisId, now = new Date().toISOString(),
}) {
  const observed = observation ?? unknownObservation();
  assertValidObservation(observed);
  const priced = observed.status === USAGE_UNKNOWN
    ? { reference_cost_usd: null, pricing_basis_id: null }
    : referenceCostUsd(observed, { model, ...(basisId ? { basisId } : {}) });

  return {
    attempt_id: attemptId,
    status: observed.status,
    input_tokens: observed.input_tokens,
    output_tokens: observed.output_tokens,
    reasoning_tokens: observed.reasoning_tokens,
    cache_read_tokens: observed.cache_read_tokens,
    cache_write_tokens: observed.cache_write_tokens,
    provider_steps: observed.provider_steps,
    reported_cost_usd: observed.reported_cost_usd,
    reported_cost_source: observed.reported_cost_source,
    reference_cost_usd: priced.reference_cost_usd,
    pricing_basis_id: priced.pricing_basis_id,
    source_backend: backend,
    source_artifact: observed.source_artifact ?? null,
    source_format: observed.source_format ?? "none",
    malformed_events: observed.malformed_events ?? 0,
    observed_at: now,
  };
}
