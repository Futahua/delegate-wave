# Pro scaffold study — findings

## Question

An article claimed that DeepSeek-V4-Pro's capability depends on reasoning effort and on the shape of
the *first* request — specifically that a Minimal-style opening (bare persona, small tool set) unlocks
behaviour a fuller scaffold suppresses.

Three configs, all Pro over the OpenCode Go route, all through the real Dispatcher and
`HarnessBackend` against a throwaway data root:

| | reasoning effort | opening request |
|---|---|---|
| **A** | `high` | delegate-wave's `workerPrompt` |
| **B** | `max` | delegate-wave's `workerPrompt` |
| **C** | `max` | bare persona + task, no framing |

Config D — the staged tool catalog — **was not tested, and should have been.** See
[the correction](#correction-what-this-study-actually-measured) below.

## Result

**24/24 validated. Every task, every config, on the first attempt.**

```
task                    A(high)         B(max)          C(bare)      spread
range-index           204s $0.0083   125s $0.0056   325s $0.0119    2.6x
template-render        76s $0.0035    94s $0.0042    56s $0.0033    1.7x
compensated-sum        50s $0.0027    52s $0.0032    44s $0.0027    1.2x
grapheme-text          34s $0.0024    46s $0.0031    37s $0.0023    1.4x
calendar-duration     144s $0.0072    99s $0.0053   103s $0.0056    1.5x
log-pipeline           35s $0.0024    40s $0.0028    29s $0.0023    1.4x
roundtrip-codec        64s $0.0034   146s $0.0067    55s $0.0031    2.7x
async-cache            77s $0.0040    44s $0.0029    23s $0.0020    3.3x
```

**No effect was measurable in this saturated corpus, and the article's central staged-tool-catalog
hypothesis was not tested.** That is a much weaker statement than "the claim is not reproduced," and
it is the correct one: a corpus where every cell scores 100% cannot distinguish good configurations
from bad ones, so the absence of a gap here is a ceiling, not evidence of equivalence.

Cost and latency do vary, but not in a way that supports the claim. The rightmost column is the
ratio between the fastest and slowest config *on an identical task*, and the sign of the difference
flips task to task: A is cheapest on three, C on four, B on one. `range-index` took 125s under B and
325s under C; `async-cache` took 77s under A and 23s under C. Run-to-run variance on one task exceeds
any systematic gap between configs, so at n=1 these numbers establish a noise floor, not an effect.

## What the corpora do and do not establish

Three corpora were saturated in sequence, which is itself the main methodological finding: **for this
model, on tasks of this size, pass-rate has no resolving power.**

The first tier (five tasks) was built for algorithmic difficulty — asymptotic complexity, a
misdirection in a tokenizer, Neumaier compensation, grapheme clusters, month-end clamping. A passed
5/5 first attempt.

The second tier was built for a different failure mode, taken from the FrontierSWE report that agents
"decide to submit solutions very early… due to overconfidence in their wrong solutions" and
"misdiagnose performance bottlenecks." Each task carries a visible defect that is real, fixable, and
*insufficient*, behind which sits a second defect that only surfaces if the worker keeps going. That
"insufficient" property is verified rather than asserted — `verify-hard.mjs` requires the reference to
pass, the shipped code to fail, **and a competent fix to the visible defect alone to still fail**.

Pro cleared that tier too, first attempt, and *faster and cheaper* than the easier corpus. The
early-submission trap did not catch it.

Two of those three tasks were wrong on first construction and were caught by the partial-fix check:

- `log-pipeline`'s hidden cost was a per-record `new RegExp`, which V8 caches — so the shipped code
  passed its own performance assertion, making the task free.
- `roundtrip-codec`'s legacy fixture contained no backslash, so mirror-image escaping decoded it
  identically to the correct answer. The task only becomes real once the format is genuinely
  versioned, because a backslash is data in the old encoding and an escape in the new one — which
  makes the two indistinguishable by inspection unless the encoder marks what it writes.

Both would have produced a clean-looking null result for the wrong reason.

## Correction: what this study actually measured

The three configs vary **reasoning effort** (A vs B) and **prompt wording** (B vs C). None of them
varies the first-request *tool surface*, which is the actual mechanism the source result describes:

```
request #1    minimal persona + tiny API-visible tool catalog
request #2+   full tool catalog
```

So the budget went to the two less interesting variables. The interesting one was skipped.

It was skipped for a bad reason, recorded here because the reasoning is the instructive part: this
study inherited a stale premise that staging required a *persistent Minimal bash*, which win32 cannot
provide without a PTY. That premise was already known to be wrong. The frozen Windows run that scored
98 then 99 used `pwsh + read` on request #1 and 25 Standard tools on request #2+ — Windows native, no
persistent bash anywhere in it. Nothing about it needs a PTY.

Staging is also directly supported by the harness rather than requiring imitation:
`ctx.tools.restrict(filter)` applies an agent-scoped visibility mask and returns a dispose function,
which is precisely "narrow catalog, then widen."

**Config D has since been built and works.** It is a ~60-line plugin
([`src/harness/stage-plugin.js`](../../src/harness/stage-plugin.js)) that restricts the catalog on
`agent/created` and lifts the restriction on the first `tools/result`. Widening triggers on the first
tool *result* rather than a request counter, because an opening request that called nothing is
exactly the case where the model has not committed to an approach and the anchoring effect being
measured would not yet exist.

The condition is verified off disk, not asserted: every transition is written to a marker file, and
the runner reads it back onto each result. Three runs, three confirmations —

```json
{"narrowed_to":["pwsh","read"],"widened_after":"pwsh","widened_to_count":25,"verified":true}
```

— which reproduces the frozen Windows configuration exactly: `pwsh/read → 25 tools`.

D then scored **3/3 on the hard corpus**, like every other config. As predicted, that says nothing
about the hypothesis. The corpus is the bottleneck, not the harness.

**The corpus is the wrong place to test it**, which D's 3/3 confirms. D needs tasks where current Pro
succeeds *50–85%* of the time — repo-scale work with many-file exploration, competing hypotheses,
migrations or API interactions, debugging after tests fail, and enough context that premature
commitment actually costs something. Any task where both configs score 100% should be discarded on
sight.

The comparison should then be on **validated success, attempts to success, Codex escalation avoided,
cost per successful task, and wall time per successful task** — not on stylistic tics of the
trajectory.

## Caveats

- **n=1 per cell.** These runs bound the effect size against a measured noise floor; they do not
  estimate it. Nothing here rules out a small systematic difference.
- **24/24 is a ceiling, not evidence of equivalence.** Repeating A/B/C at n=5 would mostly measure,
  more precisely, an effect these tasks cannot express.
- **Tasks are single-file and self-contained.** Single-file problems probably erase exactly the
  long-horizon planning and context-management failure that the staged-catalog result exposed.
- All measurements are from delegate-wave's own usage receipts; cost figures are executor-computed
  against the pinned basis, not a provider bill.

## The most useful thing here

The hard tier — deliberately built to be nastier, using a documented failure mode — was solved
*faster and cheaper* than the tier it was meant to be harder than. Human intuition about what makes
an agent task difficult turns out to be a poor benchmark generator. Difficulty has to be measured
against the model rather than designed for it, which is why the 50–85% success band is the selection
criterion for the next corpus rather than anything about how the tasks look.

## Consequence for delegate-wave

`workerPrompt`'s framing costs nothing in capability at this task size, and it buys the invariants the
dispatcher depends on. No production change is indicated. The one change made is a `promptBuilder`
seam on `HarnessBackend`, defaulted to `workerPrompt`, so a measurement can vary the scaffold without
maintaining a fork of the backend that drifts from the code it is meant to measure.
