import crypto from "node:crypto";
import { transaction } from "../db.js";
import { ControlError, asControlError } from "./errors.js";

const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MUTATION_COMMANDS = new Set([
  "project.create", "job.create", "job.run", "integration.propose",
  "approval.grant", "integration.run", "reconcile",
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
    this.db = dispatcher.db;
    this.pendingWaitMs = pendingWaitMs;
  }

  async execute(command, args = {}, context = {}) {
    if (MUTATION_COMMANDS.has(command)) return this.mutate(command, args, context);
    return this.query(command, args);
  }

  async query(command, args = {}) {
    const handlers = {
      health: () => ({ ok: true, doctor: this.dispatcher.doctor() }),
      "project.list": () => this.dispatcher.listProjects(),
      "job.list": () => this.dispatcher.listJobs(args.projectId || null),
      "job.get": () => this.dispatcher.status(args.jobId),
      "proposal.get": () => this.dispatcher.integrationStatus(args.proposalId),
      "approval.list": () => this.dispatcher.listApprovals(args.proposalId || null),
      attention: () => this.dispatcher.attention(),
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

    let response;
    try {
      response = await this.executeMutation(command, args, { principalId, originChannel });
    } catch (error) {
      const normalized = asControlError(error);
      if (String(normalized.code).includes("UNCERTAIN")) throw this.uncertain(requestId, normalized);
      try {
        this.recordFailedResult(requestId, normalized);
      } catch (receiptError) {
        throw this.uncertain(requestId, receiptError);
      }
      throw normalized;
    }

    try {
      this.recordSucceededResult(requestId, response);
    } catch (receiptError) {
      throw this.uncertain(requestId, receiptError);
    }
    return response;
  }

  recordSucceededResult(requestId, response) {
    transaction(this.db, () => {
      this.db.prepare(`INSERT INTO control_request_results(
        request_id, outcome, response_json, created_at
      ) VALUES (?, 'SUCCEEDED', ?, ?)`).run(requestId, JSON.stringify(response), now());
    });
  }

  recordFailedResult(requestId, error) {
    transaction(this.db, () => {
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
    };
    const handler = handlers[command];
    if (!handler) throw new ControlError("UNKNOWN_COMMAND", `Unknown mutation command: ${command}`, 404);
    return handler();
  }
}
