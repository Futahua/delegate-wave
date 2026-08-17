// What the scarce manager is allowed to see, and how much of it.
//
// Two rules govern this module, and both exist because the manager is the expensive component.
//
// 1. EVERY REVIEW PACK IS BUILT FROM ONE ATTEMPT ID. Not from paths the orchestrator happened to be
//    holding, not from "the latest attempt", not from a diff computed on the spot. The attempt row
//    is the key, and the commit, changed files, validation runs, worker report and instruction are
//    all read through it. A state-machine bug can then send the WRONG attempt id -- which the
//    acceptance gate catches, because the same id is bound to the review turn -- but it cannot
//    assemble a pack that validates attempt A while showing artifacts from attempt B.
//
// 2. NOTHING IS SILENTLY TRUNCATED. Everything here is bounded, because unbounded evidence spends
//    scarce tokens on log noise. But a bound that quietly drops content teaches the manager to reason
//    confidently about a diff it never saw. Every clipped section reports that it was clipped, how
//    much was omitted, and how to ask for the rest.
import fs from "node:fs";

// Byte ceilings. Deliberately modest: the manager is reasoning about a decision, not reading a
// codebase, and a pack that grows without limit converts a judgment call into a context-window
// problem.
export const EVIDENCE_LIMITS = Object.freeze({
  candidateDiff: 24_000,
  validationOutput: 6_000,
  workerReport: 8_000,
  explorationReport: 8_000,
  instruction: 8_000,
});

// Clips to a byte budget and says so. Returns the shape the renderer understands, never a bare
// string, so a caller cannot accidentally drop the truncation flag on the way to the prompt.
export function bounded(text, limit, { keep = "tail" } = {}) {
  const source = String(text ?? "");
  if (source.length <= limit) {
    return { text: source, truncated: false, total_bytes: source.length, included_bytes: source.length };
  }
  // Validation output keeps its TAIL: the failure and the summary line live at the end, and a head
  // clip would show the manager a successful-looking prelude to a failed run. Diffs keep their HEAD,
  // because a diff is read from the top and its early hunks carry the shape of the change.
  const text2 = keep === "tail" ? source.slice(-limit) : source.slice(0, limit);
  return { text: text2, truncated: true, total_bytes: source.length, included_bytes: text2.length };
}

function readArtifact(artifactPath, limit, options) {
  if (!artifactPath || !fs.existsSync(artifactPath)) return null;
  try {
    return bounded(fs.readFileSync(artifactPath, "utf8"), limit, options);
  } catch {
    return null;
  }
}

// The pack for a planning turn: what the human wants, and the ground rules. Nothing about the
// repository, because the manager does not explore it directly -- that is what cheap workers are for,
// and pointing the most expensive model at a codebase is the substitution this architecture exists to
// prevent.
export function buildPlanEvidence({ objective, baseSha, validationCommands, protectedPaths, explorations = [] }) {
  return {
    kind: "PLAN",
    objective,
    base_sha: baseSha,
    validation_commands: validationCommands ?? [],
    protected_paths: protectedPaths ?? [],
    // Present only after an exploration round; empty on the first turn.
    explorations: explorations.map((report) => ({
      question: report.question,
      answer: bounded(report.answer, EVIDENCE_LIMITS.explorationReport, { keep: "head" }),
      job_id: report.jobId,
    })),
  };
}

