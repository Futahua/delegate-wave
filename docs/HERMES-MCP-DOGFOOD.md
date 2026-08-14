# Hermes MCP Compatibility Record

Date: 2026-08-14

The adapter was probed with the actual local Hermes installation at:

```text
D:\Letters\MatTroiSeConMoc\HermesAI\.hermes\hermes-agent
```

Its installed Python MCP SDK launched `node src/cli.js mcp` over stdio, negotiated the adapter's
supported protocol `2025-06-18`, discovered all five tools, and called `list_projects` through a live localhost Control
API using only the observer credential.

The first probe found a real compatibility defect: MCP `structuredContent` must be an object, while
list results were emitted as an array. The adapter now returns `{ "result": ... }` for every
structured result. The identical second probe passed:

```text
server                 delegate-wave
tools discovered       5
list_projects error    false
structured result      object
```

The deterministic suite passes 58/58 tests, including observer read success, observer mutation
rejection before dispatcher invocation, unequal credential enforcement, bounded tool discovery,
and newline-delimited JSON-RPC lifecycle/call behavior.

No model call or model cost was used for this slice.
