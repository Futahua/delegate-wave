# Executor A/B protocol: executor-ab-v1

Frozen 2026-08-14, before either executor was run against it.

## Question

Does a DeepSeek-native Harness executor lower **cost per validated candidate** relative to OpenCode,
without increasing failures or weakening the worker confinement boundary?

## Corpus

Ten tasks in `tasks.json`. Each has a fixed goal, a deliverable, and a verifier under `verifiers/`.

Verifiers live **outside** the fixture. If they shipped inside the attempt repository, a worker could
read the acceptance criteria instead of solving the task, and because the fixture is copied whole,
the first worker would also see the criteria for every later pair. The runner resolves the verifier
root to an absolute path outside the worktree and runs it with the worktree as the working directory.

`DIGEST` covers the entire apparatus -- tasks, protocol, fixture inputs, verifiers, and the
line-ending rule -- hashed by sorted path and bytes. Hashing `tasks.json` alone would leave a later
edit to a fixture or verifier invisible, which defeats preregistration. The merged corpus commit SHA
is recorded alongside results, so Git provides an independent second identity for the frozen
apparatus.

Each task declares a `verification_kind`, and the instrument matches the claim:

```text
deterministic-artifact   derive the complete expected result from the frozen inputs and compare
                         exactly (t01, t02, t03, t07, t08, t09)
structural-source-edit   compare against the exact permitted transformation of the frozen source
                         (t06, t10)
semantic-behaviour       preserve unauthorized bytes structurally, then check behaviour against a
                         hidden deterministic reference over a broad declared domain (t04, t05)
```

The third class exists because open-ended behaviour cannot be established by examples: an
implementation that hardcodes the sampled cases would pass while being wrong everywhere else, and an
exact source comparison cannot express "correct for all non-empty arrays". A finite oracle does not
prove an arbitrary implementation either, but a broad fixed domain with a recorded seed is a sound
instrument and is materially stronger than sample-case validation.

Separately, every task declares `allowed_changes`, and every verifier enforces it by comparing the
whole candidate tree against the frozen fixture, rejecting any added, deleted, or modified path
outside that set. Judging only the requested artifact would accept a candidate that produced the
right answer while damaging something else. Expectations are always derived from the frozen fixture,
never from candidate inputs: reading a candidate input would let a worker rewrite the problem and
have the verifier validate its own altered version.

Verifiers consume the declaration in `tasks.json` rather than restating it, so the declared boundary
and the enforced boundary cannot drift apart.

Every verifier is proven bidirectional in `test/corpus.test.js`: it accepts a correct solution and
rejects plausible wrong answers. A verifier that passes whatever it is given makes
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

`maxAttempts` is **1**. A backend's first failure is what the experiment measures; letting the
scheduler retry would repair a weak executor and hide the difference. Retry economics is a separate
later experiment.

Execution order is precommitted and balanced, because provider latency and cache state drift during a
run and always running one backend first would confound the comparison. Each pair runs **back to
back** in this order, both arms before the next pair begins, so drift affects both arms equally:

```text
pair  task                    order
 1    t01-csv-totals          OpenCode -> Harness
 2    t02-filter-select       Harness  -> OpenCode
 3    t03-json-reshape        OpenCode -> Harness
 4    t04-bugfix-off-by-one   Harness  -> OpenCode
 5    t05-add-function        OpenCode -> Harness
 6    t06-rename-consistent   Harness  -> OpenCode
 7    t07-doc-from-code       OpenCode -> Harness
 8    t08-text-transform      Harness  -> OpenCode
 9    t09-two-file-join       OpenCode -> Harness
10    t10-constrained-edit    Harness  -> OpenCode
```

The pilot is pairs 1 and 2, one leading with each executor.

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
