# Executor A/B protocol: executor-ab-v1

Frozen 2026-08-14, before either executor was run against it.

## Question

Does a DeepSeek-native Harness executor lower **cost per validated candidate** relative to OpenCode,
without increasing failures or weakening the worker confinement boundary?

## Corpus

Ten tasks in `tasks.json`, digest recorded in `DIGEST`. Each has a fixed goal, a deliverable, and a
verifier under `fixture/verify/`.

Every verifier is proven bidirectional in `test/corpus.test.js`: it accepts a correct solution and
rejects at least two plausible wrong answers. A verifier that passes whatever it is given makes
first-pass validation rate optimistic for both executors equally, so the comparison would look clean
and mean nothing. That failure mode was found in the earlier baseline, where a task's deliverable was
never tested by its own validation plan.

The corpus is frozen. No task may be edited once either executor has run it. If a task proves
defective, the pair is discarded and restarted rather than adjusted.

## Route equalization

Both executors MUST run against the same DeepSeek API, model, and account.

The five-job OpenCode baseline in `docs/EXECUTOR-BASELINE.md` used the `opencode-go` route. It is the
production operational baseline, not the experimental control: normalizing it showed executor-reported
cost differing from the reference basis by a factor of 2.0, which would otherwise be attributed to the
executor rather than to the commercial arrangement.

## Calibration is separate from the corpus

Provider configuration and measurement plumbing are debugged on a throwaway calibration task, never
on one of the ten. Debugging a route can require several runs, partial candidates, and repeated edits
to the task itself; doing that on a corpus task would expose or mutate one side of a pair before the
experiment starts.

## Gate before any pair runs

The OpenCode-on-direct-DeepSeek calibration run must satisfy all of:

```text
usageCoverage().healthy === true
receipt status            COMPLETE
reference_cost_usd        non-null, basis deepseek-direct-2026-08-14-v2
reference cost            reproduced by hand from the recorded token counts
capture failures          none
missing evidence          none
```

`usageCoverage()` encodes this gate directly, so the runner does not have to remember a supplementary
filter.

## Execution

Each task runs once per executor from the same base commit, with the same goal and the same
validation plan, in a fresh worktree. Twenty runs total.

A pilot of two pairs runs first. Its purpose is instrumentation, not performance: it must show that
both executors produce complete usage receipts, that cache-read units mean the same thing on both
sides, that failures are counted rather than dropped, and that reference costs reproduce by hand.
Only then do the remaining eight pairs run, without further changes to the experiment.

## Measures

```text
cost per validated candidate    reference cost, one pinned basis, failed attempts included
executor completion rate        attempts that produced a candidate at all
first-attempt candidate success
validation pass given candidate
integration success given validated candidate
attempts per validated job
wall time
input / output / reasoning / cache-read tokens
```

Failed attempts count toward cost. An executor that is cheap per success but fails often is not
cheap.

## Decision rule

Promote DeepSeek Flash and Pro to Harness only if it materially lowers cost per validated candidate
without raising failure rates or weakening confinement. On a tie, keep OpenCode: Harness is a
developer preview with expected compatibility churn, and that carries real maintenance cost.

Luna stays on OpenCode either way.

## Out of scope

Harness Code Mode, subagents, workflows, Ralph, and skills stay disabled. Code Mode is documented by
its authors as containment rather than a security boundary, with authority comparable to a shell, so
it remains unacceptable until workers run inside a real OS, container, or separate-identity boundary.
