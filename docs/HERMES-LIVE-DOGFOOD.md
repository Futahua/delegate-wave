# Hermes Live Read-Surface Dogfood

Date: 2026-08-14

PR #5 was merged as `849970b`. The documented `delegate_wave` MCP server was then added to the
installed Hermes configuration at `D:\Letters\MatTroiSeConMoc\HermesAI\.hermes\config.yaml`.
Distinct operator and observer credentials were generated into the Windows user environment; their
values were not printed or stored in Git.

The Control API was started on `127.0.0.1:47321`. A live observer query succeeded and a live observer
mutation was rejected with HTTP 403. `hermes mcp test delegate_wave` connected in 609 ms and
discovered exactly the five selected tools.

## Natural-language result

Hermes used `opencode-go/deepseek-v4-flash` to answer which project was active, what required human
attention, and what happened with the latest real-project job. It correctly separated the real
`delegate-wave` repository from canary history, found the latest successful self-dogfood job, and
identified superseded `NEEDS_ATTENTION` jobs plus three `READY_FOR_INTEGRATION` candidates.

The five-tool read surface was therefore sufficient for this first operator-status workflow. No
Codex model call was used.

## Efficiency finding

Three otherwise equivalent runs exposed an important Hermes invocation cost:

| Invocation | Total counted tokens | Input | Cache read | Output | API calls |
|---|---:|---:|---:|---:|---:|
| default tool surface, Hermes source checkout | 140,099 | 52,009 | 86,784 | 1,306 | 3 |
| `--toolsets delegate_wave`, Hermes source checkout | 102,409 | 39,271 | 61,824 | 1,314 | 3 |
| `--toolsets delegate_wave --ignore-rules`, neutral directory | 52,300 | 26,364 | 24,192 | 1,744 | 3 |

The bounded invocation reduced total counted tokens by 62.7%, but the final result is still large for
a simple status question. Offline `hermes prompt-size` showed that launching from the Hermes source
checkout injected roughly 75 KB of repository context. Prompt instructions such as "use MCP only"
do not remove unused tool schemas; an explicit toolset restriction is required.

OpenCode Go did not report pricing to Hermes. Each usage receipt contains
`estimated_cost_usd: 0.0` together with `cost_status: unknown`; this MUST be interpreted as unknown
cost, not zero cost.

Raw usage receipts remain outside Git under:

```text
D:\AssistantSystem\delegate-wave\artifacts\hermes-dogfood\
```

## Resulting operating guidance

- Dedicated development-status invocations SHOULD enable only the `delegate_wave` toolset.
- Status invocations SHOULD start from a neutral directory, not a source checkout with unrelated
  repository instructions.
- `--ignore-rules` is appropriate for a dedicated stateless benchmark/concierge invocation, but not
  as a blanket replacement for Hermes preference memory.
- A later optimization SHOULD add a compact deterministic overview query so the model can answer the
  common status question with one bounded tool result instead of assembling several broad reads.
- Hermes mutation authority remains disabled.
