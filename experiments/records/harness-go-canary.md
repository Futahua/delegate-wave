# Harness-on-OpenCode-Go canary

Date: 2026-08-15. A throwaway calibration, deliberately not one of the ten frozen tasks.

Purpose: prove a real Harness process -- not a hand-built HTTP request -- reaches DeepSeek V4 Flash
through the OpenCode Go gateway, performs a file edit, and yields usage evidence, before any route
protocol is frozen against it.

## Wire-level smoke test

Run directly against `https://opencode.ai/zen/go/v1` with the existing Go key.

```text
GET /models                      200, deepseek-v4-flash exposed as a bare wire model
baseline completion              200
thinking: enabled                200, reasoning_tokens 6
thinking: disabled               200, reasoning_tokens absent
reasoning_effort: high           200, reasoning_tokens 18
stream_options include_usage     200
reasoning tool call              tool_calls 1, reasoning_content present
reasoning_content replay + tool  200, correct answer, prompt_cache_hit_tokens 384
```

Every DeepSeek-specific field Harness sends is accepted. `thinking: disabled` measurably suppressed
reasoning tokens rather than being ignored, so the gateway honours the field. The tool-call
continuation -- the second request replaying `reasoning_content` alongside the tool result -- is the
difficult DeepSeek V4 behaviour, and it succeeded with prefix cache reuse.

## Real Harness process

```text
package        @deepseek-ai/dsh@0.1.0-rc.6
profile        headless + restricted patch (recorded beside this file)
adapter        deepseek-official, baseURL https://opencode.ai/zen/go/v1
wire model     deepseek-v4-flash
task           read pairs.csv, create SUM.md with the total
result         SUM.md contains 7, correct
elapsed        13.5 s
```

### The restricted profile

Stock `headless` carries capabilities the delegate-wave worker contract forbids. Disabled:
`tool-bash`, `tool-pwsh`, `bash-sandbox`, `pwsh-sandbox`, `shell-env`, `tool-skill`, `skill`,
`skill-filesystem`, `skill-badge`, `user-questions`.

Removing the shell also required disabling `permission` (`@deepseek-ai/dsh-permission-presets`),
which waits on the shell service and otherwise blocks boot. Its presets exist to gate shell and exec
permissions this worker does not have.

Code Mode, subagents, workflows and Ralph are absent from `headless` already and stay absent: Harness
documents its worker-thread code runtime as containment rather than a security boundary, with
authority comparable to a shell.

## Open problem: usage evidence is not obtainable from this configuration

The canary succeeded, but its session artifact is a 511-byte header:

```text
.dsh/sessions/<workspace>/session-<id>/session.jsonl.zstd
  1 record, kind "session", no usage-bearing fields
```

The per-turn events carrying token counts are not persisted by `headless` as configured. The wire
smoke test proves the gateway returns full usage on every response, including cache-hit tokens, so
the data exists -- but a `HarnessBackend` cannot currently produce a `COMPLETE` usage receipt by
reading the session directory.

This must be resolved before `executor-ab-go-v1` is frozen, because the experiment's gate requires
`usageCoverage().healthy === true`, which requires a `COMPLETE` receipt with a non-null reference
cost. Options, in order of preference:

1. the JSON-RPC stdio surface, which streams durable session events including the model call's usage
   on `assistant/message`, so delegate-wave records raw frames and normalizes them itself;
2. enabling whatever persistence setting records model-request events in the session directory;
3. having the backend observe usage from its own transport.

Option 1 is preferred: delegate-wave owns capture, validation, normalization, pricing and measurement
health, while Harness only reports provider facts. Option 3 is least attractive, since it puts
measurement inside the executor and the usage contract deliberately keeps backends supplying neutral
observations only.

The JSON-RPC surface has no per-prompt result object -- `session/prompt` only acknowledges admission
-- which suits one prompt per attempt: persist frames until the root session emits its durable
`turn/end`, map that reason to an executor outcome, then shut the process down. The same stream
carries both lifecycle and usage evidence without Harness becoming authoritative for job success.

## Token accounting: the two arms use different conventions

Verified empirically on this route rather than taken from documentation.

```text
OpenCode step_finish   output 78, reasoning 17, and total = input + output + reasoning + cache
                       so the two figures are DISJOINT

Go wire response       completion_tokens 40, reasoning_tokens 21, ~100 chars of visible content
                       so reasoning is a SUBSET of completion
```

Harness follows the wire convention. A backend mapping `output_tokens = completion_tokens` while also
reporting `reasoning_tokens` would price every reasoning token twice, silently inflating the Harness
arm's cost -- an error that would have looked like a real efficiency difference.

The receipt's five dimensions are therefore defined as disjoint, with `output_tokens` meaning
non-reasoning output (WRK-011). A subset-style report is converted by the adapter; pricing stays
backend-independent, and a test proves the same real usage costs the same from either arm.

## Read isolation is not yet sufficient for the experiment

The restricted profile removes shell, skills and questions, but stock `headless` uses `fs-local`, and
Harness's filesystem sandbox restricts writes while reads pass through in every mode.

The trusted verifiers deliberately live outside the worker repository. A Harness worker running as
the same Windows user could read them by absolute path, which would recreate the verifier-leak
problem PR #13 eliminated and hand the Harness arm a capability the OpenCode arm does not have.

A delegate-wave-owned, symlink-aware read/write fence confined to the attempt worktree is required
before the corpus is exposed to Harness. Stock `dsh-fs-sandbox` is not sufficient.

## Not yet done

`executor-ab-go-v1` is not frozen. Freezing a route protocol whose usage evidence path is unproven
would preregister an experiment that cannot satisfy its own measurement gate.
