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
  const server = createControlServer({
    service: new ControlService({ dispatcher, pendingWaitMs: 2000 }),
    token,
    principalId: "john",
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
  return { root: dataRoot, dispatcher, server, token, url, client: new ControlClient({ baseUrl: url, token }), close };
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

test("the Control API carries a write job through exact approved integration", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-control-flow-"));
  const root = path.join(temp, "data");
  const repo = path.join(temp, "repo");
  fs.mkdirSync(repo);
  await command("git", ["init", "-b", "main"], repo);
  await command("git", ["config", "user.name", "Test"], repo);
  await command("git", ["config", "user.email", "test@example.invalid"], repo);
  fs.writeFileSync(path.join(repo, "input.txt"), "before\n");
  await command("git", ["add", "."], repo);
  await command("git", ["commit", "-m", "initial"], repo);
  await command("git", ["branch", "integration"], repo);
  const token = "flow-token";
  const backend = new FakeBackend(async ({ worktreePath }) => {
    fs.writeFileSync(path.join(worktreePath, "output.txt"), "through-control-api\n");
    return { exitCode: 0, stdout: "ok", stderr: "" };
  });
  const running = await startControlServer({ root, backend, token, principalId: "john", port: 0 });
  const client = new ControlClient({ baseUrl: running.url, token });
  try {
    const project = await client.post("/v1/projects", {
      name: "Flow", repoPath: repo, branch: "integration", validation: [], protectedPaths: [],
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
    assert.equal((await client.get(`/v1/jobs/${job.id}`)).job.id, job.id);
  } finally {
    await running.close();
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
    assert.equal(fs.existsSync(path.join(temp, "data")), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
