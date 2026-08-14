import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { initializeDataRoot, openDatabase } from "../src/db.js";
import { FakeBackend } from "../src/backend.js";
import { managedPaths } from "../src/paths.js";
import { runProcess } from "../src/process.js";
import { ControlClient } from "../src/control/client.js";
import { ControlService } from "../src/control/service.js";
import { createControlServer, startControlServer } from "../src/control/server.js";
import { PRINCIPAL_SCOPES, ROUTES, SCOPES } from "../src/control/contract.js";

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const requestId = () => `req_${crypto.randomUUID()}`;

async function command(name, args, cwd) {
  const result = await runProcess(name, args, { cwd });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

function fakeDispatcher(root, overrides = {}) {
  initializeDataRoot(root);
  const db = openDatabase(managedPaths(root).database);
  return {
    db,
    doctor: () => ({ healthy: true }),
    overview: () => ({ schema_version: 1, totals: { projects: 0, jobs_needing_attention: 0, jobs_ready_for_integration: 0 } }),
    listProjects: () => [],
    listJobs: () => [],
    listApprovals: () => [],
    attention: () => ({ jobs: [], unresolved_integrations: [] }),
    ...overrides,
  };
}

async function fixture(t, overrides = {}, root = null) {
  const temp = root ? null : fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-control-"));
  const dataRoot = root || path.join(temp, "data");
  const dispatcher = fakeDispatcher(dataRoot, overrides);
  const token = `token-${crypto.randomUUID()}`;
  const observerToken = `observer-${crypto.randomUUID()}`;
  const proposerToken = `proposer-${crypto.randomUUID()}`;
  const service = new ControlService({ dispatcher, pendingWaitMs: 2000 });
  const server = createControlServer({
    service,
    token,
    principalId: "john",
    observerToken,
    proposerToken,
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const close = async () => {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
    dispatcher.db.close();
    if (temp) fs.rmSync(temp, { recursive: true, force: true });
  };
  if (t) t.after(close);
  return {
    root: dataRoot, dispatcher, service, server, token, observerToken, proposerToken, url,
    client: new ControlClient({ baseUrl: url, token }), close,
  };
}

test("duplicate and concurrent request IDs produce one durable side effect", async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    createJob: async (args) => { calls += 1; await delay(100); return { id: "job-one", ...args }; },
  });
  const requestId = `req_${crypto.randomUUID()}`;
  const body = { projectId: "p1", goal: "one", mode: "write", maxAttempts: 2 };
  const [first, second] = await Promise.all([
    f.client.post("/v1/jobs", body, requestId),
    f.client.post("/v1/jobs", body, requestId),
  ]);
  const third = await f.client.post("/v1/jobs", body, requestId);
  assert.deepEqual(first, second);
  assert.deepEqual(second, third);
  assert.equal(calls, 1);
  await assert.rejects(
    f.client.post("/v1/jobs", { ...body, goal: "different" }, requestId),
    (error) => error.code === "REQUEST_CONFLICT",
  );
  assert.equal(f.dispatcher.db.prepare("SELECT COUNT(*) AS count FROM control_request_intents").get().count, 1);
  assert.equal(f.dispatcher.db.prepare("SELECT COUNT(*) AS count FROM control_request_results").get().count, 1);
});

test("concurrent CLI processes with one request ID receive one job identity", async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    createJob: async () => { calls += 1; await delay(100); return { id: "job-from-two-clients" }; },
  });
  const request = requestId();
  const args = [cliPath, "job", "create", "--project", "p1", "--goal", "same", "--request-id", request];
  const options = {
    env: { DELEGATE_WAVE_CONTROL_URL: f.url, DELEGATE_WAVE_CONTROL_TOKEN: f.token },
    timeoutMs: 10_000,
  };
  const [one, two] = await Promise.all([
    runProcess(process.execPath, args, options),
    runProcess(process.execPath, args, options),
  ]);
  assert.equal(one.exitCode, 0, one.stderr);
  assert.equal(two.exitCode, 0, two.stderr);
  assert.deepEqual(JSON.parse(one.stdout), JSON.parse(two.stdout));
  assert.equal(calls, 1);
});

