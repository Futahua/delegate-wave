# External orchestration lessons

Reconnaissance before building. Each entry records one mechanism, what it solves, and what
delegate-wave decided. Not a literature review — entries exist to stop us rediscovering something a
maintained project already learned, or to record why we deliberately did not adopt it.

Read 2026-08-17 against: `stablyai/orca`, `HenryLach/taskplane`, `razzant/claudexor`,
`ComposioHQ/agent-orchestrator`.

---

## Orca — can it satisfy `AgentRuntime`?

```text
External mechanism:   Desktop orchestrator; per-worktree agents; CLI over terminals and worktrees
Problem it solves:    Running several coding agents side by side, each isolated, tracked in one place
Public interface:     orca worktree create|rm|list|ps|show|set
                      orca terminal create|read|send|wait|stop|close|show
                      orca skills get orchestration   (version-matched guide, binary-resident)
State it owns:        Worktrees, terminal handles (runtime-scoped), agent processes
Failure semantics:    `terminal_handle_stale` after an Orca restart; reacquire via `terminal list`
Resume semantics:     `terminal send --text "continue" --enter` — keystroke injection into a TUI
Windows support:      Yes, native desktop app (.exe)
Evidence returned:    `--json` on every command; completion via `terminal wait --for tui-idle`
Recommendation:       DEFERRED — seam kept, adapter not written. NOT "rejected".
Relevant files:       skill-guides/orca-cli.md, skills/orchestration/SKILL.md
```

**Four blockers, in order of severity.**

1. **Completion is quiescence, not task completion.** The documented wait is `terminal wait --for
   tui-idle --timeout-ms 300000`.

   ```text
   Orca `terminal wait` proves observed TUI quiescence,
   not semantic/task completion.
   ```

   That is the precise disqualifier, and the precision matters. Quiescence is *stronger* than
   request-accepted — something really was observed — but *weaker* than the agent having finished its
   task. A model that pauses to think, or a harness that buffers, is quiescent and unfinished.
   Candidate capture is the one moment in delegate-wave where being wrong is unrecoverable:
   snapshotting a quiet-but-unfinished worktree commits a mid-edit tree as the attempt's complete
   work. Agent Orchestrator, which owns TUI sessions natively, refuses to treat idle as terminal and
   requires explicit signal AND idle AND process exit to converge — independent confirmation that
   quiescence alone cannot trigger capture.

2. **Orca-owned worktree creation cannot currently meet our exact-base contract.** Documented flags
   for `worktree create` are `--name`, `--repo`, `--agent`, `--prompt`, `--no-parent` — no ref, no
   path. `snapshotCandidate` measures every candidate against an exact recorded base commit at a path
   delegate-wave chose.

   This is a statement about *Orca-owned workspaces through the documented surface*, not about Orca.
   A future adapter could attach an Orca terminal or session to a **delegate-wave-owned worktree**,
   which sidesteps the issue entirely — the runtime contract already separates `provisionWorkspace`
   from `spawn` for exactly this reason. Do not record this as permanent.

3. **The CLI ships inside the desktop app.** "The CLI is distributed as part of the desktop
   installation, not separately." delegate-wave runs headless under a Windows Task Scheduler
   supervisor; taking a GUI desktop application as a hard dependency of the unattended path is a
   large operational cost for a component we would only be renting.

4. **The contract we would depend on is unreadable from outside.** `skills/orchestration/SKILL.md`
   says plainly: *"This file is a discovery stub, not the usage guide"*, and the real reference comes
   from `orca skills get orchestration` on the installed binary because commands *"change between
   Orca releases."* The orchestration primitives that motivated this whole evaluation — dispatch,
   `worker_done`, ask/reply, decision gates, coordinator loops, task DAGs — are named there and
   specified only there. Orca is not installed on this machine, so those contracts were not read.

5. **Model and effort provenance is unproven, by Orca's own account.** Issue #10846 (OPEN, read
   2026-08-17) is the concern that maps most directly onto what delegate-wave exists to establish:

   > `applyAgentSessionOptionLaunch` ... returns early when the model is not in the seed, so a
   > requested effort simply vanishes from the launch args ... A caller that asked for `xhigh` cannot
   > tell it launched at the default.

   On the catalog itself, after drift from the live API: it *"simultaneously offers an invalid choice
   and hides a valid one."* The issue states the general rule outright — *"a requested flag is not
   proof of the active model"* — and says there is currently no mechanism to satisfy it beyond
   reading terminal banners.

   This matters more than it first looks. `attempts.model` and `attempts.capability_profile` are
   recorded as **evidence of what ran**, and every cost figure, pricing basis and executor comparison
   is keyed to them. Under a runtime that cannot report what it applied, those columns quietly become
   records of what was *requested* — the same manufactured provenance as writing `codex-default` into
   a model column, which this project has already had to remove once.

   It is not a reason to reject Orca. It is a precise statement of the boundary: **if Orca becomes the
   runtime, delegate-wave keeps owning launch provenance**, or its cost accounting describes
   intentions rather than events.

   (Issue #7748 — `ok:true` reported when a prompt had not reached the target TUI — was cited as
   closed-as-completed. GitHub's API returned 503 during this check, so that status is **unverified
   here** and is not relied on in either direction.)

