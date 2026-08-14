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

function integerOrNull(value) {
  return Number.isFinite(value) ? Math.trunc(value) : null;
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
    steps.push(event.part ?? event);
  }

  if (!steps.length) {
    return {
      status: USAGE_UNKNOWN,
      ...EMPTY_TOKENS,
      provider_steps: 0,
      provider_reported_cost_usd: null,
      malformed_events: malformed,
    };
  }

  let cost = null;
  const totals = { input: 0, output: 0, reasoning: 0, read: 0, write: 0 };
  let usable = 0;
  for (const step of steps) {
    const tokens = step?.tokens;
    if (!tokens || typeof tokens !== "object") { malformed += 1; continue; }
    usable += 1;
    totals.input += integerOrNull(tokens.input) ?? 0;
    totals.output += integerOrNull(tokens.output) ?? 0;
    totals.reasoning += integerOrNull(tokens.reasoning) ?? 0;
    totals.read += integerOrNull(tokens.cache?.read) ?? 0;
    totals.write += integerOrNull(tokens.cache?.write) ?? 0;
    if (Number.isFinite(step.cost)) cost = (cost ?? 0) + step.cost;
  }

  if (!usable) {
    return {
      status: USAGE_UNKNOWN,
      ...EMPTY_TOKENS,
      provider_steps: 0,
      provider_reported_cost_usd: null,
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
    provider_reported_cost_usd: cost,
    malformed_events: malformed,
  };
}

// Builds the persisted receipt for one attempt. Returns an UNKNOWN receipt rather than throwing when
// the artifact is missing or unreadable: absence of evidence is itself the evidence.
export function buildUsageReceipt({
  attemptId, backend, model, artifactPath, format = "opencode-events-jsonl",
  basisId, now = new Date().toISOString(),
}) {
  let parsed;
  if (artifactPath && fs.existsSync(artifactPath)) {
    try {
      parsed = parseOpenCodeUsage(fs.readFileSync(artifactPath, "utf8"));
    } catch {
      parsed = null;
    }
  }
  if (!parsed) {
    parsed = {
      status: USAGE_UNKNOWN,
      ...EMPTY_TOKENS,
      provider_steps: 0,
      provider_reported_cost_usd: null,
      malformed_events: 0,
    };
  }

  const priced = parsed.status === USAGE_UNKNOWN
    ? { reference_cost_usd: null, pricing_basis_id: null }
    : referenceCostUsd(parsed, { model, ...(basisId ? { basisId } : {}) });

  return {
    attempt_id: attemptId,
    status: parsed.status,
    input_tokens: parsed.input_tokens,
    output_tokens: parsed.output_tokens,
    reasoning_tokens: parsed.reasoning_tokens,
    cache_read_tokens: parsed.cache_read_tokens,
    cache_write_tokens: parsed.cache_write_tokens,
    provider_steps: parsed.provider_steps,
    provider_reported_cost_usd: parsed.provider_reported_cost_usd,
    reference_cost_usd: priced.reference_cost_usd,
    pricing_basis_id: priced.pricing_basis_id,
    source_backend: backend,
    source_artifact: artifactPath ?? null,
    source_format: format,
    malformed_events: parsed.malformed_events,
    observed_at: now,
  };
}
