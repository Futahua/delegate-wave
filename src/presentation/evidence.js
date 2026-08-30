function validationSummary(validation) {
  if (validation.outcome === "PASSED") return `Validation passed: ${validation.command}`;
  if (validation.outcome === "CHECK_DID_NOT_RUN") return `Validation did not run: ${validation.command}`;
  return `Validation failed: ${validation.command}`;
}

export function projectEvidence({ validations = [], managerTurns = [], attempts = [] }) {
  const evidence = validations.map((validation) => ({
    id: `validation:${validation.id}`,
    occurred_at: validation.finished_at,
    kind: "validation",
    state: validation.outcome === "PASSED" ? "passed" : validation.outcome === "CHECK_DID_NOT_RUN" ? "not_run" : "failed",
    summary: validationSummary(validation),
    attempt_id: validation.attempt_id,
    source: { table: "validation_runs", id: validation.id },
    authority: "evidence",
  }));
  for (const turn of managerTurns) {
    if (turn.state !== "COMPLETED" || !turn.action) continue;
    evidence.push({
      id: `manager-turn:${turn.id}`,
      occurred_at: turn.finished_at ?? turn.started_at,
      kind: "manager_decision",
      state: String(turn.action).toLowerCase(),
      summary: `Manager ${String(turn.action).toLowerCase().replaceAll("_", " ")}`,
      ...(turn.subject_attempt_id ? { attempt_id: turn.subject_attempt_id } : {}),
      source: { table: "manager_turns", id: turn.id },
      authority: "evidence",
    });
  }
  for (const attempt of attempts) {
    if (!attempt.result_commit) continue;
    evidence.push({
      id: `candidate:${attempt.id}`,
      occurred_at: attempt.finished_at ?? attempt.started_at,
      kind: "candidate",
      state: attempt.validation_state.toLowerCase(),
      summary: `Candidate ${attempt.result_commit}`,
      attempt_id: attempt.id,
      source: { table: "attempts", id: attempt.id },
      authority: "evidence",
    });
  }
  return evidence.sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)));
}
