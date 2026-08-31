// The manager's vocabulary. Every JSON shape that crosses the semantic boundary is defined here and
// nowhere else, so no subsystem invents its own.
//
// The distinction this file exists to hold open:
//
//   OBJECTIVE   immutable human intent, recorded once at authorization
//   BRIEF       what the manager wants THIS worker to do right now
//   EVIDENCE    what workers and the deterministic layer actually observed
//   DECISION    the manager's semantic judgment about a candidate
//
// Before this module those were one field: `jobs.goal` was the human's sentence, the worker's
// prompt, and the retry's prompt simultaneously. Collapsing them again is the specific regression
// this contract is meant to prevent.
import crypto from "node:crypto";

// What the manager decided. Six, not five: REVISE and RETHINK are genuinely different decisions and
// cost genuinely different amounts.
//
//   REVISE    the approach is right, this implementation of it is wrong. Reissue a corrected brief
//             to a worker; the diagnosis stands.
//   RETHINK   the diagnosis itself is wrong. Correcting the code cannot help, because the plan it
//             implements is the defect. Return to reasoning, usually via fresh exploration.
//
// Folding RETHINK into REVISE is expensive in exactly the way this system exists to avoid: it spends
// another implementation attempt re-executing a plan already known to be wrong, then spends another
// scarce review turn discovering that again. The distinction came from Taskplane, which carries it
// as a separate reviewer verdict. See docs/research/EXTERNAL-ORCHESTRATION-LESSONS.md.
export const MANAGER_ACTIONS = Object.freeze([
  "EXPLORE", "IMPLEMENT", "ACCEPT", "REVISE", "RETHINK", "ESCALATE",
]);

// Where one scarce-model call got to. Deliberately separate from MANAGER_ACTIONS: an action is what
// the manager DECIDED, this is what happened to the CALL, and the two fail independently.
//
// UNCERTAIN is the one that earns its place. A call that was issued but whose response never became
// durable may already have been answered and billed. Asking again spends the scarce resource twice
// to answer a question that may already be answered, so the orchestrator records the ambiguity and
// stops rather than retrying. Taskplane reaches the same state from the other direction with its
// UNAVAILABLE verdict -- their policy is that the worker proceeds cautiously; ours is the inverse,
// because our next step is an invitation to write to a human's repository.
export const MANAGER_TURN_STATES = Object.freeze([
  "INTENDED", "RUNNING", "COMPLETED", "FAILED", "UNCERTAIN",
]);

// Which question the manager was asked. Recorded per turn because the same model, at the same cost,
// answering "what should we build" and "did this actually solve it" are different observations and
// must be separable when reading back what the scarce budget was spent on.
export const MANAGER_PHASES = Object.freeze(["PLAN", "SYNTHESIS", "REVIEW"]);

// Worker tiers are a manager-facing abstraction, deliberately not model names. The manager reasons
// about difficulty; the dispatcher owns routing. A manager that could name models would be able to
// spend the operator's money on a route the operator never configured.
export const WORKER_TIERS = Object.freeze(["ordinary", "hard"]);

// Hard structural limits. These are the bounded-scarce-resource invariant: token accounting may be
// unavailable from a provider, but a turn ceiling is enforceable regardless of what the provider
// reports, so the manager can never run away even when its usage is UNKNOWN.
export const MANAGER_LIMITS = Object.freeze({
  maxExplorationRounds: 3,
  maxExplorationsPerRound: 3,
  maxRevisionRounds: 2,
  // Ceiling on scarce-model calls for one managed job, independent of the round counters above.
  // Derived from them (1 plan + 3 synthesis + 3 review + slack) rather than chosen freely, so
  // raising a round limit without revisiting this one cannot silently uncap the budget.
  maxTurns: 12,
});

const MAX_TEXT = Object.freeze({
  reason: 4000,
  question: 4000,
  instructions: 12000,
  diagnosis: 4000,
  acceptanceItem: 500,
  evidenceItem: 1000,
  deliverItem: 300,
});

class ContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "ManagerContractError";
    // Marks a failure of the manager's OUTPUT, not of delegate-wave. The orchestrator uses this to
    // decide whether to re-ask or to fail the run, and never to reinterpret the response.
    this.contract = true;
  }
}

function text(value, field, limit) {
  if (typeof value !== "string") throw new ContractError(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new ContractError(`${field} must not be empty`);
  if (trimmed.length > limit) throw new ContractError(`${field} exceeds ${limit} characters`);
  return trimmed;
}

function stringList(value, field, { limit, itemLimit, required = false }) {
  if (value === undefined || value === null) {
    if (required) throw new ContractError(`${field} is required`);
    return [];
  }
  if (!Array.isArray(value)) throw new ContractError(`${field} must be an array`);
  if (required && value.length === 0) throw new ContractError(`${field} must not be empty`);
  if (value.length > limit) throw new ContractError(`${field} may hold at most ${limit} entries`);
  return value.map((item, index) => text(item, `${field}[${index}]`, itemLimit));
}

// One question for one cheap read worker.
//
// `deliver` is the shape of the answer, not a wish: an exploration whose report cannot be used is a
// scarce-model turn wasted on reading it. Requiring the manager to state what it wants back makes
// the uselessness visible at parse time rather than at synthesis time.
export function parseExploration(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractError(`${field} must be an object`);
  }
  return {
    question: text(value.question, `${field}.question`, MAX_TEXT.instructions),
    deliver: stringList(value.deliver, `${field}.deliver`, { limit: 8, itemLimit: MAX_TEXT.deliverItem }),
  };
}

// What one cheap write worker should do, and what "done" means for it.
//
// `acceptance` is required and non-empty on purpose. A brief without acceptance criteria is a goal
// with extra words: the review turn would have nothing to check the candidate against except the
// objective, which is exactly the state this whole system was built to leave.
export function parseBrief(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractError(`${field} must be an object`);
  }
  const tier = value.worker_tier ?? "ordinary";
  if (!WORKER_TIERS.includes(tier)) {
    throw new ContractError(`${field}.worker_tier must be one of ${WORKER_TIERS.join(", ")}`);
  }
  return {
    diagnosis: text(value.diagnosis, `${field}.diagnosis`, MAX_TEXT.diagnosis),
    instructions: text(value.instructions, `${field}.instructions`, MAX_TEXT.instructions),
    acceptance: stringList(value.acceptance, `${field}.acceptance`, {
      limit: 12, itemLimit: MAX_TEXT.acceptanceItem, required: true,
    }),
    relevant_evidence: stringList(value.relevant_evidence, `${field}.relevant_evidence`, {
      limit: 20, itemLimit: MAX_TEXT.evidenceItem,
    }),
    uncertainties: stringList(value.uncertainties, `${field}.uncertainties`, {
      limit: 10, itemLimit: MAX_TEXT.evidenceItem,
    }),
    worker_tier: tier,
  };
}

