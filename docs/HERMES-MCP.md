# Hermes MCP Adapter

The first Hermes adapter is intentionally read-only. It translates MCP stdio calls into the public
`delegate-wave` Control API; it never opens SQLite, invokes `Dispatcher`, or receives the operator
credential.

## Exposed tools

```text
list_projects
get_project_summary
get_job
get_attention_needed
get_integration
```

No tool creates or runs work, grants approval, integrates code, reconciles state, or changes policy.
The Control API independently enforces this boundary with a distinct observer bearer credential;
even a forged MCP `tools/call` for a mutation cannot cross the HTTP command boundary.

## Start the Control API

Use distinct random values. The observer token is deliberately less powerful than the operator
token, but it is still a credential and should remain in the credential environment rather than Git.

```powershell
$env:DELEGATE_WAVE_CONTROL_TOKEN = '<operator-secret>'
$env:DELEGATE_WAVE_CONTROL_OBSERVER_TOKEN = '<different-observer-secret>'
$env:DELEGATE_WAVE_CONTROL_PRINCIPAL = '<operator-id>'
delegate-wave serve
```

## Configure the local Hermes installation

Put the observer value in Hermes' `.env` as `DELEGATE_WAVE_HERMES_CONTROL_TOKEN`. Add this block to
Hermes' `config.yaml` (the paths below match the current Windows installation):

```yaml
mcp_servers:
  delegate_wave:
    command: "node"
    args:
      - "D:/Letters/MatTroiSeConMoc/delegate-wave/src/cli.js"
      - "mcp"
    env:
      DELEGATE_WAVE_CONTROL_URL: "http://127.0.0.1:47321"
      DELEGATE_WAVE_HERMES_CONTROL_TOKEN: "${DELEGATE_WAVE_HERMES_CONTROL_TOKEN}"
    tools:
      include:
        - list_projects
        - get_project_summary
        - get_job
        - get_attention_needed
        - get_integration
      resources: false
      prompts: false
```

Hermes registers these as `mcp_delegate_wave_<tool>`. If the Control API is down, calls fail without
falling back to direct state access.

## Deferred mutation boundary

Hermes mutation tools require a future proposal/approval capability that can prove a distinct
authenticated `hermes-mcp` origin and human approval. This adapter MUST NOT be given the operator
token as a shortcut.