**Decision.** The `AgentRuntime` seam stays, because the seam is cheap and the reason for it is
sound. `OrcaRuntime` is not written. A first draft *was* written against guessed commands
(`orca agent start --instruction-file`, `worktree create --ref <sha> --path`) and every one of them
was wrong — which is the concrete argument for this directive, and the reason the file now carries a
verification checklist instead of an implementation.

**Status: ORCARUNTIME DEFERRED, SEAM KEPT. Not a rejection of Orca — a statement that its documented
completion signal cannot drive candidate capture, and that its orchestration contract is unreadable
without the binary. Revisit after installing Orca and running `orca skills get orchestration`.**

---

## Taskplane — persistent worker context and inline revision

```text
External mechanism:   Worker calls a `review_step` tool at step boundaries; reviewer spawns with
                      telemetry, writes .reviews/R00N-{type}-step{N}.md; worker reads it and
                      continues in the same context
Problem it solves:    Revision without paying to rediscover the repository
Public interface:     review_step tool; verdicts APPROVE / REVISE / RETHINK / UNAVAILABLE
State it owns:        Worker conversation, worktree, step-boundary commits
Failure semantics:    UNAVAILABLE = reviewer produced no output; worker "proceeds cautiously"
Resume semantics:     Same process, same conversation, same worktree — review is mid-turn
Windows support:      Not stated
Evidence returned:    Baseline commit SHA per code review, so the reviewer sees one step's diff
Recommendation:       ADAPT PATTERN (partially) — and explicitly REJECT the inline-review shape
Relevant files:       README.md, docs/explanation/review-loop.md
```

**The part we cannot take, and why it matters.** Taskplane's persistent context works *because the
review happens inside the worker's turn*. That is incompatible with delegate-wave's central
guarantee. Our review runs after the attempt terminates, after `snapshotCandidate` has written one
immutable tree, and after deterministic validation ran against that same tree. If the worker keeps
running past the review, the reviewed tree is no longer the integrated tree, and "semantic review
accepted this candidate" stops naming anything. **Do not move review inside the worker's turn.**

**The part we take, and its status.** Persistence of the *conversation* across attempts is orthogonal
to when review happens. A correction can reach the same agent that already loaded the repository, and
that agent then produces a *new* attempt with a *new* captured tree. So `AgentRuntime.send(session,
revision)` is worth having; `review_step` is not.

**Correctness must never depend on it.** Conversation reuse is an economic optimization — it avoids
paying twice to rediscover the repository — and a runtime whose session died with its process must
produce the same *outcome*, only more expensively. So the policy branches on a declared capability:

```text
if resumable:  reuse the conversation, send the revision
else:          fresh worker + previous evidence + revision brief
```

A managed run that silently produced worse results on a non-resumable runtime would have smuggled a
performance feature into the definition of correct.

**Verdict vocabulary we were missing.** Taskplane has four verdicts; our contract had three actions
and folded two distinct situations together.

- `RETHINK` — the *plan* is wrong, not the code. Distinct from REVISE, and it maps to re-entering
  exploration rather than reissuing an implementation brief. Our `EXPLORE` action already covers the
  mechanism; the finding is that a reviewer must be able to reach it *after* seeing a candidate, not
  only before one exists.
- `UNAVAILABLE` — the reviewer produced no usable output. This independently validates the
  `UNCERTAIN` manager-turn state. Their policy is that the worker "proceeds cautiously"; **ours must
  be the opposite.** A review that did not happen can never become an acceptance, because acceptance
  is the gate in front of a human's repository.

**Status: ADOPT `send()` SEAM AND THE UNAVAILABLE DISTINCTION. REJECT INLINE REVIEW.**

---

## Claudexor — bounded delegation and family budget authority

```text
External mechanism:   `agent --delegate` belt: a parent harness spawns bounded isolated children
Problem it solves:    Letting a strong agent buy cheap labour without giving that labour authority
Public interface:     claudexor_ask / _plan / _run / _best_of / _run_status / _run_result
State it owns:        Daemon-owned budget authority per run family; admission counters; event log
Failure semantics:    Typed refusals; a late overshoot or unverifiable child settlement replaces a
                      prepared success with a typed budget failure
Resume semantics:     Parent cancellation cascades to children; retry creates a fresh top-level family
Windows support:      NO — CLI/daemon are macOS + Linux. Concrete blocker.
Evidence returned:    credential_profile_id / credential_route per event; live subscription quota
Recommendation:       ADOPT CONCEPTS — cannot consume the dependency
Relevant files:       docs/ARCHITECTURE.md, README.md
```

**Closest prior art to our authority model, and it agrees with us.** *"There is NO
apply/decision/thread/settings tool: the PARENT integrates results in its own workspace."* That is
our "manager ACCEPT means semantic review accepted this candidate; it does not mean integrate",
reached independently. Likewise *"enforced SERVER-SIDE at the tool boundary (never trusting the
harness)"* is our "capability is a preference, authority is not."

