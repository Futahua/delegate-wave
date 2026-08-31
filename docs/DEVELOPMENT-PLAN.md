# Delegate Wave development plan

Updated: 2026-08-31

Planning baseline: `de0f38791dd7b49b79de3ed0d662912b90d30772`

Branch: `codex/backpack-presentation-v1`

Current checkpoint: **CP1 — close the original presentation regression**

Plan status: **approved direction; implementation not started**

This is the persistent execution and handoff document for Delegate Wave. It is
deliberately scoped to one person, trusted agents, personal repositories and one
trusted machine ecosystem. External workflow systems are design references only;
they are not a target architecture or dependency plan.

## Personal-use target

> I tell Hermes to change one of my repositories from my laptop or phone.
> Delegate Wave cheaply gets it done, checks it, wakes the same conversation,
> and almost never requires me to understand or repair the machinery underneath.

If work does not materially improve that sentence, it does not belong in the
near-term plan.

```text
Delegate Wave owns facts it can establish mechanically.
Models make judgments only where judgment is actually needed.
Worker prose cannot override the ledger, Git or validators.
```

## Existing foundations to keep, not generalize

- SQLite ledger and restart reconciliation.
- Single-flight workers and durable commissions.
- Isolated Git worktrees, candidate capture and deterministic validation.
- PREPARE -> VALIDATE -> compare-and-swap integration.
- Cancellation, failure and stale-state reconciliation.
- Durable Hermes watch/wake delivery to the originating conversation.
- Requested/applied/observed model and usage receipts.

These solve real personal-use needs. Maintain them and fix demonstrated defects;
do not turn them into a generic workflow framework.

## Source incidents and preserved evidence

- Rich visual regression: `docs/visual-demo-20260831/`.
- Successful minimal wake-back spine: `docs/dogfood-20260831-result/`.
- Preserved failed rich session: `asess_568b38a2-9fa0-4b87-ad5d-9dfb6741a273`.
- Preserved candidate: `2799378846726b8adfcefad818ff4a67fe9d9f18`.

Do not answer, mutate or manually settle that `WAITING_FOR_HERMES` session. It is
the failure witness. Fix the code and use a new session plus a fresh disposable
fixture for acceptance.

## Checkpoint discipline

Every implementation checkpoint requires focused regressions, the full local
suite with established failures separated, relevant build/lint checks, no unrelated
changes, a normal commit/push, and an update here with exact SHA and evidence.
Deploy/restart only when a physical checkpoint requires it.

Statuses: `NOT STARTED`, `IN PROGRESS`, `BLOCKED`, `PASS`, `PARTIAL`, `DEFERRED`.
At most one checkpoint is `IN PROGRESS`.

---

# CP1 — Fix the reproduced visual-demo failure

Status: **NOT STARTED**

Priority: **immediate release/dogfood gate**

## Goal

```text
PLAN -> concurrent EXPLORE x2 -> SYNTHESIS -> IMPLEMENT
     -> deterministic validation -> REVIEW -> ACCEPT
```

Finish in `SEMANTICALLY_ACCEPTED` MANUAL state with an unintegrated candidate.

## CP1.1 — Repository-relative worker paths

- [ ] Briefs state that the current directory is the assigned attempt worktree.
- [ ] Manager-generated references use `router.js`, `test.js`, etc.; never the
      registered/original checkout's absolute path.
- [ ] Reject Windows/POSIX absolute paths, UNC/file URLs and traversal in generated
      repository-task path fields.
- [ ] Keep explorer confinement. Do not loosen it to hide a bad brief.
- [ ] Test Windows/POSIX absolute variants, traversal and valid relative paths.

## CP1.2 — Implementation worker role boundary

- [ ] Separate full human intent as context from the worker's executable task.
- [ ] State that manager decisions, explorers, validation, review, presentation,
      session IDs and final reporting are not implementation-worker responsibilities.
- [ ] Prohibit dispatching, emulating or inventing workers, turns, sessions,
      candidate IDs, validation records or integration records.
