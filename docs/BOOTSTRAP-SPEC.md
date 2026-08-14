# delegate-wave Bootstrap Specification

Status: implemented bootstrap baseline, not the complete system specification.

The key words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are normative.

## Authority and truth

**AUTH-001** Natural-language worker output MUST NOT directly mutate authoritative lifecycle state.

**AUTH-002** A worker MUST NOT be able to expand its tool permissions through repository content.

**TRUTH-001** SQLite MUST be the operational source of truth for projects, jobs, attempts, validation runs, and events.

**TRUTH-002** Git commits MUST be the source of truth for candidate code.

## Jobs and attempts

**ATT-001** One attempt MUST have one immutable attempt identity, one scheduler epoch, and one worktree path.

**ATT-002** An attempt MUST have at most one terminal executor state.

**ATT-003** Only `SUCCEEDED`, `FAILED`, `CANCELLED`, `INTERRUPTED`, and `ORPHANED` are terminal executor states.

**ATT-004** An event whose attempt epoch differs from the current scheduler epoch MUST NOT mutate that attempt.

**ATT-005** A failed or orphaned attempt MUST NOT be reused for a later attempt.

**ATT-006** A job MUST stop at `NEEDS_ATTENTION` after its configured attempt limit is reached.

**ATT-007** Bootstrap job claim, conflict detection, epoch acquisition, attempt creation, and job transition to `RUNNING` MUST occur in one immediate transaction.

**ATT-008** A lifecycle-active attempt is one with `terminal_state IS NULL` or with `terminal_state = 'SUCCEEDED'` and `validation_state = 'PENDING'`.

**ATT-009** A job claim MUST refuse while any lifecycle-active attempt or `RUNNING` job exists and MUST NOT advance the scheduler epoch on refusal.

**ATT-010** Attempt creation MUST persist the owning scheduler process identity in the same transaction as epoch acquisition.

**ATT-011** Executor intent MUST be persisted on the attempt row before backend launch; PID publication and terminal results MUST match that intent.

**ATT-012** Reconciliation MUST fail closed when executor intent exists without an executor PID receipt because whether the backend process spawned is uncertain.

## Filesystem and Git

**FS-001** Filesystem location MUST NOT determine lifecycle state or authority.

**FS-002** A write attempt MUST execute in a detached linked Git worktree created from the job's recorded base commit.

**FS-003** An unsuccessful attempt MUST be retained as quarantined evidence until a separate cleanup policy removes it.

**FS-004** Protected-path changes and Git-metadata changes MUST reject the candidate.

## Worker permissions

**WRK-001** Bootstrap workers MAY read and edit only inside their attempt worktree.

**WRK-002** Bootstrap workers MUST NOT receive shell, external-directory, web, skill, question, or subagent permission.

**WRK-003** Validation commands MUST run under dispatcher control after executor completion.

**WRK-005** Every executor attempt MUST record one immutable usage receipt describing what was
observed of its provider consumption. The receipt MUST be written before an executor failure,
timeout, protected-path rejection, empty candidate, or validation failure is converted into a
lifecycle outcome, because those attempts consume tokens and belong in cost per validated candidate.

**WRK-006** A usage receipt is an observation, never authority. It MUST NOT cause an attempt to
succeed, satisfy validation, or authorize integration. The raw executor artifact remains the audit
source; the receipt is a compact projection of it.

**WRK-007** Absent usage MUST be recorded as `UNKNOWN` with null numeric fields, never as zero. A
provider receipt explicitly reporting no usage is `COMPLETE` with zeroes. Usage observed alongside a
malformed or truncated accounting is `PARTIAL`, retaining what was observed. If normalization fails,
the raw artifact MUST be preserved and the receipt MUST record `UNKNOWN` rather than guessed numbers.

**WRK-008** Reported cost and reference cost MUST remain distinct facts. A reported cost MUST carry
its provenance, because an executor-computed figure is not a provider bill; it MUST be null when
none is reported, never zero. Reference cost MUST be derived by delegate-wave, never by a backend,
from observed tokens against a pinned append-only pricing basis whose identifier is stored beside the
number. A basis MUST NOT invent a rate for a dimension its provider does not publish: an observation
using an unpriced dimension MUST yield a null reference cost. A reference cost MUST NOT overwrite a
reported cost.

