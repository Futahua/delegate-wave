#!/usr/bin/env node
import crypto from "node:crypto";
import { ControlClient } from "./control/client.js";

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) { positional.push(item); continue; }
    const key = item.slice(2);
    const next = argv[index + 1];
    const value = next && !next.startsWith("--") ? argv[++index] : true;
    if (options[key] === undefined) options[key] = value;
    else options[key] = Array.isArray(options[key]) ? [...options[key], value] : [options[key], value];
  }
  return { positional, options };
}

function values(value) { return value === undefined ? [] : (Array.isArray(value) ? value : [value]); }
function required(options, name) {
  if (!options[name] || options[name] === true) throw new Error(`Missing --${name}`);
  return options[name];
}
let activeRequestId = null;
function requestId(options) {
  activeRequestId = options["request-id"] || `req_${crypto.randomUUID()}`;
  console.error(`request_id: ${activeRequestId}`);
  return activeRequestId;
}
function print(value) { console.log(JSON.stringify(value, null, 2)); }

function help() {
  console.log(`delegate-wave Control API CLI

Commands:
  serve
  init
  project add --name NAME --path REPO [--branch BRANCH] [--validate CMD]... [--protect PATH]...
  project list
  job create --project ID --goal TEXT [--mode read|write] [--max-attempts 2]
  job run --job ID [--model provider/model]
  job status --job ID
  job list [--project ID]
  integration propose --job ID
  integration run --proposal ID
  integration show --proposal ID
  approval grant --proposal ID [--expires-at ISO] [--maximum-cost AMOUNT] [--idempotency-key KEY]
  approval list [--proposal ID]
  attention
  doctor
  reconcile [--apply]

Mutations accept --request-id ID for safe retries. The server binds approval identity.

Environment:
  DELEGATE_WAVE_CONTROL_TOKEN       required shared local token
  DELEGATE_WAVE_CONTROL_URL         default http://127.0.0.1:47321
  DELEGATE_WAVE_CONTROL_PRINCIPAL   server-side principal (serve only)
  DELEGATE_WAVE_DATA_ROOT           managed data root (serve only)
`);
}

async function serve() {
  const { startControlServer } = await import("./control/server.js");
  const running = await startControlServer();
  print({ serving: true, url: running.url });
  const stop = async () => { await running.close(); process.exit(0); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  if (!positional[0] || options.help) { help(); return; }
  if (positional[0] === "serve") { await serve(); return; }
  const client = new ControlClient();
  const [resource, action] = positional;
  if (resource === "init" || resource === "doctor") {
    print(await client.get("/v1/health"));
  } else if (resource === "attention") {
    print(await client.get("/v1/attention"));
  } else if (resource === "reconcile") {
    print(await client.post("/v1/reconcile", { apply: options.apply === true }, requestId(options)));
  } else if (resource === "project" && action === "add") {
    print(await client.post("/v1/projects", {
      name: required(options, "name"), repoPath: required(options, "path"), branch: options.branch || "HEAD",
      validation: values(options.validate), protectedPaths: values(options.protect),
    }, requestId(options)));
  } else if (resource === "project" && action === "list") {
    print(await client.get("/v1/projects"));
  } else if (resource === "job" && action === "create") {
    print(await client.post("/v1/jobs", {
      projectId: required(options, "project"), goal: required(options, "goal"), mode: options.mode || "write",
      maxAttempts: Number(options["max-attempts"] || 2),
    }, requestId(options)));
  } else if (resource === "job" && action === "run") {
    const jobId = required(options, "job");
    print(await client.post(`/v1/jobs/${encodeURIComponent(jobId)}/run`, { model: options.model || null }, requestId(options)));
  } else if (resource === "job" && action === "status") {
    print(await client.get(`/v1/jobs/${encodeURIComponent(required(options, "job"))}`));
  } else if (resource === "job" && action === "list") {
    const query = options.project ? `?projectId=${encodeURIComponent(options.project)}` : "";
    print(await client.get(`/v1/jobs${query}`));
  } else if (resource === "integration" && action === "propose") {
    print(await client.post("/v1/integration/proposals", { jobId: required(options, "job") }, requestId(options)));
  } else if (resource === "integration" && action === "run") {
    const proposalId = required(options, "proposal");
    print(await client.post(`/v1/integration/${encodeURIComponent(proposalId)}/run`, {}, requestId(options)));
  } else if (resource === "integration" && action === "show") {
    print(await client.get(`/v1/proposals/${encodeURIComponent(required(options, "proposal"))}`));
  } else if (resource === "approval" && action === "grant") {
    if (options.principal || options.origin) throw new Error("Approval identity is bound by the server; --principal/--origin are forbidden");
    print(await client.post("/v1/approvals", {
      proposalId: required(options, "proposal"), expiresAt: options["expires-at"] || null,
      maximumCost: options["maximum-cost"] === undefined ? null : Number(options["maximum-cost"]),
      idempotencyKey: options["idempotency-key"] || null,
    }, requestId(options)));
  } else if (resource === "approval" && action === "list") {
    const query = options.proposal ? `?proposalId=${encodeURIComponent(options.proposal)}` : "";
    print(await client.get(`/v1/approvals${query}`));
  } else {
    throw new Error(`Unknown command: ${positional.join(" ")}`);
  }
}

main().catch((error) => {
  console.error(`delegate-wave: ${error.code ? `${error.code}: ` : ""}${error.message}`);
  if (activeRequestId && ["CONTROL_API_UNAVAILABLE", "INVALID_CONTROL_RESPONSE", "REQUEST_UNCERTAIN"].includes(error.code)) {
    console.error(`Request outcome may be uncertain. Retry the exact command with: --request-id ${activeRequestId}`);
  }
  process.exitCode = 1;
});