- [ ] Limit the actionable contract to `What to do`, acceptance, known facts and unknowns.
- [ ] Prefer a small structured worker-task representation over one large prose prompt.
- [ ] Test an objective containing PLAN/EXPLORE/SYNTHESIS/REVIEW and prove the
      implementation brief treats those as context, not worker actions.

## CP1.3 — Authoritative REVIEW facts

- [ ] Include manager run ID and prior turn ID/phase/action/state.
- [ ] Include exploration child job IDs, attempt IDs and terminal states.
- [ ] Include implementation subject attempt, candidate commit/tree, changed files
      and deterministic validation receipt/state.
- [ ] Build those fields from SQLite, Git and validators, never worker prose.
- [ ] Render privileged DW facts before worker testimony.
- [ ] Filter or clearly subordinate worker orchestration claims so they cannot decide
      whether work or a candidate exists.

Core adversarial regression:

```text
ledger:
  real PLAN, two real explorers, real SYNTHESIS
  candidate exists, validation PASSED

worker testimony:
  "IDs were emulated"
  "no candidate exists"

required:
  REVIEW receives real IDs and candidate
  testimony cannot erase those facts
  reviewer decides only whether the real diff satisfies intent
```

## CP1.4 — Verification

- [ ] Build the adversarial fixture with real durable child/attempt records.
- [ ] Assert prior durable outcomes/history remain unchanged.
- [ ] Run focused manager/session/review/path-rendering suites.
- [ ] Run complete `npm test` and relevant build/lint checks.
- [ ] Record exact counts and distinguish established failures.

## CP1.5 — Physical visual-demo acceptance

Prerequisites: CP1.1–CP1.4 complete, suite acceptable, normal deployment, healthy
doctor and fresh Hermes MCP path.

- [ ] Operator registers a fresh disposable router fixture.
- [ ] New Hermes conversation starts exactly one MANUAL session.
- [ ] Exactly two genuine concurrent explorations run in one round.
- [ ] Neither explorer attempts the registered/original checkout path.
- [ ] Genuine SYNTHESIS starts exactly one implementation attempt.
- [ ] Implementation narration does not impersonate manager phases.
- [ ] Candidate capture and `npm test` PASS.
- [ ] REVIEW uses ledger facts and ACCEPTS a semantically correct diff.
- [ ] Session reaches `SEMANTICALLY_ACCEPTED`; candidate stays unintegrated.
- [ ] Exact originating Hermes conversation receives a truthful completion wake.
- [ ] Capture concurrent, expanded, implementation/validation and final UI evidence.

CP1 exit: every item passes. A correct diff plus REVIEW escalation remains PARTIAL.
Do not begin another architecture initiative before closing this.

---

# CP2 — Preserve durable personal-use recovery

Status: **NOT STARTED**

Entry gate: CP1 PASS

Maintain what is already built; do not create a generic reconciliation framework.

- [ ] Keep restart recovery for session/manager/attempt/wake state.
- [ ] Keep existing semantic retry safety and single-flight constraints.
- [ ] Keep successful work durable across ordinary process failure.
- [ ] Keep cancellation/failure closure consistent and evidence-preserving.
- [ ] Add regressions when a real incident or nearby plausible edge requires one.
- [ ] Periodically run a bounded restart/wake dogfood; no broad chaos platform.

CP2 exit: observed restart/lost-response cases recover without manual SQLite or Git repair.

---

# CP3 — Practical mistake prevention for trusted workers

Status: **NOT STARTED**

Entry gate: CP1 path/role boundaries PASS

The goal is preventing accidental damage, not hostile multi-tenant isolation.

```text
explorer       reads its assigned worktree
implementer    modifies its assigned worktree
validator      runs declared deterministic checks
Delegate Wave owns candidate capture and integration
```

- [ ] Keep worktree boundaries explicit in every task contract.
- [ ] Keep control-plane work outside repository-worker responsibilities.
- [ ] Prevent unrelated DW/Hermes/Papers/Backpack paths entering candidate scope.
- [ ] Keep control credentials out of worker instructions/artifacts.
- [ ] Use trusted/restricted profiles honestly; do not claim an OS sandbox.
- [ ] Add narrow checks for actual dogfood mistakes, not enterprise RBAC.

