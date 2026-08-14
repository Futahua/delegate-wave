#!/usr/bin/env node
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { ControlClient } from "../control/client.js";

const TOOLS = Object.freeze([
  {
    name: "get_overview",
    description: "Get one bounded operational overview: project health, latest jobs, and items needing human attention.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_projects",
    description: "List software projects known to delegate-wave.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_project_summary",
    description: "Get one project and its 20 most recent jobs with total/truncation metadata. Read-only; does not start work.",
    inputSchema: {
      type: "object", properties: { project_id: { type: "string" } }, required: ["project_id"], additionalProperties: false,
    },
  },
  {
    name: "get_job",
    description: "Get authoritative status, attempts, and validations for one job.",
    inputSchema: {
      type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"], additionalProperties: false,
    },
  },
  {
    name: "get_attention_needed",
    description:
      "List work needing human attention: jobs, unresolved integration operations, and work "
      + "proposals awaiting an operator decision.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_integration",
    description: "Get an integration proposal, approvals, operations, and receipts.",
    inputSchema: {
      type: "object", properties: { proposal_id: { type: "string" } }, required: ["proposal_id"], additionalProperties: false,
    },
  },
  {
    name: "propose_work",
    description:
      "Propose one bounded unit of work for human authorization. This does NOT start work: it creates a "
      + "pending request that a human operator must explicitly authorize before any worker runs. "
      + "Requires a proposal credential; it cannot approve, run, or integrate anything.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        goal: { type: "string", description: "What the worker should accomplish, in plain language." },
        mode: { type: "string", enum: ["read", "write"] },
        maximum_cost: { type: "number", description: "Optional cost ceiling in dollars." },
        idempotency_key: { type: "string", description: "Stable key so a retried proposal is not duplicated." },
      },
      required: ["project_id", "goal", "idempotency_key"],
      additionalProperties: false,
    },
  },
  {
    name: "list_work_proposals",
    description: "List work proposals and their decisions. Read-only.",
    inputSchema: {
      type: "object", properties: { project_id: { type: "string" } }, additionalProperties: false,
    },
  },
  {
    name: "get_work_proposal",
    description: "Get one work proposal, its bounds, and its authorization decision.",
    inputSchema: {
      type: "object", properties: { proposal_id: { type: "string" } }, required: ["proposal_id"], additionalProperties: false,
    },
  },
]);

const MCP_PROTOCOL_VERSION = "2025-06-18";
const PROJECT_SUMMARY_JOB_LIMIT = 20;

function requiredString(args, name) {
  if (typeof args?.[name] !== "string" || !args[name].trim()) throw new Error(`${name} must be a non-empty string`);
  return args[name];
}

export class HermesMcpAdapter {
  constructor({ client }) { this.client = client; }

  listTools() { return TOOLS; }

  async callTool(name, args = {}) {
    if (name === "get_overview") return this.client.get("/v1/overview");
    if (name === "list_projects") return this.client.get("/v1/projects");
    if (name === "get_project_summary") {
      const projectId = requiredString(args, "project_id");
      const projects = await this.client.get("/v1/projects");
      const project = projects.find((item) => item.id === projectId);
      if (!project) throw new Error(`Unknown project: ${projectId}`);
      const jobs = await this.client.get(`/v1/jobs?projectId=${encodeURIComponent(projectId)}`);
      return {
        project,
        recent_jobs: jobs.slice(0, PROJECT_SUMMARY_JOB_LIMIT),
        total_jobs: jobs.length,
        truncated: jobs.length > PROJECT_SUMMARY_JOB_LIMIT,
      };
    }
    if (name === "get_job") return this.client.get(`/v1/jobs/${encodeURIComponent(requiredString(args, "job_id"))}`);
    if (name === "get_attention_needed") return this.client.get("/v1/attention");
    if (name === "get_integration") return this.client.get(`/v1/proposals/${encodeURIComponent(requiredString(args, "proposal_id"))}`);
    if (name === "propose_work") {
      // The Control API derives origin identity from the credential; the adapter never supplies it.
      return this.client.post("/v1/work/proposals", {
        projectId: requiredString(args, "project_id"),
        goal: requiredString(args, "goal"),
        mode: args.mode || "write",
        maximumCost: args.maximum_cost ?? null,
        idempotencyKey: requiredString(args, "idempotency_key"),
      }, `req_${randomUUID()}`);
    }
    if (name === "list_work_proposals") {
      const query = args.project_id ? `?projectId=${encodeURIComponent(args.project_id)}` : "";
      return this.client.get(`/v1/work/proposals${query}`);
    }
    if (name === "get_work_proposal") {
      return this.client.get(`/v1/work/proposals/${encodeURIComponent(requiredString(args, "proposal_id"))}`);
    }
    throw new Error(`Unknown tool: ${name}`);
  }
}

function send(output, message) { output.write(`${JSON.stringify(message)}\n`); }

export function hermesControlClient(environment = process.env) {
  const token = environment.DELEGATE_WAVE_HERMES_CONTROL_TOKEN;
  if (!token) throw new Error("DELEGATE_WAVE_HERMES_CONTROL_TOKEN is required");
  if (environment.DELEGATE_WAVE_CONTROL_TOKEN && token === environment.DELEGATE_WAVE_CONTROL_TOKEN) {
    throw new Error("Hermes credential must not equal operator credential");
  }
  delete environment.DELEGATE_WAVE_CONTROL_TOKEN;
  return new ControlClient({
    baseUrl: environment.DELEGATE_WAVE_CONTROL_URL,
    token,
  });
}

export function runMcpStdio({
  input = process.stdin,
  output = process.stdout,
  client = hermesControlClient(),
} = {}) {
  const adapter = new HermesMcpAdapter({ client });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  lines.on("line", async (line) => {
    let request;
    try { request = JSON.parse(line); } catch {
      send(output, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    if (request.id === undefined) return;
    try {
      let result;
      if (request.method === "initialize") {
        result = {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "delegate-wave", version: "0.1.0" },
        };
      } else if (request.method === "ping") result = {};
      else if (request.method === "tools/list") result = { tools: adapter.listTools() };
      else if (request.method === "tools/call") {
        const value = await adapter.callTool(request.params?.name, request.params?.arguments || {});
        const text = request.params?.name === "get_overview"
          ? `${value.totals.projects} projects; jobs needing attention: ${value.totals.jobs_needing_attention}; `
            + `jobs awaiting integration: ${value.totals.jobs_ready_for_integration}; `
            + `proposals awaiting decision: ${value.totals.proposals_awaiting_decision ?? 0}.`
          : JSON.stringify(value);
        result = {
          content: [{ type: "text", text }],
          structuredContent: { result: value },
          isError: false,
        };
      } else throw Object.assign(new Error(`Method not found: ${request.method}`), { rpcCode: -32601 });
      send(output, { jsonrpc: "2.0", id: request.id, result });
    } catch (error) {
      if (request.method === "tools/call" && !error.rpcCode) {
        send(output, {
          jsonrpc: "2.0", id: request.id,
          result: { content: [{ type: "text", text: error.message }], isError: true },
        });
      } else {
        send(output, { jsonrpc: "2.0", id: request.id, error: { code: error.rpcCode || -32602, message: error.message } });
      }
    }
  });
  return lines;
}
