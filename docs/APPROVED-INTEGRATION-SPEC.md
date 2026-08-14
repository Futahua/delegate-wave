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

**INT-005** `validation_plan_digest` MUST be the digest of the project's validation command plan
at proposal time.

**INT-006** One attempt MUST have at most one proposal. Re-proposing the same candidate MUST
return the existing proposal unchanged and MUST refuse if the derivable digest differs.

## Approvals

**APP-001** An approval receipt MUST be immutable in its granted authority: it grants exactly the
proposal's action digest and nothing broader.

**APP-002** An approval MUST record the granting principal, origin channel, and optional expiry.

**APP-003** Repeating a grant for the same principal and unconsumed proposal MUST return the
existing receipt. Reusing an idempotency key MUST return the existing receipt and MUST refuse if
the key was used for a different digest or proposal.

**APP-004** A proposal MUST NOT be integrated without at least one unconsumed, unexpired
approval whose granted digest equals the proposal's action digest.

## Integration runs

**INT-RUN-001** An integration run MUST atomically validate and consume one unexpired approval
and MUST record durable operation intent in one immediate transaction.

**INT-RUN-002** A run MUST refuse while any `INTENDED` operation exists for the proposal.

**INT-RUN-003** A run MUST refuse if the integration branch is checked out in any worktree.

**INT-RUN-004** A run MUST refuse if the current integration branch tip differs from the
proposal's `expected_integration_head`.

**INT-RUN-005** A run MUST refuse if the current validation plan digest differs from the
proposal's `validation_plan_digest`.

**INT-RUN-006** A run MUST verify the candidate descends from `base_sha` before proceeding.

**INT-RUN-007** A run MUST operate in a clean detached worktree under the managed integration
root and MUST NOT touch the user's checkout.

**INT-RUN-008** A run MUST cherry-pick the candidate and then execute the snapshotted
deterministic validation plan in that worktree before advancing any branch.

**INT-RUN-009** The integration branch MUST be advanced only by compare-and-swap against
`expected_integration_head` (`git update-ref <ref> <new> <expected-old>`).

**INT-RUN-010** Any pre-CAS or CAS failure MUST leave the branch tip unchanged and MUST record a
`FAILED` operation. A failed proposal remains `OPEN` and MAY be retried with a fresh approval.

**INT-RUN-011** A successful run MUST mark the operation `SUCCEEDED`, record the new head, mark
the proposal `INTEGRATED`, and transition the job to `SUCCEEDED`.

**INT-RUN-012** Re-running a successful proposal MUST be idempotent: it returns the recorded
success and consumes no additional approval.

**INT-RUN-013** Conflicting state (a successful operation on a non-`INTEGRATED` proposal) MUST be
refused as inconsistent.

## Traceability

| Normative rules | Enforced by | Tested by |
|---|---|---|
| INT-001–INT-006 | `Dispatcher.proposeIntegration`, `UNIQUE(attempt_id)`, action digest | proposal readiness and happy-path tests |
| APP-001–APP-004 | `Dispatcher.grantApproval`, stored `granted_digest`, `UNIQUE(idempotency_key)` | missing-approval and expired-approval tests |
| INT-RUN-001–INT-RUN-002 | immediate claim transaction with approval consumption and `INTENDED` operation | happy-path and validation-failure tests |
| INT-RUN-003 | `git worktree list --porcelain` branch check | checked-out-elsewhere test |
| INT-RUN-004 | `resolveRevision` comparison | stale-head test |
| INT-RUN-005 | re-derived plan digest comparison | stale-digest test |
| INT-RUN-006 | `git merge-base --is-ancestor` | happy-path test |
| INT-RUN-007–INT-RUN-008 | integration-root detached worktree, cherry-pick, validation re-run | happy-path and validation-failure tests |
| INT-RUN-009–INT-RUN-010 | `git update-ref` CAS, `FAILED` operation on error | stale-head and no-branch-movement tests |
| INT-RUN-011–INT-RUN-013 | success transaction, idempotent early return | happy-path and idempotency tests |

## Out of scope for this slice

A daemon, API, concurrency, T3/Hermes adapters, deployment, dependencies, and a generic policy
engine remain outside this worktree. Automatic approval also remains out of scope: an approval
must always be granted by an explicit operator command.
