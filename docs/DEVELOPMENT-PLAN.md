# Delegate Wave development plan

Updated: 2026-08-31  
Planning baseline: `7056340374ed2204d7f6f6e2976041f621f412bf`  
Branch: `codex/backpack-presentation-v1`  
Current checkpoint: **CP1 — close the original presentation regression**  
Plan status: **approved direction; implementation not started**

This is the persistent execution and handoff document for the next Delegate Wave
development phases. Update it in the same commit as checkpoint work. It turns the
visual-demo review and the broader architecture review into an ordered program;
it is not a commitment to implement every long-term idea before gathering evidence.

## Product thesis

Delegate Wave is a **durable, evidence-authoritative control plane in which LLMs
are replaceable reasoning components**.

```text
Hermes owns intent and conversational origin.
Delegate Wave owns durable state, identities and legal transitions.
Models supply semantic judgment.
Workers supply bounded computation.
Git and validators supply deterministic evidence.
Papers/Apers project the ledger to people.
```

The architectural invariant is:

```text
worker testimony may inform semantic judgment
but it can never redefine a mechanical fact
```

Use code for state legality, work existence, candidate identity, validation,
path authority, budgets, retry identity, publication authority and wake ownership.
Use models for investigation strategy, implementation approach, semantic review,
revision/rethink decisions and genuinely human ambiguities.

## Preserved foundations

Do not replace these working foundations without a separately reviewed reason:

- SQLite remains the operational write model and Git remains code truth.
- `manager_turns.subject_attempt_id` mechanically binds REVIEW to a candidate.
- One-open-commission and one-open-wake uniqueness remain enforced.
- Integration remains PREPARE -> VALIDATE -> compare-and-swap PUBLISH.
- Attempts retain immutable identities, instruction digests and isolated worktrees.
- Worker reports remain testimony; usage/provenance receipts retain their distinct bases.
- Hermes ownership, durable wake delivery and restart recovery remain intact.
- The manager has no repository or shell access.
- Workers remain hierarchical tools of the manager, not a peer mesh.
- No Temporal/LangGraph/framework rewrite is planned. Borrow their durability and
  replay invariants without adding another control plane.

## Source incidents and evidence

- Rich visual regression evidence: `docs/visual-demo-20260831/`.
- Successful minimal wake-back spine: `docs/dogfood-20260831-result/`.
- Preserved failed rich session: `asess_568b38a2-9fa0-4b87-ad5d-9dfb6741a273`.
- Its candidate: `2799378846726b8adfcefad818ff4a67fe9d9f18`.
- Its REVIEW escalated because worker testimony contradicted durable candidate and
  orchestration facts, and REVIEW lacked a complete privileged orchestration record.

Do not answer, mutate or manually settle that preserved `WAITING_FOR_HERMES`
session. It is the failure witness. Fix the architecture and use a new session and
fresh disposable fixture for the acceptance rerun.

## Checkpoint protocol

Every checkpoint must have all of the following before it is marked complete:

1. Focused regressions proving the stated invariants.
2. Full local test result, with pre-existing failures separated from regressions.
3. Production/lint/build checks relevant to changed surfaces.
4. No unrelated working-tree changes included.
5. A normal commit and push; no rebase, squash or force-push.
6. This document updated with completion date, exact SHA, tests and residual risks.
7. Runtime deployment only when the checkpoint explicitly requires dogfood.
8. Evidence distinguishes durable facts, deterministic evidence, model judgment
   and worker narration; never report narration as an operational fact.

Use these statuses in handoffs: `NOT STARTED`, `IN PROGRESS`, `BLOCKED`, `PASS`,
`PARTIAL`, `DEFERRED`. At most one checkpoint should be `IN PROGRESS`.

---

# CP1 — Close the original presentation regression

Status: **NOT STARTED**  
Priority: **release/dogfood gate**  
Scope: manager evidence, worker-task rendering, path contract, worker result boundary

## Goal

Repeat the rich visual workload through the genuine:

```text
PLAN -> concurrent EXPLORE x2 -> SYNTHESIS -> IMPLEMENT
     -> deterministic validation -> REVIEW -> ACCEPT
```

and finish in `SEMANTICALLY_ACCEPTED` MANUAL state with an unintegrated candidate.

## CP1.1 — Authoritative REVIEW manifest

- [ ] Extend `buildReviewEvidence()` with a machine-produced orchestration record.
- [ ] Include manager run ID.
- [ ] Include prior manager turn ID, phase, action and terminal state.
- [ ] Include each exploration child job ID, attempt ID and terminal state.
- [ ] Include the implementation subject attempt, candidate commit/tree, changed
      files and deterministic validation receipt/state.
