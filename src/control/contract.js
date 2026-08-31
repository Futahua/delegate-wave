import { ControlError } from "./errors.js";

// Every route names the scope it requires. A principal holds a scope set, so authority is granted by
// enumeration rather than by a readOnly flag that silently widens as routes are added.
export const SCOPES = Object.freeze({
  READ: "read", PROPOSE: "propose", OPERATE: "operate",
  // Authority to run an autonomous session, and only that.
  //
  // Separate from OPERATE on purpose. A session's power is bounded by the mode the user granted it
  // and by the project and ceiling it was started with -- it can commission work and, in the modes
  // that permit it, publish a validated result, but it cannot approve an arbitrary proposal, run an
  // arbitrary job, reconcile, or change policy. Granting OPERATE to reach sessions would have handed
  // over all of those at once.
  SESSION: "session",
});

export const PRINCIPAL_SCOPES = Object.freeze({
  // The operator holds SESSION too. Hermes may start autonomous sessions, so a human at the CLI
  // must not be the one principal that cannot -- an authority model where the delegate outranks the
  // person is a mistake, not a safety property.
  operator: Object.freeze([SCOPES.READ, SCOPES.PROPOSE, SCOPES.OPERATE, SCOPES.SESSION]),
  observer: Object.freeze([SCOPES.READ]),
  // Proposal authority is deliberately READ + PROPOSE: Hermes may see enough to propose bounded work
  // and may create a proposal, but holds no OPERATE scope, so it can never approve, run, integrate,
  // reconcile, or grant itself authority.
  proposer: Object.freeze([SCOPES.READ, SCOPES.PROPOSE, SCOPES.SESSION]),
});

