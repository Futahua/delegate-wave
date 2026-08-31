#!/usr/bin/env node
import crypto from "node:crypto";
import path from "node:path";
import { ControlClient } from "./control/client.js";
import { parseProjectAddArgs } from "./cli/project-add.js";

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

// Proposal commands name their target with --proposal, matching `integration` and `approval`.
// --id is still accepted so existing invocations and scripts keep working.
function proposalOption(options) {
  const value = options.proposal || options.id;
  if (!value || value === true) throw new Error("Missing --proposal");
  return value;
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
  supervisor install          install least-privilege Windows logon task
  supervisor status
  supervisor start
  supervisor stop
  supervisor uninstall        stop the supervised API, then remove the task (keeps credentials)
  supervisor migrate-secrets  upgrade a legacy combined credential bundle to scoped records
  supervisor add-role --role proposer   seal one new credential role into the existing store
  job cancel --job ID [--reason TEXT] stop a running job; records durable intent and outcome
  job advance --job ID                run, validate, and propose integration in one step
  integration approve --proposal ID   approve this exact candidate and integrate it
  integration decline --proposal ID   decide not to integrate it; keeps every record
  project retire --project ID         stop tracking a project, keeping its history
  project restore --project ID        track it again
  backup create [--label TEXT]        snapshot the operational database with a checksummed manifest
  backup list
  backup restore --backup DIR         restore the database and every repository head together
  backup restore --backup DIR --database-only   restore operational truth alone, explicitly
  restore resolve                     clear an unresolved restore once repositories are reconciled
  integration rollback --proposal ID  move an integration branch back, compare-and-swap
  proposal list [--project ID]        list Hermes work proposals awaiting a decision
  proposal show --proposal ID
  proposal authorize --proposal ID    authorize one proposal into a job (operator only)
  proposal reject --proposal ID
  mcp                         read-only Hermes MCP server over stdio
  init
  project add --name NAME --path REPO [--branch BRANCH] [--validate CMD]... [--protect PATH]...
              quote each whole command: --validate "npm test" --validate "npm run build"
  project list
  job create --project ID --goal TEXT [--mode read|write] [--max-attempts 2]
                              [--capability-profile restricted] narrow the worker for this job
  job run --job ID [--model provider/model]
  job status --job ID
  job list [--project ID]
  integration propose --job ID
  integration run --proposal ID
  integration show --proposal ID
  approval grant --proposal ID [--expires-at ISO] [--maximum-cost AMOUNT] [--idempotency-key KEY]
  approval list [--proposal ID]
  status                              what is working, needs a decision, is ready, or finished
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
  print({ serving: true, url: running.url, executor: running.executor });
  const stop = async () => { await running.close(); process.exit(0); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

async function main() {
  let { positional, options } = parseArgs(process.argv.slice(2));
  if (!positional[0] || options.help) { help(); return; }
  if (positional[0] === "project" && positional[1] === "add") {
    options = parseProjectAddArgs(process.argv.slice(2));
  }
  if (positional[0] === "serve") { await serve(); return; }

  // Drives a managed job with the real Codex manager.
  //
  // Deliberately a separate command rather than a Control API route. Advancing a
  // managed job spends scarce quota and can run cheap workers, and the Control
  // API is what the Papers relay reaches -- putting this behind a route would
  // hand that authority to a surface that is meant to observe and decide, not to
  // Shared with the served runtime so a provider is resolved identically in both.
  const { resolveManagerProvider } = await import("./manager/provider.js");

  // commission strong-model work.
  if (positional[0] === "manage") {
    const jobId = positional[1];
    if (!jobId) throw new Error("usage: delegate-wave manage <jobId> [--model <id>] [--effort <level>]");
    const [{ Dispatcher }, { ManagerService }, { CodexManagerBackend }, { dataRoot }] = await Promise.all([
      import("./service.js"), import("./manager/service.js"),
      import("./manager/backend.js"), import("./paths.js"),
    ]);
    const { BackendRouter } = await import("./harness/select.js");
    const { initializeDataRoot } = await import("./db.js");
    const root = dataRoot();
    initializeDataRoot(root);
    // Same construction the served runtime uses: the router decides per attempt
    // from the resolved model, never inside one.
    const router = new BackendRouter({
      apiKey: process.env.DELEGATE_WAVE_EXECUTOR_API_KEY || null,
      prefer: process.env.DELEGATE_WAVE_BACKEND || "harness",
    });
    const dispatcher = new Dispatcher({ root, backend: null, router });
    // A NEUTRAL working directory. The manager reasons from evidence packs
    // delegate-wave assembles, never by exploring the repository itself -- that
    // is what the cheap investigations are for, and pointing the most expensive
    // model at a codebase is the substitution this design exists to prevent.
    const workingDirectory = path.join(root, "tmp", "manager");
    // A provider-prefixed model selects an OpenAI-compatible route; a bare one uses the Codex plan.
    //
    // Both go through the SAME manager. Codex already knows how to talk to another provider --
    // model_providers is its own configuration surface -- so a second supplier is configuration,
    // not a second code path to keep in step.
    const [providerId, providerModel] = String(options.model ?? "").includes("/")
      ? options.model.split("/", 2)
      : [null, options.model ?? null];
    const manager = new CodexManagerBackend({
      model: providerModel,
      effort: options.effort ?? "high",
      workingDirectory,
      ...(providerId ? { provider: await resolveManagerProvider(providerId) } : {}),
    });
    const service = new ManagerService({ dispatcher, backend: manager, workerModel: options.workerModel ?? null });
    try {
      print(await service.advance(jobId));
    } finally {
      await manager.close();
      dispatcher.close();
    }
    return;
  }
  if (positional[0] === "supervisor") {
    const { WindowsSupervisor } = await import("./supervisor.js");
    const supervisor = new WindowsSupervisor();
    const action = positional[1];
    if (action === "run") {
      // The supervised runtime is entitled to every role, so it is a safe place to complete a
      // pending legacy-store upgrade rather than fail the logon task on a stale format.
      await supervisor.migrateSecrets();
      // Named by the task definition, not inherited from an environment snapshot.
      //
      // Task Scheduler captures its environment block when the service starts, so a User variable
      // set afterwards never reaches a task-launched process -- proven the hard way: a runtime kept
      // routing work to the wrong executor while the variable said otherwise. An explicit flag on
      // the action is a fact about the task rather than a fact about whoever's shell created it.
      if (options.backend) process.env.DELEGATE_WAVE_BACKEND = options.backend;

      // A second supervised runtime would drive the same autonomous sessions as the first.
      const running = supervisor.runtimeAlreadyRunning();
      if (running) {
        print({ ok: true, already_running: running, note: "a supervised Control API is already live; not starting a second" });
        return;
      }
      Object.assign(process.env, await supervisor.runtimeEnvironment());
      supervisor.recordRuntimePid();
      await serve();
      return;
    }
    if (action === "migrate-secrets") {
      print(await supervisor.migrateSecrets());
      return;
    }
    if (action === "add-role") {
      print(await supervisor.addSecretRole(required(options, "role")));
      return;
    }
    if (!["install", "status", "start", "stop", "uninstall"].includes(action)) {
      throw new Error(
        "Unknown supervisor command; use install, status, start, stop, uninstall, migrate-secrets, or add-role",
      );
    }
    // install carries the executor into the task definition; the others take no options.
    print(await supervisor[action](
      action === "install" && options.backend ? { workerBackend: options.backend } : undefined,
    ));
    return;
  }
  if (positional[0] === "mcp") {
    if (process.platform === "win32"
      && !process.env.DELEGATE_WAVE_HERMES_CONTROL_TOKEN
      && !process.env.DELEGATE_WAVE_CONTROL_TOKEN) {
      const { DpapiSecretStore } = await import("./supervisor.js");
      const store = new DpapiSecretStore();
      // Cutover by record presence: once a proposal credential is deliberately provisioned, Hermes
      // gains read + propose. Until then it stays read-only. Exactly one record is ever decrypted,
      // and the operator record is never among them.
      if (store.hasRecord("proposer")) {
        const proposer = await store.load("proposer");
        process.env.DELEGATE_WAVE_HERMES_CONTROL_TOKEN = proposer.DELEGATE_WAVE_CONTROL_PROPOSER_TOKEN;
      } else {
        const observer = await store.load("observer");
        process.env.DELEGATE_WAVE_HERMES_CONTROL_TOKEN = observer.DELEGATE_WAVE_CONTROL_OBSERVER_TOKEN;
      }
    }
    const { runMcpStdio } = await import("./mcp/server.js");
    runMcpStdio();
    return;
  }
  if (process.platform === "win32" && !process.env.DELEGATE_WAVE_CONTROL_TOKEN) {
    const { DpapiSecretStore } = await import("./supervisor.js");
    const operator = await new DpapiSecretStore().load("operator");
    process.env.DELEGATE_WAVE_CONTROL_TOKEN = operator.DELEGATE_WAVE_CONTROL_TOKEN;
  }
  const client = new ControlClient();
  const [resource, action] = positional;
  if (resource === "init" || resource === "doctor") {
    print(await client.get("/v1/health"));
  } else if (resource === "status") {
    print(await client.get("/v1/briefing"));
  } else if (resource === "attention") {
    print(await client.get("/v1/attention"));
  } else if (resource === "reconcile") {
    print(await client.post("/v1/reconcile", { apply: options.apply === true }, requestId(options)));
  } else if (resource === "job" && action === "cancel") {
    print(await client.post(
      `/v1/jobs/${encodeURIComponent(required(options, "job"))}/cancel`,
      { reason: options.reason || "" }, requestId(options),
    ));
  } else if (resource === "job" && action === "advance") {
    print(await client.post(
      `/v1/jobs/${encodeURIComponent(required(options, "job"))}/advance`,
      { model: options.model || null }, requestId(options),
    ));
  } else if (resource === "integration" && action === "approve") {
    print(await client.post(
      `/v1/proposals/${encodeURIComponent(required(options, "proposal"))}/approve`, {}, requestId(options),
    ));
  } else if (resource === "backup" && action === "create") {
    print(await client.post("/v1/backups", { label: options.label || "manual" }, requestId(options)));
  } else if (resource === "backup" && action === "restore") {
    print(await client.post("/v1/backups/restore", {
      backup: required(options, "backup"),
      restoreRepositories: options["database-only"] !== true,
    }, requestId(options)));
  } else if (resource === "integration" && action === "decline") {
    print(await client.post(`/v1/proposals/${encodeURIComponent(proposalOption(options))}/decline`,
      { reason: options.reason || "" }, requestId(options)));
  } else if (resource === "project" && action === "retire") {
    print(await client.post(`/v1/projects/${encodeURIComponent(required(options, "project"))}/retire`,
      {}, requestId(options)));
  } else if (resource === "project" && action === "restore") {
    print(await client.post(`/v1/projects/${encodeURIComponent(required(options, "project"))}/restore`,
      {}, requestId(options)));
  } else if (resource === "restore" && action === "resolve") {
    print(await client.post("/v1/restore/resolve", {}, requestId(options)));
  } else if (resource === "backup" && action === "list") {
    print(await client.get("/v1/backups"));
  } else if (resource === "integration" && action === "rollback") {
    print(await client.post(
      `/v1/proposals/${encodeURIComponent(required(options, "proposal"))}/rollback`, {}, requestId(options),
    ));
  } else if (resource === "proposal" && action === "list") {
    const query = options.project ? `?projectId=${encodeURIComponent(options.project)}` : "";
    print(await client.get(`/v1/work/proposals${query}`));
  } else if (resource === "proposal" && action === "show") {
    print(await client.get(`/v1/work/proposals/${encodeURIComponent(proposalOption(options))}`));
  } else if (resource === "proposal" && action === "authorize") {
    print(await client.post(
      `/v1/work/proposals/${encodeURIComponent(proposalOption(options))}/authorize`, {}, requestId(options),
    ));
  } else if (resource === "proposal" && action === "reject") {
    print(await client.post(
      `/v1/work/proposals/${encodeURIComponent(proposalOption(options))}/reject`, {}, requestId(options),
    ));
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
      // Omitted means the system default, which is broad. Naming one asks for a narrower worker.
      ...(options["capability-profile"] ? { capabilityProfile: options["capability-profile"] } : {}),
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
  if (error.code === "REQUEST_IN_PROGRESS") {
    // Not uncertain: the server is still running it. Retrying only asks the same question again.
    console.error("The request is still running. Check `delegate-wave status` rather than retrying.");
  } else if (activeRequestId && ["CONTROL_API_UNAVAILABLE", "INVALID_CONTROL_RESPONSE", "REQUEST_UNCERTAIN"].includes(error.code)) {
    console.error(`Request outcome may be uncertain. Retry the exact command with: --request-id ${activeRequestId}`);
  }
  process.exitCode = 1;
});
