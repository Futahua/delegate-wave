# delegate-wave Approved-Integration Specification

Status: implemented approved-integration vertical slice, additive to the bootstrap baseline.

The key words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are normative. All digests are
SHA-256 hex over a canonical `\n`-joined record.

## Proposals

**INT-001** An integration proposal MUST exist only for a write job in `READY_FOR_INTEGRATION`.

**INT-002** A proposal MUST select exactly one candidate attempt with
`terminal_state = 'SUCCEEDED'` and `validation_state = 'PASSED'`.

**INT-003** A proposal MUST record an immutable action digest binding exactly
`project_id`, `job_id`, `attempt_id`, `base_sha`, `candidate_commit`,
`integration_branch`, `expected_integration_head`, and `validation_plan_digest`.

**INT-004** `expected_integration_head` MUST be the integration branch tip resolved when the
proposal is recorded.

**INT-005** A proposal MUST store the exact ordered validation command plan from proposal time and
`validation_plan_digest` MUST bind that snapshot. Later project configuration changes MUST NOT
change the commands executed for the proposal.

**INT-006** Malformed project validation configuration MUST be rejected before a worker attempt is
claimed. Malformed proposal validation JSON MUST be rejected rather than interpreted as no checks.

**INT-007** One attempt MUST have at most one proposal. Re-proposing the same candidate MUST
return the existing proposal unchanged and MUST refuse if the derivable digest differs.

## Approvals

**APP-001** An approval receipt MUST be immutable in its granted authority: it grants exactly the
proposal's action digest and nothing broader.

**APP-002** An approval MUST record the granting principal, origin channel, expected state version,
granted scope, optional maximum cost, and optional expiry. For this slice, the expected state
version is the action digest and the only granted scope is `integration`.

**APP-003** Repeating a grant for the same principal and unconsumed proposal MUST return the
existing receipt. Reusing an idempotency key MUST return the existing receipt and MUST refuse if
the key was used for a different digest or proposal.

**APP-004** A proposal MUST NOT be integrated without at least one unconsumed, unexpired
approval whose granted digest equals the proposal's action digest.

## Integration runs

**INT-RUN-001** An integration run MUST atomically select one unexpired, unconsumed approval and
record durable immutable operation intent in one immediate transaction. The operation's reference
to that receipt constitutes consumption.

**INT-RUN-002** A run MUST refuse while any `INTENDED` operation exists for the proposal.

**INT-RUN-003** A run MUST refuse if the integration branch is checked out in any worktree.

**INT-RUN-004** A run MUST refuse if the current integration branch tip differs from the
proposal's `expected_integration_head`.

**INT-RUN-005** A run MUST recompute the digest of the stored validation-plan snapshot, refuse if
the snapshot no longer matches its digest, and MUST execute only that stored snapshot.

**INT-RUN-006** A run MUST verify the candidate descends from `base_sha` before proceeding.

**INT-RUN-007** A run MUST operate in a clean detached worktree under the managed integration
root and MUST NOT touch the user's checkout.

**INT-RUN-008** A run MUST cherry-pick the candidate and then execute the snapshotted
deterministic validation plan in that worktree before advancing any branch.

**INT-RUN-009** The integration branch MUST be advanced only by a local receive-pack transaction
that both refuses a branch checked out in any worktree and compare-and-swaps against
`expected_integration_head` (`--force-with-lease=<ref>:<expected-old>`).

**INT-RUN-010** After operation intent is durable, any pre-CAS or CAS failure MUST leave the branch
tip unchanged and append an `INTEGRATION_FAILED` terminal record. A failed proposal remains `OPEN`
and MAY be retried only with a fresh approval and a new operation.

**INT-RUN-011** A successful run MUST append `INTEGRATION_SUCCEEDED` and `PROPOSAL_INTEGRATED`
records containing the new head and transition the job to `SUCCEEDED`. Operation and proposal
status MUST be derived from immutable records; their stored intent rows MUST NOT be mutated.

**INT-RUN-012** Re-running a successful proposal MUST be idempotent: it returns the recorded
success and consumes no additional approval.

**INT-RUN-013** An operation intent without an immutable terminal record MUST fail closed and MUST
NOT be rerun automatically.

**INT-RUN-014** The scheduler MUST append `BRANCH_ADVANCE_INTENDED` before the ref transaction. If
the ref transaction reports an error, the scheduler MUST inspect the authoritative ref. It MAY
append `INTEGRATION_FAILED` only when the ref still equals the expected old head. If the ref
advanced, diverged, cannot be read, or a later receipt write fails, it MUST NOT append
`INTEGRATION_FAILED`; the operation remains uncertain and requires deterministic reconciliation.

## Traceability

| Normative rules | Enforced by | Tested by |
|---|---|---|
| INT-001–INT-007 | strict plan parsing, `Dispatcher.proposeIntegration`, `UNIQUE(attempt_id)`, action digest | malformed-config, proposal readiness, snapshot, and happy-path tests |
| APP-001–APP-004 | `Dispatcher.grantApproval`, stored `granted_digest`, `UNIQUE(idempotency_key)` | missing-approval and expired-approval tests |
| INT-RUN-001–INT-RUN-002 | immediate claim transaction with approval consumption and `INTENDED` operation | happy-path and validation-failure tests |
| INT-RUN-003 | `git worktree list --porcelain` branch check | checked-out-elsewhere test |
| INT-RUN-004 | `resolveRevision` comparison | stale-head test |
| INT-RUN-005 | stored plan snapshot and re-derived digest comparison | snapshot and tamper tests |
| INT-RUN-006 | `git merge-base --is-ancestor` | happy-path test |
| INT-RUN-007–INT-RUN-008 | integration-root detached worktree, cherry-pick, validation re-run | happy-path and validation-failure tests |
| INT-RUN-009–INT-RUN-010 | guarded local receive-pack CAS, immutable failure record | checked-out-branch, stale-head, ancestry, validation-failure, and no-branch-movement tests |
| INT-RUN-011–INT-RUN-014 | immutable terminal records, derived status, post-CAS fail-closed handling, idempotent early return | happy-path, immutability, stuck-intent, post-CAS failure, and idempotency tests |

## Out of scope for this slice

A daemon, API, concurrency, T3/Hermes adapters, deployment, dependencies, and a generic policy
engine remain outside this worktree. Automatic approval also remains out of scope: an approval
must always be granted by an explicit operator command.