- [ ] Derive every field from SQLite/Git/validator records, never worker prose.
- [ ] Render this section before worker testimony under an unmistakable heading such
      as `AUTHORITATIVE DELEGATE WAVE FACTS`.
- [ ] State mechanically that a worker cannot observe or override these fields.
- [ ] Either remove orchestration claims from the worker report presented to REVIEW
      or label/filter them so they cannot participate as candidate-existence evidence.

Checkpoint test:

```text
ledger: candidate exists, validation PASSED, real PLAN/explorers/SYNTHESIS
worker testimony: "IDs were emulated; no candidate exists"
result: REVIEW input exposes ledger truth; testimony cannot erase those facts
```

## CP1.2 — Role-scoped worker task contract

- [ ] Stop presenting the unchanged whole human objective as worker responsibility.
- [ ] Preserve semantic context separately from the executable worker task.
- [ ] Add an explicit implementation-role boundary: manager decisions, other workers,
      validation, integration, UI presentation, session IDs and reporting are not
      the implementation worker's responsibilities.
- [ ] Explicitly prohibit dispatching, emulating, fabricating or reporting DW
      orchestration identities.
- [ ] Keep `What to do`, acceptance criteria, known facts and unknowns as the only
      actionable implementation contract.
- [ ] Introduce a structured `WorkerTask` shape, or an equivalent typed internal
      representation, so future renderers do not reconstruct roles from prose.

Checkpoint tests:

- [ ] An objective containing PLAN/EXPLORE/SYNTHESIS/REVIEW instructions produces an
      implementation brief that clearly treats them as context, not worker work.
- [ ] A worker completion cannot populate candidate SHA, validation state, job IDs,
      manager IDs, integration state or other mechanically owned fields.
- [ ] Public narration remains available for Papers without becoming phase evidence.

## CP1.3 — Repository-relative path protocol

- [ ] Exploration and implementation briefs say the current directory is the
      assigned attempt worktree.
- [ ] Repository files are rendered as relative paths (`router.js`) or a logical
      namespace (`repo://router.js`), never as the registered checkout path.
- [ ] Reject Windows drive paths, UNC paths, POSIX absolute paths, `file://` and
      traversal (`../`) in repository-task path fields unless an explicit external
      capability contract permits them.
- [ ] Resolve logical repository paths only at worker launch inside the worktree.
- [ ] Do not weaken explorer confinement to make malformed absolute paths succeed.

Checkpoint tests:

- [ ] The visual-demo explorer questions render only worktree-relative paths.
- [ ] Cross-platform path variants and traversal are refused deterministically.
- [ ] Legitimate relative paths work on Windows and Linux.

## CP1.4 — Adversarial review regressions

- [ ] Recreate two real exploration children and one real implementation attempt in
      the deterministic test fixture.
- [ ] Inject a worker report claiming that the IDs were emulated.
- [ ] Inject a worker report claiming no candidate commit exists.
- [ ] Assert the authoritative manifest contains the actual IDs and candidate.
- [ ] Assert REVIEW is asked only the semantic question: whether the real diff
      satisfies intent—not whether mechanically known work exists.
- [ ] Assert terminal worker outcomes and prior durable history remain unchanged.

## CP1.5 — Physical acceptance rerun

Prerequisites: CP1.1–CP1.4 merged, full suite acceptable, runtime deployed normally,
doctor healthy, fresh Hermes MCP path verified.

- [ ] Create/register a fresh disposable router fixture as operator work.
- [ ] Start a new originating Hermes conversation and exactly one MANUAL session.
- [ ] Obtain exactly two genuine concurrent explorations in one round.
- [ ] Confirm no explorer attempts the registered/original checkout path.
- [ ] Confirm one SYNTHESIS and exactly one implementation attempt.
- [ ] Confirm implementation narration does not impersonate manager phases.
- [ ] Confirm candidate capture and `npm test` PASS.
- [ ] Confirm REVIEW uses ledger facts and chooses ACCEPT on a semantically correct diff.
- [ ] Confirm session becomes `SEMANTICALLY_ACCEPTED`, candidate remains unintegrated,
      and the exact originating Hermes conversation receives the truthful wake.
- [ ] Capture Papers screenshots for collapsed parallel workers, one full-width
      expanded transcript, implementation/validation and final accepted state.

CP1 exit gate: all items pass. A correct diff with REVIEW escalation remains
`PARTIAL`, not PASS. Only this gate closes the original demo incident.

---

# CP2 — Harden the durable workflow kernel

Status: **NOT STARTED**  
Entry gate: CP1 PASS

## Goal

Make reconciliation and semantic idempotency explicit without replacing SQLite or
the current state tables.

