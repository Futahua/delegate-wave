import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { initializeDataRoot, recordEvent } from "../db.js";
import { dataRoot } from "../paths.js";
import { Dispatcher, DEFAULT_WORKER_MODEL, REVIEW_MODEL } from "../service.js";
import { BackendRouter } from "../harness/select.js";
import { matchRoute, PRINCIPAL_SCOPES, SCOPES } from "./contract.js";
import { ControlError, asControlError } from "./errors.js";
import { ControlService } from "./service.js";
import { ManagerService } from "../manager/service.js";
import { CodexManagerBackend } from "../manager/backend.js";
import { AutonomousSessionService } from "../session/service.js";
import { SessionDriver } from "../session/driver.js";
import { SessionWatcher } from "../session/watcher.js";
import { HermesExternalTurns } from "../session/hermes-external-turns.js";
import { WakeDeliverer } from "../session/wake.js";
import { HermesGateway } from "../session/hermes-gateway.js";
import { SafeIntegrator } from "../integration/safe.js";
import { providerForModel } from "../manager/provider.js";

const MAX_BODY_BYTES = 1024 * 1024;

// Wakes are rare and never urgent to the second. Polling this slowly is not a compromise: the cost
// of a pass is a process spawn, and the cost of missing one for ten seconds is ten seconds.
const WAKE_DELIVERY_INTERVAL_MS = 10_000;

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
  // The scarce side's route. Named here rather than read at each turn so one served runtime uses one
  // manager, and a change of mind is a restart rather than a drift mid-session.
  managerModel = process.env.DELEGATE_WAVE_MANAGER_MODEL || "opencode-go/gpt-5.6-luna",
  managerWorkingDirectory = null,
} = {}) {
  initializeDataRoot(root);
  // Neutral by construction: the data root is not any project's repository.
  const neutralDirectory = managerWorkingDirectory ?? path.join(root, "manager-cwd");
  fs.mkdirSync(neutralDirectory, { recursive: true });
  // Harness is preferred for the models it can run; OpenCode carries the review lane and is the
  // proven fallback. The router decides per attempt, from the resolved model -- never inside an
  // attempt, which would put two executors behind a single attempt identity.
  const router = backend ? null : new BackendRouter({ apiKey: executorApiKey, prefer: preferBackend });
  const dispatcher = new Dispatcher({ root, backend, router });

  // A previous runtime may have died holding an attempt. reconcile() checks whether each owner
  // process is actually alive, so a live attempt belonging to a running scheduler is untouched while
  // an orphan is resolved -- which matters more than it used to: assertAdmissible() fences ALL work
  // behind any live attempt, so one orphan left by a crash would otherwise block the installation
  // until somebody noticed. The global fence stays strict; startup just stops lying to it.
  const recovered = await dispatcher.reconcile({ apply: true });
  const strandedCount = Array.isArray(recovered?.stranded) ? recovered.stranded.length : 0;
  if (strandedCount) {
    recordEvent(dispatcher.db, {
      kind: "RUNTIME_RECOVERED_ORPHANED_ATTEMPTS", entityType: "job", entityId: "runtime",
      payload: { attempts: recovered.stranded },
    });
  }

  // The autonomous runtime, assembled here because this is where the executor lanes are known.
  //
  // The driver is what makes a session autonomous: Hermes starts one, observes it and answers its
  // questions, and never has to call anything to make it progress. Without a driver running in the
  // served process, a session would sit in WORKING for as long as anyone kept asking.
  // A custom provider when the model names one. Without this every session's first turn reached the
  // app server unconfigured and was lost -- the CLI resolved a provider and the served runtime did
  // not, which is precisely the drift that sharing the resolver removes.
  const { provider: managerProvider, reason: providerReason } = await providerForModel(managerModel);
  if (providerReason && managerModel.includes("/")) {
    recordEvent(dispatcher.db, {
      kind: "MANAGER_PROVIDER_UNRESOLVED", entityType: "job", entityId: "runtime",
      payload: { model: managerModel, reason: providerReason },
    });
  }
  const manager = new ManagerService({
    dispatcher,
    // A NEUTRAL working directory, never a project repository. The manager reasons from evidence
    // packs delegate-wave assembles; pointing it at a repo would let it explore with the most
    // expensive tokens in the system, which is the substitution this whole layer exists to prevent.
    backend: new CodexManagerBackend({
      // The BARE model name. A provider-prefixed string selects the route; the app server is then
      // told a model it recognises, with the provider supplied alongside it. Passing the prefixed
      // name straight through is what lost every session's first turn.
      model: managerProvider ? managerModel.slice(managerModel.indexOf("/") + 1) : managerModel,
      workingDirectory: neutralDirectory,
      provider: managerProvider,
    }),
    workerModel: DEFAULT_WORKER_MODEL,
  });
  const sessions = new AutonomousSessionService({
    dispatcher, manager, integrator: new SafeIntegrator({ dispatcher }),
  });
  const driver = new SessionDriver({
    sessions,
    onError: (error, sessionId) => {
      // A driver that threw would take the serving process with it. Recorded and moved past: the
      // session's own state already carries what happened to it.
      recordEvent(dispatcher.db, {
        kind: "AUTONOMOUS_SESSION_DRIVER_ERROR", entityType: "job", entityId: sessionId,
        payload: { message: error.message },
      });
    },
    onEvent: (kind, payload) => {
      recordEvent(dispatcher.db, { kind, entityType: "job", entityId: "runtime", payload });
    },
  }).start();

  // Noticing costs nothing, so it always runs.
  //
  // The watcher only reads columns and, when something genuinely changed, writes one row. It is
  // started unconditionally because the expensive and risky part of waking somebody is DELIVERY, and
  // that is a separate object with its own gate. Enqueuing is free, durable, and the thing that must
  // not be missed: a wake that was never enqueued cannot be delivered later, while a wake that sits
  // in the outbox until the receiver is safe to write to loses nothing but time.
  const watcher = new SessionWatcher({
    sessions,
    onError: (error) => {
      recordEvent(dispatcher.db, {
        kind: "SESSION_WATCHER_ERROR", entityType: "job", entityId: "runtime",
        payload: { message: error.message },
      });
    },
    onEvent: (kind, payload) => {
      recordEvent(dispatcher.db, { kind, entityType: "job", entityId: "runtime", payload });
    },
  }).start();

  // Delivery is constructed only when a Hermes agent directory is configured, and it does not submit
  // even then.
  //
  // THREE separate gates, because they refuse three different things. Without a configured gateway
  // there is nothing to spawn at all. Without the environment flag, an operator has not asked for
  // submission. And without Hermes itself reporting that it enforces per-session exclusivity, the
  // flag authorises nothing -- that last one is checked per delivery, inside the deliverer, because
  // it is a fact about the receiver rather than about this configuration, and no environment
  // variable may be allowed to assert it.
  //
  // Everything before the mutation runs regardless: resume, canonical history, marker
  // reconciliation, PARTIAL handling.
  const deliverer = HermesGateway.configured()
    ? new WakeDeliverer({
      db: dispatcher.db,
      gateway: () => new HermesGateway(),
      // TWO TRANSPORTS, TWO SWITCHES, AND THE OLD ONE CANNOT TURN ON THE NEW.
      //
      // DELEGATE_WAVE_WAKE_SUBMIT authorised THIS runtime to write directly into somebody's
      // conversation. The routed transport does not do that at all -- it hands an event to Hermes
      // and lets the session's own owner run it -- so the old flag's safety argument says nothing
      // about the new path, and reusing it would silently carry a decision made about one mechanism
      // over to a different one.
      //
      // When the routed transport is enabled it is the ONLY transport. There is no fallback to
      // direct submit on a missing capability or an unreachable adapter: that would reinstate the
      // concurrency hazard the per-session lease was built to remove, triggered by a downgrade or a
      // wrong interpreter path rather than by anybody deciding anything.
      allowEnqueue: process.env.DELEGATE_WAVE_WAKE_ENQUEUE === "1",
      externalTurns: () => new HermesExternalTurns(),
      allowSubmit: process.env.DELEGATE_WAVE_WAKE_ENQUEUE === "1"
        ? false
        : process.env.DELEGATE_WAVE_WAKE_SUBMIT === "1",
      onEvent: (kind, payload) => {
        recordEvent(dispatcher.db, { kind, entityType: "job", entityId: "runtime", payload });
      },
      onError: (error, wakeId) => {
        recordEvent(dispatcher.db, {
          kind: "WAKE_DELIVERY_ERROR", entityType: "job", entityId: wakeId ?? "runtime",
          payload: { message: error.message },
        });
      },
    })
    : null;

  // Serialised on purpose: one pass at a time, never overlapping.
  //
  // A delivery spawns a Hermes gateway and talks to a durable conversation. Two overlapping passes
  // would be this system doing to itself exactly what section 2 of the research measured being done
  // to it -- two independent processes on the same session -- so the interval schedules the NEXT
  // pass only once the previous one has finished, rather than every N milliseconds regardless.
  let deliveryTimer = null;
  if (deliverer) {
    let running = false;
    deliveryTimer = setInterval(() => {
      if (running) return;
      running = true;
      deliverer.pass()
        .catch((error) => {
          recordEvent(dispatcher.db, {
            kind: "WAKE_DELIVERY_ERROR", entityType: "job", entityId: "runtime",
            payload: { message: error.message },
          });
        })
        .finally(() => { running = false; });
    }, WAKE_DELIVERY_INTERVAL_MS);
    if (typeof deliveryTimer.unref === "function") deliveryTimer.unref();
  }

  const service = new ControlService({ dispatcher, sessions });
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
    managerProvider: managerProvider ? managerProvider.id : null,
    // Startup evidence: which executor was ASKED for and where that instruction came from, so a
    // runtime routing work somewhere unexpected says so at boot rather than in a transcript.
    workerExecutor: {
      requested: preferBackend,
      source: process.env.DELEGATE_WAVE_BACKEND ? "cli/--backend or environment" : "default",
    },
    recoveredAttempts: strandedCount,
    executor: router ? {
      default: router.select(DEFAULT_WORKER_MODEL).selected,
      review: router.select(REVIEW_MODEL).selected,
      reason: router.select(DEFAULT_WORKER_MODEL).reason,
    } : { default: "supplied", review: "supplied", reason: "backend supplied by the caller" },
    url: `http://${host}:${address.port}`,
    sessions,
    driver,
    watcher,
    deliverer,
    async close() {
      driver.stop();
      watcher.stop();
      if (deliveryTimer) clearInterval(deliveryTimer);
      const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closed;
      dispatcher.close();
    },
  };
}
