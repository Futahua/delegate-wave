#!/usr/bin/env node
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { ControlClient } from "../control/client.js";

const TOOLS = Object.freeze([
  {
    name: "get_status",
    description:
      "The everyday answer to 'what is happening': what is working, what needs your decision, what "
      + "is ready to check, what finished, and what was integrated and then rolled back, with cost. "
      + "Start here.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
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
    if (name === "get_status") return this.client.get("/v1/briefing");
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

// One or two sentences a person can act on. Deliberately not a dump of the payload: if the answer
// needs scrolling, it has failed at being a status.
export function summarizeStatus(status) {
  const parts = [];
  if (status.working.length) {
    parts.push(`Working: ${status.working.length} job${status.working.length === 1 ? "" : "s"}`);
  }
  // The two decisions are the only moments a person is actually needed, so they are asked as
  // questions rather than announced as queue depth. Identifiers, digests, branches and executor
  // names are deliberately absent: they are available from the detailed tools, and putting them
  // here turns a decision into an administrative form.
  if (status.needs_your_decision.length) {
    const first = status.needs_your_decision[0];
    const rest = status.needs_your_decision.length - 1;
    const also = rest > 0 ? ` (${rest} more waiting)` : "";
    const goal = String(first.goal ?? "").replace(/[.!?\s]+$/, "");

    if (first.validation !== undefined) {
      // A finished candidate: say what the checks found, how much it touched, and what it cost.
      const checks = first.validation === "passed" ? "Validation passed" : `Validation ${first.validation}`;
      const files = typeof first.files_changed === "number"
        ? `, ${first.files_changed} file${first.files_changed === 1 ? "" : "s"} changed` : "";
      const spent = first.cost?.reference_cost_usd;
      const money = typeof spent === "number" && spent > 0
        ? `, about $${spent.toFixed(4)}${first.cost.complete === false ? " so far" : ""}` : "";
      parts.push(`"${goal}" is ready: ${checks}${files}${money}. Integrate it?${also}`);
    } else {
      // Proposed work that has not run yet: the cost is a ceiling, not a bill.
      const ceiling = typeof first.ceiling_usd === "number"
        ? ` under $${first.ceiling_usd.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}` : "";
      parts.push(`I can do "${goal}" with a cheap worker${ceiling}. Approve?${also}`);
    }
  }
  // One thing, said properly, rather than a recital. A person handles the newest problem first, and
  // a count of the rest is enough to know more is waiting -- reading eight failures aloud is how a
  // status answer becomes something to skim past.
  if (status.ready_to_check.length) {
    const first = status.ready_to_check[0];
    const rest = status.ready_to_check.length - 1;
    const said = first.says ?? `${first.goal} needs attention`;
    const because = first.because ? ` ${first.because}` : "";
    const older = rest > 0
      ? ` And ${rest} older item${rest === 1 ? " needs" : "s need"} attention.` : "";
    parts.push(`${said}${because}${older}`);
  }
  if (status.done.length) {
    const spent = status.done.reduce((total, job) => total + (job.cost.reference_cost_usd ?? 0), 0);
    const partial = status.done.some((job) => !job.cost.complete);
    parts.push(`Done recently: ${status.done.length}, about $${spent.toFixed(4)}${partial ? " (some cost unmeasured)" : ""}`);
  }
  // Named explicitly rather than folded into a count. Someone who watched this work succeed needs
  // to be told its change is no longer present -- and told what the branch went back to, so the
  // statement can be checked rather than taken on trust.
  if (status.reverted?.length) {
    const first = status.reverted[0];
    const rest = status.reverted.length - 1;
    // The goal is a sentence of its own and usually ends in a period; embedded mid-sentence that
    // reads as "...taken-back. was rolled back". Trailing punctuation is dropped so the line is one
    // sentence rather than two collided together.
    const goal = String(first.goal).replace(/[.!?\s]+$/, "");
    parts.push(
      `Reverted: "${goal}" was rolled back to ${first.restored_to.slice(0, 7)}; it had succeeded, `
      + `but its change is no longer present${rest > 0 ? `, and ${rest} more` : ""}`,
    );
  }
  if (!parts.length) parts.push("Nothing running, nothing waiting on you");
  if (!status.healthy) parts.push("delegate-wave reports a health problem; run doctor");
  // A part that already ends in punctuation keeps it. The decisions are questions, and "Approve?."
  // is the kind of small wrongness that makes a sentence read as generated rather than written.
  return parts.map((part) => (/[.!?]$/.test(part) ? part : `${part}.`)).join(" ");
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
        // The text form is what a person reads. It answers the question rather than restating the
        // payload, and never carries a transcript.
        let text;
        if (request.params?.name === "get_status") {
          text = summarizeStatus(value);
        } else if (request.params?.name === "get_overview") {
          text = `${value.totals.projects} projects; jobs needing attention: ${value.totals.jobs_needing_attention}; `
            + `jobs awaiting integration: ${value.totals.jobs_ready_for_integration}; `
            + `proposals awaiting decision: ${value.totals.proposals_awaiting_decision ?? 0}.`;
        } else {
          text = JSON.stringify(value);
        }
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
