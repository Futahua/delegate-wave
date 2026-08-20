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
import { MANAGER_PRICING_BASIS, pricingBasisParts, referenceCostUsd } from "../pricing.js";
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
  // One rate-limit sample, stored exactly as the provider gave it.
  //
  // Swallows everything. This is measurement, and a manager turn must not fail because the account
  // endpoint was slow, absent, or unsupported by the backend in use.
  async recordRateLimits(turnId, boundary) {
    let raw = null;
    try {
      if (typeof this.backend?.rateLimits === "function") raw = await this.backend.rateLimits();
    } catch { /* the sample is lost; the turn is not */ }
    try {
      this.db.prepare(`INSERT OR IGNORE INTO manager_rate_limit_snapshots(
        id, manager_turn_id, boundary, raw_json, observed_at
      ) VALUES (?, ?, ?, ?, ?)`).run(
        id("mrl"), turnId, boundary, raw === null ? null : JSON.stringify(raw), now(),
      );
    } catch { /* never let telemetry fail the work it measures */ }
  }

  // What the worker chosen for this job will be able to do.
  //
  // Asked of the backend that will actually run, rather than assumed, because capability is a
  // property of the selected executor and profile. Null when the backend cannot say -- rendered to
  // the manager as UNKNOWN, which is safe, instead of as a capable worker, which is not.
  workerCapabilities(job) {
    try {
      const selection = this.dispatcher.selectBackend(
        this.dispatcher.resolveModel(this.workerModel),
        job.capability_profile ?? undefined,
      );
      const backend = selection?.backend ?? selection;
      if (typeof backend?.capabilities !== "function") return null;
      return backend.capabilities({ mode: "write", profile: job.capability_profile ?? undefined });
    } catch { return null; }
  }

  async runTurn(run, { phase, prompt, subjectAttemptId = null, rolledOver = false }) {
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

    // Sampled either side of the call, so one turn's consumption is a difference rather than an
    // estimate. Recorded even when it comes back null: an account that exposes nothing is a fact
    // about the measurement, and a missing row would be indistinguishable from a turn nobody
    // sampled. Never allowed to disturb the turn -- telemetry that can fail the work it measures is
    // worse than no telemetry.
    await this.recordRateLimits(turnId, "BEFORE");

    let result;
    try {
      result = await this.backend.runTurn({
        threadId: run.thread_id, phase, prompt, subjectAttemptId,
      });
    } catch (error) {
      // A failed turn still consumed allowance, so the AFTER sample is taken on this path too.
      await this.recordRateLimits(turnId, "AFTER");

      // The conversation outlived by the work it commissioned.
      //
      // A managed run is mostly waiting: the manager decides in seconds, then a worker builds for
      // minutes. On 2026-08-20 a thread survived 45s of consecutive turns and was gone after a
      // 6m48s gap, taking a finished candidate down with it. The gap is not incidental -- it is the
      // architecture, and it happens on every run.
      //
      // Replayed ONLY because the backend positively established the thread was rejected before
      // inference: no output, no usage, nothing billed. Conversation continuity is an optimization
      // here, not correctness -- the evidence pack carries the objective, the current evidence and
      // the prior decisions -- so a fresh thread receiving the same pack decides the same question.
      //
      // Once. If a brand-new thread is also refused, that is not a stale conversation any more.
      if (error?.staleThread === true && !rolledOver) {
        this.finishTurn(turnId, run, "FAILED", {
          error: `thread rollover: ${String(error?.message ?? error)}`,
        });
        const previous = run.thread_id;
        const started = await this.backend.startRun({ model: run.requested_model ?? undefined });
        // Persisted BEFORE anything uses it, so a crash mid-rollover cannot leave the run pointing
        // at a thread that no longer exists while a live one goes unrecorded.
        if (started?.threadId) {
          this.setRun(run.id, { thread_id: started.threadId });
          run.thread_id = started.threadId;
        }
        recordEvent(this.db, {
          kind: "MANAGER_THREAD_ROLLOVER", entityType: "job", entityId: run.job_id,
          payload: {
            old_thread: previous,
            new_thread: started?.threadId ?? null,
            reason: "THREAD_NOT_FOUND",
            semantic_turn: { phase, subjectAttemptId },
            failed_turn_id: turnId,
            retry: 1,
          },
        });
        return this.runTurn(run, { phase, prompt, subjectAttemptId, rolledOver: true });
      }

      const uncertain = error?.uncertain === true;
      this.finishTurn(turnId, run, uncertain ? "UNCERTAIN" : "FAILED", { error: String(error?.message ?? error) });
      throw new ManagerStop(
        uncertain
          ? `manager turn ${turnId} was accepted but its result was lost: ${error?.message ?? error}`
          : `manager turn ${turnId} failed: ${error?.message ?? error}`,
        uncertain ? "UNCERTAIN" : "TURN_FAILED",
      );
    }

    await this.recordRateLimits(turnId, "AFTER");

    // A backend whose conversation identity only exists after the first message reports it here.
    // Recorded before anything else uses the turn, so a crash cannot leave a live session that no
    // row points at -- the next turn would silently start a second conversation and the manager
    // would lose everything it had been told.
    if (result.threadId && result.threadId !== run.thread_id) {
      this.setRun(run.id, { thread_id: result.threadId });
      run.thread_id = result.threadId;
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

  // A manager turn acquires one terminal truth exactly once.
  //
  // Two defects lived here, and the weaker one hid the stronger. The receipt was written with
  // INSERT OR REPLACE: SQLite resolves a primary-key collision by deleting the conflicting row and
  // inserting the replacement, and delete triggers fire for that only when recursive_triggers is
  // enabled -- which this connection does not enable. So the immutability triggers on
  // manager_usage_receipts could never protect this path.
  //
  // The stronger defect is that the UPDATE had no state predicate. Even with a protected receipt, a
  // second call could rewrite a COMPLETED turn's response, digest and action -- turning a recorded
  // ACCEPT into a REVISE against the same scarce call. The TURN must be write-once, not merely its
  // usage row.
  //
  // Both are fixed by one shape: terminalize only from a live state, require exactly one row to
  // change, and insert the receipt plainly. A second attempt changes nothing and the whole
  // transaction rolls back, so no half-rewrite survives.
  finishTurn(turnId, run, state, { usage = null, responsePath = null, action = null, error = null } = {}) {
    return transaction(this.db, () => {
      const changed = this.db.prepare(`UPDATE manager_turns
        SET state = ?, response_artifact = ?, response_digest = ?, action = ?, finished_at = ?
        WHERE id = ? AND state IN ('INTENDED', 'RUNNING')`).run(
        state, responsePath,
        responsePath && fs.existsSync(responsePath)
          ? crypto.createHash("sha256").update(fs.readFileSync(responsePath)).digest("hex")
          : null,
        action, now(), turnId,
      ).changes;

      if (changed !== 1) {
        // Already terminal. The first account stands and this one is refused rather than merged.
        throw new ManagerStop(
          `manager turn ${turnId} is already terminal and cannot be finished again`,
          "TURN_ALREADY_TERMINAL",
        );
      }

      if (usage) {
        // Priced against the model that ACTUALLY answered, falling back to the one requested.
        //
        // The distinction is the same one the run row keeps: a provider that silently served a
        // different model billed for that one, and pricing the request instead would produce a
        // confident figure for work that never happened. Where the provider stated nothing,
        // requested is the only evidence there is, and is used as such rather than treated as
        // proof.
        //
        // referenceCostUsd returns null for a model no basis prices, and that null is recorded
        // rather than smoothed to zero. Because the tokens are stored beside it, adding a basis
        // later prices these receipts retroactively without re-running anything.
        const priced = referenceCostUsd(usage, {
          model: run.actual_model || run.requested_model,
          basisId: MANAGER_PRICING_BASIS,
        });
        const { basis, version } = pricingBasisParts(priced.pricing_basis_id);
        this.db.prepare(`INSERT INTO manager_usage_receipts(
          manager_turn_id, status, input_tokens, output_tokens, reasoning_tokens,
          cache_read_tokens, cache_write_tokens, total_tokens, source, observed_at,
          reference_cost_usd, pricing_basis, pricing_basis_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          turnId, usage.status, usage.input_tokens, usage.output_tokens, usage.reasoning_tokens,
          usage.cache_read_tokens, usage.cache_write_tokens, usage.total_tokens, usage.source, now(),
          priced.reference_cost_usd, basis, version,
        );
      }
      recordEvent(this.db, {
        kind: `MANAGER_TURN_${state}`, entityType: "job", entityId: run.job_id,
        payload: { turnId, action, error },
      });
      return true;
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

        // A cancelled root stops the manager, not merely its workers.
        //
        // Cancellation kills the family's live attempts, but the coordinator is a separate loop that
        // was still holding its own plan: it would return from a cancelled exploration round, spend a
        // scarce SYNTHESIS turn on the wreckage, and then commission an implementation for work the
        // operator had just stopped. Checked every iteration, because cancellation can land between
        // any two steps.
        if (this.dispatcher.getJob(jobId).status === "CANCELLED") {
          transaction(this.db, () => {
            this.setRun(run.id, { status: "CANCELLED" });
            recordEvent(this.db, {
              kind: "MANAGER_RUN_CANCELLED", entityType: "job", entityId: jobId,
              payload: { runId: run.id, at: run.status },
            });
          });
          break;
        }
        if (run.status === "PLANNING") await this.plan(run);
        // No round of its own: nothing was investigated, so it re-decides on what is already known.
        else if (run.status === "SYNTHESIZING") {
          await this.synthesize(run, run.exploration_round, this.roundPlanOrEmpty(run, run.exploration_round));
        }
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
      workerCapabilities: this.workerCapabilities(job),
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
        // The candidate is NOT erased here. A rethink invalidates the diagnosis, not the work: the
        // manager may decide, once it knows more, that the existing candidate is repairable after
        // all. Only IMPLEMENT abandons it, and that is an explicit decision to start over.
        //
        // With a candidate in hand this is a RE-synthesis, not a fresh plan. Sending it to PLANNING
        // would mislabel the turn and, worse, hand it a pack that cannot mention the candidate --
        // PLAN has no REVISE -- so work that survived in the database would vanish from the
        // manager's decision surface. Preserving the candidate is only half the fix; it also has to
        // remain decidable.
        this.setRun(run.id, {
          status: run.last_candidate_attempt_id ? "SYNTHESIZING" : "PLANNING",
        });
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
      // Same reason as above: exploring does not throw away a candidate that already exists.
      this.setRun(run.id, { exploration_round: round, status: "EXPLORING" });
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

  // The plan for a round that may not have one.
  //
  // A re-synthesis after a question-less rethink has no round of its own, and reading a missing plan
  // must not be an error there. readRoundPlan stays strict, because a round that WAS opened and lost
  // its plan is a real fault.
  roundPlanOrEmpty(run, round) {
    return fs.existsSync(this.roundPlanPath(run, round)) ? this.readRoundPlan(run, round) : [];
  }

  readRoundPlan(run, round) {
    const target = this.roundPlanPath(run, round);
    if (!fs.existsSync(target)) throw new ManagerStop(`exploration round ${round} has no recorded plan`, "NO_PLAN");
    return JSON.parse(fs.readFileSync(target, "utf8"));
  }

  // Runs this round's investigations concurrently, then synthesizes them.
  //
  // Every child job is created BEFORE any of them starts. Two reasons: the authority split needs to
  // know how many investigations still need to run, and creating jobs is the cheap half -- doing it
  // up front means a crash mid-round resumes against a complete plan rather than a partial one.
  //
  // Allocation is deliberately boring: equal shares of what is actually available. Anything smarter
  // -- per-question estimates, dynamic redistribution -- is a policy the experiment does not need,
  // and every share is still checked atomically by admitAttempt(), so this is allocation rather than
  // a second authority mechanism.
  async explore(run) {
    const job = this.dispatcher.getJob(run.job_id);
    const round = run.exploration_round;
    const plan = this.readRoundPlan(run, round);

    const pending = [];
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
      pending.push({ exploration, child });
    }

    if (pending.length) {
      const { ceiling, rootJobId } = this.dispatcher.budgetAuthority(run.job_id);
      let share = null;
      if (ceiling !== null && ceiling !== undefined) {
        const spend = this.dispatcher.familySpend(rootJobId);
        const headroom = ceiling - spend.spent - this.dispatcher.reservedAuthority(rootJobId);
        // A round that cannot fund its investigations is refused before any of them starts, rather
        // than funding the first two and discovering the third has nothing left.
        if (!(headroom > 0)) {
          throw new ManagerStop(
            `the family has no remaining authority for ${pending.length} investigation(s)`,
            "BUDGET_EXCEEDED",
          );
        }
        share = headroom / pending.length;
      }

      // allSettled, never all. A failed investigation is evidence the synthesis turn must be told
      // about, not a reason to abandon its siblings -- and Promise.all would abandon them the moment
      // one rejected, discarding work already paid for.
      await Promise.allSettled(pending.map(({ exploration, child }) => this.dispatcher.runJob(child.id, {
        model: this.workerModel,
        instruction: renderExploration({ objective: job.goal, exploration }),
        reservationRequest: share,
      }).catch((error) => {
        recordEvent(this.db, {
          kind: "MANAGER_EXPLORATION_FAILED", entityType: "job", entityId: run.job_id,
          payload: { runId: run.id, round, childJobId: child.id, error: String(error?.message ?? error) },
        });
        throw error;
      })));
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

  // The candidate a rethink left behind, assembled from the ledger rather than from the turn that
  // produced it.
  //
  // Read fresh every time. If this came from anything the conversation carried, a thread that
  // expired between turns would take it with it -- and the whole point is that a fresh thread given
  // the same pack decides the same question.
  priorCandidate(run) {
    const safeParse = (value) => { try { return JSON.parse(value ?? "null"); } catch { return null; } };
    if (!run.last_candidate_attempt_id) return null;
    const attempt = this.db.prepare("SELECT * FROM attempts WHERE id = ?").get(run.last_candidate_attempt_id);
    if (!attempt) return null;

    // The decision that sent this candidate back, and its stated reason, from the last REVIEW turn
    // that judged it.
    const review = this.db.prepare(
      `SELECT * FROM manager_turns WHERE manager_run_id = ? AND phase = 'REVIEW'
         AND subject_attempt_id = ? AND action IS NOT NULL ORDER BY ordinal DESC LIMIT 1`,
    ).get(run.id, attempt.id);
    let diagnosis = null;
    if (review?.response_artifact) {
      try {
        diagnosis = JSON.parse(fs.readFileSync(review.response_artifact, "utf8"))?.reason ?? null;
      } catch { diagnosis = null; }
    }

    return {
      attempt_id: attempt.id,
      result_commit: attempt.result_commit,
      changed_files: safeParse(attempt.changed_files_json) ?? [],
      validation_state: attempt.validation_state,
      previous_decision: review?.action ?? null,
      // Bounded: enough to decide, not the whole review replayed at full price on every later turn.
      review_diagnosis: diagnosis ? diagnosis.slice(0, 1200) : null,
    };
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
      priorCandidate: this.priorCandidate(run),
      // The envelope for the work being PLANNED, which is implementation. Investigation children run
      // read-only, but the manager is deciding what to build, not what to read.
      workerCapabilities: this.workerCapabilities(job),
    });

    // SYNTHESIS rather than a second PLAN. The turn ledger exists to say what scarce budget was
    // spent on, and "deciding what to investigate" and "deciding what to build given findings" are
    // different questions at the same price.
    const { decision } = await this.runTurn(run, { phase: "SYNTHESIS", prompt: renderEvidence(pack) });

    if (decision.action === "IMPLEMENT") {
      // An explicit decision to abandon whatever candidate exists and start from the authorized
      // base. Recorded, because "we threw away a working tree and started over" is a fact about how
      // the money was spent, not an implementation detail.
      if (run.last_candidate_attempt_id) {
        recordEvent(this.db, {
          kind: "MANAGER_CANDIDATE_ABANDONED", entityType: "job", entityId: run.job_id,
          payload: { runId: run.id, attemptId: run.last_candidate_attempt_id, reason: decision.reason },
        });
      }
      this.storeBrief(run, decision.brief);
      this.setRun(run.id, { status: "IMPLEMENTING", last_candidate_attempt_id: null });
      return;
    }
    if (decision.action === "ESCALATE") throw new ManagerStop(decision.reason, "ESCALATED", decision.question);
    if (decision.action === "EXPLORE" || decision.action === "RETHINK") {
      return this.openExplorationRound(this.getRun(run.job_id), decision.explorations, decision.reason);
    }
    // Repairing the candidate that survived the rethink.
    //
    // This is the state the manager kept trying to express and the machine could not represent: a
    // review invalidated the diagnosis, investigation established something new, and the existing
    // candidate is repairable under the corrected understanding. Answering REVISE there is coherent,
    // and refusing it threw away a whole run on 2026-08-20.
    //
    // Only valid post-candidate. A synthesis that has never produced anything has nothing to revise,
    // and accepting REVISE there would start a "repair" from a base commit with no repair to make.
    if (decision.action === "REVISE") {
      if (!run.last_candidate_attempt_id) {
        throw new ManagerStop(
          `the manager answered REVISE after synthesizing round ${round}, but no candidate has been `
          + "produced yet; there is nothing to revise",
          "REVISE_WITHOUT_CANDIDATE",
        );
      }
      return this.revise(run, decision);
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

  // Prices receipts that were recorded before any basis could price them.
  //
  // Completing history rather than rewriting it. A receipt whose cost is already stated is never
  // touched -- that figure names the basis that produced it and stays reproducible -- so this only
  // fills NULLs, and only from tokens the provider reported at the time. The tokens are the evidence;
  // the dollars are a derivation over them, which is exactly why storing the first made the second
  // recoverable without re-running anything.
  //
  // Dry by default, like reconcile: seeing what would change is not the same decision as changing it.
  repriceReceipts({ apply = false, basisId = MANAGER_PRICING_BASIS } = {}) {
    const { basis, version } = pricingBasisParts(basisId);
    const rows = this.db.prepare(`SELECT r.*, t.manager_run_id, t.phase,
        m.job_id, m.actual_model, m.requested_model
      FROM manager_usage_receipts r
      JOIN manager_turns t ON t.id = r.manager_turn_id
      JOIN manager_runs m ON m.id = t.manager_run_id
      WHERE r.reference_cost_usd IS NULL AND r.status != 'UNKNOWN'
        AND NOT EXISTS (SELECT 1 FROM manager_receipt_pricings p
          WHERE p.manager_turn_id = r.manager_turn_id
            AND p.pricing_basis = ? AND p.pricing_basis_version = ?)`)
      .all(basis, version ?? "");

    const priced = [];
    const refused = [];
    for (const row of rows) {
      const model = row.actual_model || row.requested_model;
      const result = referenceCostUsd(row, { model, basisId });
      if (result.reference_cost_usd === null) {
        refused.push({ turnId: row.manager_turn_id, jobId: row.job_id, model, totalTokens: row.total_tokens });
        continue;
      }
      priced.push({
        turnId: row.manager_turn_id, jobId: row.job_id, runId: row.manager_run_id, phase: row.phase,
        model, totalTokens: row.total_tokens, cost: result.reference_cost_usd, basisId: result.pricing_basis_id,
      });
    }

    if (apply && priced.length) {
      transaction(this.db, () => {
        const insert = this.db.prepare(`INSERT INTO manager_receipt_pricings(
          manager_turn_id, pricing_basis, pricing_basis_version, reference_cost_usd, derived_at
        ) VALUES (?, ?, ?, ?, ?)`);
        for (const entry of priced) insert.run(entry.turnId, basis, version ?? "", entry.cost, now());
        for (const jobId of [...new Set(priced.map((entry) => entry.jobId))]) {
          const forJob = priced.filter((entry) => entry.jobId === jobId);
          recordEvent(this.db, {
            kind: "MANAGER_RECEIPTS_REPRICED", entityType: "job", entityId: jobId,
            payload: {
              basisId, turns: forJob.length,
              referenceCostUsd: forJob.reduce((acc, entry) => acc + entry.cost, 0),
              note: "reference cost derived from stored token counts under a basis added after the "
                + "turns were bought; not provider-reported spend",
            },
          });
        }
      });
    }

    return {
      applied: apply,
      basisId,
      priced,
      refused,
      totalCostUsd: priced.reduce((acc, entry) => acc + entry.cost, 0),
    };
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
  //
  // basisId names which price list this report is denominated in. Passed rather than assumed,
  // because a total whose halves came from different bases is not a total.
  report(jobId, { basisId = MANAGER_PRICING_BASIS } = {}) {
    const run = this.getRun(jobId);
    if (!run) return null;
    const turns = this.turns(run.id);
    const wanted = pricingBasisParts(basisId);
    // A receipt's own figure first; otherwise a derivation over its tokens under the named basis.
    //
    // Priced-at-observation and priced-later are both legitimate answers to "what did this cost",
    // and the receipt's own is preferred because it was computed against the model actually serving
    // that turn. Neither is provider-reported spend, and the basis travels with the number either
    // way so a reader can tell which is which.
    const receipts = turns.map((turn) => {
      const receipt = this.db.prepare(
        "SELECT * FROM manager_usage_receipts WHERE manager_turn_id = ?",
      ).get(turn.id);
      if (!receipt || receipt.reference_cost_usd !== null) return receipt;
      // The NAMED basis, never merely the newest.
      //
      // "Most recently derived" looks equivalent while exactly one basis exists and stops being so
      // the moment a second is added: a report would then silently change basis as derivations
      // accumulate, and observation-time figures under one basis would sit beside retropriced
      // figures under another in the same total. Asking for a basis by name keeps a report
      // reproducible and keeps its components comparable to each other.
      const derived = this.db.prepare(
        `SELECT * FROM manager_receipt_pricings
         WHERE manager_turn_id = ? AND pricing_basis = ? AND pricing_basis_version = ?`,
      ).get(turn.id, wanted.basis, wanted.version ?? "");
      return derived
        ? {
          ...receipt,
          reference_cost_usd: derived.reference_cost_usd,
          pricing_basis: derived.pricing_basis,
          pricing_basis_version: derived.pricing_basis_version || null,
        }
        : receipt;
    }).filter(Boolean);
    // Re-derived under the report's basis, not read off receipts priced under another one. A report
    // is denominated in one price list or it is not a report.
    const family = this.dispatcher.familyReferenceSpend(jobId, basisId);
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
        pricing_basis: basisId,
        ...(family.complete ? {} : { unpriced_attempts: family.unpriced_attempts }),
      },
    };
  }
}

// Exported so the coverage rule below can be tested on its own. Whether a partial total is
// withheld is a claim about honesty of reporting, and it should not require staging a whole managed
// run against two different providers to check.
export function summarize(receipts) {
  const totals = {
    total_tokens: 0, total_complete: true,
    input_tokens: 0, output_tokens: 0, reasoning_tokens: 0,
    components_complete: true, ambiguous_turns: 0, unmeasured_turns: 0,
    // Money, kept honest about its own coverage.
    //
    // reference_cost_usd stays null unless EVERY receipt priced. A partial total is the failure
    // mode this whole ledger exists to avoid: it reads as the cost of the run while being the cost
    // of an unstated subset, and the reader has no way to see the difference. The per-turn figures
    // remain individually inspectable either way.
    reference_cost_usd: null, priced_turns: 0, unpriced_turns: 0, pricing_bases: [],
  };
  let priceable = 0;
  for (const receipt of receipts) {
    if (receipt.total_tokens === null) totals.total_complete = false;
    else totals.total_tokens += receipt.total_tokens;
    if (receipt.status === "UNKNOWN") { totals.unmeasured_turns += 1; totals.components_complete = false; continue; }
    if (receipt.status === "PARTIAL") { totals.ambiguous_turns += 1; totals.components_complete = false; continue; }
    totals.input_tokens += receipt.input_tokens ?? 0;
    totals.output_tokens += receipt.output_tokens ?? 0;
    totals.reasoning_tokens += receipt.reasoning_tokens ?? 0;
  }
  for (const receipt of receipts) {
    if (receipt.reference_cost_usd === null || receipt.reference_cost_usd === undefined) {
      totals.unpriced_turns += 1;
      continue;
    }
    totals.priced_turns += 1;
    priceable += receipt.reference_cost_usd;
    const named = [receipt.pricing_basis, receipt.pricing_basis_version].filter(Boolean).join("-");
    if (named && !totals.pricing_bases.includes(named)) totals.pricing_bases.push(named);
  }
  if (receipts.length && totals.unpriced_turns === 0) totals.reference_cost_usd = priceable;
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
