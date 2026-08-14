# Hermes MCP Normative Specification

**MCP-001** The Hermes adapter MUST call only the public Control API and MUST NOT access dispatcher
internals, SQLite, Git integration machinery, or execution backends.

**MCP-002** The initial adapter MUST expose read-only tools only.

**MCP-003** Hermes MUST receive a credential distinct from the operator credential. The Control API
MUST reject every mutating route authenticated with that observer credential.

**MCP-004** Observer and operator credentials MUST NOT be equal.

**MCP-005** The observer credential MUST bind to a server-configured principal (default `hermes`) and
origin `hermes-mcp`. Caller content MUST NOT select or override this identity.

**MCP-006** The stdio adapter MUST emit only newline-delimited JSON-RPC on stdout. Diagnostics MAY
use stderr.

**MCP-007** Unknown MCP methods and tools MUST fail without issuing a Control API request.

**MCP-008** Adding mutating Hermes tools requires a separate authority specification and MUST NOT be
implemented by giving Hermes the operator credential.

**MCP-009** The Hermes credential MUST be explicitly present and MUST NOT fall back to or equal the
operator credential. The MCP process MUST discard an accidentally inherited operator credential.

**MCP-010** Project summaries MUST include at most the 20 most recent jobs and MUST report the total
job count and whether the result was truncated.

**MCP-011** The everyday overview MUST be a deterministic Control API query bounded to 20 projects,
20 attention items, 160 characters per summary, and 3 KiB for the complete serialized result.

**MCP-012** Overview bounds MUST be applied in SQLite queries before data reaches the MCP adapter.
The overview MUST NOT include source paths, attempt history, validation logs, artifact paths, raw
receipts, failure details, or full job goals.

**MCP-013** The overview's MCP text content MUST contain only compact totals. The complete overview
MUST appear once in `structuredContent`, not be duplicated as JSON text.

**MCP-014** Overview health MUST derive from authoritative `doctor()` health. It MUST expose only
counts for active attempts, unresolved integrations, and missing repositories; repository paths MUST
NOT enter the overview.

## Traceability

| Rules | Enforced by | Tested by |
|---|---|---|
| MCP-001–002 | `HermesMcpAdapter` and bounded tool list | adapter surface test |
| MCP-003–005 | observer authentication branch in Control server | observer query/mutation and equal-token tests |
| MCP-006–007 | `runMcpStdio` JSON-RPC loop | stdio lifecycle/tool-call tests |
| MCP-008 | absent mutation tools and documentation | adapter surface test |
| MCP-009 | `hermesControlClient` fail-closed credential construction | factory and production-process fallback tests |
| MCP-010 | bounded project-summary projection | 23-job summary test |
| MCP-011–012 | `Dispatcher.overview` SQL projection and byte fitter | 25-project/25-attention query test |
| MCP-013 | overview-specific MCP renderer | stdio structured-result non-duplication test |
| MCP-014 | `doctor()`-derived overview health projection | missing-repository false-green regression |
