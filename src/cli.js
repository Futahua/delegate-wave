#!/usr/bin/env node
import { initializeDataRoot } from "./db.js";
import { dataRoot } from "./paths.js";
import { Dispatcher } from "./service.js";
import { OpenCodeBackend } from "./backend.js";

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

function values(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function required(options, name) {
  if (!options[name] || options[name] === true) throw new Error(`Missing --${name}`);
  return options[name];
}

function print(value) { console.log(JSON.stringify(value, null, 2)); }

function help() {
  console.log(`delegate-wave bootstrap CLI

Commands:
  init
  project add --name NAME --path REPO [--branch BRANCH] [--validate CMD]... [--protect PATH]...
  project list
  job create --project ID --goal TEXT [--mode read|write] [--max-attempts 2]
  job run --job ID [--model provider/model]
  job status --job ID
  job list [--project ID]
  doctor
  reconcile [--apply]

Environment:
  DELEGATE_WAVE_DATA_ROOT   managed data root (Windows default: D:\\AssistantSystem\\delegate-wave)
  DELEGATE_WAVE_OPENCODE_ATTACH   optional persistent OpenCode server URL
`);
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const root = dataRoot();
  if (positional[0] === "init") {
    print({ initialized: true, paths: initializeDataRoot(root) });
    return;
  }
  if (!positional[0] || options.help) { help(); return; }
  initializeDataRoot(root);
  const dispatcher = new Dispatcher({
    root,
    backend: new OpenCodeBackend({ attach: process.env.DELEGATE_WAVE_OPENCODE_ATTACH }),
  });
  try {
    const [resource, action] = positional;
    if (resource === "doctor") {
      print(dispatcher.doctor());
    } else if (resource === "reconcile") {
      print(await dispatcher.reconcile({ apply: options.apply === true }));
    } else if (resource === "project" && action === "add") {
      print(await dispatcher.addProject({
        name: required(options, "name"),
        repoPath: required(options, "path"),
        branch: options.branch || "HEAD",
        validation: values(options.validate),
        protectedPaths: values(options.protect),
      }));
    } else if (resource === "project" && action === "list") {
      print(dispatcher.listProjects());
    } else if (resource === "job" && action === "create") {
      print(await dispatcher.createJob({
        projectId: required(options, "project"),
        goal: required(options, "goal"),
        mode: options.mode || "write",
        maxAttempts: Number(options["max-attempts"] || 2),
      }));
    } else if (resource === "job" && action === "run") {
      print(await dispatcher.runJob(required(options, "job"), { model: options.model || null }));
    } else if (resource === "job" && action === "status") {
      print(dispatcher.status(required(options, "job")));
    } else if (resource === "job" && action === "list") {
      print(dispatcher.listJobs(options.project || null));
    } else {
      throw new Error(`Unknown command: ${positional.join(" ")}`);
    }
  } finally {
    dispatcher.close();
  }
}

main().catch((error) => {
  console.error(`delegate-wave: ${error.message}`);
  process.exitCode = 1;
});