CP3 exit: malformed briefs/confused workers cannot turn an ordinary repository job
into an accidental product/control-plane edit.

---

# CP4 — Diagnostics that prevent repeated manual debugging

Status: **NOT STARTED**

Entry gate: CP1 PASS; implement incrementally from real incidents

Extend `doctor` only for states that have caused real operator pain:

- [ ] stale `WORKING` session against terminal root/manager;
- [ ] RUNNING attempt with dead owner, or live owner against terminal state;
- [ ] stale Hermes dashboard/MCP executable path;
- [ ] unresolved/stuck integration;
- [ ] stuck or contradictory wake/outbox/receiver state;
- [ ] impossible manager/job/session combinations;
- [ ] candidate/passed attempt missing required Git or validation evidence;
- [ ] expected repository head versus loaded runtime SHA when available.

Output the exact entity, violated invariant and safe next action. Simple severity
levels are fine; a tracing deployment or enterprise dashboard is not.

CP4 exit: one supported command diagnoses these failures without ad hoc SQL or
manual process archaeology.

---

# CP5 — Use it and measure whether it saves scarce Codex usage

Status: **DEFERRED until CP1 PASS**

After CP1, stop speculative architecture work and run 10–20 representative personal jobs.

Record per accepted task:

- [ ] accepted/rejected outcome;
- [ ] manager turns and worker attempts;
- [ ] premium Codex/subscription consumption;
- [ ] cheap-provider spend with its accounting basis;
- [ ] wall time;
- [ ] human interventions and approximate recovery minutes;
- [ ] validation/revision count and false escalations.

Compare with using Luna directly. Optimize scarce-model usage plus human recovery
cost per accepted change, not raw cheap tokens.

CP5 exit: decide whether DW is worth maintaining, which task shapes benefit and
which complexity should be removed. Phone initiation may join this corpus after
the desktop path is reliable; no distributed scheduler or adaptive-routing system is required.

---

# Explicitly dropped or deferred

```text
Temporal migration
Kubernetes-style generic controller framework
full event-sourcing rewrite
OpenTelemetry deployment
formal SLSA implementation
multi-user RBAC or tenant isolation
cloud/horizontal scaling
distributed scheduling
hostile-worker security model
generic plugin architecture
large provenance framework
enterprise dashboards
complex adaptive routing system
```

Borrow small principles only when they fix a demonstrated problem: reconcile
durable state instead of trusting process lifetime, make retries safe, preserve
candidate evidence, and treat workers as bounded tools. Keep the principle, not
the infrastructure.

# Handoff template

```text
Checkpoint:
Status: NOT STARTED | IN PROGRESS | BLOCKED | PASS | PARTIAL | DEFERRED
Starting SHA:
Ending/pushed SHA:
Files changed:
Behavior/invariant implemented:
Focused tests:
Full suite/build:
Runtime deployed/restarted: no | yes (why, PID/SHA)
Dogfood/session IDs:
Evidence paths:
Known failures/deviations:
Next exact action:
Unrelated local changes preserved:
```

# Progress ledger

| Checkpoint | Status | Completion SHA | Evidence / next gate |
|---|---|---|---|
| CP1 Fix reproduced visual failure | NOT STARTED | — | Implement CP1.1–CP1.4 before rerun |
| CP2 Preserve durable recovery | NOT STARTED | — | Maintenance after CP1 PASS |
| CP3 Practical worker guardrails | NOT STARTED | — | Narrow personal-use safeguards |
| CP4 Useful doctor diagnostics | NOT STARTED | — | Add only demonstrated failures |
| CP5 Measure 10–20 real jobs | DEFERRED | — | Begin after CP1 PASS |

Next action: **CP1.1 repository-relative paths and CP1.2 role-scoped worker
briefs**, then CP1.3 authoritative REVIEW facts and adversarial regressions. Do
not rerun the physical demo until CP1.1–CP1.4 pass.
