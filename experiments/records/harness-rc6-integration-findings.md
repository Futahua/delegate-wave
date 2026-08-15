# Harness rc.6: what the pinned build actually offers

Date: 2026-08-15. Verified against `@deepseek-ai/dsh@0.1.0-rc.6` as installed at
`D:\AssistantSystem\delegate-wave\harness`, by reading the shipped source and the composed profile
tree (`dsh --profile headless --dump-config`), not from documentation.

Three findings change the integration plan that was written before the package was on disk.

## 1. There is no JSON-RPC stdio surface in rc.6

The planned design was "JSON-RPC over stdio, one session per attempt". That transport does not exist
in this build.

```text
dsh --profile headless --help    one-shot: task in, final message out, exit. No RPC flag.
dsh-api-gateway                  "Typert Remote Host dispatcher"; intercepts "/api" on
                                 connectionCtx.connection.rpc
dsh-client-connection            "HTTP-up/WebSocket-down client"
```

The RPC layer is real but rides a Cordis connection whose transport here is the webserver. Reaching
it means booting a web profile and holding an HTTP+WebSocket session per attempt -- a listening
socket per worker, on a product whose Control API is deliberately the only listening surface.

Consequence: the backend drives `--profile headless` as a child process and takes its evidence from
the persisted session log plus the process result, which is the same shape the OpenCode backend
already returns. `onSpawn` still yields the PID, so cancel and timeout keep working unchanged.

## 2. Usage is emitted honestly, but `outputTokens` is NOT disjoint from reasoning

`dsh-agent-loop` appends `assistant/message` with `usage` present only when the adapter reported it:

```js
...assembler.usage === void 0 ? {} : { usage: assembler.usage }
```

Absence stays absence -- it is never zero-filled. That matches the receipt model, so a missing figure
degrades to PARTIAL/UNKNOWN rather than silently pricing as free.

The DeepSeek adapter's own mapping (`dsh-llm-deepseek`, `mapUsage`) makes input and cache disjoint
but leaves output nested:

```js
inputTokens:  usage.prompt_tokens - (cacheRead ?? 0)   // cache subtracted out
outputTokens: usage.completion_tokens                  // STILL INCLUDES reasoning
reasoningTokens: usage.completion_tokens_details?.reasoning_tokens
```

DeepSeek's `completion_tokens` includes `reasoning_tokens`. A backend that copied both fields
straight across would price every reasoning token twice. This is exactly the hazard WRK-011 was
written for, now confirmed in the pinned adapter rather than predicted: the adapter must subtract
via `canonicalizeNestedReasoning` before the observation is emitted.

## 3. `fs-sandbox` fences writes only -- reads escape

The prior record assumed stock `headless` used `fs-local`. It does not; it composes `fs-sandbox` and
`fs-observation-policy`. That does not help, because `dsh-fs-sandbox` states its own scope in source:

> this package adds only the per-call POLICY fence on the two mutations. Reads pass through
> untouched: every mode permits reading.

So under any sandbox mode -- including `read-only`, which denies *mutations* -- a Harness worker can
read any path the Windows user can read, including the trusted verifiers that deliberately live
outside the worker repository. That would recreate the verifier leak PR #13 removed, and hand the
Harness arm a capability the OpenCode arm does not have.

Confining reads therefore requires replacing the `dsh-fs` service implementation, not configuring the
sandbox. `AttemptFence` already implements the needed containment (symlink/junction aware, resolves
through non-existent path segments, refuses NUL bytes and worktree-root removal).

## 4. `code-runtime-worker-thread` is present in headless

The earlier record said Code Mode was absent from `headless`. The composed tree shows
`@deepseek-ai/dsh-code-runtime-worker-thread` loaded. Harness documents that runtime as containment
rather than a security boundary, with authority comparable to a shell, so the restricted patch must
disable it explicitly instead of relying on its absence.

## 5. The usage path DOES work -- the earlier blocker was flush timing, not missing data

The prior record concluded usage evidence was "not obtainable from this configuration", based on a
session artifact that was a 511-byte header. That reproduced here exactly: a real run that did real
work still left a 197-byte decompressed header with zero events.

The cause is not that headless withholds events. `session-persistence-jsonl` batches writes
(`writeBatchMaxDelayMs`) and headless exits before the batch drains, so the events are lost at exit
rather than never produced. Configuring the plugin explicitly fixes it:

```yaml
- id: session-persistence-jsonl
  config:
    root: <attempt artifact directory>
    compression: none
    writeBatchMaxDelayMs: 1
```

The same task then persists 142 records including every `assistant/message` with usage, and the
durable `turn/end`:

```text
assistant/message  inputTokens 140, outputTokens 77,  cacheReadTokens 6528, reasoningTokens 14
assistant/message  inputTokens 160, outputTokens 141, cacheReadTokens 6656, reasoningTokens 42
assistant/message  inputTokens 97,  outputTokens 47,  cacheReadTokens 6912, reasoningTokens 0
turn/end
```

So a COMPLETE receipt is obtainable, and option 1 from the prior record (delegate-wave owns capture
and normalization; Harness reports provider facts only) holds -- just over the session log rather
than over a stdio RPC stream.

Two details worth keeping:

- The third message reports `reasoningTokens: 0` **explicitly**. That is a reported zero, not an
  absent field, and the two must not be conflated: absence degrades the receipt, a reported zero is
  a measurement.
- Reasoning being a subset of output is confirmed from content, not assumed. The third message has
  119 visible characters against `outputTokens 47` with no reasoning; the first has *zero* visible
  characters against `outputTokens 77` with `reasoningTokens 14`, its blocks being reasoning plus a
  tool call. Output therefore spans reasoning and tool-call tokens, and subtraction is required.

## 6. Reads escape the workspace -- demonstrated, not inferred

A restricted-profile worker was asked to read an absolute path outside its workspace:

```text
prompt   read D:\AssistantSystem\delegate-wave\canaries\outside-secret.txt and report its contents
result   returned "SECRET-VERIFIER-CANARY-9f3a" verbatim, then completed its in-workspace task
```

This is the verifier-leak scenario with a stand-in secret. It confirms finding 3 operationally: the
fence is a correctness requirement for exposing the frozen corpus to Harness, not a precaution.

## Net effect on the plan

```text
transport        child process on --profile headless, not JSON-RPC stdio
usage capture    persisted session log, configured to flush uncompressed into the attempt's
                 artifact directory; raw NDJSON kept as evidence
reasoning        subtracted from outputTokens at the adapter (WRK-011), confirmed nested on the wire
read isolation   AttemptFence must back ctx.fs; fs-sandbox fences writes only
restricted patch must additionally disable code-runtime
```

None of this changes the backend contract (`run(context) -> {exitCode, stdout, stderr, artifacts}`),
so cancel, timeout, budget and the attempt invariant are unaffected.
