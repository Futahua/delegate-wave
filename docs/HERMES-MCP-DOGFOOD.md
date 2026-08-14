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

After the credential hardening, a further installed-SDK probe launched the MCP process with both
`OPERATOR` and `OBSERVER` present. The HTTP harness observed exactly `Bearer OBSERVER`; the call
passed, and the operator credential was not selected.

The deterministic suite passes 60/60 tests, including observer read success, observer mutation
rejection before dispatcher invocation, unequal credential enforcement, bounded tool discovery,
missing-token operator-fallback rejection, 20-job summary bounds, and newline-delimited JSON-RPC
lifecycle/call behavior.

No model call or model cost was used for this slice.