**WRK-009** A usage-capture failure MUST NOT fail the attempt, and MUST NOT be silent. It MUST leave
a durable record.

Measurement health MUST distinguish two questions over the attempts that reached executor intent.
A dataset is *accounted* when every such attempt has either a usage receipt or an explicit
capture-failure record, so nothing vanished silently. A dataset is *healthy* only when every such
attempt carries a receipt that can actually support a cost total: `COMPLETE` status with a non-null
reference cost.

The existence of a receipt row is therefore not sufficient for health. A capture failure, an
`UNKNOWN` receipt, a `PARTIAL` receipt, and a `COMPLETE` receipt the pricing basis could not price are
each accounted for but leave the dataset unhealthy, because none yields a defensible cost for the
attempt it describes. Coverage MUST report those categories separately so the reason is mechanical
rather than inferred.

A cost-per-validated-candidate result MUST NOT be accepted over a dataset that is not healthy.
Attempts that never reached executor intent MUST be excluded from this coverage, since they invoked
no backend and consumed no provider usage.

**WRK-010** A backend is untrusted for measurement exactly as it is untrusted for success. The
finalizer MUST validate a backend-supplied observation before it can become a receipt, rejecting
non-integral or negative dimensions, a positive step count under `UNKNOWN`, and a reported cost whose
provenance disagrees with it. An invalid observation MUST become a visible capture failure rather
than a plausible but corrupt receipt.

**WRK-011** The five usage dimensions -- input, output, reasoning, cache-read, cache-write -- MUST be
disjoint, and `output_tokens` MUST mean non-reasoning generated output. Providers disagree on this:
some report reasoning tokens separately from generated output, while the DeepSeek wire protocol
reports reasoning as a subset of its completion total. A backend adapter MUST convert to the
canonical disjoint form, and MUST record a malformed observation rather than a plausible one when the
provider's report is incoherent. Pricing MUST remain backend-independent: the same real usage MUST
cost the same regardless of which executor reported it.

**WRK-004** Every executor attempt MUST have a dispatcher-resolved, provider-qualified model
persisted before the attempt launches. An execution backend MUST fail closed rather than fall back to
an ambient model or provider, so a caller that bypasses dispatcher routing cannot reopen
non-deterministic provider selection. Routing remains explicit: DeepSeek Flash is the default bulk
worker, Luna the focused review and debugging lane, and DeepSeek Pro the escalation lane.

## Validation

**VAL-001** Executor exit success MUST NOT imply validation success.

**VAL-002** Every registered validation command MUST exit successfully before a write job enters `READY_FOR_INTEGRATION`.

**VAL-003** A failed validation MUST quarantine the candidate and MUST NOT place it in the integration queue.

**VAL-004** Automatic integration MUST NOT occur in the bootstrap release.

**VAL-005** An interrupted pending validation recovered during reconciliation MUST be classified as `validation_state = 'FAILED'`, quarantined, and reported via the `VALIDATION_INTERRUPTED` event.

**VAL-006** A validation MUST record fenced durable intent on its attempt row before spawning its command, and the spawned validator PID MUST be published through a fenced callback before its result can become authoritative.

**VAL-007** Reconciliation MUST fail closed when validation intent exists without a validator PID receipt because whether the command spawned is uncertain.

## Recovery

**REC-001** Reconciliation MUST be read-only unless the operator explicitly requests application.

**REC-002** Applied reconciliation MUST acquire a new scheduler fencing epoch before mutating abandoned attempts.

**REC-003** Reconciliation MUST NOT recover an attempt while any recorded scheduler, executor, or validator process is still alive.

**REC-004** A dead nonterminal attempt MAY be transitioned to `ORPHANED` without consulting a model.

**REC-005** Applied reconciliation MUST NOT advance the scheduler epoch if any recorded scheduler, executor, or validator process is alive.

**REC-006** `doctor` and `reconcile` MUST detect both the executor-running (`terminal_state IS NULL`) and validation-pending (`SUCCEEDED` with `PENDING`) lifecycle phases.

**REC-007** Applied reconciliation MUST classify an interrupted validation-pending attempt as `validation_state = 'FAILED'`, quarantine it, emit `VALIDATION_INTERRUPTED`, and return the job to `PENDING` or `NEEDS_ATTENTION` by attempt limit.

