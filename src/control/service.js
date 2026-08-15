import crypto from "node:crypto";
import { transaction } from "../db.js";
import { ControlError, asControlError } from "./errors.js";

const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MUTATION_COMMANDS = new Set([
  "project.create", "job.create", "job.run", "integration.propose",
  "approval.grant", "integration.run", "reconcile",
  "work.propose", "work.proposal.authorize", "work.proposal.reject", "job.cancel",
  "backup.create", "backup.restore", "restore.resolve", "integration.rollback", "job.advance", "integration.approve",
]);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(command, args) {
  return crypto.createHash("sha256").update(canonical({ command, args })).digest("hex");
}

function rejectIdentity(args) {
  const forbidden = ["principal", "principal_id", "principalId", "origin", "origin_channel", "originChannel"];
  const supplied = forbidden.find((key) => Object.hasOwn(args, key));
  if (supplied) throw new ControlError("IDENTITY_SPOOFING", `Request body may not set ${supplied}`, 403);
}

export class ControlService {
  constructor({ dispatcher, pendingWaitMs = 5000 }) {
    this.dispatcher = dispatcher;
    this.pendingWaitMs = pendingWaitMs;
  }

  // Read through to the dispatcher's current handle rather than caching one.
  //
  // Restore closes the live database and reopens a new handle over the restored file. A cached
  // reference would still point at the closed handle, so writing the terminal receipt would fail and
  // a fully successful restore would be reported to the caller as REQUEST_UNCERTAIN -- the single
  // most alarming answer the API can give, on the one operation an operator runs under stress.
  get db() {
    return this.dispatcher.db;
  }

  async execute(command, args = {}, context = {}) {
    if (MUTATION_COMMANDS.has(command)) return this.mutate(command, args, context);
    return this.query(command, args);
  }

  async query(command, args = {}) {
    const handlers = {
      health: () => ({ ok: true, doctor: this.dispatcher.doctor() }),
      overview: () => this.dispatcher.overview(),
      "project.list": () => this.dispatcher.listProjects(),
      "job.list": () => this.dispatcher.listJobs(args.projectId || null),
      "job.get": () => this.dispatcher.status(args.jobId),
      "proposal.get": () => this.dispatcher.integrationStatus(args.proposalId),
      "work.proposal.list": () => this.dispatcher.listWorkProposals(args.projectId || null),
      "backup.list": () => this.dispatcher.listBackups(),
      "work.proposal.get": () => this.dispatcher.getWorkProposal(args.proposalId),
      "approval.list": () => this.dispatcher.listApprovals(args.proposalId || null),
      attention: () => this.dispatcher.attention(),
      briefing: () => this.dispatcher.briefing(),
    };
    const handler = handlers[command];
    if (!handler) throw new ControlError("UNKNOWN_COMMAND", `Unknown query command: ${command}`, 404);
    return handler();
  }

  async mutate(command, args = {}, context = {}) {
    const requestId = context.requestId;
    const principalId = context.principalId;
    const originChannel = context.originChannel;
    if (!requestId || typeof requestId !== "string") throw new ControlError("REQUEST_ID_REQUIRED", "Mutations require a request_id", 400);
    if (!principalId || !originChannel) throw new ControlError("IDENTITY_REQUIRED", "Server-authenticated identity is required", 401);
    rejectIdentity(args);

    const argsDigest = digest(command, args);
    const claim = transaction(this.db, () => {
      const existing = this.db.prepare("SELECT * FROM control_request_intents WHERE request_id = ?").get(requestId);
      if (existing) {
        if (existing.command !== command || existing.args_digest !== argsDigest
          || existing.principal_id !== principalId || existing.origin_channel !== originChannel) {
          throw new ControlError("REQUEST_CONFLICT", `request_id ${requestId} was already used for a different operation`, 409);
        }
        const result = this.db.prepare("SELECT * FROM control_request_results WHERE request_id = ?").get(requestId);
        return result ? { kind: "result", result } : { kind: "pending" };
      }
      this.db.prepare(`INSERT INTO control_request_intents(
        request_id, command, args_digest, principal_id, origin_channel, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`).run(requestId, command, argsDigest, principalId, originChannel, now());
      return { kind: "execute" };
    });

    if (claim.kind === "result") return this.decodeResult(claim.result);
    if (claim.kind === "pending") return this.waitForResult(requestId);

    // Kept so the receipt can be written even if the command replaced the database underneath us.
    const intent = { command, argsDigest, principalId, originChannel, createdAt: now() };

    let response;
    try {
      response = await this.executeMutation(command, args, { principalId, originChannel });
    } catch (error) {
      const normalized = asControlError(error);
      if (String(normalized.code).includes("UNCERTAIN")) throw this.uncertain(requestId, normalized);
      try {
        this.recordFailedResult(requestId, normalized, intent);
      } catch (receiptError) {
        throw this.uncertain(requestId, receiptError);
      }
      throw normalized;
    }

    try {
      this.recordSucceededResult(requestId, response, intent);
    } catch (receiptError) {
      throw this.uncertain(requestId, receiptError);
    }
    return response;
  }

  // Restore replaces the whole database, including the intent row this request wrote a moment ago.
  // The receipt has a foreign key to that intent, so without re-establishing it the receipt cannot
  // land and a fully successful restore reports as uncertain. Re-inserting the intent this request
  // genuinely made is not fabrication: it carries this request's own durable record across the swap.
  reinstateIntent(requestId, intent) {
    const present = this.db.prepare("SELECT 1 FROM control_request_intents WHERE request_id = ?").get(requestId);
    if (present) return;
    this.db.prepare(`INSERT INTO control_request_intents(
      request_id, command, args_digest, principal_id, origin_channel, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`).run(
      requestId, intent.command, intent.argsDigest, intent.principalId, intent.originChannel, intent.createdAt,
    );
  }

