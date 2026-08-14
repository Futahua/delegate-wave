# OpenCode executor baseline

Date: 2026-08-14

A small clean baseline captured before evaluating DeepSeek Harness as a second executor backend. The
purpose is a control group, not a benchmark: five live jobs is enough to characterize the current
executor before changing anything, and deliberately fewer than the planned A/B so the paired
experiment is not pre-spent.

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

## What is not measured here

Cost per validated candidate is the metric the Harness comparison exists to answer, and it is absent:
neither the attempt row nor the OpenCode artifacts currently record token usage or dollars. The A/B
harness must capture input, output, and cache-read tokens per attempt for both backends, or the
comparison cannot be made on the metric that matters.

## Baseline conditions

```text
control plane   main at 9a05d14
schema          10
executor        OpenCodeBackend, dispatcher-resolved model (WRK-004)
credentials     operator, observer, proposer sealed in current-user DPAPI
suite           117/117
```
