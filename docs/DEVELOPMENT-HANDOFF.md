# delegate-wave Development Handoff

Updated: 2026-08-15

## What this is now

A working personal daily driver, not a bootstrap. The V1 acceptance sentence holds end to end on the
live installation:

> Tell Hermes what you want changed -> Hermes proposes bounded work -> authorize once -> cheap
> workers perform it -> deterministic validation checks it -> one approval integrates it -> Hermes
> reports what changed and what it cost -> ordinary failures and reboots recover without hand
> repairing SQLite or Git.

Verified live on 2026-08-15: Hermes proposed, one authorization ran worker and validation and
produced an integration proposal in 12.7 s, one approval integrated commit fbd66a3, and Hermes
reported Done with $0.000787 at complete cost accounting.

## What V1 added on top of the bootstrap

```text
cancel            durable intent, process kill, stale-callback refusal, terminal receipt
budget            enforced ceilings; unmeasured spend blocks rather than passes
recovery          backup with checksums, verified restore, compare-and-swap rollback
auto-advance      two human decisions instead of six operator steps
Hermes surface    working / needs a decision / ready to check / done, with honest cost
fence             symlink and junction aware attempt-root read/write/list/search confinement
gauntlet          sixteen failure modes asserted as tests
```

## Still deferred, deliberately

```text
HarnessBackend       the restricted profile and wire compatibility are proven; the JSON-RPC usage
                     path is not, so no route protocol is frozen and no A/B has been run
executor A/B         blocked on the above; OpenCode remains production
concurrent waves     one integration branch, serial integration
T3-native execution, multi-machine scheduling, hosted CI, automatic routing
```

The Harness work is recorded in `experiments/records/`. The frozen task corpus for that comparison is
`experiments/executor-ab-v1`, digest b34387db, merge commit 7ef7b74f, untouched.

## Mission

Maximize useful inexpensive-agent work per unit of scarce expensive-model usage, on one machine, for
one person. DeepSeek Flash is expendable and does ordinary work; Luna reviews and debugs; DeepSeek
Pro is escalation; Codex is reserved for genuine judgment.

Repository: `https://github.com/Futahua/delegate-wave`

```text
local checkout    D:\Letters\MatTroiSeConMoc\delegate-wave
managed data      D:\AssistantSystem\delegate-wave
Hermes config     D:\Letters\MatTroiSeConMoc\HermesAI\.hermes
```

## Frozen architecture

```text
Human intent
  -> Hermes (interpret, propose)
  -> MCP adapter
  -> Control API (the authority boundary)
  -> deterministic policy and state machines
  -> SQLite operational truth + Git code truth
  -> disposable OpenCode workers
  -> Codex only for judgment, escalation, integration conflict
```

Natural language expresses intent but never grants authority. State transitions authorize side
effects; side effects never prove a transition occurred.

Attempt invariant:

```text
one attempt -> one immutable identity -> one fencing epoch -> one worktree -> at most one terminal result
```

Only a fenced `SUCCEEDED` attempt that passes deterministic validation may become an integration
candidate.

## Authority model

```text
operator    read + propose + operate      the human, via CLI
proposer    read + propose                Hermes: may request work, may not approve it
observer    read                          read-only status
```

Each credential is a separate DPAPI record; a process decrypts only the role it needs. Control-plane
credentials are scrubbed from every child process, derived from one declared list so a new role
cannot silently remain inheritable.

## Normative specifications

```text
docs/BOOTSTRAP-SPEC.md            worker permissions, validation, usage accounting (WRK-001..011)
docs/CONTROL-API-SPEC.md          the mutation authority boundary
docs/APPROVED-INTEGRATION-SPEC.md integration, approval, compare-and-swap
docs/PROPOSAL-AUTHORITY-SPEC.md   proposal-only authority (PROP-001..015)
docs/SUPERVISOR-SPEC.md           Windows supervision and credential storage (SUP-001..013)
```

Every normative rule has a traceability row naming the tests that enforce it.

## Working discipline

- Preserve unrelated user changes.
- Prefer deterministic fixes and tests over model calls when the issue is already understood.
- Never merge a version that authorizes itself; human approval stays external to the candidate.
- Never place credentials in Git, command arguments, Task Scheduler XML, logs, artifacts, or model
  context.
- Recovery is a supported operation, not an emergency: backup, restore, and rollback exist so nobody
  edits SQLite or Git by hand.