export const ROUTES = Object.freeze([
  { method: "GET", pattern: /^\/v1\/health$/, command: "health", scope: SCOPES.READ },
  // One capability, three operations -- not three permission checkpoints. Starting is where the
  // authority is exercised; polling and answering continue a session that was already permitted.
  { method: "POST", pattern: /^\/v1\/sessions$/, command: "session.start", mutation: true, scope: SCOPES.SESSION },
  { method: "GET", pattern: /^\/v1\/sessions\/([^/]+)$/, command: "session.poll", params: ["sessionId"], scope: SCOPES.READ },
  { method: "GET", pattern: /^\/v1\/sessions$/, command: "session.list", scope: SCOPES.READ },
  { method: "GET", pattern: /^\/v1\/sessions\/([^/]+)\/timeline$/, command: "session.timeline", params: ["sessionId"], scope: SCOPES.READ },
  { method: "POST", pattern: /^\/v1\/sessions\/([^/]+)\/answer$/, command: "session.answer", params: ["sessionId"], mutation: true, scope: SCOPES.SESSION },
  { method: "POST", pattern: /^\/v1\/sessions\/([^/]+)\/fail$/, command: "session.fail", params: ["sessionId"], mutation: true, scope: SCOPES.SESSION },
  { method: "POST", pattern: /^\/v1\/sessions\/([^/]+)\/tick$/, command: "session.tick", params: ["sessionId"], mutation: true, scope: SCOPES.SESSION },
  { method: "GET", pattern: /^\/v1\/overview$/, command: "overview", scope: SCOPES.READ },
  { method: "GET", pattern: /^\/v1\/projects$/, command: "project.list", scope: SCOPES.READ },
  { method: "POST", pattern: /^\/v1\/projects$/, command: "project.create", mutation: true, scope: SCOPES.OPERATE },
  { method: "GET", pattern: /^\/v1\/jobs$/, command: "job.list", scope: SCOPES.READ },
  { method: "POST", pattern: /^\/v1\/jobs$/, command: "job.create", mutation: true, scope: SCOPES.OPERATE },
  { method: "GET", pattern: /^\/v1\/jobs\/([^/]+)$/, command: "job.get", params: ["jobId"], scope: SCOPES.READ },
  { method: "POST", pattern: /^\/v1\/jobs\/([^/]+)\/run$/, command: "job.run", params: ["jobId"], mutation: true, scope: SCOPES.OPERATE },
  { method: "GET", pattern: /^\/v1\/proposals\/([^/]+)$/, command: "proposal.get", params: ["proposalId"], scope: SCOPES.READ },
  { method: "POST", pattern: /^\/v1\/integration\/proposals$/, command: "integration.propose", mutation: true, scope: SCOPES.OPERATE },
  { method: "POST", pattern: /^\/v1\/approvals$/, command: "approval.grant", mutation: true, scope: SCOPES.OPERATE },
  { method: "GET", pattern: /^\/v1\/approvals$/, command: "approval.list", scope: SCOPES.READ },
  { method: "POST", pattern: /^\/v1\/integration\/([^/]+)\/run$/, command: "integration.run", params: ["proposalId"], mutation: true, scope: SCOPES.OPERATE },
  { method: "GET", pattern: /^\/v1\/attention$/, command: "attention", scope: SCOPES.READ },
  { method: "GET", pattern: /^\/v1\/briefing$/, command: "briefing", scope: SCOPES.READ },
  { method: "POST", pattern: /^\/v1\/reconcile$/, command: "reconcile", mutation: true, scope: SCOPES.OPERATE },
  { method: "POST", pattern: /^\/v1\/jobs\/([^/]+)\/cancel$/, command: "job.cancel", params: ["jobId"], mutation: true, scope: SCOPES.OPERATE },
  // Recovery: explicit operator operations so a problem never requires editing SQLite or Git by hand.
  { method: "POST", pattern: /^\/v1\/jobs\/([^/]+)\/advance$/, command: "job.advance", params: ["jobId"], mutation: true, scope: SCOPES.OPERATE },
  { method: "POST", pattern: /^\/v1\/proposals\/([^/]+)\/approve$/, command: "integration.approve", params: ["proposalId"], mutation: true, scope: SCOPES.OPERATE },
  { method: "POST", pattern: /^\/v1\/backups$/, command: "backup.create", mutation: true, scope: SCOPES.OPERATE },
  { method: "GET", pattern: /^\/v1\/backups$/, command: "backup.list", scope: SCOPES.READ },
  { method: "POST", pattern: /^\/v1\/backups\/restore$/, command: "backup.restore", mutation: true, scope: SCOPES.OPERATE },
  { method: "POST", pattern: /^\/v1\/restore\/resolve$/, command: "restore.resolve", mutation: true, scope: SCOPES.OPERATE },
  { method: "POST", pattern: /^\/v1\/proposals\/([^/]+)\/decline$/, command: "integration.decline", params: ["proposalId"], mutation: true, scope: SCOPES.OPERATE },
  { method: "POST", pattern: /^\/v1\/proposals\/([^/]+)\/rollback$/, command: "integration.rollback", params: ["proposalId"], mutation: true, scope: SCOPES.OPERATE },
  { method: "POST", pattern: /^\/v1\/projects\/([^/]+)\/retire$/, command: "project.retire", params: ["projectId"], mutation: true, scope: SCOPES.OPERATE },
  { method: "POST", pattern: /^\/v1\/projects\/([^/]+)\/restore$/, command: "project.restore", params: ["projectId"], mutation: true, scope: SCOPES.OPERATE },

  // Proposal-only authority: creating and reading bounded work requests.
  { method: "POST", pattern: /^\/v1\/work\/proposals$/, command: "work.propose", mutation: true, scope: SCOPES.PROPOSE },
  { method: "GET", pattern: /^\/v1\/work\/proposals$/, command: "work.proposal.list", scope: SCOPES.READ },
  { method: "GET", pattern: /^\/v1\/work\/proposals\/([^/]+)$/, command: "work.proposal.get", params: ["proposalId"], scope: SCOPES.READ },
  // Authorizing a proposal into a job is operator-only; it is the human gate in the loop.
  { method: "POST", pattern: /^\/v1\/work\/proposals\/([^/]+)\/authorize$/, command: "work.proposal.authorize", params: ["proposalId"], mutation: true, scope: SCOPES.OPERATE },
  { method: "POST", pattern: /^\/v1\/work\/proposals\/([^/]+)\/reject$/, command: "work.proposal.reject", params: ["proposalId"], mutation: true, scope: SCOPES.OPERATE },
]);

export function matchRoute(method, pathname) {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const match = pathname.match(route.pattern);
    if (!match) continue;
    const params = {};
    (route.params || []).forEach((name, index) => { params[name] = decodeURIComponent(match[index + 1]); });
    return { ...route, params };
  }
  throw new ControlError("ROUTE_NOT_FOUND", `Unknown Control API route: ${method} ${pathname}`, 404);
}