// Parses one manager response. Throws rather than guessing.
//
// Optimistic interpretation is forbidden here specifically. A response that ALMOST says ACCEPT is
// not an acceptance, and a missing brief is not an empty brief: both would spend real worker money
// on a decision the manager did not make. Every field a chosen action needs is required for that
// action, and fields belonging to other actions are dropped rather than carried along, so a
// malformed-but-plausible response cannot smuggle a second instruction through.
export function parseManagerDecision(raw) {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(extractJsonObject(raw));
    } catch (error) {
      throw new ContractError(`manager response is not JSON: ${error.message}`);
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractError("manager response must be a JSON object");
  }
  const action = value.action;
  if (!MANAGER_ACTIONS.includes(action)) {
    throw new ContractError(`action must be one of ${MANAGER_ACTIONS.join(", ")}`);
  }
  const reason = text(value.reason, "reason", MAX_TEXT.reason);

  if (action === "EXPLORE") {
    if (!Array.isArray(value.explorations) || value.explorations.length === 0) {
      throw new ContractError("EXPLORE requires a non-empty explorations array");
    }
    if (value.explorations.length > MANAGER_LIMITS.maxExplorationsPerRound) {
      throw new ContractError(
        `EXPLORE may request at most ${MANAGER_LIMITS.maxExplorationsPerRound} investigations per round`,
      );
    }
    return {
      action,
      reason,
      explorations: value.explorations.map((item, index) => parseExploration(item, `explorations[${index}]`)),
      brief: null,
      question: null,
    };
  }

  if (action === "IMPLEMENT" || action === "REVISE") {
    return {
      action,
      reason,
      explorations: [],
      brief: parseBrief(value.brief, "brief"),
      question: null,
    };
  }

  // RETHINK abandons the current diagnosis, so it must not carry a brief: a brief would be an
  // instruction derived from the reasoning just declared wrong. Explorations are optional here --
  // the manager may already know what it needs to learn, or may want a synthesis turn first.
  if (action === "RETHINK") {
    const explorations = Array.isArray(value.explorations) ? value.explorations : [];
    if (explorations.length > MANAGER_LIMITS.maxExplorationsPerRound) {
      throw new ContractError(
        `RETHINK may request at most ${MANAGER_LIMITS.maxExplorationsPerRound} investigations`,
      );
    }
    return {
      action,
      reason,
      explorations: explorations.map((item, index) => parseExploration(item, `explorations[${index}]`)),
      brief: null,
      question: null,
    };
  }

  if (action === "ESCALATE") {
    // The escalation question is the whole product of this action. Without it the human receives
    // "the manager gave up", which is the failure experience this system exists to replace.
    return {
      action,
      reason,
      explorations: [],
      brief: null,
      question: text(value.question, "question", MAX_TEXT.question),
    };
  }

  return { action, reason, explorations: [], brief: null, question: null };
}

// Pulls the JSON object out of a response that wrapped it in prose or a fence.
//
// Deliberately conservative: it finds the first balanced top-level object and nothing else. It does
// not repair trailing commas, close unbalanced braces, or pick the "most likely" object out of
// several. Repairing malformed output is the same thing as interpreting it optimistically, one
// abstraction layer down.
export function extractJsonObject(raw) {
  const source = String(raw ?? "");
  const fenced = source.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  const body = fenced ? fenced[1] : source;
  const start = body.indexOf("{");
  if (start === -1) throw new Error("no JSON object found in response");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < body.length; index += 1) {
    const character = body[index];
    if (escaped) { escaped = false; continue; }
    if (character === "\\") { escaped = true; continue; }
    if (character === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return body.slice(start, index + 1);
    }
  }
  throw new Error("unbalanced JSON object in response");
}

// The exact instruction a worker was given, as a stable identity.
//
// This is what makes "a managed retry must differ from the attempt it is retrying" mechanically
// checkable rather than a matter of the manager's word. Two attempts with the same digest received
// the same instruction, whatever the manager said about correcting course.
export function instructionDigest(instruction) {
  return crypto.createHash("sha256").update(String(instruction)).digest("hex");
}

// A repository worker runs in an isolated worktree, not in the registered checkout. The manager may
// know the registered path from the human objective and repeat it in a question or brief; passing
// that physical path through makes a correctly confined worker attempt the wrong filesystem. Rewrite
// only this project's registered checkout prefix. External paths are left alone because a personal
// task may deliberately grant one; this is not a generic path language or sandbox policy.
function worktreeRelativeText(value, repositoryPath) {
  const source = String(value);
  const root = String(repositoryPath ?? "").replace(/[\\/]+$/, "");
  if (!root) return source;
  const escapedSegments = root.split(/[\\/]+/).map((segment) => (
    segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  ));
  const flags = /^[A-Za-z]:/.test(root) || root.startsWith("\\\\") ? "gi" : "g";
  const registeredCheckout = new RegExp(`${escapedSegments.join("[\\\\/]")}([\\\\/])?`, flags);
  const rewritten = source.replace(registeredCheckout, (_match, separator) => (separator ? "" : "."));
  if (registeredCheckout.test(rewritten)) {
    throw new ContractError("worker instruction still references the registered repository checkout");
  }
  return rewritten;
}

