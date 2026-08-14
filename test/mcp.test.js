import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { hermesControlClient, HermesMcpAdapter, runMcpStdio } from "../src/mcp/server.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("Hermes adapter exposes only bounded read tools", async () => {
  const paths = [];
  const jobs = Array.from({ length: 23 }, (_, index) => ({ id: `j${index + 1}` }));
  const client = { get: async (path) => { paths.push(path); return path === "/v1/projects" ? [{ id: "p1" }] : jobs; } };
  const adapter = new HermesMcpAdapter({ client });
  assert.deepEqual(adapter.listTools().map((tool) => tool.name), [
    "get_overview", "list_projects", "get_project_summary", "get_job", "get_attention_needed", "get_integration",
  ]);
  assert.equal(adapter.listTools().some((tool) => /create|run|approve|grant|reconcile/.test(tool.name)), false);
  assert.deepEqual(await adapter.callTool("get_project_summary", { project_id: "p1" }), {
    project: { id: "p1" }, recent_jobs: jobs.slice(0, 20), total_jobs: 23, truncated: true,
  });
  assert.deepEqual(paths, ["/v1/projects", "/v1/jobs?projectId=p1"]);
});

test("Hermes credential is explicit, distinct, and removes inherited operator authority", () => {
  assert.throws(() => hermesControlClient({ DELEGATE_WAVE_CONTROL_TOKEN: "OPERATOR" }), /HERMES_CONTROL_TOKEN is required/);
  assert.throws(() => hermesControlClient({
    DELEGATE_WAVE_CONTROL_TOKEN: "same", DELEGATE_WAVE_HERMES_CONTROL_TOKEN: "same",
  }), /must not equal operator/);
  const environment = {
    DELEGATE_WAVE_CONTROL_TOKEN: "OPERATOR",
    DELEGATE_WAVE_HERMES_CONTROL_TOKEN: "OBSERVER",
    DELEGATE_WAVE_CONTROL_URL: "http://127.0.0.1:1",
  };
  const client = hermesControlClient(environment);
  assert.equal(client.token, "OBSERVER");
  assert.equal("DELEGATE_WAVE_CONTROL_TOKEN" in environment, false);
});

test("MCP process cannot fall back to an inherited operator token", async (t) => {
  let authenticatedQueries = 0;
  const server = http.createServer((request, response) => {
    if (request.headers.authorization === "Bearer OPERATOR") authenticatedQueries += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true,"result":[]}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const environment = {
    ...process.env,
    DELEGATE_WAVE_CONTROL_TOKEN: "OPERATOR",
    DELEGATE_WAVE_CONTROL_URL: `http://127.0.0.1:${address.port}`,
  };
  delete environment.DELEGATE_WAVE_HERMES_CONTROL_TOKEN;
  const child = spawn(process.execPath, [fileURLToPath(new URL("../src/cli.js", import.meta.url)), "mcp"], {
    env: environment, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_projects", arguments: {} } })}\n`);
  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  assert.notEqual(exitCode, 0);
  assert.match(stderr, /DELEGATE_WAVE_HERMES_CONTROL_TOKEN is required/);
  assert.equal(stdout, "");
  assert.equal(authenticatedQueries, 0);
});

test("stdio MCP lifecycle and tool calls use newline-delimited JSON-RPC", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => { text += chunk.toString(); });
  const overview = {
    schema_version: 1,
    totals: { projects: 3, jobs_needing_attention: 2, jobs_ready_for_integration: 1 },
    attention: [{ summary: "structured-only-marker" }],
  };
  const client = { get: async (path) => path === "/v1/overview" ? overview : [{ id: "project-one" }] };
  const lines = runMcpStdio({ input, output, client });
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_projects", arguments: {} } })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_overview", arguments: {} } })}\n`);
  for (let index = 0; index < 100 && text.trim().split("\n").length < 4; index += 1) await delay(10);
  input.end();
  lines.close();
  const responses = text.trim().split("\n").map(JSON.parse);
  assert.equal(responses.length, 4);
  assert.equal(responses[0].result.protocolVersion, "2025-06-18");
  assert.equal(responses[0].result.capabilities.tools.listChanged, false);
  assert.equal(responses[1].result.tools.length, 6);
  assert.deepEqual(responses[2].result.structuredContent, { result: [{ id: "project-one" }] });
  assert.equal(responses[3].result.content[0].text, "3 projects; jobs needing attention: 2; jobs awaiting integration: 1.");
  assert.doesNotMatch(responses[3].result.content[0].text, /structured-only-marker/);
  assert.deepEqual(responses[3].result.structuredContent, { result: overview });
});
