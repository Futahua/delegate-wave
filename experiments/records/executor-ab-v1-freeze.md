# executor-ab-v1 freeze record

The apparatus was frozen before either executor was run against it.

```text
corpus                    executor-ab-v1
apparatus preregistered   2026-08-14   (tasks.json frozen_at)
merged to main            2026-08-15 +07:00
merge commit              7ef7b74f4c0dd07c889a22d608328988ea50b76a
apparatus digest          b34387dbc319dcbe6b0a30585b931b9646056d33fe91cabce586a9e2475f07fa
corpus tree               0f1376ffc07b1dd5eb69ba444a6c88b4efd603a6
src tree                  95a3ae9d949cc08f2a96cc0752f5eb6fa1e468e3
test tree                 ad76fb968144b8b7b9c9cab7540d61d6be572e06
suite                     174/174
```

The two dates describe different events: the apparatus was preregistered on 2026-08-14 and the merge
landed after local midnight. Neither is the other's correction.

Two independent identities: the digest, recomputable with `node digest.mjs`, and the merge commit,
which Git verifies. Either detects a post-hoc edit.

## Measurement plane state

The supervised installation was restarted onto merged main before any calibration, since the
previously running API predated the usage-receipt work and would have produced no receipts at all.

```text
control API      restarted, healthy
schema           12
receipt objects  attempt_usage_receipts with both immutability triggers
```

Restarting surfaced two registered projects whose repositories had been deleted, left over from the
credential-leak probes. `doctor()` correctly reported the installation unhealthy. The repositories
were restored as placeholders rather than deleting the project rows, since removing them would have
discarded audit history to make a health check pass.

## Temp and cache location

`os.tmpdir()` already resolves to `D:\Programs\evTEMP`, and a spawned child inherits it, so executor
temp was never the constraint. C: pressure comes from package and global caches. For any run that
installs packages, redirect per process rather than editing the machine environment:

```text
TEMP / TMP          D:\AssistantSystem\delegate-wave\tmp
npm_config_cache    D:\AssistantSystem\delegate-wave\npm-cache
```

Both directories exist. Process-scoped assignment was verified to move `os.tmpdir()` without
altering the user or machine environment.

## Route decision: OpenCode Go for both arms

The calibration was originally preregistered against the direct DeepSeek API. The configured OpenCode
providers are `ollama-cloud, openrouter, opencode-go, openai, meta` -- no direct DeepSeek entry -- and
a smoke test showed the better experiment does not need one.

OpenCode Go exposes `deepseek-v4-flash` as a bare wire model on an OpenAI-compatible endpoint, and
Harness's DeepSeek adapter takes a configurable `baseURL` and passes the selected model through as
the wire model. Both executors can therefore run over the same endpoint, the same account, and the
same wire model, which holds the commercial route constant and leaves the executor loop as the only
variable. That answers the question we actually care about: does Harness get more accepted work from
the same scarce Go allowance?

`deepseek-official` in Harness names the adapter route, not the destination host; the resolved
`baseURL` decides where the request goes.

### Smoke test results

Run directly against `https://opencode.ai/zen/go/v1`, authenticating with the existing Go key.

```text
GET /models                      200, deepseek-v4-flash exposed
baseline completion              200
thinking: enabled                200, reasoning_tokens 6
thinking: disabled               200, reasoning_tokens absent
reasoning_effort: high           200, reasoning_tokens 18
stream_options include_usage     200
reasoning tool call              tool_calls 1, reasoning_content present
reasoning_content replay + tool  200, correct answer, cache-hit 384 tokens
```

Every DeepSeek-specific field Harness sends is accepted. `thinking: disabled` measurably suppressed
reasoning tokens rather than being ignored, and the tool-call continuation -- the second request
replaying `reasoning_content` alongside the tool result, which is the difficult DeepSeek V4 behaviour
-- succeeded and reported prefix cache reuse.

### Historical 2x discrepancy: corrected statement

An earlier draft described the historical 2x gap as evidence of a route or commercial-arrangement
difference. That is too strong. The accurate statement:

> Historical OpenCode artifacts reported an executor-computed cost exactly 2x below the normalized
> reference cost. OpenCode Go's published rates for this model match the corrected v2 reference basis,
> so the discrepancy is consistent with stale executor cost metadata, but its cause was not
> independently established.

## Next: a superseding experiment identity

`executor-ab-v1` stays immutable at the identities above. The route change is preregistered as a new
experiment, `executor-ab-go-v1`, referencing the same frozen task corpus by digest rather than
modifying it, so the corpus is reused without the protocol being edited after the fact.

The throwaway calibration fixture is prepared at
`D:\AssistantSystem\delegate-wave\canaries\calibration-v1`, deliberately not one of the ten frozen
tasks.

## Gate, before any pair runs

```text
usageCoverage().healthy === true
receipt status            COMPLETE
reference_cost_usd        non-null, basis deepseek-direct-2026-08-14-v2
reference cost            reproduced by hand from the recorded token counts
capture failures          none
missing evidence          none
```