**REC-008** Process-liveness probing MUST treat only definite process nonexistence as dead; access denial or an unknown probe failure MUST be treated as alive.

**REC-009** Authoritative reconciliation MUST invoke process probing with only a PID argument; collection callback metadata MUST NOT be interpreted as a probe implementation.

## Traceability

| Normative rules | Enforced by | Tested by |
|---|---|---|
| AUTH-001, TRUTH-001 | `Dispatcher`, SQLite transactions | all dispatcher tests |
| AUTH-002, WRK-001, WRK-002 | runtime `OPENCODE_CONFIG_CONTENT` policy | disposable live OpenCode Go canary; `CANARY-REPORT.md` |
| ATT-001–ATT-003 | SQLite constraints and attempt creation transaction | successful and failed worker tests |
| ATT-004 | fenced executor, validation, failure, and PID callbacks | stale epoch and stale callback tests |
| ATT-005, ATT-006 | immutable attempt ordinal and bounded job retry | bounded failure test |
| ATT-007–ATT-012 | `runJob` immediate claim transaction, lifecycle-active predicate, scheduler PID and executor intent/PID receipts | invalid invocation, live executor, uncertain executor start, blocked validation, and direct predicate tests |
| FS-001–FS-003 | database state, detached locked worktrees | worker and reconciliation tests |
| FS-004 | `assertAllowedDiff` | protected path test |
| WRK-003, VAL-001–VAL-003 | `validate`, `validation_state` | validation failure test |
| WRK-004 | `Dispatcher.resolveModel` persists the resolved model; `OpenCodeBackend` refuses an absent model | default-model resolution test; unrouted-backend refusal test; distinct-lane test; live no-model run recorded in the proposal dogfood |
| WRK-005 | `recordAttemptUsage` runs immediately after the backend returns, before failure conversion | failed-attempt usage test; validation-failure retention test; immutability triggers |
| WRK-006 | receipts live in their own table and are never read by acceptance logic | failed-attempt test asserting the attempt stays FAILED; idempotent re-record test |
| WRK-007 | `parseOpenCodeUsage` status states with null numeric fields under UNKNOWN, enforced by a schema CHECK | UNKNOWN/PARTIAL/COMPLETE parser tests; missing-artifact test; live historical normalization |
| WRK-008 | `pricing.js` pinned append-only bases; separate reported and reference columns with cost provenance | separate-facts receipt test; unknown-model, unknown-basis, and unpriced-cache-write null tests; published-rate check; superseded-basis test |
| WRK-009 | `recordAttemptUsage` emits `USAGE_RECEIPT_FAILED`; `usageCoverage` separates accounted from healthy and scopes to `EXECUTOR_INTENDED` | capture-failure invalidates health test; unexplained-gap test; pre-executor-attempt exclusion test |
| WRK-010 | `assertValidObservation` runs in the finalizer before any receipt is written | finalizer rejection test; invalid-backend-observation dispatcher test; conflicting-duplicate-id test |
| WRK-011 | `canonicalizeNestedReasoning` converts subset-style reports; pricing sums disjoint dimensions | nested-reasoning canonicalization test; cross-arm equal-pricing test proving the naive mapping inflates one arm |
| VAL-004 | absence of integration command | interface conformance review |
| VAL-005–VAL-007, REC-001–REC-009 | fenced row-level intent/PID receipts, fail-closed liveness probe, explicit PID callback, `doctor`, `reconcile`, `VALIDATION_INTERRUPTED` | dead recorded PID, live owners, uncertain executor/validator starts, genuine blocked-validator, and interrupted validation recovery tests |

## Known bootstrap limitations

- OpenCode permission enforcement passed the documented disposable live-model canary; this evidence applies to the tested runtime configuration and is not a general OS sandbox guarantee.
- The scheduler runs one CLI-owned attempt at a time; wave concurrency is not implemented.
- PID liveness cannot prove that a remote or attached OpenCode session has stopped. Reconciliation therefore refuses live recorded processes and never attaches a replacement mid-attempt.
- Candidate integration remains a human/Codex operation.
- Semantic blockers and Hermes/T3 adapters are not part of this baseline. Approved integration and the local Control API are specified separately.
