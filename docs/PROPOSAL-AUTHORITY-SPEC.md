# Proposal-only work authority

Hermes may express intent in ordinary language. It may never grant itself authority. This slice adds
a third principal that can request bounded work and nothing else, plus the explicit human-authorized
bridge that turns one exact proposal into one job.

```text
Hermes (proposal credential)  -> create bounded work proposal
human operator (operator credential) -> authorize or reject that exact proposal
authorized proposal -> exactly one job -> worker -> deterministic validation
                    -> integration approval -> integration
Hermes (observer credential) -> observe completion
```

## Scopes

**PROP-001** Control API authority MUST be granted by enumerated scopes, not by a read-only flag.
Every route MUST declare the scope it requires, and a route with no declared scope MUST be treated as
requiring `operate`.

**PROP-002** The three principals hold fixed scope sets. A request MUST NOT select, widen, or
influence its own scopes.

```text
operator  read, propose, operate
proposer  read, propose
observer  read
```

**PROP-003** The proposal credential MUST be distinct from both the operator and observer
credentials, and the server MUST refuse to start if any two are equal.

**PROP-004** The proposal credential MUST be rejected on every `operate`-scoped route: project
creation, job creation, job run, integration proposal, approval grant, integration run, reconcile,
and work-proposal authorization or rejection. Supervisor operations remain CLI-only and are not
exposed through the Control API at all.

## Proposals

**PROP-005** A work proposal MUST record origin identity taken from the authenticated credential,
never from the request body, and MUST carry an action digest, an expected state version, an expiry,
an idempotency identity, and an optional cost ceiling.

**PROP-006** Creating a work proposal MUST NOT cause any job, attempt, validation, approval, or
integration lifecycle transition. A proposal is a request, not work.

**PROP-007** Re-sending an identical proposal under the same idempotency key MUST return the same
proposal identity. A different action under an existing key MUST be refused. The action digest MUST
therefore be derived from the requested action alone, excluding server-defaulted values such as an
expiry read from the clock.

**PROP-008** Work proposals and their decisions MUST be immutable once written, enforced in the
database rather than by convention.

## Authorization

**PROP-009** Only an `operate`-scoped credential may authorize or reject a work proposal.
Authorization is the human gate: it MUST record the deciding identity and MUST be the only path by
which a proposal becomes a job.

**PROP-010** Authorization MUST refuse an expired proposal, a proposal whose expected state version
no longer matches the project, and a proposal whose stored action digest does not re-derive from its
own recorded intent.

**PROP-011** Authorization MUST be idempotent: re-authorizing an already-authorized proposal MUST
return the same job rather than create a second one. A rejected proposal MUST NOT later become work.

## Traceability

| Normative rule | Enforced by | Tested by |
|---|---|---|
| PROP-001–002 | per-route `scope` and fixed `PRINCIPAL_SCOPES` | route-scope declaration test; scope-set test |
| PROP-003 | distinctness checks in `createControlServer` | three-principal distinctness test |
| PROP-004 | server scope check before dispatch | route-table-driven operator-surface refusal test; MCP adapter reachability test |
| PROP-005 | server-derived identity; `rejectIdentity` on bodies | origin-identity and spoofing-refusal tests |
| PROP-006 | proposal insert performs no lifecycle transition | acceptance test asserts no job exists after proposing |
| PROP-007 | digest excludes expiry; unique idempotency key | idempotent-proposal test; conflicting-reuse refusal |
| PROP-008 | immutability triggers on both tables | schema triggers; existing immutability pattern |
| PROP-009 | `operate` scope on authorize/reject routes | acceptance test proves Hermes cannot authorize |
| PROP-010 | expiry, state-version, and digest re-derivation checks | expired and superseded proposal tests |
| PROP-011 | decision row keyed by proposal id | idempotent-authorization and rejected-proposal tests |

## Deferred

Proposal-time cost enforcement against real spend, multi-step proposals, proposal amendment, and any
Hermes-initiated execution remain out of scope. The cost ceiling is recorded and bounded but is not
yet compared against measured worker cost.
