# First self-hosting acceptance check

Date: 2026-08-14  
Scope: first self-hosting acceptance record. `delegate-wave` created, independently validated,
proposed, explicitly approved, and integrated this documentation candidate through its own
approved-integration path after PR #2. This is the first candidate promoted end-to-end by the
running system rather than by manual cherry-pick.

## Identifiers (operator fills after execution)

| Role | Value |
|---|---|
| Base commit | `<BASE_COMMIT>` |
| Job / attempt | `<JOB_ID>` / `<ATTEMPT_ID>` |
| Candidate commit | `<CANDIDATE_COMMIT>` |
| Validation plan digest | `<VALIDATION_PLAN_DIGEST>` |
| Proposal | `<PROPOSAL_ID>` |
| Approval receipt | `<APPROVAL_ID>` |
| Integration run | `<OPERATION_ID>` |
| Integration head | `<INTEGRATION_HEAD>` |

## Safety invariants exercised

- **Managed attempt worktree**: the candidate was produced inside the locked, detached attempt
  worktree; only `docs/SELF-HOSTING-CHECK.md` was changed.
- **Exact validation snapshot**: the ordered validation plan was snapshotted at proposal time and
  re-executed from the stored snapshot before integration.
- **Immutable approval**: an exact-digest approval receipt was granted and consumed, granting no
  authority broader than the proposal's action digest.
- **Managed integration worktree**: integration cherry-picked the candidate in a clean detached
  worktree under the managed integration root.
- **Guarded CAS**: the integration branch advanced only via a guarded local receive-pack
  compare-and-swap against the expected head.
- **Untouched user checkout**: the user's checkout was not modified by creation, validation, or
  integration.

## Verification checklist

- [ ] Candidate commit exists and descends from the base commit.
- [ ] Independent validation passed from the stored plan snapshot.
- [ ] Proposal recorded with exact action digest and matching validation-plan digest.
- [ ] Approval granted by an explicit operator command and consumed exactly once.
- [ ] Integration succeeded with `INTEGRATION_SUCCEEDED` / `PROPOSAL_INTEGRATED` terminal records.
- [ ] Integration head equals the expected head; user checkout is unmodified.
- [ ] `delegate-wave doctor` reports healthy; `git diff --check` on the candidate is clean.
- [ ] `docs/SELF-HOSTING-CHECK.md` is the only file the candidate changed.
