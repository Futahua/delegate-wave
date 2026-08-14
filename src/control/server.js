import http from "node:http";
import crypto from "node:crypto";
import os from "node:os";
import { initializeDataRoot } from "../db.js";
import { dataRoot } from "../paths.js";
import { Dispatcher } from "../service.js";
import { OpenCodeBackend } from "../backend.js";
import { matchRoute } from "./contract.js";
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
}) {
  if (!token) throw new Error("DELEGATE_WAVE_CONTROL_TOKEN is required");
  if (!principalId) throw new Error("Control server principal identity is required");
  if (observerToken && observerToken === token) throw new Error("Observer and operator control tokens must be distinct");
  return http.createServer(async (req, res) => {
    try {
      const identity = tokenMatches(req.headers.authorization, token)
        ? { principalId, originChannel, readOnly: false }
        : (observerToken && tokenMatches(req.headers.authorization, observerToken)
          ? { principalId: observerPrincipalId, originChannel: observerOriginChannel, readOnly: true }
          : null);
      if (!identity) throw new ControlError("UNAUTHORIZED", "Invalid control token", 401);
      const url = new URL(req.url, "http://localhost");
      const route = matchRoute(req.method, url.pathname);
      if (identity.readOnly && route.mutation) {
        throw new ControlError("READ_ONLY_CREDENTIAL", "Observer credential cannot invoke mutations", 403);
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
  backend = new OpenCodeBackend({ attach: process.env.DELEGATE_WAVE_OPENCODE_ATTACH }),
} = {}) {
  initializeDataRoot(root);
  const dispatcher = new Dispatcher({ root, backend });
  const service = new ControlService({ dispatcher });
  const server = createControlServer({ service, token, principalId, observerToken, observerPrincipalId });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  return {
    server,
    dispatcher,
    url: `http://${host}:${address.port}`,
    async close() {
      const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closed;
      dispatcher.close();
    },
  };
}
