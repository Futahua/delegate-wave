# First self-hosting acceptance check

Date: 2026-08-14  
Scope: first self-hosting acceptance record. `delegate-wave` created, independently validated,
proposed, explicitly approved, and integrated this documentation candidate through its own
approved-integration path after PR #2. This is the first candidate promoted end-to-end by the
running system rather than by manual cherry-pick.

## Identifiers

| Role | Value |
|---|---|
| Base commit | `18b0d1373dad333148a4d8f1d45c2b4771c6092f` |
| Job / attempt | `job_adc67871-ac01-4ef2-b210-3408482771f3` / `job_adc67871-ac01-4ef2-b210-3408482771f3.1` |
| Candidate commit | `c4512a295c327d54a06388ec866aea3822f08daa` |
| Validation plan digest | `328e123c63857fd8473bd4bd3581e655b08b7440d7f5d2c31cc375607582f539` |
| Proposal | `proposal_4918b841-7759-44ba-9651-27883c70b635` |
| Approval receipt | `approval_11e6163d-b915-49d9-b7fb-dd5d680b56ca` |
| Integration run | `integration_op_c9ae5753-2905-444e-b3a7-9355008c5b2c` |
| Integration head | `758e9705b556ce2b6fcb7c09165cf5c13abb7787` |

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

- [x] Candidate commit exists and descends from the base commit.
- [x] Independent validation passed from the stored plan snapshot.
- [x] Proposal recorded with exact action digest and matching validation-plan digest.
- [x] Approval granted by an explicit operator command and consumed exactly once.
- [x] Integration succeeded with `INTEGRATION_SUCCEEDED` / `PROPOSAL_INTEGRATED` terminal records.
- [x] Integration head equals the expected head; user checkout is unmodified.
- [x] `delegate-wave doctor` reports healthy; `git diff --check` on the candidate is clean.
- [x] `docs/SELF-HOSTING-CHECK.md` is the only file the candidate changed.

## Notes

- Two earlier safe failed operations preceded this run: a checked-out-main attempt and a flaky
  validation attempt. The deterministic concurrency-test fix was merged as PR #3 at
  `f8f3511af5ffbd0e95497dc4724a74e91758e0a8`; neither failure moved `main`.
