// The semantic control loop.
//
// Deliberately outside Dispatcher. Dispatcher owns mechanical truth -- what changed, what passed,
// what cost money, what may be integrated -- and it is already the largest file in the project. This
// owns judgment: what to build, whether the result solves the objective, and whether to try again.
// Keeping them apart is what lets the manager be wrong without the record becoming wrong.
//
//   PLAN ──> IMPLEMENT ──> (worker, candidate, validation) ──> REVIEW ──┬─> ACCEPT
//     ^                          ^                                      │
//     └── RETHINK ───────────────┴── REVISE ─────────────────────────────┤
//                                                                        └─> ESCALATE
//
// Every transition below is written together with its reboot interpretation. A transition whose
// answer to "what happens if the process dies immediately after this write?" is unknown is not
// finished, because the durable states exist precisely so a crash is legible afterwards.
//
// The one rule that outranks the rest: ACCEPT is a semantic judgment, never integration authority.
// The manager can be wrong too. Its value is that it is far less likely to misunderstand the task
// than a cheap worker -- not that its words become true.
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { recordEvent, transaction } from "../db.js";
import { git } from "../git.js";
import {
  MANAGER_LIMITS, instructionDigest, parseManagerDecision, renderBrief, renderExploration,
} from "./contracts.js";
import { buildPlanEvidence, buildReviewEvidence, renderEvidence } from "./evidence.js";
import { observeManagerUsage } from "./backend.js";

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${crypto.randomUUID()}`;

export class ManagerService {
  constructor({ dispatcher, backend, workerModel = null }) {
    if (!dispatcher) throw new Error("ManagerService requires a dispatcher");
    if (!backend) throw new Error("ManagerService requires a manager backend");
    this.dispatcher = dispatcher;
    this.db = dispatcher.db;
    this.backend = backend;
    this.workerModel = workerModel;
  }

  getRun(jobId) {
    return this.db.prepare("SELECT * FROM manager_runs WHERE job_id = ?").get(jobId) ?? null;
  }

  turns(runId) {
    return this.db.prepare("SELECT * FROM manager_turns WHERE manager_run_id = ? ORDER BY ordinal").all(runId);
  }

  // Creates the run row, or returns the existing one.
  //
  // The revision cap is resolved here rather than read from MANAGER_LIMITS at decision time, because
  // it is bounded by two independent things: the manager's own limit, and how many attempts the job
  // was authorized for. A run permitted two revisions on a job authorized for two attempts would
  // promise a third attempt the scheduler must refuse, and the manager would spend a scarce review
  // turn producing a brief that could never run.
  async ensureRun(jobId) {
    const existing = this.getRun(jobId);
    if (existing) return existing;
    const job = this.dispatcher.getJob(jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);
    if (job.strategy !== "managed") throw new Error(`Job ${jobId} is a ${job.strategy} job`);

    const started = await this.backend.startRun({});
    const revisionCap = Math.max(0, Math.min(MANAGER_LIMITS.maxRevisionRounds, job.max_attempts - 1));
    const runId = id("mrun");
    return transaction(this.db, () => {
      const raced = this.getRun(jobId);
      if (raced) return raced;
      this.db.prepare(`INSERT INTO manager_runs(
        id, job_id, status, requested_model, actual_model, thread_id,
        exploration_round, revision_round, max_exploration_rounds, max_revision_rounds, max_turns,
        created_at, updated_at
      ) VALUES (?, ?, 'PLANNING', ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)`).run(
        runId, jobId, started.requestedModel ?? null, started.actualModel ?? null,
        started.threadId, MANAGER_LIMITS.maxExplorationRounds, revisionCap,
        MANAGER_LIMITS.maxTurns, now(), now(),
      );
      recordEvent(this.db, {
        kind: "MANAGER_RUN_STARTED", entityType: "job", entityId: jobId,
        payload: { runId, threadId: started.threadId, revisionCap },
      });
      return this.getRun(jobId);
    });
  }

  setRun(runId, fields) {
    const keys = Object.keys(fields);
    const assignments = keys.map((key) => `${key} = ?`).join(", ");
    this.db.prepare(`UPDATE manager_runs SET ${assignments}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((key) => fields[key]), now(), runId);
  }

  // Runs one scarce-model turn, recording intent before the call and outcome after it.
  //
  // Reboot interpretation, which is the reason for the shape:
  //
  //   INTENDED   the row exists and the process is gone -> the call MAY have been made and billed.
  //              Recovery converts this to UNCERTAIN. It is never replayed.
  //   COMPLETED  a terminal signal arrived and the decision is durable.
  //   FAILED     the call demonstrably did not happen, or the turn completed having failed.
  //   UNCERTAIN  accepted, then lost. Quota may be gone and the answer may exist. A second call
  //              would pay twice to ask a question that may already be answered, so the run stops
  //              and a person decides.
  async runTurn(run, { phase, prompt, subjectAttemptId = null }) {
    const existing = this.turns(run.id);
    if (existing.length >= run.max_turns) {
      throw new ManagerStop(
        `manager run ${run.id} reached its ${run.max_turns}-turn ceiling`,
        "TURN_LIMIT",
      );
    }
    const ordinal = existing.length + 1;
    const turnId = id("mturn");
    const artifactDir = path.join(this.dispatcher.paths.artifacts, "manager", run.id);
    fs.mkdirSync(artifactDir, { recursive: true });
    const promptPath = path.join(artifactDir, `turn-${ordinal}-prompt.txt`);
    fs.writeFileSync(promptPath, prompt);

    // Durable BEFORE the call. A row that exists with no result is the evidence that a scarce call
    // may have happened, which is the whole point of writing it first.
    transaction(this.db, () => {
      this.db.prepare(`INSERT INTO manager_turns(
        id, manager_run_id, ordinal, phase, state, model, prompt_artifact, subject_attempt_id, started_at
      ) VALUES (?, ?, ?, ?, 'INTENDED', ?, ?, ?, ?)`).run(
        turnId, run.id, ordinal, phase, run.actual_model ?? run.requested_model ?? null,
        promptPath, subjectAttemptId, now(),
      );
      recordEvent(this.db, {
        kind: "MANAGER_TURN_INTENDED", entityType: "job", entityId: run.job_id,
        payload: { turnId, phase, ordinal, subjectAttemptId },
      });
    });

    let result;
    try {
      result = await this.backend.runTurn({
        threadId: run.thread_id, phase, prompt, subjectAttemptId,
      });
    } catch (error) {
      const uncertain = error?.uncertain === true;
      this.finishTurn(turnId, run, uncertain ? "UNCERTAIN" : "FAILED", { error: String(error?.message ?? error) });
      throw new ManagerStop(
        uncertain
          ? `manager turn ${turnId} was accepted but its result was lost: ${error?.message ?? error}`
          : `manager turn ${turnId} failed: ${error?.message ?? error}`,
        uncertain ? "UNCERTAIN" : "TURN_FAILED",
      );
    }

    const usage = observeManagerUsage(this.backend, result);
    const responsePath = path.join(artifactDir, `turn-${ordinal}-response.txt`);
    fs.writeFileSync(responsePath, result.text ?? "");

    // A turn that completed without a usable answer is a completed, billed turn. Its usage is
    // recorded before anything decides what to do about the missing answer.
    if (result.status === "failed" || result.text === null) {
      this.finishTurn(turnId, run, "FAILED", { usage, responsePath, error: result.error ?? "no agent message" });
      throw new ManagerStop(
        `manager turn ${turnId} completed without a usable decision: ${result.error ?? "no agent message"}`,
        "TURN_FAILED",
      );
    }

    let decision;
    try {
      decision = parseManagerDecision(result.text);
    } catch (error) {
      // Malformed output is never interpreted optimistically. The turn is recorded as completed --
      // it ran and it cost -- but it produced no decision, and the run stops.
      this.finishTurn(turnId, run, "COMPLETED", { usage, responsePath, action: null });
      throw new ManagerStop(`manager turn ${turnId} produced malformed output: ${error.message}`, "MALFORMED");
    }

    this.finishTurn(turnId, run, "COMPLETED", { usage, responsePath, action: decision.action });
    return { decision, turnId };
  }

  finishTurn(turnId, run, state, { usage = null, responsePath = null, action = null, error = null } = {}) {
    transaction(this.db, () => {
      this.db.prepare(`UPDATE manager_turns
        SET state = ?, response_artifact = ?, response_digest = ?, action = ?, finished_at = ?
        WHERE id = ?`).run(
        state, responsePath,
        responsePath && fs.existsSync(responsePath)
          ? crypto.createHash("sha256").update(fs.readFileSync(responsePath)).digest("hex")
          : null,
        action, now(), turnId,
      );
      if (usage) {
        this.db.prepare(`INSERT OR REPLACE INTO manager_usage_receipts(
          manager_turn_id, status, input_tokens, output_tokens, reasoning_tokens,
          cache_read_tokens, cache_write_tokens, total_tokens, source, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          turnId, usage.status, usage.input_tokens, usage.output_tokens, usage.reasoning_tokens,
          usage.cache_read_tokens, usage.cache_write_tokens, usage.total_tokens, usage.source, now(),
        );
      }
      recordEvent(this.db, {
        kind: `MANAGER_TURN_${state}`, entityType: "job", entityId: run.job_id,
        payload: { turnId, action, error },
      });
    });
  }

  // Drives a managed job as far as it can go without a person.
  async advance(jobId) {
    const job = this.dispatcher.getJob(jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);
    if (job.strategy !== "managed") throw new Error(`Job ${jobId} is a ${job.strategy} job`);

    // The authorized-base guard must fire HERE, not only before the root's own first attempt.
    //
    // A managed run buys exploration before it implements anything, and those children skip the
    // guard by design because they inherit a base rather than being independently authorized. So the
    // root's first-attempt check would fire only after the family had already spent money
    // investigating a world the implementation is then refused permission to touch. Checked once, at
    // the entry to any paid activity.
    await this.dispatcher.assertAuthorizedBaseIntact(job, this.dispatcher.getProject(job.project_id));

    let run = await this.ensureRun(jobId);

    try {
      // Bounded by max_turns inside runTurn(); this only prevents a policy bug from spinning.
      for (let step = 0; step < MANAGER_LIMITS.maxTurns * 3; step += 1) {
        run = this.getRun(jobId);
        if (["ACCEPTED", "AWAITING_HUMAN", "FAILED", "CANCELLED"].includes(run.status)) break;
        if (run.status === "PLANNING") await this.plan(run);
        else if (run.status === "EXPLORING") await this.explore(run);
        else if (run.status === "IMPLEMENTING") await this.implement(run);
        else if (run.status === "REVIEWING") await this.review(run);
        else break;
      }
    } catch (stop) {
      if (!(stop instanceof ManagerStop)) throw stop;
      this.halt(this.getRun(jobId), stop);
    }
    return this.report(jobId);
  }

  // Stops the run without inventing a next step. Every reason lands the human in the same place --
  // a job needing a decision -- but the recorded reason distinguishes "the manager asked you
  // something" from "we do not know whether a scarce call was billed".
  halt(run, stop) {
    transaction(this.db, () => {
      this.setRun(run.id, {
        status: stop.code === "UNCERTAIN" ? "AWAITING_HUMAN" : "AWAITING_HUMAN",
        escalation_question: stop.question ?? stop.message,
      });
      this.db.prepare("UPDATE jobs SET status = 'NEEDS_ATTENTION', updated_at = ? WHERE id = ?")
        .run(now(), run.job_id);
      recordEvent(this.db, {
        kind: "MANAGER_HALTED", entityType: "job", entityId: run.job_id,
        payload: { runId: run.id, code: stop.code, reason: stop.message },
      });
    });
  }

  async plan(run) {
    const job = this.dispatcher.getJob(run.job_id);
    const project = this.dispatcher.getProject(job.project_id);
    const pack = buildPlanEvidence({
      objective: job.goal,
      baseSha: job.base_sha,
      validationCommands: JSON.parse(project.validation_json || "[]"),
      protectedPaths: JSON.parse(project.protected_json || "[]"),
    });
    const { decision } = await this.runTurn(run, { phase: "PLAN", prompt: renderEvidence(pack) });

    if (decision.action === "IMPLEMENT") {
      this.storeBrief(run, decision.brief);
      this.setRun(run.id, { status: "IMPLEMENTING" });
      return;
    }
    if (decision.action === "ESCALATE") {
      throw new ManagerStop(decision.reason, "ESCALATED", decision.question);
    }
    if (decision.action === "EXPLORE" || decision.action === "RETHINK") {
      return this.openExplorationRound(run, decision.explorations, decision.reason);
    }
    throw new ManagerStop(
      `the manager answered ${decision.action} during planning: ${decision.reason}`,
      "UNSUPPORTED",
    );
  }

  // Commits to an exploration round BEFORE any of its work is bought.
  //
  // The ordering is the whole point. If the round were recorded after launching the first child, a
  // crash in between would leave children with no round that owns them, and recovery would open the
  // round again and pay for the same investigations twice. Persisting first means the worst case is
  // a round that exists with no children yet, which is simply resumed.
  openExplorationRound(run, explorations, reason) {
    if (!explorations.length) {
      // RETHINK may legitimately arrive with no questions: the manager wants to re-plan rather than
      // re-investigate. Nothing to buy, so go straight back to planning.
      transaction(this.db, () => {
        this.setRun(run.id, { status: "PLANNING", last_candidate_attempt_id: null });
        recordEvent(this.db, {
          kind: "MANAGER_REPLAN", entityType: "job", entityId: run.job_id,
          payload: { runId: run.id, reason },
        });
      });
      return;
    }
    const round = run.exploration_round + 1;
    if (round > run.max_exploration_rounds) {
      throw new ManagerStop(
        `the manager asked for exploration round ${round} but only ${run.max_exploration_rounds} are permitted`,
        "EXPLORATION_LIMIT",
      );
    }
    this.writeRoundPlan(run, round, explorations);
    transaction(this.db, () => {
      this.setRun(run.id, {
        exploration_round: round, status: "EXPLORING", last_candidate_attempt_id: null,
      });
      recordEvent(this.db, {
        kind: "MANAGER_EXPLORATION_REQUESTED", entityType: "job", entityId: run.job_id,
        payload: { runId: run.id, round, questions: explorations.map((item) => item.question), reason },
      });
    });
  }

  roundPlanPath(run, round) {
    return path.join(this.dispatcher.paths.artifacts, "manager", run.id, `explorations-${round}.json`);
  }

  writeRoundPlan(run, round, explorations) {
    const target = this.roundPlanPath(run, round);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(explorations, null, 2));
  }

  readRoundPlan(run, round) {
    const target = this.roundPlanPath(run, round);
    if (!fs.existsSync(target)) throw new ManagerStop(`exploration round ${round} has no recorded plan`, "NO_PLAN");
    return JSON.parse(fs.readFileSync(target, "utf8"));
  }

  // Runs this round's investigations, then synthesizes them.
  //
  // Serial on purpose. Family budget admission sums SETTLED receipts, so three children started
  // together would each observe the same spend and could collectively exceed one ceiling. Running
  // them one at a time proves the semantic algorithm without reopening that race; parallelism waits
  // for atomic admission.
  async explore(run) {
    const job = this.dispatcher.getJob(run.job_id);
    const round = run.exploration_round;
    const plan = this.readRoundPlan(run, round);

    for (const exploration of plan) {
      // Resumable by identity rather than by position: a child is found by the question it was
      // created for, so a crash between creating a child and recording anything about it resumes
      // rather than commissioning the same investigation twice.
      let child = this.db.prepare(
        "SELECT * FROM jobs WHERE parent_job_id = ? AND internal_kind = 'MANAGER_EXPLORATION' AND goal = ?",
      ).get(run.job_id, exploration.question);

      if (!child) {
        child = await this.dispatcher.createJob({
          projectId: job.project_id,
          goal: exploration.question,
          mode: "read",
          maxAttempts: 1,
          parentJobId: run.job_id,
          internalKind: "MANAGER_EXPLORATION",
        });
      }
      // Already finished on an earlier pass; do not pay for it again.
      if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(child.status)) continue;

      const instruction = renderExploration({ objective: job.goal, exploration });
      try {
        await this.dispatcher.runJob(child.id, { model: this.workerModel, instruction });
      } catch (error) {
        // A failed investigation is a fact the synthesis turn must be told, not a reason to abandon
        // the round. It becomes an UNKNOWN report below.
        recordEvent(this.db, {
          kind: "MANAGER_EXPLORATION_FAILED", entityType: "job", entityId: run.job_id,
          payload: { runId: run.id, round, childJobId: child.id, error: String(error?.message ?? error) },
        });
      }
    }

    return this.synthesize(run, round, plan);
  }

  // Reads each investigation's report back from its own attempt artifact.
  //
  // From disk, not from an in-memory string the worker happened to return: the report has to survive
  // a reboot, and it has to be attributable to one exact child attempt. A missing or unreadable
  // report is reported as UNKNOWN rather than as an empty answer, because "we could not find out"
  // and "there is nothing there" lead the manager to opposite conclusions.
  collectReports(run, plan) {
    return plan.map((exploration) => {
      const child = this.db.prepare(
        "SELECT * FROM jobs WHERE parent_job_id = ? AND internal_kind = 'MANAGER_EXPLORATION' AND goal = ?",
      ).get(run.job_id, exploration.question);
      if (!child) return { question: exploration.question, state: "NOT_RUN", answer: null, jobId: null };

      const attempt = this.db.prepare(
        "SELECT * FROM attempts WHERE job_id = ? ORDER BY ordinal DESC LIMIT 1",
      ).get(child.id);
      if (!attempt) return { question: exploration.question, state: "NOT_RUN", answer: null, jobId: child.id };
      if (attempt.terminal_state !== "SUCCEEDED") {
        return {
          question: exploration.question, state: "FAILED", answer: null, jobId: child.id,
          detail: attempt.failure_signature ?? this.dispatcher.lastFailureReason(child.id),
        };
      }
      if (!attempt.result_text_artifact || !fs.existsSync(attempt.result_text_artifact)) {
        return { question: exploration.question, state: "UNKNOWN", answer: null, jobId: child.id };
      }
      try {
        return {
          question: exploration.question,
          state: "PRESENT",
          answer: fs.readFileSync(attempt.result_text_artifact, "utf8"),
          jobId: child.id,
          attemptId: attempt.id,
        };
      } catch {
        return { question: exploration.question, state: "CORRUPT", answer: null, jobId: child.id };
      }
    });
  }

  async synthesize(run, round, plan) {
    const job = this.dispatcher.getJob(run.job_id);
    const project = this.dispatcher.getProject(job.project_id);
    const reports = this.collectReports(run, plan);
    const pack = buildPlanEvidence({
      objective: job.goal,
      baseSha: job.base_sha,
      validationCommands: JSON.parse(project.validation_json || "[]"),
      protectedPaths: JSON.parse(project.protected_json || "[]"),
      explorations: reports,
    });

    // SYNTHESIS rather than a second PLAN. The turn ledger exists to say what scarce budget was
    // spent on, and "deciding what to investigate" and "deciding what to build given findings" are
    // different questions at the same price.
    const { decision } = await this.runTurn(run, { phase: "SYNTHESIS", prompt: renderEvidence(pack) });

    if (decision.action === "IMPLEMENT") {
      this.storeBrief(run, decision.brief);
      this.setRun(run.id, { status: "IMPLEMENTING" });
      return;
    }
    if (decision.action === "ESCALATE") throw new ManagerStop(decision.reason, "ESCALATED", decision.question);
    if (decision.action === "EXPLORE" || decision.action === "RETHINK") {
      return this.openExplorationRound(this.getRun(run.job_id), decision.explorations, decision.reason);
    }
    throw new ManagerStop(
      `the manager answered ${decision.action} after synthesizing round ${round}: ${decision.reason}`,
      "UNSUPPORTED",
    );
  }

  storeBrief(run, brief) {
    const artifactDir = path.join(this.dispatcher.paths.artifacts, "manager", run.id);
    fs.mkdirSync(artifactDir, { recursive: true });
    const briefPath = path.join(artifactDir, `brief-${run.revision_round + 1}.json`);
    fs.writeFileSync(briefPath, JSON.stringify(brief, null, 2));
    return briefPath;
  }

  currentBrief(run) {
    const briefPath = path.join(
      this.dispatcher.paths.artifacts, "manager", run.id, `brief-${run.revision_round + 1}.json`,
    );
    if (!fs.existsSync(briefPath)) throw new ManagerStop("the implementation brief is missing", "NO_BRIEF");
    return JSON.parse(fs.readFileSync(briefPath, "utf8"));
  }

  async implement(run) {
    const job = this.dispatcher.getJob(run.job_id);
    const brief = this.currentBrief(run);
    const attempts = this.db.prepare("SELECT * FROM attempts WHERE job_id = ? ORDER BY ordinal").all(run.job_id);
    const previous = attempts.at(-1) ?? null;

    // A revision starts from the previous candidate so the worker corrects an implementation rather
    // than rewriting one from nothing. Candidate capture still measures against job.base_sha, so
    // what is eventually offered remains one complete net change from the authorized base.
    const startSha = run.revision_round > 0 && previous?.result_commit ? previous.result_commit : job.base_sha;
    const instruction = renderBrief({
      objective: job.goal,
      brief,
      attemptOrdinal: attempts.length + 1,
      priorFailure: run.revision_round > 0 ? brief.diagnosis : null,
    });

    // A managed retry that repeated its instruction would be the re-roll this whole layer exists to
    // remove, so it is refused rather than quietly performed.
    const digest = instructionDigest(instruction);
    if (previous && previous.instruction_digest === digest) {
      throw new ManagerStop(
        "the revision instruction is identical to the previous attempt's; refusing to re-roll",
        "IDENTICAL_INSTRUCTION",
      );
    }

    // The root sits at RUNNING between attempts; runJob claims from PENDING or NEEDS_ATTENTION.
    this.db.prepare("UPDATE jobs SET status = 'PENDING', updated_at = ? WHERE id = ?").run(now(), run.job_id);
    await this.dispatcher.runJob(run.job_id, {
      model: this.workerModel, instruction, startSha,
    });
    const attempt = this.db.prepare(
      "SELECT * FROM attempts WHERE job_id = ? ORDER BY ordinal DESC LIMIT 1",
    ).get(run.job_id);
    this.setRun(run.id, { status: "REVIEWING", last_candidate_attempt_id: attempt?.id ?? null });
  }

  async review(run) {
    const job = this.dispatcher.getJob(run.job_id);
    const project = this.dispatcher.getProject(job.project_id);
    const attemptId = run.last_candidate_attempt_id;
    if (!attemptId) throw new ManagerStop("there is no candidate attempt to review", "NO_CANDIDATE");

    const pack = await buildReviewEvidence({
      db: this.db,
      repoPath: project.repo_path,
      attemptId,
      diffCommits: (repoPath, from, to) => git(repoPath, ["diff", from, to], { raw: true }),
      priorDecisions: this.turns(run.id).filter((turn) => turn.action).map((turn) => ({
        phase: turn.phase, action: turn.action, ordinal: turn.ordinal,
      })),
      budget: this.dispatcher.budgetState(run.job_id),
    });

    const { decision } = await this.runTurn(run, {
      phase: "REVIEW", prompt: renderEvidence(pack), subjectAttemptId: attemptId,
    });

    if (decision.action === "ACCEPT") return this.accept(run, attemptId, pack);
    if (decision.action === "ESCALATE") throw new ManagerStop(decision.reason, "ESCALATED", decision.question);
    if (decision.action === "REVISE") return this.revise(run, decision);
    if (decision.action === "RETHINK") return this.rethink(run, decision);
    throw new ManagerStop(`the manager answered ${decision.action} during review`, "UNSUPPORTED");
  }

  // The only path to READY_FOR_INTEGRATION for a managed root.
  //
  // Checked here rather than trusted, because the manager is a probabilistic component making a
  // claim about a mechanical fact. Deterministic validation is not something semantic acceptance can
  // substitute for, and evidence the manager was never shown cannot support a judgment about it.
  accept(run, attemptId, pack) {
    const attempt = this.db.prepare("SELECT * FROM attempts WHERE id = ?").get(attemptId);
    if (!attempt) throw new ManagerStop(`accepted attempt ${attemptId} does not exist`, "NO_CANDIDATE");
    if (attempt.job_id !== run.job_id) {
      throw new ManagerStop(`attempt ${attemptId} belongs to another job`, "WRONG_JOB");
    }
    if (attempt.terminal_state !== "SUCCEEDED" || attempt.validation_state !== "PASSED") {
      throw new ManagerStop(
        `ACCEPT is invalid: attempt ${attemptId} is ${attempt.terminal_state}/${attempt.validation_state}`,
        "ACCEPT_WITHOUT_VALIDATION",
      );
    }
    if (!attempt.result_commit) {
      throw new ManagerStop(`ACCEPT is invalid: attempt ${attemptId} produced no candidate`, "ACCEPT_WITHOUT_CANDIDATE");
    }
    if (!pack.evidence_complete) {
      throw new ManagerStop(
        `ACCEPT is invalid: the review could not establish ${pack.unreadable_evidence.map((e) => e.evidence).join(", ")}`,
        "ACCEPT_ON_INCOMPLETE_EVIDENCE",
      );
    }
    const budget = this.dispatcher.budgetState(run.job_id);
    if (budget.blocks_integration_offer) {
      throw new ManagerStop(
        `the work is accepted but its family spend of ${budget.spent.toFixed(4)} reached the `
        + `${budget.ceiling} ceiling; it is not offered for integration`,
        "BUDGET_EXCEEDED",
      );
    }

    // One transaction: the acceptance identity and the promotion commit together, so a crash cannot
    // leave a root advertised as integration-ready with no record of what was accepted.
    transaction(this.db, () => {
      this.setRun(run.id, { status: "ACCEPTED", accepted_attempt_id: attemptId });
      this.db.prepare("UPDATE jobs SET status = 'READY_FOR_INTEGRATION', updated_at = ? WHERE id = ?")
        .run(now(), run.job_id);
      recordEvent(this.db, {
        kind: "MANAGER_ACCEPTED", entityType: "job", entityId: run.job_id,
        payload: { runId: run.id, attemptId, candidate: attempt.result_commit },
      });
    });
  }

  revise(run, decision) {
    const next = run.revision_round + 1;
    if (next > run.max_revision_rounds) {
      throw new ManagerStop(
        `the manager asked for revision ${next} but only ${run.max_revision_rounds} are permitted`,
        "REVISION_LIMIT",
      );
    }
    transaction(this.db, () => {
      this.setRun(run.id, { revision_round: next, status: "IMPLEMENTING" });
      recordEvent(this.db, {
        kind: "MANAGER_REVISION_REQUESTED", entityType: "job", entityId: run.job_id,
        payload: { runId: run.id, round: next, reason: decision.reason },
      });
    });
    // Written after the round advances so currentBrief() resolves the new one.
    this.storeBrief(this.getRun(run.job_id), decision.brief);
  }

  // The diagnosis was wrong, so correcting the code cannot help.
  //
  // Any investigations the manager attached are honoured directly rather than discarded. Throwing
  // them away and returning to PLANNING would spend a second scarce turn asking for the questions it
  // just asked for -- the manager pays to repeat itself, and the round it already reasoned about is
  // lost. The contract allows RETHINK to carry explorations precisely so this does not happen.
  rethink(run, decision) {
    recordEvent(this.db, {
      kind: "MANAGER_RETHINK", entityType: "job", entityId: run.job_id,
      payload: {
        runId: run.id, reason: decision.reason,
        questions: decision.explorations.map((item) => item.question),
      },
    });
    return this.openExplorationRound(run, decision.explorations, decision.reason);
  }

  // What a reboot makes of an interrupted run.
  //
  // A turn left INTENDED means the process died between recording the intent and recording the
  // result. The scarce call may have been made, answered and billed. Replaying it would pay twice to
  // ask a question that may already have an answer -- exactly the resource this system exists to
  // conserve -- so the turn becomes UNCERTAIN and the run stops for a person. Nothing here resumes
  // anything automatically.
  reconcile({ apply = false } = {}) {
    const stranded = this.db.prepare(`SELECT t.*, r.job_id FROM manager_turns t
      JOIN manager_runs r ON r.id = t.manager_run_id
      WHERE t.state IN ('INTENDED', 'RUNNING')`).all();
    if (!apply) return { stranded: stranded.map((turn) => turn.id), applied: false };

    for (const turn of stranded) {
      transaction(this.db, () => {
        this.db.prepare("UPDATE manager_turns SET state = 'UNCERTAIN', finished_at = ? WHERE id = ?")
          .run(now(), turn.id);
        this.db.prepare(`UPDATE manager_runs SET status = 'AWAITING_HUMAN',
          escalation_question = ?, updated_at = ? WHERE id = ?`).run(
          "A manager call was interrupted. It may already have run and consumed quota, so it will "
          + "not be repeated automatically. Decide whether to continue this job.",
          now(), turn.manager_run_id,
        );
        this.db.prepare("UPDATE jobs SET status = 'NEEDS_ATTENTION', updated_at = ? WHERE id = ?")
          .run(now(), turn.job_id);
        recordEvent(this.db, {
          kind: "MANAGER_TURN_UNCERTAIN", entityType: "job", entityId: turn.job_id,
          payload: { turnId: turn.id, reason: "interrupted before a result was recorded" },
        });
      });
    }
    return { stranded: stranded.map((turn) => turn.id), applied: true };
  }

  // Everything the scarce-resource metric needs, in one place.
  report(jobId) {
    const run = this.getRun(jobId);
    if (!run) return null;
    const turns = this.turns(run.id);
    const receipts = turns.map((turn) => this.db.prepare(
      "SELECT * FROM manager_usage_receipts WHERE manager_turn_id = ?",
    ).get(turn.id)).filter(Boolean);
    const family = this.dispatcher.familySpend(jobId);
    return {
      job_id: jobId,
      status: run.status,
      accepted_attempt_id: run.accepted_attempt_id,
      escalation_question: run.escalation_question,
      exploration_round: run.exploration_round,
      revision_round: run.revision_round,
      strong: {
        turns: turns.length,
        by_phase: turns.reduce((acc, turn) => ({ ...acc, [turn.phase]: (acc[turn.phase] ?? 0) + 1 }), {}),
        // Component totals only from receipts whose split resolved; the provider total separately.
        ...summarize(receipts),
      },
      cheap: {
        jobs: family.jobs,
        reference_cost_usd: family.spent,
        complete: family.complete,
      },
    };
  }
}

function summarize(receipts) {
  const totals = {
    total_tokens: 0, total_complete: true,
    input_tokens: 0, output_tokens: 0, reasoning_tokens: 0,
    components_complete: true, ambiguous_turns: 0, unmeasured_turns: 0,
  };
  for (const receipt of receipts) {
    if (receipt.total_tokens === null) totals.total_complete = false;
    else totals.total_tokens += receipt.total_tokens;
    if (receipt.status === "UNKNOWN") { totals.unmeasured_turns += 1; totals.components_complete = false; continue; }
    if (receipt.status === "PARTIAL") { totals.ambiguous_turns += 1; totals.components_complete = false; continue; }
    totals.input_tokens += receipt.input_tokens ?? 0;
    totals.output_tokens += receipt.output_tokens ?? 0;
    totals.reasoning_tokens += receipt.reasoning_tokens ?? 0;
  }
  return totals;
}

// A controlled stop. Distinct from a thrown Error so a policy decision to halt is never confused
// with a defect, and so the reason survives into the record a person reads.
export class ManagerStop extends Error {
  constructor(message, code, question = null) {
    super(message);
    this.name = "ManagerStop";
    this.code = code;
    this.question = question;
  }
}
