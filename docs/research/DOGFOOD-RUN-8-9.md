# Dogfood runs 8 and 9 — the loop closes

Same objective throughout (1458 chars, unmodified), `--model gpt-5.5`,
`opencode-go/deepseek-v4-flash` workers, revision cap 1 (derived from
`max_attempts: 2`), ceiling $0.50, base `f48b834`.

| | run 6 | run 7 | run 8 | run 9 |
|---|---|---|---|---|
| manager turns | 4 | 3 | 4 | 4 |
| strong tokens | 92,413 | 74,128 | 94,941 | **125,921** |
| per turn | 23,103 | 24,709 | 23,735 | **31,480** |
| attempts | 3 ok, 2 fail | 4 ok | 3 ok, 2 fail | **5 ok** |
| files written | 0 | 6 | **0** | **11 and 12** |
| `npm ci` | never reached | CHECK_FAILED | never reached | **PASSED** |
| `npm run build` | — | — | — | **CHECK_FAILED (real)** |
| cheap spend | $0.0405 | $0.0414 | $0.0359 | $0.0591 |
| outcome | revision cap | EXPLORE in REVIEW | revision cap | **revision cap** |

## Run 8 — the shell was not the blocker

Both implementation attempts failed identically to run 6: `reason: "length"`,
exactly 32,000 reasoning tokens in a single step, zero output, **zero changed
files**. But this time the worker *had* a shell and used it well — four bash
calls including `npm ci`, all inside the worktree.

That ruled out capability. The worker read thirteen to fifteen files, reasoned
itself to the per-step cap, and never wrote anything. It was not short of context
and not short of tools; it spent its budget understanding the problem.

`ffb2e0d` tells it to write early and incrementally, not to re-survey what the
brief already establishes, and states that reading everything and writing nothing
is a failed attempt. Not a context-size fix: the cap being hit is a per-step
reasoning limit, and enlarging anything would have bought a longer survey.

Run 8 also produced the first observable quota crossing: `usedPercent` moved
**98 → 99** across a 94,941-token run.

That is all it establishes. It does NOT estimate 94,941 tokens per percentage
point. With integer quantization the underlying figure could have sat at 98.99%
and crossed after almost no consumption, or at 98.01% and crossed after nearly a
full point -- and if the reported value is rounded rather than floored, the
uncertainty is wider still. A single boundary crossing cannot support a
runs-per-week capacity figure, and the earlier "on the order of 100 managed runs
per week" was an inference the evidence does not carry.

What is established: **run 8 crossed one observable 1%-resolution quota
boundary.** Estimating capacity needs several crossings with total strong usage
accumulated between them.

## Run 9 — every stage works

Job `job_03739b4c-9404-4fe3-8c72-ecf89e52a6dd`.

Both attempts SUCCEEDED and produced substantial candidates — eleven and twelve
files: `src/App.tsx`, `src/app.css`, `src/components/{Bits,Composer,DetailPane,RunList}.tsx`,
`src/fixtures.ts`, `src/main.tsx`, `src/normalize.ts`, `test/app.test.tsx`,
`test/normalize.test.ts`.

**The production validation pipeline executed correctly through its first genuine
failure:**

```
[PASSED]       exit=0   npm ci
[CHECK_FAILED] exit=2   npm run build
```

The plan's remaining two checks -- `git diff --exit-code -- public` and `npm test`
-- were never reached, because the plan stops at the first failure. Two of four
ran. That is enough to verify `afeba64` on the production path and is not the
same claim as the whole plan having executed.

`npm ci` passing is `bfa5519` verified in production — the shim path with a space
now reaches cmd intact. The build failure is real, not an invocation defect:

```
test/app.test.tsx(52,36): error TS2769: No overload matches this call.
test/scratch.test.tsx(14,33): error TS2769: No overload matches this call.
```

The manager then did the job the architecture exists to buy. First review:

> *"The candidate does not meet acceptance because deterministic build fails at
> TypeScript. The UI change is directionally aligned, but the implementation must
> compile and update the public artifact before it can be accepted."*

Second review, after the revision:

> *"The second candidate still fails the same TypeScript build error and
> introduced a leftover scratch test that also fails… The diagnosis is now
> narrower: the injected `call` prop type must be made…"*

It caught that the worker had left behind `scratch.tsx`, renamed into
`test/scratch.test.tsx` mid-run, which then failed compilation too — a defect
introduced by the fix attempt. It narrowed its diagnosis between rounds rather
than repeating itself. Then it asked for revision 2, the cap is 1, and it
escalated.

**The revision cap is now the demonstrated bottleneck.** Every precondition
holds: a legitimate candidate existed, validation genuinely ran, and the manager
was revising on real evidence rather than compensating for broken signals. Runs 6
and 8 also ended on the cap, but on repeated worker failure with no candidate at
all; run 9 is the first time the limit bound on good work.

## Shell egress — a real breach

`external_directory: deny` is a per-tool permission and does not fence `bash`.
Across runs 7–9, 24 shell invocations. Runs 7 and 8: all inside the worktree.

Run 9: **two invocations reached outside it, and succeeded.**

```
ls "D:/Letters/MatTroiSeConMoc/PAPERS 3/Papers-3"
  -> AGENTS.md HERMES.md README.md THIRD_PARTY_NOTICES.md assets build docs ...
wc -l ".../README.md" ".../AGENTS.md" ".../HERMES.md"
  -> 59, 7, 174
```

The worker obtained directory names and line counts of the host application's
repository. It did not read their contents. The experimental impact is small; the
boundary result is not: after `5a4211f` a worker can leave its worktree, and one
did, on the first run where the shell was used in earnest.

This is consistent with the stated trust model — cheap operators, not hostile
tenants — but it is now a demonstrated property rather than a theoretical one,
and any experiment whose validity depends on worker isolation needs a real fence
rather than a tool permission.

## Cost

Run 9 is the most expensive run so far at 125,921 strong tokens, 31,480 per
turn — because it is the first to carry large candidate diffs through two REVIEW
turns. Fresh input per turn (11,128) is the highest recorded, consistent with the
earlier finding that REVIEW turns carry a phase payload on top of the rising
cache floor.

Quota stayed at 99% throughout, having crossed during run 8.

## Status

The architecture is proven. The chain runs end to end:

```
strong plan -> cheap investigation -> evidence -> implementation
  -> deterministic validation -> strong review -> revision -> escalation
```

Every defect found in runs 3–9 was a truthfulness or contract defect in
delegate-wave's own execution layer, and every one was surfaced by the system
reporting honestly rather than by inspection.

What has been demonstrated is the SAFE-ESCALATION path: the manager refusing to
accept work that deterministic evidence does not support. The successful managed
path -- a candidate that goes green and reaches ACCEPT -- has not yet run,
because run 9 stopped at the revision limit rather than at a judgment.

**Core completion:** one run with `maxAttempts: 3`, giving the existing
`maxRevisionRounds: 2` its full two revisions. Run 9 is the first valid evidence
for that change: a real candidate existed and the manager had a concrete second
correction to make.

**Optimization, afterwards:** manager-context compaction, especially REVIEW
payloads; quota-aware admission once several boundary crossings exist; cheaper
failure and retry policy; revision-limit defaults.

**Optional hardening:** a real filesystem fence for shell-enabled workers,
`cmd.exe` argument edge cases, UI and API polish.
