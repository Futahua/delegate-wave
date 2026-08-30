const LABELS = {
  queued: "Queued", planning: "Planning", exploring: "Exploring", implementing: "Implementing",
  validating: "Validating", reviewing: "Reviewing", needs_input: "Needs input",
  ready: "Ready for integration", completed: "Completed", failed: "Failed",
};

export function derivePhase({ job, managerRun, attempts = [] }) {
  let id;
  if (managerRun?.status === "AWAITING_HUMAN" || job.status === "NEEDS_ATTENTION") id = "needs_input";
  else if (job.status === "SUCCEEDED") id = "completed";
  else if (["FAILED", "CANCELLED"].includes(job.status) || managerRun?.status === "FAILED") id = "failed";
  else if (job.status === "READY_FOR_INTEGRATION" || managerRun?.status === "ACCEPTED") id = "ready";
  else if (managerRun?.status === "REVIEWING") id = "reviewing";
  else if (attempts.some((attempt) => attempt.terminal_state === "SUCCEEDED" && attempt.validation_state === "PENDING")) id = "validating";
  else if (managerRun?.status === "EXPLORING") id = "exploring";
  else if (managerRun?.status === "IMPLEMENTING" || attempts.some((attempt) => attempt.terminal_state === null)) id = "implementing";
  else if (["PLANNING", "SYNTHESIZING"].includes(managerRun?.status)) id = "planning";
  else id = job.status === "PENDING" ? "queued" : "implementing";
  return { id, label: LABELS[id], active: !["ready", "completed", "failed", "needs_input"].includes(id) };
}

const WORK_STAGES = [
  ["planning", "Planning"],
  ["exploring", "Exploring"],
  ["implementing", "Implementing"],
  ["validating", "Validating"],
  ["reviewing", "Reviewing"],
];

function workContext({ managerRun, managerTurns, attempts, validations, childJobs }) {
  const lastTurn = managerTurns.at(-1);
  if (managerRun?.status === "AWAITING_HUMAN") {
    if (lastTurn?.phase === "REVIEW") return "reviewing";
    if (["PLAN", "SYNTHESIS"].includes(lastTurn?.phase)) return "planning";
    if (attempts.some((attempt) => attempt.job_id && childJobs.some((child) => child.id === attempt.job_id))) return "exploring";
    if (attempts.some((attempt) => attempt.terminal_state === null)) return "implementing";
    return "planning";
  }
  if (managerRun?.status === "REVIEWING") return "reviewing";
  if (validations.some((validation) => !validation.finished_at)) return "validating";
  if (managerRun?.status === "EXPLORING") return "exploring";
  if (managerRun?.status === "IMPLEMENTING" || attempts.some((attempt) => attempt.terminal_state === null)) return "implementing";
  if (["PLANNING", "SYNTHESIZING"].includes(managerRun?.status)) return "planning";
  return null;
}

/** Work history only. Attention and terminal outcomes are deliberately not rail steps. */
export function derivePhaseSteps({ job, managerRun, managerTurns = [], attempts = [], validations = [], childJobs = [] }) {
  const observed = new Set();
  if (managerRun || managerTurns.some((turn) => ["PLAN", "SYNTHESIS"].includes(turn.phase))) observed.add("planning");
  if (childJobs.some((child) => child.internal_kind === "MANAGER_EXPLORATION")) observed.add("exploring");
  if (attempts.some((attempt) => !childJobs.some((child) => child.id === attempt.job_id))) observed.add("implementing");
  if (validations.length) observed.add("validating");
  if (managerTurns.some((turn) => turn.phase === "REVIEW")) observed.add("reviewing");

  const current = workContext({ managerRun, managerTurns, attempts, validations, childJobs });
  if (current) observed.add(current);
  const terminalFailure = ["FAILED", "CANCELLED"].includes(job.status) || managerRun?.status === "FAILED";
  const failedStage = terminalFailure ? [...WORK_STAGES].reverse().find(([id]) => observed.has(id))?.[0] : null;
  return WORK_STAGES.map(([id, label]) => {
    let state = "future";
    if (id === current) state = "active";
    else if (observed.has(id)) state = failedStage === id ? "failed" : "done";
    return { id, label, state };
  });
}