test("durable intent without a result fails closed instead of redispatching", async (t) => {
  let calls = 0;
  const f = await fixture(t, { createJob: () => { calls += 1; return { id: "must-not-run" }; } });
  const body = { projectId: "p1", goal: "uncertain", mode: "write", maxAttempts: 2 };
  const request = "uncertain-request";
  const canonical = (value) => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
    return JSON.stringify(value);
  };
  const argsDigest = crypto.createHash("sha256").update(canonical({ command: "job.create", args: body })).digest("hex");
  f.dispatcher.db.prepare(`INSERT INTO control_request_intents(
    request_id, command, args_digest, principal_id, origin_channel, created_at
  ) VALUES (?, ?, ?, 'john', 'local-cli', ?)`).run(request, "job.create", argsDigest, new Date().toISOString());
  await assert.rejects(
    f.client.post("/v1/jobs", body, request),
    (error) => error.code === "REQUEST_UNCERTAIN",
  );
  assert.equal(calls, 0);
});

test("successful mutation with failed success receipt remains uncertain and never redispatches", async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    createJob: () => {
      calls += 1;
      f.dispatcher.db.prepare("INSERT INTO metadata(key, value) VALUES ('receipt-test-effect', 'created')").run();
      return { id: "created-before-receipt-failure" };
    },
  });
  f.service.recordSucceededResult = () => { throw new Error("injected success receipt failure"); };
  const body = { projectId: "p1", goal: "receipt fault", mode: "write", maxAttempts: 2 };
  const request = requestId();
  await assert.rejects(f.client.post("/v1/jobs", body, request), (error) => error.code === "REQUEST_UNCERTAIN");
  assert.equal(f.dispatcher.db.prepare("SELECT value FROM metadata WHERE key = 'receipt-test-effect'").get().value, "created");
  assert.equal(f.dispatcher.db.prepare("SELECT * FROM control_request_results WHERE request_id = ?").get(request), undefined);
  await assert.rejects(f.client.post("/v1/jobs", body, request), (error) => error.code === "REQUEST_UNCERTAIN");
  assert.equal(calls, 1);
});

test("explicit uncertain command errors never become definitive failed receipts", async (t) => {
  const uncertain = new Error("branch outcome requires reconciliation");
  uncertain.code = "POST_CAS_RECEIPT_UNCERTAIN";
  const f = await fixture(t, { runIntegration: async () => { throw uncertain; } });
  const request = requestId();
  await assert.rejects(
    f.client.post("/v1/integration/proposal-one/run", {}, request),
    (error) => error.code === "REQUEST_UNCERTAIN",
  );
  assert.equal(f.dispatcher.db.prepare("SELECT * FROM control_request_results WHERE request_id = ?").get(request), undefined);
});

