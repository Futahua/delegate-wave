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
fence             symlink and junction aware attempt-root confinement, for `restricted` work
gauntlet          sixteen failure modes asserted as tests
Harness           default executor, selectable capability profile, per-call usage evidence
```

## Executors

DeepSeek Harness is the default executor for ordinary work; OpenCode is the proven fallback, intact
and unchanged. Selection is explicit, happens between attempts, and reports its reason, so a fallback
is a readable fact rather than an inference from which artifacts appeared.

```text
Flash, Pro   HarnessBackend    @deepseek-ai/dsh@0.1.0-rc.6, pinned, via the OpenCode Go route
Luna         OpenCodeBackend   the review lane by design; Harness cannot run this model
fallback     OpenCodeBackend   when Harness is absent, mis-versioned, or has no credential
switch       DELEGATE_WAVE_BACKEND=opencode selects OpenCode explicitly (not a degradation)
```

Selection is per attempt, from the resolved model, and recorded on the attempt row alongside the
capability profile.

Never mid-attempt: a failover inside an attempt would put two executors behind one attempt identity.
A Harness attempt that dies is a failed attempt, and its worktree is quarantined, never reused.

Why Harness is preferred: reasoning effort is pinned rather than inherited from a route default,
usage arrives as durable per-call evidence instead of being scraped from a transcript, and its
capability profile is selectable.

## Capability is policy; authority is not

The governing rule: **agents are trusted operators, not trusted authorities.** Capability may be
broad. Permanence stays governed.

```text
trusted     default. Shell, PowerShell, code execution, subprocesses, developer tooling,
            skills, filesystem access beyond the worktree.
restricted  attempt-root filesystem fence; no shell, code runtime, or skills.
```

`trusted` is the default because these workers are extensions of their operator. Denying a coding
agent a shell makes it worse at the job, and this system's value never rested on the worker being
unable to reach a file -- it rests on the worker's claims being checked.

`restricted` is not deprecated. It is required wherever containment is genuinely the point: the
frozen executor comparison's trusted verifiers live outside the worker repository, and a worker that
reads them passes every task without doing the work. That is a methodological failure, not a security
one. Its fence replaces the `fs` provider outright, because Harness's own sandbox fences writes only
-- its source says reads pass through in every mode -- and the backend boots the composed profile
first and refuses to run if the fence is not really in it.

The fence remains a trusted in-process path check, not a kernel boundary. Under `restricted` that
holds because the worker has no shell, subprocess, or code runtime.

The worker's prompt is profile-specific, and must be: a worker told it lacks a capability its profile
grants will usually obey the instruction, so the capability is discarded silently. Both write prompts
state the actual invariant -- a worker's own claims are not acceptance.

No profile changes who computes the Git diff, who runs validation, what counts as cost evidence, what
may be integrated, attempt identity and fencing, worktree quarantine, or the two-decision flow.
Worktrees stay mandatory for mutating jobs -- for recoverability and clean candidate capture, the
same reason a developer uses a branch despite trusting themselves.

## Final closure state

```text
head                 (see PR #15)
tests                308, 307 passing, 1 skipped (file symlinks need Windows elevation;
                     the directory-junction case covers the same property)
frozen corpus        experiments/executor-ab-v1, digest b34387db..., recomputed and unchanged
live gauntlet        10/10 (execution 7, recovery 3)
doctor               healthy
```

Remaining non-blocking UX work: a `Reverted` bucket in the briefing. After a rollback the job
correctly leaves `done` -- the truth is right -- but it disappears from every bucket rather than
saying what happened. That is information design, not a truth bug.

## Still deferred, deliberately

```text
executor A/B         Harness shipped on its merits; no comparison has been run
concurrent waves     one integration branch, serial integration
T3-native execution, multi-machine scheduling, hosted CI, automatic routing
```

The Harness work is recorded in `experiments/records/`, including
`harness-rc6-integration-findings.md`, which corrects three assumptions made before the package was
installed. The frozen task corpus for a future comparison is `experiments/executor-ab-v1`, digest
b34387db, merge commit 7ef7b74f, untouched.

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
  -> disposable workers (Harness by default, OpenCode for review and fallback)
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