// The pack for a review turn, assembled entirely from one attempt id.
//
// The boundary is `attemptId`, not a bag of pre-fetched pieces. An earlier version accepted
// `brief`, `validationRuns` and `diff` from the caller, which meant an orchestration bug could hand
// it attempt A with attempt B's diff -- the precise mixed-evidence failure the comment above claimed
// was impossible. Nothing crosses this boundary except identifiers, so there is nothing to mismatch.
//
//   attemptId -> attempt row -> job -> objective
//                            -> validation_runs
//                            -> instruction_artifact   (the exact brief that was sent)
//                            -> result_text_artifact   (the worker's report)
//                            -> result_commit + job.base_sha -> diff
//
// Git is reached through the injected `diffCommits` so this module stays free of process spawning,
// but the two commits it is given come from the attempt and its job, never from a caller.
export async function buildReviewEvidence({
  db, repoPath, attemptId, diffCommits, priorDecisions = [], budget = null,
}) {
  if (!db) throw new Error("review evidence requires the database it reads from");
  if (!attemptId) throw new Error("review evidence requires the attempt it is about");

  const attempt = db.prepare("SELECT * FROM attempts WHERE id = ?").get(attemptId);
  if (!attempt) throw new Error(`Unknown attempt: ${attemptId}`);
  const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(attempt.job_id);
  if (!job) throw new Error(`Attempt ${attemptId} has no job`);

  const validationRuns = db.prepare(
    "SELECT * FROM validation_runs WHERE attempt_id = ? ORDER BY started_at",
  ).all(attemptId);

  // Read back rather than re-rendered. A re-render could differ from what was actually sent, and the
  // manager would then be judging work against a brief nobody ever gave.
  const briefRead = readArtifact(attempt.instruction_artifact, EVIDENCE_LIMITS.instruction, { keep: "head" });

  // Computed from the attempt's own commit against its own job's authorized base. A caller cannot
  // substitute a different range.
  let diff = null;
  if (attempt.result_commit && diffCommits) {
    diff = await diffCommits(repoPath, job.base_sha, attempt.result_commit);
  }

  const objective = job.goal;

  const changedFiles = (() => {
    try { return JSON.parse(attempt.changed_files_json ?? "[]"); } catch { return []; }
  })();

  const brief = briefRead;

  return {
    kind: "REVIEW",
    objective,
    // The instruction this worker actually received, read back from its artifact.
    brief,
    job_id: job.id,
    subject_attempt_id: attempt.id,
    attempt: {
      id: attempt.id,
      ordinal: attempt.ordinal,
      model: attempt.model,
      backend: attempt.backend,
      terminal_state: attempt.terminal_state,
      validation_state: attempt.validation_state,
      // The two commits that make a revision legible: where this worker started, and what it
      // produced. They differ when a revision built on a prior candidate.
      start_sha: attempt.start_sha,
      result_commit: attempt.result_commit,
      instruction_digest: attempt.instruction_digest,
    },
    changed_files: changedFiles,
    changed_file_count: changedFiles.length,
    candidate_diff: diff ? bounded(diff, EVIDENCE_LIMITS.candidateDiff, { keep: "head" }) : null,
    validation: (validationRuns ?? []).map((run) => ({
      command: run.command,
      exit_code: run.exit_code,
      // Tail: a failing run's reason is at the end.
      output: readArtifact(run.output_path, EVIDENCE_LIMITS.validationOutput, { keep: "tail" }),
    })),
    // Testimony, explicitly labelled as such. The candidate is what actually changed; this is what
    // the worker believes it did, and the disagreement between them is often the whole finding.
    worker_report: readArtifact(attempt.result_text_artifact, EVIDENCE_LIMITS.workerReport, { keep: "head" }),
    prior_decisions: priorDecisions.map((decision) => ({
      phase: decision.phase, action: decision.action, ordinal: decision.ordinal,
    })),
    budget,
  };
}

// Renders a pack into the text one manager turn receives.
//
// Plain text rather than JSON: the manager reads this, and a wall of escaped JSON spends tokens on
// syntax. The RESPONSE is strict JSON, because that one is parsed.
export function renderEvidence(pack) {
  const lines = [];
  const section = (title) => { lines.push("", `## ${title}`, ""); };
  const clip = (value, label) => {
    if (!value) return;
    lines.push(value.text);
    if (value.truncated) {
      lines.push("");
      lines.push(
        `[${label} truncated: ${value.included_bytes} of ${value.total_bytes} bytes shown. `
        + "This is a bounded view, not the whole thing. If the decision depends on what was omitted, "
        + "do not guess -- request a targeted investigation instead.]",
      );
    }
  };

  lines.push(`# Objective (the human's intent, unchanged)`, "", pack.objective);

  if (pack.kind === "PLAN") {
    section("Ground rules");
    lines.push(`Base commit: ${pack.base_sha}`);
    lines.push(pack.validation_commands.length
      ? `Deterministic checks that will run: ${pack.validation_commands.join(" && ")}`
      : "No deterministic checks are configured for this project.");
    if (pack.protected_paths.length) {
      lines.push(`Paths a worker may not touch: ${pack.protected_paths.join(", ")}`);
    }
    if (pack.explorations.length) {
      section("What investigation established");
      for (const item of pack.explorations) {
        lines.push(`### ${item.question}`, "");
        clip(item.answer, "investigation report");
        lines.push("");
      }
    }
    return lines.join("\n");
  }

  section("The brief this worker was given");
  if (pack.brief) clip(pack.brief, "brief");
  else lines.push("(no instruction artifact was recorded for this attempt)");

  section("What actually changed");
  lines.push(`Attempt ${pack.attempt.id} (${pack.attempt.model ?? "unknown model"})`);
  lines.push(`Started from ${pack.attempt.start_sha ?? "the authorized base"}; produced ${pack.attempt.result_commit ?? "no commit"}.`);
  lines.push(`${pack.changed_file_count} file(s) changed: ${pack.changed_files.join(", ") || "none"}`);
  if (pack.candidate_diff) {
    lines.push("");
    clip(pack.candidate_diff, "candidate diff");
  }

  section("Deterministic checks");
  if (!pack.validation.length) {
    lines.push("No checks were configured, so passing them proves nothing about this change.");
  }
  for (const run of pack.validation) {
    lines.push(`\`${run.command}\` exited ${run.exit_code}.`);
    if (run.output) {
      lines.push("");
      clip(run.output, "check output");
      lines.push("");
    }
  }

  if (pack.worker_report) {
    section("What the worker says it did (testimony, not evidence)");
    clip(pack.worker_report, "worker report");
  }

  if (pack.prior_decisions.length) {
    section("Your earlier decisions on this job");
    for (const decision of pack.prior_decisions) {
      lines.push(`${decision.ordinal}. ${decision.phase}: ${decision.action}`);
    }
  }

  if (pack.budget && pack.budget.ceiling !== null) {
    section("Budget");
    lines.push(`About $${Number(pack.budget.spent).toFixed(4)} of a $${pack.budget.ceiling} limit `
      + `has been spent (${pack.budget.state}).`);
  }

  return lines.join("\n");
}
