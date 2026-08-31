import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";

// The reserved _meta key the MCP client stamps the calling conversation into.
const CALLER_META_KEY = "io.delegate-wave/hermes-session-id";
import { hermesControlClient, HermesMcpAdapter, runMcpStdio } from "../src/mcp/server.js";
import { MANAGER_SYSTEM_INSTRUCTIONS } from "../src/manager/backend.js";

test("Hermes contracts reject control-plane work and route terminal intent through session_fail", async () => {
  const calls = [];
  const adapter = new HermesMcpAdapter({ client: { post: async (...args) => { calls.push(args); return { state: "FAILED" }; } } });
  const tools = adapter.listTools();
  const start = tools.find((tool) => tool.name === "session_start");
  assert.match(start.description, /inside the selected registered repository/);
  assert.match(start.description, /Never.*external\/control-plane/);
  assert.match(MANAGER_SYSTEM_INSTRUCTIONS, /ESCALATE before\s+commissioning any worker/);
  assert.match(MANAGER_SYSTEM_INSTRUCTIONS, /Shell access is not an OS sandbox/);
  assert.match(tools.find((tool) => tool.name === "session_answer").description, /Clarification only.*session_fail/);
  assert.match(tools.find((tool) => tool.name === "session_answer").description, /branch and base are immutable/);
  assert.ok(start.inputSchema.properties.branch);
  assert.ok(start.inputSchema.properties.expected_base_sha);
  const fail = tools.find((tool) => tool.name === "session_fail");
  assert.equal(fail.inputSchema.properties.reason.maxLength, 2000);
  assert.equal(fail.inputSchema.additionalProperties, false);
  assert.deepEqual(await adapter.callTool("session_fail", { session_id: "s/1", reason: "prerequisites impossible" },
    { [CALLER_META_KEY]: "owner" }), { state: "FAILED" });
  assert.equal(calls[0][0], "/v1/sessions/s%2F1/fail");
  assert.deepEqual(calls[0][1], { reason: "prerequisites impossible", hermesSessionId: "owner" });
});

test("session_start carries structured branch and expected base through MCP", async () => {
  const calls = [];
  const adapter = new HermesMcpAdapter({ client: { post: async (...args) => { calls.push(args); return {}; } } });
  await adapter.callTool("session_start", {
    project_id: "p", intent: "change feature", mode: "MANUAL",
    branch: "codex/live-work-ui", expected_base_sha: "a".repeat(40),
  }, { [CALLER_META_KEY]: "owner" });
  assert.deepEqual(calls[0][1], {
    projectId: "p", intent: "change feature", mode: "MANUAL", maximumCost: null,
    branch: "codex/live-work-ui", expectedBaseSha: "a".repeat(40), hermesSessionId: "owner",
  });
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("Hermes adapter exposes only bounded read tools", async () => {
  const paths = [];
  const jobs = Array.from({ length: 23 }, (_, index) => ({ id: `j${index + 1}` }));
  const client = { get: async (path) => { paths.push(path); return path === "/v1/projects" ? [{ id: "p1" }] : jobs; } };
  const adapter = new HermesMcpAdapter({ client });
  assert.deepEqual(adapter.listTools().map((tool) => tool.name), [
    "get_status",
    "get_overview", "list_projects", "get_project_summary", "get_job", "get_attention_needed", "get_integration",
    "propose_work", "session_start", "session_poll", "session_answer", "session_fail",
    "list_work_proposals", "get_work_proposal",
  ]);
  // Hermes may propose bounded work, but exposes no tool that approves, runs, integrates, or
  // reconciles. propose_work creates a request that a human must authorize before anything runs.
  assert.equal(adapter.listTools().some((tool) => /approve|authorize|grant|run|integrate|reconcile/.test(tool.name)), false);
  assert.match(
    adapter.listTools().find((tool) => tool.name === "propose_work").description,
    /does NOT start work/,
  );
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
  assert.equal(responses[1].result.tools.length, 14);
  assert.deepEqual(responses[2].result.structuredContent, { result: [{ id: "project-one" }] });
  assert.equal(
    responses[3].result.content[0].text,
    "3 projects; jobs needing attention: 2; jobs awaiting integration: 1; proposals awaiting decision: 0.",
  );
  assert.doesNotMatch(responses[3].result.content[0].text, /structured-only-marker/);
  assert.deepEqual(responses[3].result.structuredContent, { result: overview });
});

test("the Hermes MCP adapter cannot reach any operator-scoped route", async () => {
  const attempted = [];
  const client = {
    get: async (p) => { attempted.push(`GET ${p}`); return p === "/v1/projects" ? [{ id: "p" }] : []; },
    post: async (p) => { attempted.push(`POST ${p}`); return {}; },
  };
  const adapter = new HermesMcpAdapter({ client });
  for (const tool of adapter.listTools()) {
    const args = {
      project_id: "p", job_id: "j", proposal_id: "x", goal: "g", idempotency_key: "k",
      intent: "do the thing", session_id: "s", answer: "yes", reason: "prerequisites impossible",
    };
    // Every call carries the caller identity the client stamps in production.
    // session_start now refuses without one rather than starting work nobody is
    // watching, so a sweep over every tool has to supply it.
    await adapter.callTool(tool.name, args, { [CALLER_META_KEY]: "session_probe" });
  }
  // Two mutations, and both are bounded. A work proposal decides nothing on its own, and a session
  // acts only inside the envelope the user granted it -- neither can approve an arbitrary proposal,
  // run an arbitrary job, reconcile, or change policy.
  const posts = attempted.filter((call) => call.startsWith("POST "));
  assert.deepEqual(posts.sort(), [
    "POST /v1/sessions", "POST /v1/sessions/s/answer", "POST /v1/sessions/s/fail", "POST /v1/work/proposals",
  ]);
  // The operator-scoped surface stays unreachable, which is the property this test exists for.
  assert.equal(attempted.some((call) => /approvals|\/run|reconcile|\/authorize|\/reject/.test(call)), false);
  assert.equal(attempted.some((call) => /\/approve|\/decline|\/integration|\/backups/.test(call)), false);
});

test("every mutation the adapter performs carries a request id", async () => {
  // The Control API refuses a mutation without one. session_start shipped without it and passed the
  // whole suite, because nothing asserted the third argument -- the failure only appeared against a
  // live server, from inside Hermes, after the credential work was already done.
  const posts = [];
  const client = {
    get: async (p) => (p === "/v1/projects" ? [{ id: "p" }] : []),
    post: async (p, body, requestId) => { posts.push({ path: p, requestId }); return {}; },
  };
  const adapter = new HermesMcpAdapter({ client });
  for (const tool of adapter.listTools()) {
    await adapter.callTool(tool.name, {
      project_id: "p", job_id: "j", proposal_id: "x", goal: "g", idempotency_key: "k",
      intent: "do the thing", session_id: "s", answer: "yes", reason: "prerequisites impossible",
    }, { [CALLER_META_KEY]: "session_probe" });
  }
  assert.ok(posts.length >= 3, "the mutating tools were exercised");
  for (const post of posts) {
    assert.equal(typeof post.requestId, "string",
      `${post.path} was posted without a request id and would be refused`);
    assert.ok(post.requestId.length > 8, `${post.path} sent an implausible request id`);
  }
  // Distinct per call: a reused id would read as a retry of a different operation.
  assert.equal(new Set(posts.map((p) => p.requestId)).size, posts.length);
});
