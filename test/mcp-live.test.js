// Exercises the real `delegate-wave mcp` launcher against a live Control API, so the credential the
// production process actually loads is the one under test -- not a client constructed by the test.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { initializeDataRoot } from "../src/db.js";
import { FakeBackend } from "../src/backend.js";
import { Dispatcher } from "../src/service.js";
import { ControlService } from "../src/control/service.js";
import { createControlServer } from "../src/control/server.js";
import { runProcess } from "../src/process.js";

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));

async function mcpCall(environment, calls) {
  const child = spawn(process.execPath, [cliPath, "mcp"], {
    env: { ...process.env, ...environment }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`);
  calls.forEach((call, index) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: index + 2, method: "tools/call", params: call })}\n`);
  });
  child.stdin.end();
  await new Promise((resolve) => child.on("close", resolve));
  return stdout.trim().split("\n").filter(Boolean).map(JSON.parse);
}

test("the real MCP process proposes with the proposer credential and still cannot operate", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-mcp-live-"));
  const root = path.join(temp, "data");
  const repo = path.join(temp, "repo");
  fs.mkdirSync(repo);
  for (const args of [["init", "-b", "main"], ["config", "user.name", "T"], ["config", "user.email", "t@e.invalid"]]) {
    await runProcess("git", ["-C", repo, ...args]);
  }
  fs.writeFileSync(path.join(repo, "f.txt"), "x\n");
  await runProcess("git", ["-C", repo, "add", "."]);
  await runProcess("git", ["-C", repo, "commit", "-m", "initial"]);
  await runProcess("git", ["-C", repo, "branch", "integration"]);
  initializeDataRoot(root);

  const dispatcher = new Dispatcher({ root, backend: new FakeBackend(async () => ({ exitCode: 0, stdout: "", stderr: "" })) });
  const project = await dispatcher.addProject({ name: "Live", repoPath: repo, branch: "integration", validation: [] });
  const token = `operator-${crypto.randomUUID()}`;
  const proposerToken = `proposer-${crypto.randomUUID()}`;
  const server = createControlServer({
    service: new ControlService({ dispatcher }), token, principalId: "john",
    observerToken: `observer-${crypto.randomUUID()}`, proposerToken,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
    dispatcher.close();
    fs.rmSync(temp, { recursive: true, force: true });
  });

  const responses = await mcpCall(
    { DELEGATE_WAVE_CONTROL_URL: url, DELEGATE_WAVE_HERMES_CONTROL_TOKEN: proposerToken },
    [
      { name: "propose_work", arguments: { project_id: project.id, goal: "live proposal", idempotency_key: "live-1" } },
      { name: "get_overview", arguments: {} },
    ],
  );

  const proposed = responses.find((message) => message.id === 2);
  assert.equal(proposed.result.isError, false, JSON.stringify(proposed.result));
  assert.equal(responses.find((message) => message.id === 3).result.isError, false);

  // The proposal is real and durable, and it created no job.
  const proposals = dispatcher.listWorkProposals();
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].origin_principal, "hermes-proposer");
  assert.equal(proposals[0].state, "PENDING");
  assert.deepEqual(dispatcher.listJobs(), []);

  // The same credential cannot authorize, approve, run, or reconcile.
  for (const [method, route, body] of [
    ["POST", `/v1/work/proposals/${proposals[0].id}/authorize`, {}],
    ["POST", "/v1/approvals", { proposalId: "x" }],
    ["POST", "/v1/reconcile", {}],
    ["POST", "/v1/jobs", { projectId: project.id, goal: "no" }],
  ]) {
    const response = await fetch(`${url}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${proposerToken}`,
        "content-type": "application/json",
        "x-request-id": `req_${crypto.randomUUID()}`,
      },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 403, `${route} must refuse the proposer credential`);
    assert.equal((await response.json()).error.code, "INSUFFICIENT_SCOPE");
  }
});
