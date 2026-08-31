# CP1 physical visual-demo acceptance — 2026-08-31

Result: **PASS**, with one separate Hermes presentation caveat recorded below.

## Deployment and fixture

- Reviewed Delegate Wave source: `2373ce874b8b334e2a35d741e0aee6a437bba3c5`.
- Supported supervisor stop/start loaded that source as PID 51892 at 17:53:11
  Asia/Saigon.
- Doctor was healthy before and after the run: SQLite integrity `ok`, no running
  attempts, missing repositories or unresolved integrations.
- Papers remained running with the preserved data-directory argument.
- Observed Hermes MCP processes used
  `Products/DelegateWave/Current/src/cli.js`.
- Disposable repository: `D:/Programs/evTEMP/dw-visual-demo-cp1-20260831`.
- Registered project: `dw-visual-demo-cp1-20260831-ee38d3`.
- Baseline/main stayed at `3451f22112b0218e475fc708a18beb483f2a7ca6`.
- Registered validation was exactly `["npm test"]`; `package.json` was protected.

## Durable workflow evidence

- Hermes conversation: `20260831_175451_d81bff`.
- Autonomous session: `asess_953508cd-4c8a-41bc-8e75-627b14f2ec30`.
- Root job: `job_e5d36cc3-86f1-471a-a0be-bb2939e914c9`.
- Manager run: `mrun_a5165035-8763-4c42-9fe8-e909aba1e0b2`.
- PLAN: `mturn_8edb60a1-40fd-4c63-b124-5afa0cf4be28`, action `EXPLORE`.
- Explorer A: job `job_1de0dd81-84e4-4159-9416-3f6e65acb4e5`, attempt
  `job_1de0dd81-84e4-4159-9416-3f6e65acb4e5.1`, `SUCCEEDED`.
- Explorer B: job `job_3573317c-adfe-4745-be97-b924c3f2f28b`, attempt
  `job_3573317c-adfe-4745-be97-b924c3f2f28b.1`, `SUCCEEDED`.
- The explorers started 39 ms apart and genuinely overlapped. Their durable goals
  contain only repository-relative file references.
- SYNTHESIS: `mturn_a83d07d9-41f8-4e42-a663-7019ad11ffaa`, action `IMPLEMENT`.
- Implementation: `job_e5d36cc3-86f1-471a-a0be-bb2939e914c9.1`, `SUCCEEDED`.
- Candidate commit: `85dc64915d00bc0262356f9b04d9a01bcb04c7e5`.
- Candidate tree: `29ea797755e6ea615f23c4dccb94f7023da5ee68`.
- Changed files: `router.js`, `test.js`.
- Validation: `validation_6acf7fdc-4758-461e-99bd-376a2f570f5e`, command
  `npm test`, exit 0, `PASSED`.
- REVIEW: `mturn_0ab80f1a-2533-4dbf-a9fe-7c05d00084f8`, action `ACCEPT`, subject
  attempt equal to the real implementation attempt.
- Final session: `SEMANTICALLY_ACCEPTED`; manager: `ACCEPTED`; root:
  `READY_FOR_INTEGRATION`.
- No integration proposal or operation exists. Disposable main is unchanged and
  clean, so the accepted MANUAL candidate remains unintegrated and unpublished.

## Wake and presentation evidence

- Watch: `wtch_0698c895-d9ef-4005-9d5f-13a976111914`.
- Wake: `wake_415f51e7-3940-4588-920e-08896557e41a`, reason `READY`.
- Wake receiver state progressed to `FINISHED`; Delegate Wave reconciled it to
  `DELIVERED` after one attempt at 17:58:03 local time.
- The exact originating Hermes conversation displayed the truthful
  `DELEGATE WAVE · READY FOR REVIEW` card.
- Papers physically showed: PLAN; two side-by-side live explorer cards; a full-width,
  bounded expanded transcript with internal scrolling; settled Markdown findings;
  SYNTHESIS; one implementation worker; validator `npm test`; and REVIEW acceptance.

The read-only explorers intentionally had file read/search tools rather than a shell.
One explorer narrated that no shell was available and unsuccessfully tried to read
external Git metadata through its `.git` worktree pointer. This did not block it:
both explorers completed from repository files, and Delegate Wave independently
owned Git/candidate and deterministic validation truth.

### Separate Hermes UI caveat

After the READY wake, Hermes displayed a transient `Regenerate failed: target user
message is no longer in session history` toast and did not render an additional
narrative assistant paragraph. Durable receiver evidence still says `FINISHED` and
the correct READY card is visible in the exact conversation. This is presentation
follow-up evidence for Hermes, not a Delegate Wave CP1 workflow failure.

## Usage and elapsed time

- Delegate Wave session start to semantic acceptance: 95.537 seconds.
- Three Luna manager turns: PLAN, SYNTHESIS, REVIEW.
- Three DeepSeek worker attempts: two explorers and one implementation.
- Worker reported costs: `$0.004207656`, `$0.005809852`, `$0.003295004`.
- Manager reference costs: `$0.0082248`, `$0.00217472`, `$0.00171778`.
- No human intervention advanced the Delegate Wave state after the initial Hermes
  request; subsequent inspection was read-only.
