# Dogfood run 5 — the loop works; the flat-cost hypothesis does not survive it

Job `job_f29fa506-41f5-47b7-8c28-f64cff377e6d`, 2026-08-19. Same project, same
objective as runs [3](DOGFOOD-RUN-3.md) and [4](DOGFOOD-RUN-4.md), read
byte-for-byte from run 4's ledger row (1458 chars, unmodified). `--model gpt-5.5`.
Base clean at `f48b834`. No intervention.

Terminal state: `AWAITING_HUMAN`. Escalation: *"the manager asked for revision 2
but only 1 are permitted."*

## The three runs

| | run 3 | run 4 | run 5 |
|---|---|---|---|
| manager turns | 4 | 4 | **6** |
| phases reached | PLAN, SYNTHESIS | PLAN, SYNTHESIS | PLAN, SYNTHESIS, **REVIEW** |
| strong tokens | 77,613 | 81,495 | **159,725** |
| strong per turn | 19,403 | 20,374 | **26,621** |
| explorations commissioned | 8 | 7 | 4 |
| attempts | 8 SUCCEEDED | 1 SUCCEEDED, 2 FAILED | 6 SUCCEEDED |
| reports captured | 0 of 8 | 1 of 3 | 4 of 6 |
| cheap spend (reference) | $0.0328 | $0.0034 | $0.0625 |
| candidate produced | no | no | **yes, twice** |
| human interventions | 0 | 0 | 0 |

Run 5 is the first to complete the semantic loop: PLAN → 3 exploration rounds →
IMPLEMENT → REVIEW → REVISE → REVIEW. It ran out of revision budget, not out of
ideas.

## The flat ~20k/turn band was an artifact

Runs 3 and 4 both clustered near 20k strong tokens per manager turn despite
wildly different worker productivity, which looked like strong evidence that
manager cost is turn-driven and decoupled from output. Run 5 refutes the strong
form of that claim. Both runs had died before reaching REVIEW, so the band was
measuring only the cheap phases.

| turn | phase | action | fresh | cache read | total | prompt |
|---|---|---|---|---|---|---|
| 1 | PLAN | EXPLORE | 11,837 | 6,528 | 18,365 | 1,724 ch |
| 2 | SYNTHESIS | EXPLORE | 2,153 | 17,792 | 19,945 | 6,050 ch |
| 3 | SYNTHESIS | EXPLORE | 1,923 | 18,816 | 20,739 | 2,368 ch |
| 4 | SYNTHESIS | IMPLEMENT | 3,850 | 19,840 | 23,690 | 8,018 ch |
| 5 | REVIEW | REVISE | 11,914 | 21,888 | 33,802 | 36,896 ch |
| 6 | REVIEW | REVISE | 11,056 | 32,128 | 43,184 | 33,761 ch |

Decomposed against turn index and phase, the two components behave differently:

- **Cache read grows monotonically** with turn index — 6,528 → 32,128, a 4.9×
  increase — and is indifferent to phase. This is persistent accumulated context,
  exactly as predicted.
- **Fresh input is phase-dependent and not flat at all.** PLAN and both REVIEW
  turns cost ~11–12k fresh; the three SYNTHESIS turns cost 1.9–3.9k. A REVIEW
  turn carries a candidate diff, and its prompt is 5–15× larger than a SYNTHESIS
  prompt.

So persistent context dominates the *floor* and explains why cost never falls,
but phase composition drives the *peaks*: turn 6 cost 2.35× turn 1. Neither
component alone accounts for the curve, and the honest statement is narrower than
the one run 4 suggested:

> Marginal manager cost rises with turn index through accumulated context, and
> rises again with phase through candidate-bearing REVIEW prompts. It is not
> constant, and it is not proportional to useful work either.

Total cost is therefore superlinear in turns: 1.5× the turns of run 3 bought
2.06× the tokens.

## Finding — `SUCCEEDED` is being derived from the exit code alone

Two of the three round-1 explorations produced **no report at all**, while being
recorded `terminal_state = SUCCEEDED` with `exit_code = 0`.

| attempt | events | text events | report |
|---|---|---|---|
| `job_152f8f3f….1` | 44,924 bytes, 34 events | **0** | absent |
| `job_d9877b4a….1` | 55,068 bytes | **0** | absent |
| `job_0437e222….1` | 60,270 bytes, 50 events | 3 | 3,556 bytes |

Both failures end with an `error` event carrying a provider 400:

> `[unsupported_tool_schema] The tool schema is not supported
> (unsupported_keyword)` — `statusCode: 400`, `isRetryable: false`

This is **not** the run-3 parser defect. The parser is correct; there was no
final text to read, because the worker's turn died at the provider. OpenCode then
exited 0, and delegate-wave read that exit code as success.

An attempt that emitted an unrecoverable `error` event and produced no answer is
not a success, and the ledger currently says it is. The receipts are right —
these workers *did* reach a provider, so `COMPLETE` with real cost ($0.0023 and
$0.0026) is the correct settlement, and `NO_PROVIDER_CONTACT` correctly does not
apply. Only the terminal state is wrong.

The system degraded safely for the third consecutive run: turns 2 and 3 both
carry the unanswered marker, so the manager was told plainly that those questions
had no answers and commissioned another round rather than inventing one.

Report capture on the paths that did produce text is now verified end to end.
Every report that exists on disk was found **verbatim inside a later manager
prompt** — turns 2, 4, 5 and 6 respectively — so the run-3 seam is closed on the
live path, not merely in a fixture.

## The work product

Two candidates, both `validation = FAILED`:

- attempt 1 → `df1dd4f5`: `src/App.tsx`, `src/components.tsx`, `src/lib/adapters.ts`,
  `src/lib/model.ts`, `src/lib/operations.ts`, `src/main.tsx`, `src/styles.css`,
  `test/adapters.test.ts`
- attempt 2 → `3f4402f7`: the same, plus `test/operations.test.ts`

This is a real dashboard implementation against the frozen nine-operation relay,
not a stub. The manager's final review is the most encouraging artifact of the
whole exercise:

> *"The candidate still fails required acceptance because deterministic checks
> were not actually executed, public remains stale, and the evidence again shows
> the harness used an invalid PowerShell command with `&&` before npm ran."*

It read the validation evidence, identified that the build never ran rather than
that it failed, noticed the same shell defect recurring across two attempts, and
declined to accept — while explicitly preserving the work: *"Do not rewrite the
feature unless verification reveals real defects."* That is the judgment the
architecture exists to buy, and it was exercised without human input.

The gate is still unmet. Nothing was integrated, and PR #16 stays draft.

## Not measurable from this run: scarce quota

The optimization target is least scarce strong-model allowance per successful
task, not fewest tokens. Cache reads are 73% of run 5's strong total (116,992 of
159,725), and whether a plan-authenticated subscription charges them like fresh
input is unknown — billing categories and quota accounting need not coincide.

`CodexManagerBackend.rateLimits()` exists and is **never called and never
persisted**. There is no rate-limit table and no column. So the question cannot
be answered retrospectively from runs 3–5 at all; it requires capturing
`rateLimits()` before and after each manager turn on a future run and deriving
allowance consumed per turn.

That is the next measurement, and it must precede any strong-manager brake:
throttling turns is only the right lever if turns are what the subscription
actually charges for.
