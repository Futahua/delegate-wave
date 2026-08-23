// The interaction layer: one autonomous task, from the user's words to a finished result.
//
// This is what Hermes talks to, and it exists because delegate-wave had no home for three things:
// the user's intent in their own words, the autonomy they granted, and the semantic conversation
// between Hermes and the manager. Everything below it -- ManagerService, workers, validation,
// evidence, pricing -- is unchanged and unaware this layer exists.
//
// THE SHAPE IS START / POLL / ANSWER, NOT ONE BLOCKING CALL.
//
// Hermes reaches delegate-wave over MCP, whose per-call timeout defaults to 300 seconds with idle
// stdio recycling. A managed run is minutes of worker time, so a call that waited for it would be a
// call that times out. But polling is not a workaround here: delegate-wave's truth is already
// durable and already restart-tolerant, and a manager thread is already a cache rather than a
// record. Returning immediately and resuming from SQLite is the shape the system already had.
//
// MODE IS A PERMISSION ENVELOPE, NOT A WORKFLOW STATE.
//
// `mode` says what this session may do; `state` says what is happening. They are separate columns
// and separate concepts. The moment a mode starts meaning "which step comes next" it has become the
// approval ceremony this design exists to remove -- so nothing here branches on mode to decide what
// to do next, only to decide what is permitted at all.
import crypto from "node:crypto";
import { recordEvent, transaction } from "../db.js";
import { ManagerStop } from "../manager/service.js";

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${crypto.randomUUID()}`;

export const SESSION_MODES = Object.freeze(["AUTO", "MANUAL", "ACCEPT_EDITS", "PLAN", "BYPASS"]);

// What a mode PERMITS. Deliberately not a table of steps.
//
// Only two questions are asked of a mode today: may this session change a repository at all, and
// may it proceed without a person. Everything else a mode might eventually govern is a permission
// question, and permission questions belong here rather than in the loop below.
const MODE_POLICY = Object.freeze({
  // Investigate and reason; never modify anything. Enforced by commissioning a read-mode job, so
  // the refusal is mechanical rather than a promise this layer makes.
  PLAN: Object.freeze({ mayWrite: false, mayProceedUnattended: true }),
  MANUAL: Object.freeze({ mayWrite: true, mayProceedUnattended: false }),
  ACCEPT_EDITS: Object.freeze({ mayWrite: true, mayProceedUnattended: true }),
  AUTO: Object.freeze({ mayWrite: true, mayProceedUnattended: true }),
  // Suppresses QUESTIONS, never INVARIANTS. Protected paths, deterministic validation, CAS
  // integration, budget admission, worktree and credential isolation are mechanical and refuse
  // under this mode exactly as under any other. Nothing in this file can switch them off, which is
  // the point: there is no flag to find.
  BYPASS: Object.freeze({ mayWrite: true, mayProceedUnattended: true }),
});

export function modePolicy(mode) {
  const policy = MODE_POLICY[mode];
  if (!policy) throw new Error(`Unknown autonomy mode: ${mode}`);
  return policy;
}

export class AutonomousSessionService {
  constructor({ dispatcher, manager }) {
    if (!dispatcher) throw new Error("AutonomousSessionService requires a dispatcher");
    if (!manager) throw new Error("AutonomousSessionService requires a manager");
    this.dispatcher = dispatcher;
    this.manager = manager;
    this.db = dispatcher.db;
  }

  // Accepts the task and returns. Nothing is waited for.
  async start({ projectId, intent, mode = "AUTO", maximumCost = null, maxAttempts = 3 }) {
    if (!SESSION_MODES.includes(mode)) throw new Error(`Unknown autonomy mode: ${mode}`);
    if (typeof intent !== "string" || !intent.trim()) throw new Error("intent must be a non-empty string");
    const project = this.dispatcher.getProject(projectId);
    if (!project) throw new Error(`Unknown project: ${projectId}`);
    const policy = modePolicy(mode);

    // A PLAN session commissions a READ job. The prohibition is enforced by the executor's own
    // capability envelope, not by this layer remembering to check -- a promise made here could be
    // forgotten by the next caller, while a read-mode job cannot write.
    const job = await this.dispatcher.createJob({
      projectId,
      goal: intent,
      strategy: "managed",
      mode: policy.mayWrite ? "write" : "read",
      maxAttempts,
      ...(maximumCost === null ? {} : { maximumCost }),
    });

    const sessionId = id("asess");
    transaction(this.db, () => {
      this.db.prepare(`INSERT INTO autonomous_sessions(
        id, project_id, job_id, intent, mode, state, maximum_cost, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'WORKING', ?, ?, ?)`).run(
        sessionId, projectId, job.id, intent, mode, maximumCost, now(), now(),
      );
      recordEvent(this.db, {
        kind: "AUTONOMOUS_SESSION_STARTED", entityType: "job", entityId: job.id,
        payload: { sessionId, mode, intent: intent.slice(0, 400) },
      });
    });
    return { session_id: sessionId, state: "WORKING", job_id: job.id, mode };
  }

  get(sessionId) {
    return this.db.prepare("SELECT * FROM autonomous_sessions WHERE id = ?").get(sessionId) ?? null;
  }

  setState(sessionId, fields) {
    const keys = Object.keys(fields);
    this.db.prepare(
      `UPDATE autonomous_sessions SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ?
       WHERE id = ?`,
    ).run(...keys.map((k) => fields[k]), now(), sessionId);
  }

  messages(sessionId) {
    return this.db.prepare(
      "SELECT * FROM autonomous_session_messages WHERE session_id = ? ORDER BY ordinal",
    ).all(sessionId);
  }

  // The manager's question, recorded as evidence before anyone is asked.
  //
  // Written durably first so that a process that dies between deciding to ask and being asked
  // resumes holding the question, rather than losing it and re-deriving a possibly different one at
  // the next scarce turn.
  ask(sessionId, { body, whyItMatters = null, evidence = [] }) {
    const ordinal = (this.db.prepare(
      "SELECT MAX(ordinal) AS max FROM autonomous_session_messages WHERE session_id = ?",
    ).get(sessionId).max ?? 0) + 1;
    const messageId = id("amsg");
    transaction(this.db, () => {
      this.db.prepare(`INSERT INTO autonomous_session_messages(
        id, session_id, ordinal, direction, body, why_it_matters, evidence_json, created_at
      ) VALUES (?, ?, ?, 'TO_HERMES', ?, ?, ?, ?)`).run(
        messageId, sessionId, ordinal, body, whyItMatters, JSON.stringify(evidence), now(),
      );
      this.setState(sessionId, { state: "WAITING_FOR_HERMES" });
    });
    return messageId;
  }

  // Hermes' answer, reasoning from a conversation delegate-wave never sees.
  answer(sessionId, text) {
    const session = this.get(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    if (session.state !== "WAITING_FOR_HERMES") {
      throw new Error(`Session ${sessionId} is ${session.state} and is not waiting for an answer`);
    }
    if (typeof text !== "string" || !text.trim()) throw new Error("answer must be a non-empty string");
    const open = this.db.prepare(
      `SELECT * FROM autonomous_session_messages
       WHERE session_id = ? AND direction = 'TO_HERMES' AND answered_by IS NULL
       ORDER BY ordinal DESC LIMIT 1`,
    ).get(sessionId);
    if (!open) throw new Error(`Session ${sessionId} has no unanswered question`);

    const messageId = id("amsg");
    transaction(this.db, () => {
      this.db.prepare(`INSERT INTO autonomous_session_messages(
        id, session_id, ordinal, direction, body, created_at
      ) VALUES (?, ?, ?, 'FROM_HERMES', ?, ?)`).run(
        messageId, sessionId, open.ordinal + 1, text, now(),
      );
      this.db.prepare("UPDATE autonomous_session_messages SET answered_by = ? WHERE id = ?")
        .run(messageId, open.id);
      this.setState(sessionId, { state: "WORKING" });
      recordEvent(this.db, {
        kind: "AUTONOMOUS_SESSION_ANSWERED", entityType: "job", entityId: session.job_id,
        payload: { sessionId, question: open.body.slice(0, 300), answer: text.slice(0, 300) },
      });
    });

    // Outside the transaction above, which owns the session's own rows. The manager owns its run and
    // opens its own transaction to move it; nesting the two would abort both.
    //
    // The manager parked itself in AWAITING_HUMAN when it escalated. Hermes IS the human for this
    // purpose -- it holds the intent the question was derived from -- so an answer returns the run to
    // work rather than leaving it waiting for a person who has already been represented.
    this.manager.resumeFromEscalation(session.job_id, { reason: "answered by Hermes" });
    return { session_id: sessionId, state: "WORKING" };
  }

  // The clarifications the manager should reason from, oldest first.
  //
  // Read from the ledger rather than carried, so a fresh manager thread sees exactly what an
  // unbroken one would. This is the same rule the prior-candidate pack follows and for the same
  // reason: a thread is a cache, and the decision must not depend on which one is current.
  clarifications(sessionId) {
    const messages = this.messages(sessionId);
    const out = [];
    for (const message of messages) {
      if (message.direction !== "TO_HERMES" || !message.answered_by) continue;
      const answer = messages.find((item) => item.id === message.answered_by);
      if (answer) out.push({ question: message.body, answer: answer.body });
    }
    return out;
  }

  // Advances the session as far as it can go without a person.
  //
  // Called by whatever is driving -- a supervisor tick, a test, a restart. It is safe to call at any
  // time and from any state: a session already waiting stays waiting, a finished one stays finished.
  // That property is what makes restart-resumption free, because "resume" and "keep going" are the
  // same operation.
  async tick(sessionId) {
    const session = this.get(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    if (["WAITING_FOR_HERMES", "SEMANTICALLY_ACCEPTED", "COMPLETED", "FAILED"].includes(session.state)) {
      return this.poll(sessionId);
    }

    try {
      await this.manager.advance(session.job_id, {
        // The manager reasons from evidence; these are the answers Hermes already gave it.
        clarifications: this.clarifications(sessionId),
      });
    } catch (error) {
      if (error instanceof ManagerStop && error.code === "ESCALATED") {
        // A question, not a failure. The manager decided a person's judgment is needed -- and in
        // this architecture "a person" is Hermes, which holds the intent this was derived from and
        // can often answer without waking anyone.
        this.ask(sessionId, {
          body: error.question || error.message,
          whyItMatters: error.message,
          evidence: [],
        });
        return this.poll(sessionId);
      }
      this.setState(sessionId, {
        state: "FAILED",
        outcome: error instanceof ManagerStop ? `${error.code}: ${error.message}` : error.message,
      });
      return this.poll(sessionId);
    }

    const run = this.manager.getRun(session.job_id);
    if (run?.status === "AWAITING_HUMAN") {
      this.ask(sessionId, {
        body: run.escalation_question || "The manager stopped and needs a decision.",
        whyItMatters: "The manager could not proceed without judgment.",
        evidence: [],
      });
      return this.poll(sessionId);
    }
    if (run?.status === "ACCEPTED") {
      // Stops at the semantic result. Integration is a separate, more dangerous boundary and is
      // deliberately not attempted here.
      this.setState(sessionId, { state: "SEMANTICALLY_ACCEPTED", outcome: null });
    }
    return this.poll(sessionId);
  }

  // A small semantic state, never the ledger.
  poll(sessionId) {
    const session = this.get(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    const base = {
      session_id: session.id,
      state: session.state.toLowerCase(),
      mode: session.mode,
      intent: session.intent,
    };

    if (session.state === "WAITING_FOR_HERMES") {
      const open = this.db.prepare(
        `SELECT * FROM autonomous_session_messages
         WHERE session_id = ? AND direction = 'TO_HERMES' AND answered_by IS NULL
         ORDER BY ordinal DESC LIMIT 1`,
      ).get(sessionId);
      return {
        ...base,
        question: open?.body ?? null,
        why_it_matters: open?.why_it_matters ?? null,
        relevant_evidence: open ? JSON.parse(open.evidence_json || "[]") : [],
      };
    }

    if (["SEMANTICALLY_ACCEPTED", "COMPLETED"].includes(session.state)) {
      const run = this.manager.getRun(session.job_id);
      const attempt = run?.accepted_attempt_id
        ? this.db.prepare("SELECT * FROM attempts WHERE id = ?").get(run.accepted_attempt_id)
        : null;
      return {
        ...base,
        result: attempt
          ? {
            attempt: attempt.id,
            candidate_commit: attempt.result_commit,
            changed_files: JSON.parse(attempt.changed_files_json || "[]"),
            validation: attempt.validation_state,
          }
          : null,
      };
    }

    if (session.state === "FAILED") return { ...base, outcome: session.outcome };
    return base;
  }
}
