import http from "node:http";
import crypto from "node:crypto";
import os from "node:os";
import { initializeDataRoot } from "../db.js";
import { dataRoot } from "../paths.js";
import { Dispatcher, DEFAULT_WORKER_MODEL, REVIEW_MODEL } from "../service.js";
import { BackendRouter } from "../harness/select.js";
import { matchRoute, PRINCIPAL_SCOPES, SCOPES } from "./contract.js";
import { ControlError, asControlError } from "./errors.js";
import { ControlService } from "./service.js";

const MAX_BODY_BYTES = 1024 * 1024;

function tokenMatches(header, token) {
  if (!token || typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ControlError("BODY_TOO_LARGE", "Request body exceeds 1 MiB", 413);
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("body must be an object");
    return parsed;
  } catch (error) {
    throw new ControlError("MALFORMED_JSON", `Malformed JSON body: ${error.message}`, 400);
  }
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

export function createControlServer({
  service, token, principalId, originChannel = "local-cli",
  observerToken = null, observerPrincipalId = "hermes", observerOriginChannel = "hermes-mcp",
  proposerToken = null, proposerPrincipalId = "hermes-proposer", proposerOriginChannel = "hermes-mcp-proposal",
}) {
  if (!token) throw new Error("DELEGATE_WAVE_CONTROL_TOKEN is required");
  if (!principalId) throw new Error("Control server principal identity is required");
  if (observerToken && observerToken === token) throw new Error("Observer and operator control tokens must be distinct");
  if (proposerToken && proposerToken === token) throw new Error("Proposer and operator control tokens must be distinct");
  if (proposerToken && observerToken && proposerToken === observerToken) {
    throw new Error("Proposer and observer control tokens must be distinct");
  }

  // Ordered most- to least-privileged. Each credential resolves to a fixed scope set; a request can
  // never select or widen its own scopes.
  const credentials = [
    { token, principalId, originChannel, scopes: PRINCIPAL_SCOPES.operator },
    observerToken
      ? { token: observerToken, principalId: observerPrincipalId, originChannel: observerOriginChannel, scopes: PRINCIPAL_SCOPES.observer }
      : null,
    proposerToken
      ? { token: proposerToken, principalId: proposerPrincipalId, originChannel: proposerOriginChannel, scopes: PRINCIPAL_SCOPES.proposer }
      : null,
  ].filter(Boolean);

  return http.createServer(async (req, res) => {
    try {
      const matched = credentials.find((candidate) => tokenMatches(req.headers.authorization, candidate.token));
      const identity = matched
        ? { principalId: matched.principalId, originChannel: matched.originChannel, scopes: matched.scopes }
        : null;
      if (!identity) throw new ControlError("UNAUTHORIZED", "Invalid control token", 401);
      const url = new URL(req.url, "http://localhost");
      const route = matchRoute(req.method, url.pathname);
      // Fail closed: a route without a declared scope requires full operator authority.
      const requiredScope = route.scope || SCOPES.OPERATE;
      if (!identity.scopes.includes(requiredScope)) {
        throw new ControlError(
          "INSUFFICIENT_SCOPE",
          `Credential lacks the ${requiredScope} scope required by ${route.command}`,
          403,
        );
      }
      const body = route.method === "POST" ? await readJson(req) : {};
      const args = { ...body, ...route.params };
      if (route.method === "GET") {
        for (const [key, value] of url.searchParams) args[key] = value;
      }
      const result = await service.execute(route.command, args, {
        requestId: req.headers["x-request-id"],
        principalId: identity.principalId,
        originChannel: identity.originChannel,
      });
      send(res, 200, { ok: true, result });
    } catch (error) {
      const normalized = asControlError(error);
      send(res, normalized.status || 500, {
        ok: false,
        error: { code: normalized.code, message: normalized.message, details: normalized.details },
      });
    }
  });
}

export async function startControlServer({
  root = dataRoot(),
  host = process.env.DELEGATE_WAVE_CONTROL_HOST || "127.0.0.1",
  port = Number(process.env.DELEGATE_WAVE_CONTROL_PORT || 47321),
  token = process.env.DELEGATE_WAVE_CONTROL_TOKEN,
  principalId = process.env.DELEGATE_WAVE_CONTROL_PRINCIPAL || os.userInfo().username,
  observerToken = process.env.DELEGATE_WAVE_CONTROL_OBSERVER_TOKEN || null,
  observerPrincipalId = process.env.DELEGATE_WAVE_CONTROL_OBSERVER_PRINCIPAL || "hermes",
  proposerToken = process.env.DELEGATE_WAVE_CONTROL_PROPOSER_TOKEN || null,
  proposerPrincipalId = process.env.DELEGATE_WAVE_CONTROL_PROPOSER_PRINCIPAL || "hermes-proposer",
  executorApiKey = process.env.DELEGATE_WAVE_EXECUTOR_API_KEY || null,
  preferBackend = process.env.DELEGATE_WAVE_BACKEND || "harness",
  backend = null,
} = {}) {
  initializeDataRoot(root);
  // Harness is preferred for the models it can run; OpenCode carries the review lane and is the
  // proven fallback. The router decides per attempt, from the resolved model -- never inside an
  // attempt, which would put two executors behind a single attempt identity.
  const router = backend ? null : new BackendRouter({ apiKey: executorApiKey, prefer: preferBackend });
  const dispatcher = new Dispatcher({ root, backend, router });
  const service = new ControlService({ dispatcher });
  const server = createControlServer({
    service, token, principalId, observerToken, observerPrincipalId, proposerToken, proposerPrincipalId,
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  return {
    server,
    dispatcher,
    // Reported, not inferred from which executor's artifacts turn up. Routing is per model, so the
    // report names each lane rather than pretending one executor serves everything.
    executor: router ? {
      default: router.select(DEFAULT_WORKER_MODEL).selected,
      review: router.select(REVIEW_MODEL).selected,
      reason: router.select(DEFAULT_WORKER_MODEL).reason,
    } : { default: "supplied", review: "supplied", reason: "backend supplied by the caller" },
    url: `http://${host}:${address.port}`,
    async close() {
      const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closed;
      dispatcher.close();
    },
  };
}
