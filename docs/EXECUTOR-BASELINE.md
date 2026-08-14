# OpenCode executor baseline

Date: 2026-08-14

A small baseline captured before evaluating DeepSeek Harness as a second executor backend. The
purpose is to characterize the current production executor before changing anything, using
deliberately fewer jobs than the planned A/B so the paired experiment is not pre-spent.

This is the **production operational baseline**, not the experimental control. These runs use the
`opencode-go` route, so comparing them directly against a Harness run on DeepSeek's direct API would
measure harness, provider route, and commercial model together. The paired experiment must put both
executors on the same DeepSeek API, model, and account; otherwise its result cannot be attributed to
the executor.

All runs used the full product path: Hermes proposal, operator authorization, worker, deterministic
validation, integration.

## Runs

```text
job                        attempts  terminal    validation  exec s   model
hermes-proposal-v1 #1      2         SUCCEEDED   PASSED      11.2     opencode-go/deepseek-v4-flash
hermes-proposal-v1 #2      1         SUCCEEDED   PASSED      12.1     opencode-go/deepseek-v4-flash
baseline-v1 #1             1         SUCCEEDED   PASSED      12.3     opencode-go/deepseek-v4-flash
baseline-v1 #2             1         SUCCEEDED   PASSED      10.5     opencode-go/deepseek-v4-flash
baseline-v1 #3             1         SUCCEEDED   PASSED      13.2     opencode-go/deepseek-v4-flash
```

```text
jobs                          5
first-pass validation success 4 / 5
attempts per validated job    1.2 mean
executor wall time            10.5 - 13.2 s, mean 11.9 s
integration success           5 / 5
rework after integration      0
```

The single retry was the pre-routing-fix attempt that selected OpenCode's ambient Google provider and
failed with `ProviderAuthError`. It is counted because failed attempts cost real time, but it is an
environment defect that WRK-004 has since made unreachable, not a model failure. Excluding it,
first-pass validation success is 4/4.

## Output correctness

Outputs were checked by hand, not only by the validation command, because a validation plan can pass
without testing the deliverable:

```text
TOTALS.md      widget 2 + gadget 5 = 7                     correct
CONTRIBUTING.md three accurate bullets, header preserved   correct
SUMMARY.md     per-region lines; total units 44            correct
SUMMARY.md     highest revenue north 42.00 (east 40.00)    correct
PRICING.md     price sort descending                       correct
```

One process observation: `baseline-v1`'s validation plan only checked `SUMMARY.md`, so job #3's
`PRICING.md` deliverable passed validation without being tested. The output was correct on inspection,
but the paired A/B must give each task a validation command that actually exercises its own
deliverable, or first-pass validation rate will be measured optimistically for both backends.

## Provider usage evidence

An earlier draft of this document claimed no token or cost evidence existed. That was wrong. The
backend already runs OpenCode with `--format json`, and every `opencode-events.jsonl` contains
`step_finish` events carrying `tokens.input`, `tokens.output`, `tokens.reasoning`,
`tokens.cache.read`, `tokens.cache.write`, and `cost`. The evidence was captured all along; nothing
was rerun to obtain it.

Totalled across `step_finish` events per attempt:

```text
job                   steps   input  output  reason  cacheRd    cost($)
hermes #1 TOTALS          4    4665     282      17    20992   0.000398
hermes #1 attempt 1       0       0       0       0        0   absent
hermes #2 CONTRIBUTING    4    4576     349      12    21248   0.000401
baseline #1 SUMMARY       4    4531     324     107    21376   0.000407
baseline #2 REVENUE       3    4511     242     125    14848   0.000388
baseline #3 PRICING       4    5217     548     181    22400   0.000499

total                         23500    1745     442   100864   0.002092
```

```text
validated candidates            5
provider-reported cost total    $0.002092
provider-reported cost each     $0.000398 mean
cache-read tokens               100,864 (4.3x the uncached input total)
```

Two cautions on these numbers.

Provider-reported `cost` is non-zero on this route, so the `opencode-go` path does report a figure
rather than the zero seen in some reports. It is still a subscription product, so this number should
be treated as a provider-reported value, not as marginal per-request billing. A separate reference
cost derived from token counts against a pinned pricing snapshot is what the A/B should compare, with
the pricing basis recorded beside it.

The failed attempt produced no `step_finish` events at all, because it died in provider
authentication before any model call. Its usage is genuinely absent rather than zero, and the
evidence contract must distinguish those two cases: a missing receipt must be `UNKNOWN`, never
silently totalled as zero, or failed work will look free in cost per validated candidate.

## What is not yet in the attempt record

The evidence exists in artifacts but is not normalized or persisted per attempt, so it cannot be
queried or compared across backends. That contract is the next piece of work, and it must cover
failed attempts, since failed work is part of cost per validated candidate.

## Baseline conditions

```text
control plane   main at 9a05d14
schema          10
executor        OpenCodeBackend, dispatcher-resolved model (WRK-004)
credentials     operator, observer, proposer sealed in current-user DPAPI
suite           117/117
```
