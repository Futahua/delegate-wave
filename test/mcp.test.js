import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { HermesMcpAdapter, runMcpStdio } from "../src/mcp/server.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("Hermes adapter exposes only bounded read tools", async () => {
  const paths = [];
  const client = { get: async (path) => { paths.push(path); return path === "/v1/projects" ? [{ id: "p1" }] : [{ id: "j1" }]; } };
  const adapter = new HermesMcpAdapter({ client });
  assert.deepEqual(adapter.listTools().map((tool) => tool.name), [
    "list_projects", "get_project_summary", "get_job", "get_attention_needed", "get_integration",
  ]);
  assert.equal(adapter.listTools().some((tool) => /create|run|approve|grant|reconcile/.test(tool.name)), false);
  assert.deepEqual(await adapter.callTool("get_project_summary", { project_id: "p1" }), {
    project: { id: "p1" }, jobs: [{ id: "j1" }],
  });
  assert.deepEqual(paths, ["/v1/projects", "/v1/jobs?projectId=p1"]);
});

test("stdio MCP lifecycle and tool calls use newline-delimited JSON-RPC", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => { text += chunk.toString(); });
  const client = { get: async () => [{ id: "project-one" }] };
  const lines = runMcpStdio({ input, output, client });
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_projects", arguments: {} } })}\n`);
  for (let index = 0; index < 100 && text.trim().split("\n").length < 3; index += 1) await delay(10);
  input.end();
  lines.close();
  const responses = text.trim().split("\n").map(JSON.parse);
  assert.equal(responses.length, 3);
  assert.equal(responses[0].result.protocolVersion, "2025-06-18");
  assert.equal(responses[0].result.capabilities.tools.listChanged, false);
  assert.equal(responses[1].result.tools.length, 5);
  assert.deepEqual(responses[2].result.structuredContent, { result: [{ id: "project-one" }] });
});
