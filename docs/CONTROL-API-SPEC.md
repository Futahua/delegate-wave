# Local Control API Specification

Status: implemented bootstrap contract for PR #4.

The Control API is the authority boundary between operator adapters and `delegate-wave`. The CLI is
the first adapter. MCP, Hermes, T3, and future clients MUST use the same boundary rather than mutate
dispatcher state directly.

## Authority and identity

**CTL-AUTH-001** The CLI MUST NOT import or instantiate `Dispatcher`, the database, paths, or an
execution backend. If the Control API is unavailable, the CLI MUST fail without a direct fallback.

**CTL-AUTH-002** The local server MUST authenticate requests before routing them.

**CTL-AUTH-003** The server MUST bind `principal_id` and `origin_channel`. A request body MUST NOT
assert or override either value.

**CTL-AUTH-004** The initial local CLI origin MUST be `local-cli`. The principal MUST come from the
server configuration or local operating-system identity, never from CLI arguments.

**CTL-AUTH-005** Control-plane authority credentials MUST NOT be inherited by executors,
validation commands, Git hooks, or other child processes. A caller MAY explicitly supply a token
only for a process whose purpose is to act as a Control API client.

**CTL-AUTH-006** A configured observer credential MUST be distinct from the operator credential and
MUST be rejected on all mutating routes. Its identity is server-bound, not caller-supplied.

## Explicit command surface

**CTL-CMD-001** The HTTP adapter MUST expose an explicit allowlist of commands. It MUST NOT expose
generic method invocation, SQL, lifecycle mutation, blocker mutation, or arbitrary dispatcher calls.

The v1 routes are:

```text
GET  /v1/health
GET  /v1/overview
GET  /v1/projects
POST /v1/projects
GET  /v1/jobs
POST /v1/jobs
GET  /v1/jobs/:id
POST /v1/jobs/:id/run
GET  /v1/proposals/:id
POST /v1/integration/proposals
GET  /v1/approvals
POST /v1/approvals
POST /v1/integration/:proposal/run
GET  /v1/attention
POST /v1/reconcile
```

**CTL-CMD-002** The command contract MUST remain separate from HTTP route matching so another
adapter can translate into the same bounded operations without inheriting HTTP as authority.

**CTL-CMD-003** Malformed bodies, unknown routes, and identity-spoofing fields MUST be rejected
before a dispatcher command is invoked.

## Durable request identity

**CTL-REQ-001** Every mutation MUST carry a non-empty `request_id` in `X-Request-Id`.

**CTL-REQ-002** Before executing a mutation, the service MUST durably append an immutable intent
binding `request_id`, command, canonical argument digest, principal, and origin.

**CTL-REQ-003** Reuse of a `request_id` with any different binding MUST fail with
`REQUEST_CONFLICT` and MUST NOT execute a command.

**CTL-REQ-004** A completed request MUST have one immutable terminal result. Exact retries MUST
return the recorded result without repeating the side effect.

**CTL-REQ-005** Concurrent exact retries MAY wait for the first owner. If no terminal result becomes
available within the bounded wait, they MUST return `REQUEST_UNCERTAIN`; they MUST NOT redispatch.

**CTL-REQ-006** After restart, an intent without a terminal result MUST remain uncertain. Restart or
transport disconnect MUST NOT grant permission to repeat its side effect.

**CTL-REQ-007** Failure to persist a success receipt after a mutation returns success MUST leave the
request without a terminal result and return `REQUEST_UNCERTAIN`. It MUST NOT manufacture a failed
receipt. A command error explicitly classified as uncertain MUST receive the same treatment.

**CTL-REQ-008** The CLI MUST print a mutation's request identity before sending it. When transport
or receipt state is uncertain, the CLI MUST show how to retry the exact command with that identity.

**CTL-REQ-009** A duplicate request whose original is still executing in this process MUST be
reported as in progress, not as uncertain. Intent without a receipt has two meanings: nobody working
on it, which is genuinely unknown, and still running, which is merely unfinished. Only the first
warrants `REQUEST_UNCERTAIN`, because that word directs an operator toward inspection or recovery.
Mutations that outlast the bounded wait are ordinary -- running a worker takes far longer -- so the
CLI's own retry advice would otherwise manufacture false uncertainty on every one of them.

## Local transport

**CTL-HTTP-001** The bootstrap server MUST bind to loopback by default and require a bearer token.

**CTL-HTTP-002** Request bodies MUST be bounded and parsed as JSON objects.

**CTL-HTTP-003** `delegate-wave serve` MAY run in the foreground. The Windows supervisor MAY decrypt
the current user's protected operator and observer credential records and run that same entry point
as a least-privilege logon task. Remote exposure, TLS termination, and multi-user authentication remain outside this
slice.

## Traceability

| Normative rules | Enforced by | Tested by |
|---|---|---|
| CTL-AUTH-001 | `ControlClient`-only CLI imports and no fallback | unavailable-API/static-import test |
| CTL-AUTH-002–004 | bearer check and server context | spoofing and bound-identity tests |
| CTL-AUTH-005 | scrubbed generic child environment | subprocess and full validation/integration tests |
| CTL-AUTH-006 | observer authentication scope | observer query/mutation and equal-token tests |
| CTL-CMD-001–003 | route and command allowlists | malformed/unknown/no-dispatch tests |
| CTL-REQ-001–008 | immutable intent/result tables, split receipt handling, and visible CLI request IDs | duplicate, concurrent, disconnect, conflict, restart, receipt-fault, uncertain-error, and CLI retry tests |
| CTL-REQ-009 | in-flight request tracking | `control.test.js` (running retry reports in progress; nothing in flight still reports uncertain) |
| CTL-HTTP-001–003 | local HTTP server and bounded parser | HTTP contract tests and full integration flow |

## Deferred

This slice does not implement remote access, Hermes mutation/T3 adapters, subscriptions,
cancellation, multi-principal authentication, automatic escalation, or concurrent waves.
