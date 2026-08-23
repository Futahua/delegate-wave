# Autonomous sessions: build-vs-borrow audit and proposed architecture

Research deliverable, revised after the transport spike falsified its first conclusion.

## Falsified route: ACP as the Hermes → delegate-wave seam

The first draft of this document concluded that delegate-wave should become an
ACP agent, because Hermes ships `acp_adapter/`, `acp_registry/`, an ACP client
file and the `agent-client-protocol` library. That conclusion was wrong, and the
error was inferring **client** capability from the presence of ACP code.

Measured against the installed Hermes 0.19.0:

| observation | file | meaning |
|---|---|---|
| `class HermesACPAgent(acp.Agent)` | `acp_adapter/server.py` | Hermes is an ACP **agent server** |
| `acp_registry/agent.json` → `"id": "hermes-agent"`, runs `hermes-acp` | `acp_registry/` | Hermes advertising **itself** so editors can launch it |
| `if agent.provider == "copilot-acp"` | `agent/agent_init.py:1102` | the only path reaching client code, one hardcoded provider |
| `class _ACPChatCompletions`, `.chat.completions.create()` | `agent/copilot_acp_client.py` | an **OpenAI-shaped inference shim** |
| `acp_command` / `acp_args` | `agent/agent_init.py:572` | override the binary that shim spawns, nothing more |

The shim's own docstring says it "lets Hermes treat the GitHub Copilot ACP server
as a chat-style" provider. It does speak `session/prompt` and handle
`session/request_permission`, but internally, collapsing an entire ACP turn into
one chat completion.

**Hermes uses ACP to consume a model, not to delegate to an agent.** Pointing
`acp_command` at delegate-wave would make Hermes treat it as an OpenAI
chat-completions endpoint — the wrong shape entirely.

There is a second, structural reason this route was never as attractive as it
looked. ACP models one client talking to one coding agent. If Hermes is an ACP
agent and delegate-wave is also an ACP agent, they are on the **same side of the
protocol**, and something else still has to be the client. ACP is valuable at the
UI ↔ Hermes boundary. It is not the Hermes ↔ delegate-wave boundary.

**Decision: REJECT ACP for this seam.** Do not author an ACP client stack inside
delegate-wave, and do not adopt an external one (`effect-acp` or otherwise) for a
boundary that turns out not to need a new protocol at all.

This negative result is the main reason the chosen architecture is small.

## The seam that already exists

`config.yaml:586` on this machine:

```yaml
mcp_servers:
  delegate_wave:
    args: ["D:/Letters/MatTroiSeConMoc/delegate-wave/src/cli.js", "mcp", ...]
  delegate_wave_overview:
    ...
```

Hermes already calls delegate-wave over MCP, in production, today. The transport
question was answered before it was asked. What is missing is not a protocol but
a **capability**: everything currently exposed is read-only, plus `propose_work`,
which explicitly "cannot approve, run, or integrate anything".

## Chosen architecture

```text
you
 │  "fix X, but don't touch parser Y"
 ▼
Hermes ── owns intent, holds the mode, judges satisfaction
 │
 │  existing MCP transport, existing observer/proposer credentials
 ▼
delegate-wave autonomous session
 ├── durable user intent
 ├── autonomy mode (permission envelope)
 ├── Hermes ↔ manager semantic messages
 ├── ManagerService  (unchanged)
 ├── workers, verifier (unchanged)
 └── eventually: safe auto-integration (separate spike)
```

No ACP. No new agent protocol. No blocking MCP call. No operator credential
handed to Hermes. No sequence of approval buttons clicked automatically.

### One capability, three operations

`autonomous_session` is a single logical capability, not three permission gates:

```text
session_start   project, intent, mode, bounds  →  session_id, state   (returns immediately)
session_poll    session_id                     →  semantic state, or a question
session_answer  session_id, answer             →  durable evidence, manager continues
```

`session_start` must return immediately. `tools/mcp_tool.py` uses a per-call
timeout defaulting to 300s with idle stdio recycling, so a managed run — minutes
of worker time — cannot be one blocking call. It creates durable state and the
machinery advances asynchronously. This is not a workaround: delegate-wave's
truth is already durable and restart-tolerant, so polling is the shape that
matches what the system already is.