  recordSucceededResult(requestId, response, intent = null) {
    transaction(this.db, () => {
      if (intent) this.reinstateIntent(requestId, intent);
      this.db.prepare(`INSERT INTO control_request_results(
        request_id, outcome, response_json, created_at
      ) VALUES (?, 'SUCCEEDED', ?, ?)`).run(requestId, JSON.stringify(response), now());
    });
  }

  recordFailedResult(requestId, error, intent = null) {
    transaction(this.db, () => {
      if (intent) this.reinstateIntent(requestId, intent);
      this.db.prepare(`INSERT INTO control_request_results(
        request_id, outcome, error_code, error_message, created_at
      ) VALUES (?, 'FAILED', ?, ?, ?)`).run(requestId, error.code, error.message, now());
    });
  }

  uncertain(requestId, cause) {
    return new ControlError(
      "REQUEST_UNCERTAIN",
      `request_id ${requestId} has durable intent but no terminal receipt: ${cause.message}`,
      409,
      { cause_code: cause.code || "RECEIPT_WRITE_FAILED" },
    );
  }

  async waitForResult(requestId) {
    const deadline = Date.now() + this.pendingWaitMs;
    while (Date.now() < deadline) {
      const result = this.db.prepare("SELECT * FROM control_request_results WHERE request_id = ?").get(requestId);
      if (result) return this.decodeResult(result);
      await sleep(25);
    }
    throw new ControlError("REQUEST_UNCERTAIN", `request_id ${requestId} has durable intent but no terminal receipt`, 409);
  }

  decodeResult(result) {
    if (result.outcome === "SUCCEEDED") return JSON.parse(result.response_json);
    throw new ControlError(result.error_code || "COMMAND_FAILED", result.error_message || "Command failed", 409);
  }

  async executeMutation(command, args, context) {
    const handlers = {
      "project.create": () => this.dispatcher.addProject(args),
      "job.create": () => this.dispatcher.createJob(args),
      "job.run": () => this.dispatcher.runJob(args.jobId, { model: args.model || null }),
      // One authorization carries the work as far as it can go without another human decision.
      "job.advance": () => this.dispatcher.advanceJob(args.jobId, { model: args.model || null }),
      // The second and final decision: approve this exact candidate and integrate it.
      "integration.approve": () => this.dispatcher.approveAndIntegrate({
        proposalId: args.proposalId,
        principal: context.principalId,
        origin: context.originChannel,
        idempotencyKey: args.idempotencyKey || null,
      }),
      "backup.create": () => this.dispatcher.backup(args.label || "manual"),
      // Clears the unresolved-restore condition; only a person can say the truths agree again.
      "restore.resolve": () => this.dispatcher.resolveRestore(),
      "backup.restore": () => this.dispatcher.restore(args.backup, {
        restoreRepositories: args.restoreRepositories !== false,
      }),
      "integration.rollback": () => this.dispatcher.rollbackIntegration({
        proposalId: args.proposalId,
        principal: context.principalId,
        origin: context.originChannel,
      }),
      "job.cancel": () => this.dispatcher.cancelJob({
        jobId: args.jobId,
        principal: context.principalId,
        origin: context.originChannel,
        reason: args.reason || "",
      }),
      "integration.propose": () => this.dispatcher.proposeIntegration({ jobId: args.jobId }),
      "approval.grant": () => this.dispatcher.grantApproval({
        proposalId: args.proposalId,
        principal: context.principalId,
        origin: context.originChannel,
        expiresAt: args.expiresAt || null,
        maximumCost: args.maximumCost ?? null,
        idempotencyKey: args.idempotencyKey || null,
      }),
      "integration.run": () => this.dispatcher.runIntegration(args.proposalId),
      reconcile: () => this.dispatcher.reconcile({ apply: args.apply === true }),
      // Origin identity is taken from the authenticated credential, never from the request body.
      "work.propose": () => this.dispatcher.proposeWork({
        projectId: args.projectId,
        goal: args.goal,
        mode: args.mode || "write",
        maximumCost: args.maximumCost ?? null,
        expiresAt: args.expiresAt || null,
        expectedStateVersion: args.expectedStateVersion || null,
        idempotencyKey: args.idempotencyKey,
        principal: context.principalId,
        origin: context.originChannel,
      }),
      // Authorizing runs the work: the operator's single decision is "do this", not "do this, then
      // tell me to start it, then tell me to validate it". Auto-advance is opt-out for callers that
      // want the decision recorded without immediately spending money.
      "work.proposal.authorize": async () => {
        const decided = await this.dispatcher.authorizeWorkProposal({
          proposalId: args.proposalId,
          principal: context.principalId,
          origin: context.originChannel,
          maxAttempts: args.maxAttempts ?? 2,
        });
        if (args.advance === false) return decided;
        const jobId = decided.decision?.job_id;
        if (!jobId) return decided;
        // A worker or validation failure is a normal outcome of advancing, not a failure of the
        // authorization itself, so it is reported rather than thrown.
        try {
          return { ...decided, advanced: await this.dispatcher.advanceJob(jobId, { model: args.model || null }) };
        } catch (error) {
          return { ...decided, advanced: null, advance_error: String(error?.message ?? error) };
        }
      },
      "work.proposal.reject": () => this.dispatcher.rejectWorkProposal({
        proposalId: args.proposalId,
        principal: context.principalId,
        origin: context.originChannel,
      }),
    };
    const handler = handlers[command];
    if (!handler) throw new ControlError("UNKNOWN_COMMAND", `Unknown mutation command: ${command}`, 404);
    return handler();
  }
}