- [ ] Define a unified `reconcileSession(sessionId) -> Command[]` vocabulary.
- [ ] Cover manager turns, exploration rounds, commissions, attempts, validation,
      review, integration, wake creation and cancellation reconciliation.
- [ ] Give every side effect a semantic identity derived from session + operation +
      round + subject, rather than relying on fresh request UUIDs.
- [ ] Preserve successful parallel work across sibling failure/retry.
- [ ] Ensure human interruption is a durable resting state and process lifetime is irrelevant.
- [ ] Make command execution retry-safe before/after crash and lost response.

## CP2.1 — Typed domain-event boundary

- [ ] Add event ID, schema version, subject, caused-by, trace ID and span ID concepts.
- [ ] Maintain an event schema registry and validate payloads at write/read boundaries.
- [ ] Write state mutation and typed domain event in the same SQLite transaction.
- [ ] Keep current state tables as the write model; do not attempt a wholesale
      event-sourcing/CQRS rewrite.

## CP2.2 — Invariant-auditing doctor

- [ ] Add severity levels `HEALTHY`, `WARN`, `BLOCKED`, `CORRUPT`.
- [ ] Detect contradictory session/root/manager states.
- [ ] Detect REVIEW/ACCEPT states without a subject/candidate.
- [ ] Verify Git objects and validation receipts for successful attempts.
- [ ] Detect open commissions on terminal jobs and dead RUNNING owners.
- [ ] Detect wake mismatches, single-flight violations and phase/run inconsistencies.
- [ ] Report expected vs loaded runtime SHA and stale MCP executable paths.
- [ ] Report unpriceable active models distinctly from historical pricing gaps.

## CP2.3 — Crash/model-based regression corpus

- [ ] Inject crash-before, crash-after, duplicate invocation, lost response and restart
      around each durable side-effect boundary.
- [ ] Assert convergence without rebuying completed manager/worker work.
- [ ] Convert every known incident into a permanent fixture: scheduler busy, manager
      bootstrap, typed fail retry, stale WORKING, CLI quoting, partial wake, stale MCP,
      absolute-path brief, fabricated orchestration and denied real candidate.

CP2 exit gate: repeated randomized/restart runs converge to legal states, doctor
reports no unexplained contradictions, and the full deterministic suite remains green.

---

# CP3 — Provenance, epistemic types and ledger-driven presentation

Status: **NOT STARTED**  
Entry gate: CP2 PASS

## CP3.1 — Epistemic authority types

- [ ] Introduce first-class classifications: `SYSTEM_FACT`,
      `DETERMINISTIC_EVIDENCE`, `SEMANTIC_JUDGMENT`, `WORKER_TESTIMONY`, `NARRATION`.
- [ ] Assign ownership for every field crossing manager, worker, validator, integration,
      Hermes and Papers boundaries.
- [ ] Reject or ignore claims outside an actor's epistemic authority.

## CP3.2 — Candidate provenance manifest

- [ ] Produce and hash a manifest containing base/candidate/tree, intent digest,
      manager run/turns, worker attempts/instruction digests/models/capabilities,
      validation plan/receipts, changed files and review action.
- [ ] Link manifest digest to candidate, REVIEW and any integration record.
- [ ] Preserve requested/applied/observed model and cost identities separately.

## CP3.3 — Trace-compatible ancestry

- [ ] Use autonomous session as trace ID.
- [ ] Use manager turns, attempts, validators and wakes as spans.
- [ ] Record causal parentage without requiring an OpenTelemetry runtime initially.

## CP3.4 — Papers projection

- [ ] Build orchestration structure only from ledger-derived events/relationships.
- [ ] Keep worker narration inside its true attempt span; narration never creates a phase.
- [ ] Visibly mark narration that conflicts with authoritative records without changing
      the ledger-derived timeline.
- [ ] Preserve the accepted full-width/bounded-scroll presentation behavior.

CP3 exit gate: one query explains why a candidate exists and how it was produced;
Papers cannot be tricked into inventing orchestration from worker prose.

---

# CP4 — Mechanical containment and capability contracts

Status: **NOT STARTED**  
Entry gate: CP1 path protocol PASS; may proceed incrementally after CP2

- [ ] Make role capabilities explicit for MANAGER, EXPLORER, IMPLEMENTER, VALIDATOR,
      INTEGRATOR and HERMES.
- [ ] Explorer: read-only attempt worktree, search, network off by default.
- [ ] Implementer: read/write attempt worktree, local shell/Git/build; network opt-in.
- [ ] Validator: no LLM, fresh validation worktree, declared commands only.
- [ ] Integrator: no LLM, DW-owned Git/CAS authority only.
- [ ] Keep control-plane credentials out of worker environments and proxy any
      credential-bearing operation through the owning control-plane component.
