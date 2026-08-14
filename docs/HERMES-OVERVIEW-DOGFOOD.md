# Hermes Compact Overview Dogfood

Date: 2026-08-14

The `get_overview` vertical slice was exercised against the live operational database through:

```text
Hermes
  -> MCP stdio
  -> observer-authenticated GET /v1/overview
  -> bounded SQLite projection
```

The Control API response contains totals, compact per-project latest-job state, and a bounded attention
queue. SQLite applies `COUNT`, status predicates, and `LIMIT` before results reach the adapter. The
final byte fitter is capped at 3 KiB and removes non-actionable project rows before attention evidence.

The installed Hermes SDK discovered the tool and consumed its result successfully. The economic
acceptance response was 2,712 serialized bytes: five project rows, three attention rows, and
`truncated: true`. MCP text content was only a compact totals sentence; the full object appeared once
in `structuredContent`.

After review, overview health was hardened to derive from authoritative `doctor()` state and gained a
`missing_repositories` count. The repeated live response was 2,737 bytes. Both measurements are
historical evidence and both remain below the 3-KiB limit.

## Economic acceptance

All model runs used `opencode-go/deepseek-v4-flash` from a neutral directory with repository rules
disabled. No Codex call was used.

| Shape | Total counted tokens | Input | Cache read | Output | Model API calls |
|---|---:|---:|---:|---:|---:|
| prior three-tool concierge baseline | 52,300 | 26,364 | 24,192 | 1,744 | 3 |
| one overview call, six-tool server | 12,345 | 6,179 | 5,632 | 534 | 2 |
| overview-only alias, 8-KiB ceiling | 11,735 | 5,786 | 5,376 | 573 | 2 |
| overview-only alias, 4-KiB ceiling | 10,036 | 1,682 | 7,808 | 546 | 2 |
| final overview-only alias, 3-KiB ceiling | **9,900** | **1,299** | **7,808** | **793** | **2** |

The final run reduced total counted tokens by 81.1% from the lean prior baseline and met the sub-10k
acceptance target. It called `get_overview` exactly once; two model API calls represent the request/tool
decision and final response.

OpenCode Go continued to report `estimated_cost_usd: 0.0` with `cost_status: unknown`. Dollar cost is
therefore unknown, not zero.

## Findings from dogfood

- Hermes rejected `--toolsets delegate_wave:get_overview`; its CLI does not accept an individual MCP
  tool selector in that position.
- A second `delegate_wave_overview` configuration alias publishes the same adapter and credential but
  selects only `get_overview` for dedicated status turns. No scheduler or authority logic is duplicated.
- The first schema used `totals.needs_attention`. DeepSeek interpreted this as a project count. The
  final schema uses `jobs_needing_attention` and `jobs_ready_for_integration`; the repeated answer was
  correct.
- The fixed Hermes prompt/cache remains the dominant floor. Further savings should not weaken the
  deterministic overview below the evidence needed for a correct answer.

Raw usage receipts remain outside Git under:

```text
D:\AssistantSystem\delegate-wave\artifacts\hermes-dogfood\
```