test("the Control API carries a write job through exact approved integration", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-control-flow-"));
  const root = path.join(temp, "data");
  const repo = path.join(temp, "repo");
  fs.mkdirSync(repo);
  await command("git", ["init", "-b", "main"], repo);
  await command("git", ["config", "user.name", "Test"], repo);
  await command("git", ["config", "user.email", "test@example.invalid"], repo);
  fs.writeFileSync(path.join(repo, "input.txt"), "before\n");
  const validationEvidence = path.join(temp, "validation-environment.txt");
  fs.writeFileSync(path.join(repo, "validate-env.cjs"), [
    "const fs = require('node:fs');",
    "if (process.env.DELEGATE_WAVE_CONTROL_TOKEN) process.exit(23);",
    "fs.appendFileSync(process.argv[2], 'token-absent\\n');",
  ].join("\n"));
  await command("git", ["add", "."], repo);
  await command("git", ["commit", "-m", "initial"], repo);
  await command("git", ["branch", "integration"], repo);
  const token = "flow-token";
  const backend = new FakeBackend(async ({ worktreePath }) => {
    fs.writeFileSync(path.join(worktreePath, "output.txt"), "through-control-api\n");
    return { exitCode: 0, stdout: "ok", stderr: "" };
  });
  const originalToken = process.env.DELEGATE_WAVE_CONTROL_TOKEN;
  process.env.DELEGATE_WAVE_CONTROL_TOKEN = token;
  const running = await startControlServer({ root, backend, token, principalId: "john", port: 0 });
  const client = new ControlClient({ baseUrl: running.url, token });
  try {
    const project = await client.post("/v1/projects", {
      name: "Flow", repoPath: repo, branch: "integration",
      validation: [`node validate-env.cjs ${JSON.stringify(validationEvidence.replaceAll("\\", "/"))}`],
      protectedPaths: [],
    }, requestId());
    const job = await client.post("/v1/jobs", {
      projectId: project.id, goal: "create output", mode: "write", maxAttempts: 2,
    }, requestId());
    const ready = await client.post(`/v1/jobs/${job.id}/run`, { model: "test/fake" }, requestId());
    assert.equal(ready.job.status, "READY_FOR_INTEGRATION");
    const proposal = await client.post("/v1/integration/proposals", { jobId: job.id }, requestId());
    const approval = await client.post("/v1/approvals", { proposalId: proposal.id }, requestId());
    assert.equal(approval.principal, "john");
    assert.equal(approval.origin, "local-cli");
    const integrated = await client.post(`/v1/integration/${proposal.id}/run`, {}, requestId());
    assert.equal(integrated.proposal.state, "INTEGRATED");
    assert.equal(await command("git", ["show", "integration:output.txt"], repo), "through-control-api");
    assert.equal(fs.readFileSync(validationEvidence, "utf8"), "token-absent\ntoken-absent\n");
    assert.equal((await client.get(`/v1/jobs/${job.id}`)).job.id, job.id);
  } finally {
    await running.close();
    if (originalToken === undefined) delete process.env.DELEGATE_WAVE_CONTROL_TOKEN;
    else process.env.DELEGATE_WAVE_CONTROL_TOKEN = originalToken;
    const listed = await runProcess("git", ["-C", repo, "worktree", "list", "--porcelain"]);
    for (const line of listed.stdout.split(/\r?\n/).filter((item) => item.startsWith("worktree ")).slice(1)) {
      await runProcess("git", ["-C", repo, "worktree", "remove", "--force", line.slice(9)]);
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("disconnect after send can retry from the durable result", async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    createJob: async () => { calls += 1; await delay(100); return { id: "job-after-disconnect" }; },
  });
  const requestId = `req_${crypto.randomUUID()}`;
  const target = new URL("/v1/jobs", f.url);
  await new Promise((resolve) => {
    const request = http.request(target, {
      method: "POST",
      headers: {
        authorization: `Bearer ${f.token}`,
        "content-type": "application/json",
        "x-request-id": requestId,
      },
    });
    request.on("error", () => resolve());
    request.end(JSON.stringify({ projectId: "p1", goal: "disconnect", mode: "write", maxAttempts: 2 }), () => {
      request.destroy();
      resolve();
    });
  });
  for (let index = 0; index < 100; index += 1) {
    if (f.dispatcher.db.prepare("SELECT 1 FROM control_request_results WHERE request_id = ?").get(requestId)) break;
    await delay(20);
  }
  const replay = await f.client.post("/v1/jobs", { projectId: "p1", goal: "disconnect", mode: "write", maxAttempts: 2 }, requestId);
  assert.equal(replay.id, "job-after-disconnect");
  assert.equal(calls, 1);
});

