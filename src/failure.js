// What broke, in words, beside the digest that identifies it.
//
// failure_signature is a hash and stays one: it exists so a repeated failure can be recognised as
// the same failure, and a readable string would make a poor key. But for a long time it was the
// ONLY thing recorded, so a real attempt reduced to "FAILED, reason = <64 hex characters>" while
// its own transcript held the cause twelve times over. The cause was captured and unreadable at the
// same moment, which is the worst of both.
//
// So classification is ADDITIVE. Nothing here changes the signature, and nothing here rewrites a
// receipt that already exists -- historical attempts keep exactly the evidence they were given, and
// their detail is recovered by reading their transcripts rather than by editing the past.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Stages, ordered by how far an attempt got before it died. Coarse on purpose: a stage should say
// which part of the machine to look at, not restate the message.
export const FAILURE_STAGES = Object.freeze({
  WORKER_LAUNCH: "WORKER_LAUNCH",
  WORKER_TOOL_DISPATCH: "WORKER_TOOL_DISPATCH",
  WORKER_EXECUTION: "WORKER_EXECUTION",
  CANDIDATE_CAPTURE: "CANDIDATE_CAPTURE",
  VALIDATION: "VALIDATION",
  UNCLASSIFIED: "UNCLASSIFIED",
});

// Recognisers, tried in order. Each names a failure whose SHAPE is known well enough to act on.
//
// Deliberately conservative: an unrecognised failure is UNCLASSIFIED with its message preserved
// verbatim, never squeezed into the closest-looking category. A wrong stage would send the next
// person to the wrong layer, which is worse than admitting the shape is new.
const RECOGNISERS = Object.freeze([
  {
    stage: FAILURE_STAGES.WORKER_TOOL_DISPATCH,
    code: "UNKNOWN_TOOL",
    // The executor received a tool call whose NAME was empty or unrecognised. Seen when a provider
    // streams the tool identity once, in the opening delta, and the assembler overwrites it with the
    // nulls that follow -- the arguments survive perfectly while the name does not.
    test: (text) => /unknown tool\s*""|unknown tool\s*''|unknown tool:\s*$/i.test(text),
  },
  {
    stage: FAILURE_STAGES.WORKER_TOOL_DISPATCH,
    code: "REPEATED_TOOL_CALL",
    // The worker made no progress and the executor stopped it. Usually a SYMPTOM: something upstream
    // is refusing every call, and the model retries because the refusal tells it nothing.
    test: (text) => /repeated tool call|not making progress/i.test(text),
  },
  {
    stage: FAILURE_STAGES.WORKER_LAUNCH,
    code: "EXECUTOR_NOT_STARTED",
    test: (text) => /spawn|ENOENT|entity not found|failed to start|executable/i.test(text),
  },
  {
    stage: FAILURE_STAGES.WORKER_EXECUTION,
    code: "PROVIDER_ERROR",
    test: (text) => /provider|app-server|api key|unauthor|rate limit|timed out|timeout/i.test(text),
  },
  {
    stage: FAILURE_STAGES.CANDIDATE_CAPTURE,
    code: "PROTECTED_PATH",
    test: (text) => /protected path changed/i.test(text),
  },
  {
    stage: FAILURE_STAGES.CANDIDATE_CAPTURE,
    code: "CAPTURE_FAILED",
    test: (text) => /worktree|cherry-pick|commit|index\.lock|git /i.test(text),
  },
]);

export function classifyFailure(message) {
  const text = String(message ?? "");
  for (const recogniser of RECOGNISERS) {
    if (recogniser.test(text)) return { stage: recogniser.stage, code: recogniser.code };
  }
  return { stage: FAILURE_STAGES.UNCLASSIFIED, code: "UNCLASSIFIED" };
}

// Writes the readable account beside the attempt's other artifacts.
//
// Content-addressed so identical failures share one file, and bounded so a runaway transcript cannot
// turn an error report into a disk problem. Returns the path, or null when nothing could be written
// -- a failure to record a failure must not become a second failure.
export function writeFailureDetail({ artifactDir, message, stage, code, evidence = [] }) {
  try {
    const lines = [
      `stage: ${stage}`,
      `code: ${code}`,
      "",
      "what happened:",
      String(message ?? "").slice(0, 4000),
    ];
    if (evidence.length) {
      lines.push("", "evidence:");
      for (const item of evidence) lines.push(`  ${item}`);
    }
    const body = `${lines.join("\n")}\n`;
    const digest = crypto.createHash("sha256").update(body).digest("hex").slice(0, 16);
    fs.mkdirSync(artifactDir, { recursive: true });
    const target = path.join(artifactDir, `failure-${digest}.txt`);
    if (!fs.existsSync(target)) fs.writeFileSync(target, body);
    return target;
  } catch {
    return null;
  }
}

// The one-line account a person actually reads, assembled from durable fields.
export function describeFailure(attempt) {
  if (!attempt?.failure_signature) return null;
  return {
    stage: attempt.failure_stage ?? FAILURE_STAGES.UNCLASSIFIED,
    code: attempt.failure_code ?? "UNCLASSIFIED",
    // Kept, because it is what deduplication and repeat detection are keyed on.
    signature: attempt.failure_signature,
    detail: attempt.failure_detail_artifact ?? null,
  };
}