// Renders a brief into the single instruction string a worker actually receives.
//
// Kept here rather than in the backend because the rendering is part of the contract: the worker
// must see the acceptance criteria the reviewer will judge it by. A backend that rendered its own
// subset could produce a worker that satisfies its prompt and fails review for reasons it was never
// told about.
export function renderBrief({
  objective, brief, repositoryPath = null, attemptOrdinal = 1, priorFailure = null,
}) {
  const lines = [];
  lines.push("Wider human objective (context only; not your role):");
  lines.push(worktreeRelativeText(objective, repositoryPath));
  lines.push("");
  lines.push("Role boundary:");
  lines.push("You are the implementation worker in an assigned repository worktree.");
  lines.push("Only Diagnosis, What to do, Established facts, Known unknowns, the previous-attempt "
    + "correction (when present), and Acceptance criteria below are actionable.");
  lines.push("The wider objective may mention manager decisions, exploration workers, validation, "
    + "review, integration, UI presentation, session IDs or final reporting. Those are not your work.");
  lines.push("Never dispatch, emulate, fabricate or report Delegate Wave workers, turns, sessions, "
    + "candidate IDs, validation records or integration records.");
  lines.push("Use repository-relative paths. Do not access the registered/original checkout; your "
    + "current directory is the assigned worktree.");
  lines.push("");
  lines.push(`Diagnosis: ${worktreeRelativeText(brief.diagnosis, repositoryPath)}`);
  lines.push("");
  lines.push("What to do:");
  lines.push(worktreeRelativeText(brief.instructions, repositoryPath));
  if (brief.relevant_evidence.length) {
    lines.push("");
    lines.push("Established facts (from earlier investigation; trust these):");
    for (const item of brief.relevant_evidence) {
      lines.push(`- ${worktreeRelativeText(item, repositoryPath)}`);
    }
  }
  if (brief.uncertainties.length) {
    lines.push("");
    lines.push("Known unknowns (verify rather than assume):");
    for (const item of brief.uncertainties) {
      lines.push(`- ${worktreeRelativeText(item, repositoryPath)}`);
    }
  }
  if (priorFailure) {
    lines.push("");
    lines.push(`This is attempt ${attemptOrdinal}. The previous attempt was rejected:`);
    lines.push(worktreeRelativeText(priorFailure, repositoryPath));
  }
  lines.push("");
  lines.push("This work is accepted only if all of the following hold:");
  for (const item of brief.acceptance) {
    lines.push(`- ${worktreeRelativeText(item, repositoryPath)}`);
  }
  return lines.join("\n");
}

// Renders an exploration into a read-worker instruction.
export function renderExploration({ objective, exploration, repositoryPath = null }) {
  const lines = [];
  lines.push(`Investigate one question in this repository. Do not modify anything.`);
  lines.push("Your current directory is the assigned read-only repository worktree. Use repository-relative "
    + "paths and do not access the registered/original checkout.");
  lines.push("");
  lines.push(`Question: ${worktreeRelativeText(exploration.question, repositoryPath)}`);
  if (exploration.deliver.length) {
    lines.push("");
    lines.push("Report back, concretely:");
    for (const item of exploration.deliver) {
      lines.push(`- ${worktreeRelativeText(item, repositoryPath)}`);
    }
  }
  lines.push("");
  lines.push("Cite exact file paths and line numbers for every claim. If you cannot establish "
    + "something, say so explicitly rather than inferring it.");
  lines.push("");
  lines.push(`For context only, the wider objective is: ${worktreeRelativeText(objective, repositoryPath)}`);
  return lines.join("\n");
}

export { ContractError };
