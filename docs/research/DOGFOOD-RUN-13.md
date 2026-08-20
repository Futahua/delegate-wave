# Dogfood run 13 — the loop closes end to end, and the first candidate lands

Same objective throughout (1458 chars, unmodified), `--model
opencode-go/gpt-5.6-luna`, `opencode-go/deepseek-v4-flash` workers, revision cap
2 (derived from `max_attempts: 3`), ceiling $0.50, base `f48b834`.

| | run 9 | run 12 | run 13 |
|---|---|---|---|
| manager turns | 4 | 4 | 4 |
| strong tokens | 125,921 | 177,701 | **187,723** |
| per turn | 31,480 | 44,425 | **46,931** |
| attempts | 5 ok | 1 ok | **2 ok** |
| `npm ci` | PASSED | PASSED | **PASSED** |
| `npm run build` | CHECK_FAILED | — | **PASSED** (after revision) |
| `git diff --exit-code -- public` | — | — | **PASSED** |
| `npm test` | — | — | **PASSED** |
| cheap spend | $0.0591 | — | $0.0566 |
| outcome | revision cap | REVISE rejected in SYNTHESIS | **ACCEPTED** |

## The path that finally closed

```
turn 1  PLAN       EXPLORE
turn 2  SYNTHESIS  IMPLEMENT   -> attempt 1: 9 files from f48b8346
turn 3  REVIEW     REVISE      -> npm run build CHECK_FAILED, 3 TypeScript errors
turn 4  REVIEW     ACCEPT      -> attempt 2: 13 files from 1a6f2b2e
```

Attempt 2 started from attempt 1's own commit rather than from the base, which is
the repair path working as designed: the worker corrected an implementation
instead of rewriting one from nothing, and the candidate offered remains one
complete net change from the authorized base.

Both halves of the manager's job were exercised. It refused a plausible candidate
that did not compile, and accepted the repaired one only after all four
deterministic checks passed *and* it had confirmed the architectural constraints
still held -- it cited the frozen nine-operation bridge boundary and verified
`src/bridge/bridge.ts` and `project.json` were untouched, which no test enforces.

Zero human interventions between authorization and the integration gate.

## What made it possible

Runs 10-12 each died on a state the machine could not represent, not on a model
error. Three separate holes, fixed in order:

- EXPLORE arriving in REVIEW (`a7818ca`)
- REVISE arriving in SYNTHESIS after a rethink (`86fc194`)
- a question-less RETHINK routed to PLANNING, where the surviving candidate was
  invisible and unusable (`3dc3b5d`)

The third also completed the invariant behind thread rollover: every turn is now
reconstructible from durable evidence, so a manager thread is a cache rather than
a record.

## The candidate, and how it was integrated

2,429 insertions across 13 files: a real dashboard over the frozen relay, with a
presentation adapter, a normalizer tolerant of unknown payload shapes, and a UI
that follows the objective's design constraints (borders not cards, monospace for
machine facts, semantic colour only).

Pre-integration inspection found one defect on the authority path. The adapter
sent `{ id, runId, jobId }` -- one run identifier under three plausible names --
to `approve` and `decline`. delegate-wave's contract is
`POST /v1/proposals/{proposalId}/approve`, and a proposal is a distinct entity
from the job that produced it. That is not a wrong label for the right thing; it
is the right label for a different thing, and it would have been a live
wrong-namespace bug the moment a host was built for this relay. No host
implements the nine operations yet, so it could not execute.

The operator fixed it directly (`f5333e8`), reran all four checks green, and
landed the result.

```
accepted attempt:  job_c06c3499-....2  (candidate commit 2daefa89)
operator fix:      f5333e87
landed tree:       f5333e87  -- github.com/Futahua/delegate-wave-backpack, workspace
validation:        npm ci / npm run build / git diff --exit-code -- public / npm test  all PASSED
reason:            authority-contract defect found during pre-integration inspection
```

**delegate-wave does not own this integration.** No proposal was created and no
approval was granted, because the operator modified the accepted candidate before
landing it. Recording an approval would assert that `2daefa89` landed when the
actual tree is `f5333e87`. The accepted attempt therefore remains un-integrated in
delegate-wave's own semantics, and the job stays `READY_FOR_INTEGRATION`; the
divergence is annotated in the event ledger as
`OPERATOR_INTEGRATION_OUT_OF_BAND`.

The distinction that matters:

- product repository -- correctly integrated
- delegate-wave integration ledger -- does not own this integration

## What run 13 does not tell us

The strong side still has no dollar figure. 187,723 tokens over four turns is the
largest manager spend recorded here and the per-turn figure has grown every run
(31,480 -> 44,425 -> 46,931), but the App Server reports tokens rather than
provider-observed dollars, so none of it converts to money yet. That measurement
is the next work, before any further managed experiment.

The `4294963241` abnormal Windows exit from run 11 is still undiagnosed and
deliberately kept separate: the validator correctly recorded "the program ran and
did not succeed", so `CHECK_FAILED` remains the honest category.