test("request identity and terminal result survive server restart", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-control-restart-"));
  const root = path.join(temp, "data");
  let calls = 0;
  const first = await fixture(null, { createJob: () => ({ id: `job-${++calls}` }) }, root);
  const requestId = `req_${crypto.randomUUID()}`;
  const body = { projectId: "p1", goal: "restart", mode: "write", maxAttempts: 2 };
  const original = await first.client.post("/v1/jobs", body, requestId);
  await first.close();
  const second = await fixture(null, { createJob: () => ({ id: `job-${++calls}` }) }, root);
  try {
    const replay = await second.client.post("/v1/jobs", body, requestId);
    assert.deepEqual(replay, original);
    assert.equal(calls, 1);
  } finally {
    await second.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("malformed, unknown, and identity-spoofing requests do not dispatch", async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    createJob: () => { calls += 1; return { id: "bad" }; },
    grantApproval: () => { calls += 1; return { id: "bad" }; },
  });
  const malformed = await fetch(`${f.url}/v1/jobs`, {
    method: "POST",
    headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json", "x-request-id": "bad-json" },
    body: "{",
  });
  assert.equal(malformed.status, 400);
  const unknown = await fetch(`${f.url}/v1/not-a-command`, { headers: { authorization: `Bearer ${f.token}` } });
  assert.equal(unknown.status, 404);
  await assert.rejects(
    f.client.post("/v1/approvals", { proposalId: "p", principal: "attacker" }, "spoof"),
    (error) => error.code === "IDENTITY_SPOOFING",
  );
  assert.equal(calls, 0);
});

test("Hermes observer credential can query but cannot mutate", async (t) => {
  let calls = 0;
  const overview = { schema_version: 1, totals: { projects: 2, jobs_needing_attention: 1, jobs_ready_for_integration: 0 } };
  const f = await fixture(t, {
    overview: () => overview,
    createJob: () => { calls += 1; return { id: "forbidden" }; },
  });
  const observer = new ControlClient({ baseUrl: f.url, token: f.observerToken });
  assert.deepEqual(await observer.get("/v1/projects"), []);
  assert.deepEqual(await observer.get("/v1/overview"), overview);
  await assert.rejects(
    observer.post("/v1/jobs", { projectId: "p", goal: "no", mode: "write", maxAttempts: 1 }, requestId()),
    (error) => error.code === "INSUFFICIENT_SCOPE",
  );
  assert.equal(calls, 0);
  assert.equal(f.dispatcher.db.prepare("SELECT COUNT(*) AS count FROM control_request_intents").get().count, 0);
});

