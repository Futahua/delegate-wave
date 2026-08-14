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

1. enable whatever persistence setting records model-request events in the session stream;
2. use the JSON-RPC stdio surface, which streams durable session events, rather than scraping a
   session directory;
3. have the backend observe usage from its own transport.

Option 3 is least attractive: it puts measurement inside the executor rather than delegate-wave, and
the usage contract deliberately keeps backends supplying neutral observations only.

## Not yet done

`executor-ab-go-v1` is not frozen. Freezing a route protocol whose usage evidence path is unproven
would preregister an experiment that cannot satisfy its own measurement gate.
