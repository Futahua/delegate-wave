# Hermes MCP Adapter

The first Hermes adapter is intentionally read-only. It translates MCP stdio calls into the public
`delegate-wave` Control API; it never opens SQLite, invokes `Dispatcher`, or receives the operator
credential.

## Exposed tools

```text
get_overview
list_projects
get_project_summary
get_job
get_attention_needed
get_integration
```

No tool creates or runs work, grants approval, integrates code, reconciles state, or changes policy.
Project summaries include only the 20 most recent jobs plus total/truncation metadata. The Control
API independently enforces the authority boundary with a distinct observer bearer credential;
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
        - get_overview
        - list_projects
        - get_project_summary
        - get_job
        - get_attention_needed
        - get_integration
      resources: false
      prompts: false
  delegate_wave_overview:
    command: "node"
    args:
      - "D:/Letters/MatTroiSeConMoc/delegate-wave/src/cli.js"
      - "mcp"
    env:
      DELEGATE_WAVE_CONTROL_URL: "http://127.0.0.1:47321"
      DELEGATE_WAVE_HERMES_CONTROL_TOKEN: "${DELEGATE_WAVE_HERMES_CONTROL_TOKEN}"
    tools:
      include:
        - get_overview
      resources: false
      prompts: false
```

Hermes registers these as `mcp_delegate_wave_<tool>`. If the Control API is down, calls fail without
falling back to direct state access. Startup also fails if the Hermes token is missing or equals an
inherited operator token; there is no operator-token fallback.

For a dedicated low-context status invocation, restrict Hermes to this server and start outside a
source checkout whose repository instructions are irrelevant:

```powershell
hermes --provider opencode-go --model deepseek-v4-flash `
  --toolsets delegate_wave_overview --ignore-rules `
  --oneshot "What needs my attention?"
```

The `delegate_wave_overview` alias starts the same read-only adapter with the same observer credential;
it only prevents five unused drill-down schemas from entering a dedicated status turn.

`--ignore-rules` is suitable for this stateless concierge shape, not for ordinary conversations that
need Hermes memory or user preferences. Live measurements and their limitations are recorded in
[HERMES-LIVE-DOGFOOD.md](HERMES-LIVE-DOGFOOD.md).

## Deferred mutation boundary

Hermes mutation tools require a future proposal/approval capability that can prove a distinct
authenticated `hermes-mcp` origin and human approval. This adapter MUST NOT be given the operator
token as a shortcut.
