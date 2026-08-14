import { ControlError } from "./errors.js";

export const ROUTES = Object.freeze([
  { method: "GET", pattern: /^\/v1\/health$/, command: "health" },
  { method: "GET", pattern: /^\/v1\/projects$/, command: "project.list" },
  { method: "POST", pattern: /^\/v1\/projects$/, command: "project.create", mutation: true },
  { method: "GET", pattern: /^\/v1\/jobs$/, command: "job.list" },
  { method: "POST", pattern: /^\/v1\/jobs$/, command: "job.create", mutation: true },
  { method: "GET", pattern: /^\/v1\/jobs\/([^/]+)$/, command: "job.get", params: ["jobId"] },
  { method: "POST", pattern: /^\/v1\/jobs\/([^/]+)\/run$/, command: "job.run", params: ["jobId"], mutation: true },
  { method: "GET", pattern: /^\/v1\/proposals\/([^/]+)$/, command: "proposal.get", params: ["proposalId"] },
  { method: "POST", pattern: /^\/v1\/integration\/proposals$/, command: "integration.propose", mutation: true },
  { method: "POST", pattern: /^\/v1\/approvals$/, command: "approval.grant", mutation: true },
  { method: "GET", pattern: /^\/v1\/approvals$/, command: "approval.list" },
  { method: "POST", pattern: /^\/v1\/integration\/([^/]+)\/run$/, command: "integration.run", params: ["proposalId"], mutation: true },
  { method: "GET", pattern: /^\/v1\/attention$/, command: "attention" },
  { method: "POST", pattern: /^\/v1\/reconcile$/, command: "reconcile", mutation: true },
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
