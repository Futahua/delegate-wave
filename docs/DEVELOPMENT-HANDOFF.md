# delegate-wave Development Handoff

Updated: 2026-08-14

## Mission and user constraint

Build a deterministic dispatcher that maximizes useful inexpensive-agent work per unit of scarce
Codex usage. The user prioritizes the project deadline over absolute Codex conservation, considers
DeepSeek inexpensive and expendable, wants Luna used for focused review/debugging, and wants every
material finding pushed to GitHub for remote review.

Repository: `https://github.com/Futahua/delegate-wave`

Local checkout: `D:\Letters\MatTroiSeConMoc\delegate-wave`

Managed data root: `D:\AssistantSystem\delegate-wave`

Hermes installation/config: `D:\Letters\MatTroiSeConMoc\HermesAI\.hermes`

## Frozen architecture

```text
Human intent
  -> Hermes (interpret/explain)
  -> MCP/protocol adapter
  -> delegate-wave Control API (authority boundary)
  -> deterministic policy/state machines
  -> SQLite operational truth + Git code truth
  -> disposable OpenCode/DeepSeek executors
  -> Codex only for genuine judgment/escalation/integration conflict
```

T3 remains the human workshop/technical console, not authoritative scheduler state. MCP is an
adapter; the Control API is the stable contract. Natural language expresses intent but never grants
authority. State transitions authorize side effects; side effects do not prove transitions occurred.

Attempt invariant:

```text
one attempt -> one immutable identity -> one fencing epoch -> one worktree -> at most one terminal result
```

Only a fenced `SUCCEEDED` attempt that passes deterministic validation may become an integration
candidate. Executor/backend reports are observations, not success authority.

## Delivered milestones

- PR #1: fenced dispatcher bootstrap, worktree isolation, validation, reconciliation, OpenCode
  permission canary, and live cheap-worker dogfood.
- PR #2/#3: approved integration vertical slice and follow-up hardening.
- PR #4: durable local Control API, strict CLI client, server-bound identity, immutable request
  intent/results, uncertainty handling, and child authority-token scrubbing.
- PR #5/#6: read-only Hermes MCP adapter and live Hermes integration.
- PR #7: bounded one-call overview. Live Hermes status cost fell from 52,300 to 9,900 counted tokens;
  result is capped at 3 KiB and health derives from authoritative `doctor()` state.
- PR #8 (current): Windows Task Scheduler supervision, current-user DPAPI credential loading,
  explicit stop/start semantics, and live recovery evidence.

Main currently includes through PR #7. PR #8 is the active draft review branch
`agent/windows-supervisor`.

## Current PR #8 state

The first PR #8 dogfood disproved an assumption: Windows recorded a force-killed long-running task as
result `-1` but did not invoke `RestartOnFailure` within 85 seconds. The corrected task combines:

- interactive-user logon trigger;
- one-minute repeated trigger;
- `MultipleInstancesPolicy=IgnoreNew`;
- five one-minute restart-on-failure requests;
- no execution-time limit;
- least privilege, no elevation.

Forced death then recovered PID 37564 as PID 44216 in approximately 46 seconds.

Remote review found two additional blockers, now fixed locally:

1. `stop` disables the task before `/End`; `start` enables before `/Run`. Live stop remained stopped
   beyond 70 seconds despite the periodic trigger.
2. Persistent plaintext user-environment Control tokens were migrated to
   `config\control-secrets.dpapi`. Installation uses current-user DPAPI, removes persistent
   Control/Hermes registry environment values, and changes the task action to `supervisor run`.
   Clean CLI and MCP processes load only their required protected credential.

DPAPI is protection at rest, not a sandbox against arbitrary code running as the same Windows user.
Truly untrusted validation still needs a separate OS identity, container, or VM.

The live task is `\delegate-wave-control`; at handoff it is enabled/running and the API is healthy on
`127.0.0.1:47321`. Do not print, commit, or copy credentials. The actual next-logon trigger remains
unobserved because the user's machine was deliberately not rebooted or logged off.

## Empirical model routing

```text
DeepSeek Flash  default bulk implementation and ordinary investigation
Luna            focused code review/debugging, especially concurrency/state machines
DeepSeek Pro    hard implementation escalation
Codex           architecture, ambiguous decomposition, integration conflict, final judgment
```

Luna found a real callback defect missed by a prior DeepSeek audit. Recorded comparable review runs:

```text
OpenCode/Luna          50.671 s, $0.0007872
DeepSeek Flash        145.454 s, $0.0018791472
Codex CLI + Luna      much larger context, estimated $0.01194732
corrected-head Luna    43.956 s, $0.00056206
```

Luna implementation ability remains less proven than its review ability. Do not build an intelligent
router yet; use explicit routing and measure real jobs.

## Immediate continuation plan

1. Finish PR #8:
   - run the complete deterministic suite;
   - repeat secret-registry/bundle/task-XML checks;
   - update the dogfood record with the two review fixes;
   - commit and push the new head for remote review;
   - merge only after the user reports no blocker.
2. Build proposal-only Hermes mutation authority as the next vertical slice:
   - Hermes MAY propose bounded work in ordinary language;
   - Hermes MUST NOT approve, run/integrate candidates, expand capability, or grant itself authority;
   - use a distinct server-bound proposal principal/scope, not the read-only observer token and not
     the operator token;
   - proposal includes origin identity, action digest, expected state version, cost ceiling, expiry,
     and idempotency identity;
   - policy may accept only proposal creation; execution remains a separate operator-approved
     Control operation;
   - add production-shaped tests proving the proposal credential is rejected on approvals,
     integration, reconciliation, task supervision, and direct scheduler mutations;
   - dogfood through live Hermes with one tiny proposal and measure total context/cost.
3. Dogfood 10–20 bounded jobs on one real noncritical project before adding concurrent waves.
4. Add compact failed-attempt handoffs later: maximum 300 tokens/2 KiB, structured observations and
   next step, never raw reasoning/transcript inheritance.
5. Add hosted CI after the product loop; current evidence is local/documented rather than a required
   GitHub status check.

## Deliberately deferred

- concurrent waves and generic lease infrastructure;
- T3-native worker execution/backend;
- persistent OpenCode server optimization;
- automatic model routing;
- multi-machine scheduling;
- production deployment and broad autonomous integration;
- treating Git worktrees as security sandboxes.

## Working discipline

- Preserve unrelated user changes and use `apply_patch` for source/document edits.
- Use draft PRs and publish material findings promptly.
- Keep raw worker transcripts out of authoritative/context paths; retain compact evidence receipts.
- Prefer deterministic fixes/tests over model calls when the issue is already understood.
- Never merge a version that authorizes itself; human approval remains external to the candidate.
- Never place credentials in Git, command arguments, Task Scheduler XML, logs, artifacts, or model
  context.
