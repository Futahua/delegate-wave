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

Config D (a staged tool catalog across requests) was dropped: it needs a persistent PTY that win32
does not provide, and faking it would have measured the imitation rather than the harness.

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

The claim is **not reproduced**. Pass-rate and attempt count are identical across all three, so
neither reasoning effort nor the opening scaffold moved the outcome on anything measured here.

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

## Caveats

- **n=1 per cell.** These runs bound the effect size against a measured noise floor; they do not
  estimate it. Nothing here rules out a small systematic difference.
- **Tasks are single-file and self-contained.** The article's claim may hold on work large enough for
  context management to matter. This corpus cannot speak to that.
- **C varies wording only.** The staged-tool-catalog half of the Minimal hypothesis is untested.
- All measurements are from delegate-wave's own usage receipts; cost figures are executor-computed
  against the pinned basis, not a provider bill.

## Consequence for delegate-wave

`workerPrompt`'s framing costs nothing in capability at this task size, and it buys the invariants the
dispatcher depends on. No production change is indicated. The one change made is a `promptBuilder`
seam on `HarnessBackend`, defaulted to `workerPrompt`, so a measurement can vary the scaffold without
maintaining a fork of the backend that drifts from the code it is meant to measure.
