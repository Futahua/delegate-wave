# Hermes MCP Normative Specification

**MCP-001** The Hermes adapter MUST call only the public Control API and MUST NOT access dispatcher
internals, SQLite, Git integration machinery, or execution backends.

**MCP-002** The initial adapter MUST expose read-only tools only.

**MCP-003** Hermes MUST receive a credential distinct from the operator credential. The Control API
MUST reject every mutating route authenticated with that observer credential.

**MCP-004** Observer and operator credentials MUST NOT be equal.

**MCP-005** The observer credential MUST bind to principal `hermes` and origin `hermes-mcp` at the
server. Caller content MUST NOT select or override this identity.

**MCP-006** The stdio adapter MUST emit only newline-delimited JSON-RPC on stdout. Diagnostics MAY
use stderr.

**MCP-007** Unknown MCP methods and tools MUST fail without issuing a Control API request.

**MCP-008** Adding mutating Hermes tools requires a separate authority specification and MUST NOT be
implemented by giving Hermes the operator credential.

## Traceability

| Rules | Enforced by | Tested by |
|---|---|---|
| MCP-001–002 | `HermesMcpAdapter` and bounded tool list | adapter surface test |
| MCP-003–005 | observer authentication branch in Control server | observer query/mutation and equal-token tests |
| MCP-006–007 | `runMcpStdio` JSON-RPC loop | stdio lifecycle/tool-call tests |
| MCP-008 | absent mutation tools and documentation | adapter surface test |
