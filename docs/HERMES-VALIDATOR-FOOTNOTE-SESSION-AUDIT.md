# Hermes validator-footnote session audit

Date: 2026-08-31 (Asia/Saigon)

## Outcome

The implementation produced by the final worker is a narrow, test-passing candidate when compared with the intended Backpack head. The autonomous session itself is correctly paused at `WAITING_FOR_HERMES` and must not be accepted as-is: Delegate Wave rooted the job on the registered project's `main` branch rather than the branch and SHA named in the Hermes request. The registered validation contract also conflicts with the requested source-only change.

No answer was sent to the outstanding Hermes question, no integration was approved, and no Backpack commit was pushed by this audit.

## Durable identity and state

| Record | Value |
| --- | --- |
| Hermes conversation | `20260831_181819_0e1fd9` |
| Autonomous session | `asess_1ade6f45-6780-4164-bf7e-70783aa90b52` |
| Root job | `job_288d515c-0dfa-4abb-9a5c-184796c6b881` |
| Project registration | `delegate-wave-backpack-b2f046` |
| Manager run | `mrun_2e7df945-70fd-450b-b057-c39449a83198` |
| Session state | `WAITING_FOR_HERMES` |
| Manager state | `AWAITING_HUMAN` |
| Root job state | `NEEDS_ATTENTION` |
| Outstanding question | Manager requested revision 3 after the configured maximum of 2 |

The registered repository path is the historical junction
`D:\Letters\MatTroiSeConMoc\Papers\Backpack projects\Delegate Wave`. Its native real path is the intended repository at
`D:\Letters\MatTroiSeConMoc\Products\Papers\Runtime\Backpack projects\Delegate Wave`.

## Process and turn chain

The session spawned one explorer followed by three implementation attempts:

| Kind | Durable ID | Result |
| --- | --- | --- |
| Explorer job | `job_15fcf03e-98f0-46f3-9d4f-e1f59d6d8afd` | attempt `.1`, `SUCCEEDED` |
| Implementation 1 | `job_288d515c-0dfa-4abb-9a5c-184796c6b881.1` | candidate `151c7b053b406d891c642bf3c8bfdb072a2cb99b`; validation passed against the wrong base |
| Implementation 2 | `job_288d515c-0dfa-4abb-9a5c-184796c6b881.2` | candidate `742469c8691ceec88f6950348e2c05b60625eb3c`; generated-public check failed |
| Implementation 3 | `job_288d515c-0dfa-4abb-9a5c-184796c6b881.3` | candidate `69eb66148e7b28454cdcf5a0154237faf1934d87`; generated-public check failed |

Manager turns:

1. `mturn_7b898...` — PLAN / EXPLORE.
2. `mturn_4df056...` — SYNTHESIS / ESCALATE after the explorer saw the wrong tree.
3. `mturn_b2cec...` — PLAN / IMPLEMENT after Hermes supplied the requested branch and SHA in prose.
4. `mturn_4a179...` — REVIEW / REVISE implementation 1.
5. `mturn_8130...` — REVIEW / REVISE implementation 2.
6. `mturn_d307...` — REVIEW / REVISE implementation 3, exhausting the revision allowance.

Two durable wakes were delivered and finished: `wake_16701244...` for the initial branch question and `wake_ee16e2ac...` for the maximum-revisions question.

## Primary orchestration defect: requested branch did not bind the session base

The Hermes request specified Backpack branch `codex/live-work-ui` at
`f0839192847ab7741394ebb8de81cbd0c9f05731`. The actual repository was clean at that SHA before and after this run.

The project registration, however, names integration branch `main`. Delegate Wave captured root base
`f48b8346fa290fb27e526de1d02e08a2ef5f2001`. The later Hermes answer correctly repeated the desired branch/path/SHA, but `session_answer` prose cannot change an already-created job's authoritative base. Every subsequent worker inherited the wrong base.

This is why manager REVIEW reported hundreds of unrelated changed files. For example, implementation 1 appeared as 358 changed files relative to `f48b834...`, even though the final implementation is narrow relative to the requested head.

Required control-plane correction:

- A repository session must bind its requested starting ref/SHA before the root job is created, or reject the request when it conflicts with the registered integration branch.
- A Hermes clarification must not claim that a branch correction took effect unless durable job state proves it.
- Session presentation and REVIEW should expose requested ref, registered integration branch, and captured base SHA together when they differ.

## Secondary contract defect: source-only scope conflicts with registered validation

The project registration runs, in order:

1. `npm ci`
2. `npm run build`
3. `git diff --exit-code -- public`
4. `npm test`

The task required changes only to `src/timeline/SessionTimeline.tsx`, `src/ui/styles.css`, and `test/session-timeline.behavior.test.tsx`, with `public` remaining byte-for-byte unchanged. But `npm run build` regenerates tracked `public` assets from the requested UI source change. Attempts 2 and 3 therefore passed install and build, then failed the public cleanliness gate before `npm test` ran.

The contract must choose one coherent delivery rule:

- generated `public` output is part of a UI candidate and may be committed, or
- build output is written elsewhere/cleaned before the public cleanliness assertion, leaving the source-only candidate unchanged.

Until that is decided, a worker cannot simultaneously satisfy the requested three-file scope and all registered validations.

## Final candidate audit against the intended head

Comparing the final candidate `69eb66148e7b28454cdcf5a0154237faf1934d87` to the intended starting SHA `f0839192847ab7741394ebb8de81cbd0c9f05731` yields exactly three changed files, 34 insertions and 5 deletions:

- `src/timeline/SessionTimeline.tsx`
- `src/ui/styles.css`
- `test/session-timeline.behavior.test.tsx`

The implementation:

- recognizes only collapsed, completed, non-failed validator spans as receipt cards;
- derives a concise command-based line such as `Run npm test · passed`;
- suppresses the redundant collapsed body for that settled state;
- preserves expansion through the existing header button and `aria-expanded` behavior;
- leaves live, failed, and waiting validators on the full consequential-card path;
- adds a dedicated `validation-receipt` class and muted, compact styling based on existing validator color tokens;
- adds behavior coverage for receipt rendering and consequential-state preservation.

Independent audit execution in the final attempt worktree:

```text
npm test
Test Files  13 passed (13)
Tests       77 passed (77)
Duration    9.27s
```

The attempt worktree retained only the expected dirty generated `public` artifacts from the prior build. The source candidate itself was not modified by this audit.

## Review gate and recovery recommendation

Do not answer the current session with “accept as-is.” Its authoritative base and validation history are not trustworthy representations of the requested branch.

The final candidate is suitable for focused human/code review as a recoverable patch relative to `f083919...`. If accepted, reproduce or cherry-pick only that three-file delta in a fresh correctly rooted session or ordinary Backpack branch workflow, then apply the repository's chosen generated-asset policy and run the complete coherent validator set.

This audit does not authorize integration, publication, project-registration mutation, session failure, or a new worker run.
