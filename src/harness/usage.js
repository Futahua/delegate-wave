// Reads a Harness session log into a neutral usage observation.
//
// A backend's only job is to report what its provider said. Pricing, coverage and measurement
// health stay in the finalizer, for every backend alike -- an executor must never compute the
// comparator it is being measured by.
//
// Two properties of the Harness wire format drive everything here, both verified against a real run
// rather than taken from documentation:
//
//  1. `assistant/message` carries `usage` only when the adapter reported it, and the field is
//     omitted rather than zero-filled when absent. So a missing figure must degrade the observation,
//     while an explicitly reported 0 is a measurement. Conflating those is the "absence became zero"
//     error that makes unmeasured work look free.
//
//  2. Harness reports `outputTokens` as DeepSeek's `completion_tokens`, which INCLUDES
//     `reasoning_tokens`, while making input and cache disjoint. Copying both across would price
//     every reasoning token twice. Confirmed on a live run: one message reported 77 output tokens
//     with 14 reasoning and zero visible text, its content being reasoning plus a tool call.
//     WRK-011 defines the receipt's dimensions as disjoint, so reasoning is subtracted here.
import fs from "node:fs";
import {
  USAGE_UNKNOWN, USAGE_PARTIAL, USAGE_COMPLETE, canonicalizeNestedReasoning,
} from "../usage.js";

export const HARNESS_USAGE_FORMAT = "dsh-session-jsonl";

const EMPTY = Object.freeze({
  input_tokens: null,
  output_tokens: null,
  reasoning_tokens: null,
  cache_read_tokens: null,
  cache_write_tokens: null,
});

function unknown({ artifact = null, malformed = 0 } = {}) {
  return {
    status: USAGE_UNKNOWN,
    ...EMPTY,
    provider_steps: 0,
    reported_cost_usd: null,
    reported_cost_source: null,
    malformed_events: malformed,
    source_artifact: artifact,
    source_format: HARNESS_USAGE_FORMAT,
  };
}

const wholeNonNegative = (value) => Number.isInteger(value) && value >= 0;

// Reads one message's usage into disjoint dimensions, or null when the report is unusable.
//
// `inputTokens` and `outputTokens` must be present: a model call that reported neither is not a
// measurement. Cache and reasoning are optional on the wire and default to 0 only because their
// absence there means the provider is stating none were used -- unlike a wholly absent usage object,
// which means nothing was reported at all.
export function readHarnessUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  if (!wholeNonNegative(usage.inputTokens) || !wholeNonNegative(usage.outputTokens)) return null;

  // Reasoning must be REPORTED, not assumed.
  //
  // Every attempt runs with `thinking: enabled` and `reasoningEffort: high`, so the adapter is
  // expected to report this dimension on every call. A missing field therefore means the report is
  // malformed or the wire contract drifted -- it does not mean no reasoning happened. Defaulting it
  // to 0 would let unmeasured reasoning price as free and pass as a COMPLETE measurement, which is
  // the "absence became zero" error this project has now made twice. An explicitly reported 0 is a
  // measurement and remains valid.
  if (!wholeNonNegative(usage.reasoningTokens)) return null;
  const reasoning = usage.reasoningTokens;

  // Cache dimensions are different: the adapter omits them when the provider reported no cache
  // activity at all, so absence here genuinely means none, and is not evidence of a broken report.
  const cacheRead = usage.cacheReadTokens === undefined ? 0 : usage.cacheReadTokens;
  const cacheWrite = usage.cacheWriteTokens === undefined ? 0 : usage.cacheWriteTokens;
  if (!wholeNonNegative(cacheRead) || !wholeNonNegative(cacheWrite)) return null;

  // The subtraction that keeps reasoning from being priced twice. Returns null when reasoning
  // exceeds output, which would mean the wire contract changed rather than that the call was free.
  const canonical = canonicalizeNestedReasoning({
    completionTokens: usage.outputTokens,
    reasoningTokens: reasoning,
  });
  if (!canonical) return null;

  return {
    input: usage.inputTokens,
    output: canonical.output_tokens,
    reasoning: canonical.reasoning_tokens,
    cache_read: cacheRead,
    cache_write: cacheWrite,
  };
}

// Parses a session log's text into an observation.
//
// The log is JSONL. Unreadable lines are counted rather than ignored, because silently skipping
// them would let a truncated or version-drifted log masquerade as a complete measurement.
export function parseHarnessUsage(text) {
  const lines = String(text ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  let malformed = 0;
  let terminated = false;
  const messages = [];

  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    // The durable end-of-turn marker. Without it the log may be a clean PREFIX of a larger bill:
    // every record parses, every usage figure is valid, and the total is still short.
    if (record?.type === "turn/end") terminated = true;
    if (record?.type !== "assistant/message") continue;
    // A message with no usage at all is a real model call whose cost was not reported. It must
    // degrade the observation, not be skipped as though it never happened.
    messages.push(record?.data?.usage ?? null);
  }

  if (messages.length === 0) return unknown({ malformed });

  const totals = { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 };
  let usable = 0;
  for (const usage of messages) {
    const read = readHarnessUsage(usage);
    if (!read) {
      malformed += 1;
      continue;
    }
    usable += 1;
    for (const key of Object.keys(totals)) totals[key] += read[key];
  }

  if (usable === 0) return unknown({ malformed });

  return {
    // COMPLETE requires two things, not one: every model call measured, AND evidence that the turn
    // actually finished.
    //
    // Truncation is not hypothetical here -- it is the failure that made this usage path look
    // unobtainable in the first place. Session writes are batched, and a process that exits before
    // the batch drains leaves a log that is perfectly well-formed and simply short. Nothing in the
    // records themselves reveals that, so completeness is judged on the terminal marker rather than
    // on the absence of parse errors.
    status: malformed > 0 || !terminated ? USAGE_PARTIAL : USAGE_COMPLETE,
    input_tokens: totals.input,
    output_tokens: totals.output,
    reasoning_tokens: totals.reasoning,
    cache_read_tokens: totals.cache_read,
    cache_write_tokens: totals.cache_write,
    provider_steps: usable,
    // Harness reports tokens, not money. Inventing a cost here would fabricate provider testimony;
    // the finalizer prices these tokens against the pinned basis instead.
    reported_cost_usd: null,
    reported_cost_source: null,
    malformed_events: malformed,
  };
}

// Reads a Harness session artifact into a neutral observation. Absence of evidence is itself
// evidence, so a missing or unreadable artifact yields UNKNOWN rather than throwing.
export function observeHarnessArtifact(artifactPath) {
  if (!artifactPath || !fs.existsSync(artifactPath)) {
    return unknown({ artifact: artifactPath ?? null });
  }
  try {
    const parsed = parseHarnessUsage(fs.readFileSync(artifactPath, "utf8"));
    return { ...parsed, source_artifact: artifactPath, source_format: HARNESS_USAGE_FORMAT };
  } catch {
    return unknown({ artifact: artifactPath });
  }
}
