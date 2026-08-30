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
