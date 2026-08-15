# pro-scaffold-v1

A separate experiment identity from `executor-ab-v1`, because it tests a different hypothesis. That
corpus stays frozen and untouched at digest `b34387db`.

## Question

Does DeepSeek V4 Pro's usable capability on our own workloads depend on the reasoning effort we pin,
and on what the model sees in its **first** request?

Three configurations, run through the real delegate-wave pipeline so the measure is validated task
success rather than a synthetic score:

```text
A  Pro / headless / reasoningEffort=high      today's production setting
B  Pro / headless / reasoningEffort=max       one config line
C  Pro / max / Minimal-aligned first request  complete persona, pwsh+read on request #1,
                                              full trusted catalog after the first tool call
```

`D` (official Minimal throughout) is deliberately absent. Its persistent-bash backend cannot run
here at all: `dsh-subprocess-local` implements terminal inspection for linux and darwin only and
throws on win32, which a live Pro worker reproduced verbatim. The published native-Windows 98/99
runs did not use it either — their first request was `pwsh + read` — so `C` reproduces the
configuration that actually produced that evidence rather than approximating one that cannot run.

## Why the tasks cannot be faked

Each task is a repository containing a deliberately wrong implementation and a test suite that
already encodes the correct behaviour. The test file is declared a **protected path**, so
delegate-wave's own policy check rejects any candidate that modifies it. The worker cannot make the
tests pass by editing the tests; it has to fix the implementation.

Validation is the same command a person would run, and success means the same thing it means in
production: a candidate that passed deterministic validation.

## What is measured

```text
validated success     did the attempt produce a candidate that passed validation
attempts              how many were needed
wall time             from job start to terminal state
reference cost        priced from the recorded usage receipt, same basis as production
tool-call failures    errors the worker hit while working
```

Reasoning-word fingerprints (`We`, `Let me`, `The user wants`) are **not** measured. They are
trajectory telemetry, not capability, and optimising for them would be measuring the wrong thing.

## Honest limits, stated in advance

- One machine, one route (OpenCode Go), one operator, a handful of tasks. This is a decision aid for
  this installation, not a benchmark.
- Sampling variance on a small task set is large. A difference smaller than the spread between
  repeated runs of the same configuration means nothing, so each configuration is run more than once
  where budget allows.
- Nothing here changes any authority boundary. The scaffold decides what the worker sees; candidate
  capture, protected-path policy, validation, approval and integration are untouched.
