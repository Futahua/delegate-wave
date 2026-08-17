# ManagerWorker v1 — protocol

## What the source result actually says

Read from the abstract of arXiv 2603.26458 on 2026-08-17, not paraphrased from memory:

```text
strong manager + weak worker     62%
strong single agent              60%
weak manager  + weak worker      42%
weak agent alone                 44%

200 instances from SWE-bench Lite

"a minimal review-only loop adds just 2pp over the baseline,
 while structured exploration and planning add 11pp"
```

The paper's own framing of the headline is **near-equivalence to the strong model alone while using
"a fraction of the strong-model token usage."** It does not claim the pairing is more capable.

Two things follow, and the second one determines this protocol.

**The 11pp is measured inside the weak family.** Weak-alone is 44%; exploration and planning are what
make a weak worker good. Against strong-direct the net is 62 versus 60.

**A 2pp completion-rate difference is not measurable at our sample size.** On 200 paired instances a
2pp gap is four tasks, comfortably inside binomial noise at p≈0.6. On 3–5 tasks at n=3 it is roughly
one third of a single task. Any completion-rate comparison we run at this scale will return noise,
and the noise will be interpretable in whichever direction we were hoping for.

This is the scaffold mistake in a new costume. That study failed because the corpus was saturated;
this one would fail because the endpoint is underpowered. Fixing saturation does not fix power.

## The endpoint

Primary, both continuous or large-discrete, both detectable at n=3–5:

```text
strong-model tokens per validated + semantically accepted task
human intellectual interventions per task
```

The paper says the token difference is "a fraction" — a multiplicative effect, not two points. That
is exactly the kind of difference a handful of tasks can show.

Secondary, and reported honestly as a guard rather than a hypothesis:

```text
completion rate            a QUALITY GUARDRAIL, not a statistical claim
cheap-worker dollars
wall time
```

At this sample size "non-inferiority" would be statistical language the data cannot support. The
honest phrasing is a guardrail: if M completes visibly fewer tasks than S or P, that stops the
experiment regardless of token savings. It does not license a claim of equivalence when it does not.

If M completes 4/5 and S completes 4/5 while M used a fifth of the strong tokens and required no
interventions, the experiment succeeded.

Report the paired per-task numbers alongside any ratio. A mean of per-task ratios hides the case
where one task dominates the total, and with five tasks that case is likely rather than exotic.

## A run whose condition cannot be established is invalid data

Not "probably fine". If the executor fell back, if the requested model or effort cannot be shown to
be what actually ran, or if usage came back UNKNOWN, the sample is excluded and the exclusion is
reported. Harness `trusted` and the OpenCode fallback are different capability conditions — one has
shell access and one does not — so a fallback run is never pooled with an intended run.

## Calibration, and why the band is not 1/3

The instinct to select tasks where direct Pro sits at 1/3–2/3 is right about saturation and wrong
about which endpoint it serves. A 50% task maximises per-task variance, which is what you want when
hunting a rate difference — the endpoint we just established we cannot measure.

For cost-per-success it is actively harmful: half the runs produce no success, so the denominator
halves and its variance doubles. A task Pro fails outright contributes nothing to "tokens per
completed task" except uncertainty.

So the band skews high:

```text
PRIMARY SET     3-5 tasks where direct Pro succeeds 2/3 or 3/3 at n=3,
                and which are repo-scale: many-file exploration, competing
                hypotheses, behaviour that must be discovered rather than read.
                Both arms should usually finish. We are comparing what it COST.

RESCUE PROBE    1-2 tasks where direct Pro succeeds 0/3 or 1/3.
                Reported separately and labelled underpowered. Answers a
                different question -- can the manager rescue what Pro alone
                cannot -- and cannot be pooled with the primary set.
```

## Task selection freezes before treatment

An earlier draft of this protocol said to "discard on sight any task where both arms score 3/3 with
near-identical token counts." That is selection on the outcome, and it is disqualifying: dropping the
tasks where the arms agreed guarantees a difference in whatever survives, whether or not one exists.
It is the same error as the saturated corpus, arriving from the opposite direction.

The order is therefore fixed:

```text
1. Calibrate with P ONLY. The other arms are not run, and their results cannot influence which
   tasks are chosen because they do not exist yet.
2. Freeze the task IDs. Write them down. This list does not change afterwards for any reason.
3. Run S and M fresh on exactly that frozen list.
```

A task that turns out to be uninformative stays in the reported results. That is what the sample
looked like.

## Arms

Three, not two. Two arms cannot separate "cheap execution is sufficient" from "strong judgment
removes the errors" — the comparison that motivated the whole project needs both contrasts.

```text
P   cheap direct
    objective -> Pro -> candidate -> validation

S   strong direct
    objective -> Codex with ordinary repository and tool access -> candidate -> validation

M   ManagerWorker
    objective
    -> text-only Codex manager (PLAN)
    -> Pro exploration, at most 2-3 bounded investigations
    -> Codex synthesis -> implementation brief
    -> Pro implementation against the brief
    -> candidate + validation
    -> Codex semantic review -> ACCEPT / REVISE / RETHINK / ESCALATE
    -> at most 2 revision rounds
```

```text
M vs S   can cheap execution substitute for strong execution, at lower strong-token cost?
M vs P   does scarce judgment remove the semantic errors that otherwise cost human attention?
```

Same substrate throughout. Candidate capture, validation, protected paths, usage accounting and the
integration gate are identical in all three; only who writes the worker's instruction differs.

## The manager does not grade itself

Manager `ACCEPT` is part of M's algorithm. It is **not** the experiment's ground truth, and using it
as such would let the arm under test define its own success while P and S are judged by something
else.

Final semantic correctness comes from one arm-blinded evaluator — a hidden behavioural verifier where
the task admits one, otherwise a judge that sees the diff without knowing which arm produced it. The
same judge scores P, S and M. Its own cost is reported separately and never counted against any arm.

Nothing else varies. No prompt tuning, no effort changes, no staged tool catalogs, no runtime swap.
`agent/exp-pro-scaffold` stays frozen and unmerged; if `promptBuilder` proves useful it is
cherry-picked as one seam, later.

## What must not be attempted yet

Do not compare delegate-wave against Orca or Taskplane in this experiment. That would vary the
manager algorithm, executor environment, task transport, worktree lifecycle, context handling and
observability at once, and a win or loss would be uninterpretable. Substrate comparison is a separate
experiment, run only if B beats A economically — and it now has a specific question to answer:

> Can Orca replace the execution machinery while delegate-wave retains the truth Orca cannot prove?

Issue #10846 already names part of that truth: a requested effort can vanish from the launch args
with no way for the caller to know. See `docs/research/EXTERNAL-ORCHESTRATION-LESSONS.md`.

## Definition of an intervention

Counted only when a person had to reason about the software or the problem after authorization.

```text
COUNTS        diagnosing why a worker misunderstood the task
              answering a manager's escalation question
              rewriting the objective because the result missed the point

DOES NOT      authorizing the work
              approving a clearly explained candidate
              reading status
```

This is the metric the whole project exists to drive to zero, so it is recorded per task from the
first run rather than reconstructed afterwards.