- [ ] Make external filesystem/network access capability-based rather than prompted.
- [ ] Document honestly where containment remains an in-process fence rather than an OS boundary.

CP4 exit gate: repository workers cannot perform control-plane operations or escape
declared path/network capabilities even when their prompt asks them to.

---

# CP5 — Operational readiness and CI

Status: **NOT STARTED**  
Entry gate: CP2 invariant auditor available

- [ ] Add Windows Node 24 CI alongside Ubuntu Node 24.
- [ ] Separate unit, recovery/state-machine, Windows integration and fixture-regression jobs.
- [ ] Investigate why recent pushed commits have no GitHub checks/workflow runs.
- [ ] Make deployment/runtime SHA and MCP executable path machine-readable.
- [ ] Add a preflight/readiness output suitable for automated dogfood capture.
- [ ] Surface stale wakes and operator-attention states without manual SQLite inspection.
- [ ] Stop relying on hand-written evidence documents for ordinary health checks;
      keep them for milestone dogfoods and incident analysis.

CP5 exit gate: a pushed candidate receives published Linux and Windows evidence, and
readiness/doctor can establish the active runtime and control-path health unaided.

---

# CP6 — Economics, adaptive routing and device expansion

Status: **DEFERRED**  
Entry gate: CP1–CP5 adequate for unattended measurement

## CP6.1 — Outcome economics

- [ ] Record accepted result, premium consumption, cheap-provider cost, manager turns,
      attempts, wall time, interventions, recovery minutes, retries and false escalations.
- [ ] Keep historical reference, current estimate, actual provider cost and subscription
      consumption as visibly separate accounting bases.
- [ ] Evaluate premium resource plus human recovery time per accepted change.

## CP6.2 — Adaptive orchestration

- [ ] Define deterministic, simple, managed, investigative and hard routing classes.
- [ ] Models select difficulty/uncertainty; policy selects commercial model/tier.
- [ ] Require evaluation evidence before adding agentic complexity.

## CP6.3 — Frozen A/B/C benchmark and device path

- [ ] Run a frozen representative corpus: direct Sol, direct/native Luna, and
      Hermes -> DW -> Luna manager + cheap worker.
- [ ] Compare accepted-result rate, resource cost, wall time and human recovery.
- [ ] Then run phone -> Hermes -> DW -> exact-conversation wake dogfood.

CP6 exit gate: decide with measured evidence whether Delegate Wave beats direct Luna
for the user's real workload and which task classes justify orchestration.

---

# Explicit non-goals

- Do not buy correctness by merely upgrading the manager model.
- Do not loosen worker filesystem restrictions to hide malformed briefs.
- Do not turn workers into long-lived peers or add worker-to-worker authority.
- Do not replace SQLite, Git validation or the existing wake protocol during CP1.
- Do not introduce Temporal, LangGraph, OpenTelemetry runtime or full event sourcing
  unless later scale/evaluation produces a concrete requirement.
- Do not repair preserved incident sessions by editing operational data or coaching
  them through a known architectural failure.
- Do not begin A/B/C benchmarking until the rich workflow can end truthfully and
  operational readiness makes results reproducible.

# Handoff template

Copy this block into the top of a continuation note and update this document before
ending a development turn:

```text
Checkpoint:
Status: NOT STARTED | IN PROGRESS | BLOCKED | PASS | PARTIAL | DEFERRED
Starting SHA:
Ending/pushed SHA:
Files changed:
Invariant implemented:
Focused tests:
Full suite/build:
Runtime deployed/restarted: no | yes (why, PID/SHA)
Dogfood/session IDs:
Evidence paths:
Known failures or deviations:
Next exact action:
Unrelated local changes preserved:
```

# Progress ledger

| Checkpoint | Status | Completion SHA | Evidence / next gate |
|---|---|---|---|
| CP1 Original presentation regression | NOT STARTED | — | Implement CP1.1–CP1.4 before new dogfood |
| CP2 Durable workflow kernel | NOT STARTED | — | Requires CP1 PASS |
| CP3 Provenance and presentation | NOT STARTED | — | Requires CP2 typed/reconciled substrate |
| CP4 Mechanical containment | NOT STARTED | — | Begin after CP1 path protocol; finish after CP2 |
| CP5 Operations and CI | NOT STARTED | — | Requires invariant auditor |
| CP6 Economics and devices | DEFERRED | — | Requires stable unattended operation |

The next implementation action is **CP1.1: add the authoritative orchestration
manifest to REVIEW**, followed in the same narrow program by CP1.2–CP1.4. Do not
launch another physical visual-demo session until those regressions and the full
suite are acceptable.