**Three things we would have got wrong.**

1. **One budget authority per family, not per participant.** *"one live parent-owned paid-budget
   authority shared by the parent and every child... exhaustion is a typed refusal, never a silent
   independent or unlimited budget."* Our managed jobs spawn exploration children. The obvious
   implementation gives each child job its own `maximum_cost`, which silently multiplies the
   operator's ceiling by the number of children. Children must settle against the parent's ceiling.

2. **Admission counts pending, not completed.** *"admission is atomic and monotonic (pending starts
   count toward the max of 8)."* Counting only finished children lets a burst of concurrent spawns
   pass a cap that was never actually free.

   **Open in delegate-wave, deliberately.** `familySpend()` sums completed receipts, so three
   explorations started together would each see $0 spent and each pass the same $0.10 gate. This is
   unexploitable *today* only because the bootstrap scheduler admits one running job at a time — and
   that restriction is exactly what parallel exploration removes. **Atomic family admission must land
   before parallel exploration does.** Recorded here and at `familyJobIds()` so the dependency cannot
   be discovered by overspending.

3. **Settlement can retract a success.** *"a late overshoot or unverifiable child settlement replaces
   the prepared success with a typed budget failure."* This is the honest answer to delegate-wave's
   own weakest claim. We cannot terminate a worker mid-call on cost, so a pre-attempt gate will
   always permit overshoot. But we *can* refuse to report a managed run as successful when
   settlement shows the ceiling was breached, or when spend cannot be established. That turns a
   start-gate into something with real consequences without building streaming cost interception.

**Nesting depth 1 and a child cap** are theirs too, and match the limits we had already chosen for
different reasons.

**Cannot consume.** CLI and daemon are macOS and Linux; Windows is not supported. That is the
blocker, not architecture taste.

**Status: ADOPT CONCEPTS (family budget, pending admission, settlement retraction). DO NOT DEPEND.**

---

## Agent Orchestrator — Windows process lifecycle and session modes

```text
External mechanism:   RuntimeAdapter port with tmux (POSIX) and ConPTY (Windows) implementations
Problem it solves:    Owning long-lived coding-agent sessions natively on Windows, without tmux
Public interface:     backend/internal/adapters/runtime/ ; session_manager ; observe/reaper
State it owns:        sessions{runtime_handle_id, provider_conversation_id, session_mode,
                      controller_generation, activity_state, is_terminated}; conversations;
                      conversation_turns; conversation_messages
Failure semantics:    lifecycle.Manager terminates only when runtime dead AND process dead AND no
                      recent activity AND no merged-PR ownership
Resume semantics:     Boot reconciliation; TUI reattaches to tmux, Chat resumes provider conversation
Windows support:      Yes — ConPTY, native, no tmux requirement
Evidence returned:    activity_state in {active, idle, waiting_input, blocked, exited}; 5s reaper probe
Recommendation:       ADAPT PATTERN — ignore the issue/PR product model
Relevant files:       docs/architecture.md, backend/internal/adapters/runtime/
```

**The distinction worth stealing: session *mode*.** AO persists `session_mode` as `tui` or `chat`
and selects the messenger from it at dispatch time. TUI sends keystrokes through a runtime handle;
Chat enqueues provider turns against `provider_conversation_id`. That is precisely the difference
between what Orca offers and what our Harness/Codex backends offer, and it says our runtime
capability flags should name the mode rather than pretending one mechanism covers both.

**Completion detection, from a project that does it properly.** AO combines *explicit agent signal +
idle probe + process exit*, and terminates only when all conditions converge. This is independent
confirmation that Orca's `--for tui-idle` alone is not a completion signal — a project that owns TUI
sessions natively refuses to treat idle as terminal.

**`controller_generation`** is AO's fencing token against a stale controller acting after a handoff.
delegate-wave already has `scheduler_epoch` doing the same job. Two projects converging on the same
mechanism is mild evidence the invariant is real.

**Do not import** the issue → worktree → PR → CI → review product model. Our problem is one fuzzy
objective needing expensive judgment, not twenty known issues needing parallel throughput. That
machinery becomes interesting only if delegate-wave ever grows into a backlog factory.

**Status: ADOPT `session_mode` CONCEPT AND CONVERGENT-COMPLETION RULE. DO NOT DEPEND.**

---

## What delegate-wave still owns after all four

Nothing above replaces any of these, and three of the four projects independently confirm the
boundary:

```text
when scarce intelligence is worth spending
what the manager asks cheap workers to learn
how that evidence is compressed
how evidence becomes an implementation brief
when a result is revised, re-explored, escalated, or abandoned
finished work / scarce-model usage, and human interventions / finished work
which statements must be proven rather than believed
```

Plus the mechanical kernel none of them offers: candidate capture through a delegate-wave-owned
index, protected-path policy on the same tree that gets committed, deterministic validation against
that exact tree, disjoint usage receipts with COMPLETE/PARTIAL/UNKNOWN honesty, and compare-and-swap
integration behind a human approval.