`session_poll` returns a small semantic state, never the ledger:

```text
working | waiting_for_hermes | completed | failed
```

and when the manager needs judgment: `question`, `why_it_matters`,
`relevant_evidence`. Hermes reasons from the original user conversation — which
delegate-wave never sees — and answers. That answer becomes durable evidence and
the manager continues from it.

### Mode is a permission envelope, not a workflow state

```text
mode           = what this session is permitted to do          (durable policy)
session state  = what is currently happening                   (observation)
```

`AUTO`, `MANUAL`, `ACCEPT_EDITS`, `PLAN`, `BYPASS`. The mode never becomes
another state-machine checkpoint, and delegate-wave contains no rule of the form
"after N reviews, ask". Interruption arises from the reasoning and safety
situation.

`BYPASS` suppresses **questions**, never **invariants**. Protected paths,
deterministic validation, CAS integration, budget admission, worktree isolation
and credential isolation are mechanical and refuse regardless of mode.

## Reuse-first decision table

| capability | candidate | decision |
|---|---|---|
| Hermes ↔ delegate-wave transport | **MCP**, already wired and live | **ADOPT (already in place)** |
| agent protocol between them | ACP | **REJECT — falsified above** |
| persistent conversation / intent | **Hermes** sessions, memory | **ADOPT** |
| autonomy mode UI | **Hermes** ACP `SessionModeState` (Default / Accept Edits / Don't Ask) | **BORROW DESIGN**, mode lives in the session |
| provider abstraction | OpenCode / Codex App Server | **KEEP (already borrowed)** |
| UI / remote control | **T3 Code** | **BORROW DESIGN**, second wave |
| sandboxing | OpenHands | **REJECT** — needs `docker.sock`, root-equivalent; worse than worktrees |
| worktrees, validation, evidence, pricing, budget, CAS, supervisor | delegate-wave | **KEEP** |

## Failure, restart and drift

| situation | behaviour |
|---|---|
| Hermes disconnects mid-run | session continues; poll resumes from SQLite |
| delegate-wave process restart | session resumes from durable evidence, not conversation |
| interrupted manager turn | existing `reconcile`: `UNCERTAIN`, never replayed |
| ceiling reached | admission refuses; surfaces as a real question |
| protected path touched | refuses mechanically, any mode |

## Sequencing

1. **Session spike** (this wave) — fake repo, fake manager, fake workers. Prove
   start/poll/answer, the semantic exchange, mode as durable policy, and
   restart-resumption. Stop at `SEMANTICALLY_ACCEPTED` with a candidate commit.
2. **Integration spike** (separate, dangerous) — CAS when unchanged, reconcile
   onto an advanced HEAD, manager-attempted conflict resolution, restore on
   post-integration validation failure, question to Hermes only when
   unresolvable. This is where real repositories start moving automatically and
   it deserves its own falsification work.
3. **Real models, real repository.**
4. **T3 Code / remote control**, once there is something to control.

## Falsification targets for the session spike

- `PLAN` cannot create a write attempt.
- `AUTO` progresses with no human ceremony.
- mode survives a process restart.
- a manager question reaches Hermes and its answer durably resumes the run.
- session resumes from SQLite after a kill, mid-run.
- `BYPASS` still refuses protected paths, still runs validation, still respects
  the ceiling, still isolates credentials.

## Sources

- [Agent Client Protocol — prompt turn](https://agentclientprotocol.com/protocol/prompt-turn)
- [Agent Client Protocol — session setup](https://agentclientprotocol.com/protocol/session-setup)
- [hermes-agent — ACP internals](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/acp-internals.md)
- [hermes-agent — copilot_acp_client.py](https://github.com/NousResearch/hermes-agent/blob/main/agent/copilot_acp_client.py)
- [OpenCode — permissions](https://opencode.ai/docs/permissions/)
- [T3 Code](https://github.com/pingdotgg/t3code)
- [OpenHands — agent server and ACP](https://www.openhands.dev/blog/use-any-coding-agent-in-openhands-with-acp)