test("observer and operator credentials must be distinct", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-token-scope-"));
  const dispatcher = fakeDispatcher(path.join(temp, "data"));
  try {
    assert.throws(() => createControlServer({
      service: new ControlService({ dispatcher }), token: "same", observerToken: "same", principalId: "john",
    }), /must be distinct/);
  } finally {
    dispatcher.db.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("approval identity comes only from the authenticated server context", async (t) => {
  let received;
  const f = await fixture(t, {
    grantApproval: (args) => { received = args; return { id: "approval-one", ...args }; },
  });
  const receipt = await f.client.post("/v1/approvals", { proposalId: "proposal-one" }, `req_${crypto.randomUUID()}`);
  assert.equal(receipt.principal, "john");
  assert.equal(receipt.origin, "local-cli");
  assert.equal(received.principal, "john");
});

test("CLI unavailable fails closed and contains no dispatcher storage imports", async () => {
  const source = fs.readFileSync(cliPath, "utf8");
  assert.doesNotMatch(source, /from ["'].\/(?:db|service|backend|paths)\.js["']/);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-cli-unavailable-"));
  try {
    const result = await runProcess(process.execPath, [cliPath, "job", "create", "--project", "p", "--goal", "g"], {
      env: {
        DELEGATE_WAVE_DATA_ROOT: path.join(temp, "data"),
        DELEGATE_WAVE_CONTROL_URL: "http://127.0.0.1:1",
        DELEGATE_WAVE_CONTROL_TOKEN: "present",
      },
    });
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /CONTROL_API_UNAVAILABLE/);
    assert.match(result.stderr, /request_id: req_/);
    assert.match(result.stderr, /Retry the exact command with: --request-id req_/);
    assert.equal(fs.existsSync(path.join(temp, "data")), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

// --- Proposal-only authority --------------------------------------------------------------------

// Every operator-scoped route the proposal credential must never reach. Driven off the route table
// so a newly added mutation cannot quietly become proposer-reachable.
const OPERATOR_ONLY = ROUTES.filter((route) => (route.scope || SCOPES.OPERATE) === SCOPES.OPERATE);

test("the proposal credential is rejected on every operator-scoped route", async (t) => {
  const f = await fixture(t);
  assert.ok(OPERATOR_ONLY.length >= 7, "expected the operator surface to be non-trivial");
  for (const route of OPERATOR_ONLY) {
    // Rebuild a concrete path from the route pattern: strip the anchors, substitute a placeholder
    // for each capture group, and unescape the separators.
    const pathname = route.pattern.source
      .replace(/^\^/, "")
      .replace(/\$$/, "")
      .replace(/\(\[\^\\?\/\]\+\)/g, "sample")
      .replaceAll("\\/", "/");
    assert.ok(
      pathname.startsWith("/v1/") && !/[[\]()+^$\\]/.test(pathname),
      `route path did not resolve to a concrete URL: ${pathname}`,
    );
    const response = await fetch(`${f.url}${pathname}`, {
      method: route.method,
      headers: {
        authorization: `Bearer ${f.proposerToken}`,
        "content-type": "application/json",
        "x-request-id": `req_${crypto.randomUUID()}`,
      },
      body: route.method === "POST" ? JSON.stringify({}) : undefined,
    });
    const payload = await response.json();
    assert.equal(response.status, 403, `${route.command} must refuse the proposal credential`);
    assert.equal(payload.error.code, "INSUFFICIENT_SCOPE", `${route.command} must fail on scope`);
  }
});

test("the observer credential cannot create work proposals", async (t) => {
  const f = await fixture(t);
  const response = await fetch(`${f.url}/v1/work/proposals`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${f.observerToken}`,
      "content-type": "application/json",
      "x-request-id": `req_${crypto.randomUUID()}`,
    },
    body: JSON.stringify({ projectId: "p", goal: "g", idempotencyKey: "k" }),
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "INSUFFICIENT_SCOPE");
});

test("a route with no declared scope fails closed to operator authority", () => {
  for (const route of ROUTES) {
    assert.ok(route.scope, `${route.command} must declare a scope`);
  }
  // The server treats a missing scope as OPERATE; proposer and observer never hold it.
  assert.equal(PRINCIPAL_SCOPES.proposer.includes(SCOPES.OPERATE), false);
  assert.equal(PRINCIPAL_SCOPES.observer.includes(SCOPES.OPERATE), false);
  assert.equal(PRINCIPAL_SCOPES.observer.includes(SCOPES.PROPOSE), false);
});

test("proposal creation records server-bound origin identity and rejects spoofing", async (t) => {
  let received;
  const f = await fixture(t, {
    proposeWork: (args) => { received = args; return { id: "wprop_1", ...args }; },
  });
  const proposer = new ControlClient({ baseUrl: f.url, token: f.proposerToken });
  await proposer.post("/v1/work/proposals", {
    projectId: "p", goal: "add a test", idempotencyKey: "k1",
  }, `req_${crypto.randomUUID()}`);
  assert.equal(received.principal, "hermes-proposer");
  assert.equal(received.origin, "hermes-mcp-proposal");

  await assert.rejects(
    proposer.post("/v1/work/proposals", {
      projectId: "p", goal: "g", idempotencyKey: "k2", principal: "john",
    }, `req_${crypto.randomUUID()}`),
    (error) => error.code === "IDENTITY_SPOOFING",
  );
});

test("distinct tokens are required across all three principals", async () => {
  const dispatcher = fakeDispatcher(fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-distinct-")));
  const service = new ControlService({ dispatcher });
  assert.throws(() => createControlServer({
    service, token: "same", proposerToken: "same", principalId: "john",
  }), /Proposer and operator control tokens must be distinct/);
  assert.throws(() => createControlServer({
    service, token: "op", observerToken: "shared", proposerToken: "shared", principalId: "john",
  }), /Proposer and observer control tokens must be distinct/);
  dispatcher.db.close();
});
