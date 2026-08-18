# Whole-tree adversarial sweep

Not a checklist of features. For each load-bearing invariant: break the protection in the source,
confirm the guarding test goes red **for the intended reason**, restore, verify the tree is clean.

A test written after its protection existed has never been shown to be falsifiable. This branch has
already produced several green tests whose fixtures could not enter the state they claimed to test,
so assertion-reading is not evidence. Mutation is.

Every entry must satisfy three criteria:

```text
1. the fixture actually entered the dangerous state
2. the assertion fails when the protection is deliberately removed
3. it survives repeated full-suite runs under load
```

Operational rule: never commit a mutant. Start from a clean head, make one minimal break, run the
narrow guarding test, restore, confirm `git diff` is empty before continuing.

---

## Wave A — catastrophic silent-wrongness

Run from `20feb8b`. One finding.

| # | Invariant | Guarding test | Mutation | Dangerous state reached | Red observed | Restored clean |
|---|---|---|---|---|---|---|
| A1 | A proposal authorizes only against the repository head it was written for | `proposal-binding`: *authorization refuses a proposal whose branch has moved* | delete the `expected_base_sha !== currentBaseSha` comparison | yes — branch moved, state version unchanged | **yes** (1 test) | yes |
| A2 | No paid work starts once the authorized base has moved | `manager-explore`: *a managed run refuses to buy exploration once its authorized base has moved* | delete the `head !== job.base_sha` comparison | yes — branch moved before any child | **yes** (1 test) | yes |
| A3 | Only the attempt a REVIEW turn accepted may be offered | *(none — see finding)* | select the latest PASSED attempt instead of `acceptedCandidate()` | **no** | **NO — GREEN** | yes |
| A4 | A callback from a superseded scheduler generation is fenced out | `dispatcher`: *stale epoch events cannot mutate an attempt*; *stale validation and failure callbacks…* | delete the `currentEpoch !== epoch` comparison | yes | **yes** (2 tests) | yes |
| A5 | Admission counts authority held by live attempts, not only settled spend | `concurrent-family`: *reservations are visible across connections and refuse an over-commitment* | `const reserved = 0` | yes — two connections, one live reservation | **yes** (1 test) | yes |
| A6 | The candidate is captured through a delegate-wave-owned index seeded from the base | `gauntlet`: four assume-unchanged / skip-worktree tests | drop the seeded temporary index; stage through the worker's own | yes — worker marks files with index flags | **yes** (4 tests) | yes |

### Finding A3 — acceptance identity was unguarded

Replacing `acceptedCandidate()` with *"the latest PASSED attempt"* left the entire suite green.

The reason is instructive rather than careless: in every scenario that existed, the accepted attempt
**was** the latest PASSED attempt. The REVISE test produces attempt 1 and attempt 2, the manager
accepts attempt 2, and "latest" and "accepted" name the same row. Both readings agree on every
sample, so no assertion could tell them apart.

The invariant is not "the newest good candidate is offered". It is that **acceptance names one exact
attempt, and that identity survives another candidate appearing afterwards** — a late-settling
worker, a stale scheduler, a defect elsewhere. Under the mutation an operator could be handed a
candidate no manager ever reviewed, which is the exact failure the semantic layer exists to prevent.

Closed by two tests:

- *a later PASSED attempt cannot displace the accepted one* — accepts attempt 1, then materializes a
  second PASSED attempt, asserts the dangerous state is real (`later.id !== accepted`), and requires
  the proposal to still name attempt 1.
- *an accepted attempt that is not the run's own is refused* — points the run at another job's
  attempt. The foreign key proves the subject is *an* attempt; it does not prove whose.

Both were re-run against the same mutation afterwards and both go red. No production change was
needed: the protection was already correct, only unproven.

---

## Waves B–D (partial)

| # | Invariant | Mutation | Red | Finding |
|---|---|---|---|---|
| B1 | An interrupted manager turn becomes UNCERTAIN, never replayed | reconcile marks `FAILED` instead | **yes** | — |
| B2 | A half-applied restore leaves a durable unhealthy marker | delete the `writeRestoreMarker` call | **yes** | — |
| C1 | Review evidence is built from one attempt, in that attempt's repository | *(none — see finding)* | **NO** | **C1** |
| C2 | A candidate with no readable diff cannot be ACCEPTed | *(none — see finding)* | **NO** | **C2** |
| C3 | An unmeasured manager turn is not zero | drop the UNKNOWN branch from the summariser | **yes** | — |
| D1 | `runJob` never promotes a managed root | `managedRoot = false` | **NO** | **D1** |
| D2 | Everyday cost is the family's cost | `familySpend` → `jobSpend` | **yes** | — |

### C1 — the repository still crossed the boundary

`buildReviewEvidence()` derived attempt, job, validation, instruction and commit from `attemptId`,
and then accepted `repoPath` from its caller. Normal execution passed the right one, so nothing was
wrong in practice — but the API permitted **attempt A with repository B**, which produces either a
failure or, if those commits happen to exist there, a plausible diff of an entirely different change.

Fixed structurally: the repository is now derived `attemptId → job → project.repo_path`, and the
parameter no longer exists. The guarding test passes a decoy path and asserts the diff was computed
in the attempt's own repository.

### C2 — ACCEPT was reachable on filenames alone

`evidence_complete` treated the instruction and the changed-file list as load-bearing but not the
candidate diff, so a write attempt could reach the manager with `candidate_diff: null` and
`evidence_complete: true`. "changed src/export.js" is equally consistent with the fix and with its
opposite; no semantic judgment survives that.

A candidate's diff is now required whenever `result_commit` exists, with ABSENT / MISSING / CORRUPT
distinguished, and the rendered prompt tells the manager it cannot accept on that basis.

### D1 — the existing test could not observe the bypass

Setting `managedRoot = false` — promoting a managed root the moment validation passes, with no
semantic review — left all 20 manager tests green.

The reason is the same shape as A3, one level further out. *"A validated candidate is NOT
integration-ready before review"* drives the loop until the manager fails at REVIEW, and `halt()`
then sets the job to `NEEDS_ATTENTION`. So `runJob` promoted, the halt overwrote it, and the
assertion inspected a status that had already been corrected. **The dangerous state existed and was
erased before it could be seen.**

Closed by checking the promotion rule where it lives, with no manager in the loop at all: run a
managed root's attempt directly, assert the candidate genuinely passed, then assert the job is
`RUNNING`, that integration is refused, and that `CANDIDATE_AWAITING_REVIEW` was recorded.

### A methodological note

D2 first appeared as a finding and was not one: the mutation string had failed to match, so nothing
was actually broken and the green result meant nothing. **Every mutation must assert that it
applied** before its result is interpreted — a mutation that silently no-ops manufactures false
confidence in exactly the direction the sweep is trying to remove.

## Wave C4 — terminal truth

| # | Invariant | Mutation | Red | Finding |
|---|---|---|---|---|
| C4 | A manager turn acquires one terminal truth exactly once | restore `INSERT OR REPLACE` **and** drop the state predicate | **yes** | **C4** |

Two defects, the weaker hiding the stronger. `finishTurn()` wrote the usage receipt with
`INSERT OR REPLACE`, so the immutability triggers never protected it — the same root cause as
finding #0. Stating that exposed the real problem: the `UPDATE` on `manager_turns` had **no state
predicate**, so even a protected receipt would not have stopped a second call rewriting a COMPLETED
turn's response, digest and action — turning a recorded ACCEPT into a REVISE against the same scarce
call, carrying the first call's usage.

Closed with one shape: terminalize only from `INTENDED`/`RUNNING`, require exactly one changed row,
plain `INSERT`, one transaction.

## Wave E — the fixtures themselves

Attacking the tests, not production. A fixture that cannot enter the state it claims to test is
indistinguishable from a passing one.

| Fixture | Precondition required | Status |
|---|---|---|
| migration | old database demonstrably lacks the new invariant | **added** — now also asserts pre-22 (no `budget_reservation_usd`, no `attempt_runtime_provenance`), not merely pre-19 |
| branch drift | `HEAD_after !== expected_base_sha` | **added** |
| restore | the tracked branch demonstrably moved before restoring | **added** to the retired-branch case; the mixed case already had it |
| candidate identity | `accepted_attempt !== later_passed_attempt` | already present |
| cross-thread transport | distinct threads, distinct turns, answers identify their own thread | already present |
| family concurrency | connection B genuinely sees connection A's live reservation | already present |

The migration fixture is hand-written, so it does not follow the schema forward on its own: without
the pre-22 assertions a later version's columns could quietly become part of the "old" database and
the migration under test would have nothing left to do.

## Loaded stability

Five consecutive bare `node --test` whole-suite runs, 454 tests each, 453 passing, 0 failing. Not
isolated files: the `.git/worktrees` contention bug appeared only under a full run and passed in
isolation, so global Git/SQLite/process interference is part of the system under test rather than
noise around it.

## Method corrections earned during the sweep

Two, both from the sweep catching itself.

**A mutation must assert that it applied.** D2 first read as a finding and was not — the replacement
string had failed to match, nothing was broken, and the green result meant nothing. A mutation that
silently no-ops manufactures confidence in exactly the direction the sweep exists to remove.

**Commit the fix before mutating against it.** Restoring a mutation with `git checkout -- <file>`
reverts to HEAD, which destroys an uncommitted fix in the same file. This happened once, and was
caught only because the *next* mutation reported that it had not applied. Fixes are now committed
first, so restoration cannot lose them.

## Remaining before merge

```text
ledger + PR description update      once, now
one real managed Codex task         end to end, after the deterministic sweep is closed
final merge audit
```

```text
B  recoverability and durable truth   migration 18->22, fresh-vs-migrated, reboot/reconcile,
                                      backup/restore/retirement
C  evidence truth                     missing/corrupt/truncated manager evidence, usage
                                      COMPLETE/PARTIAL/UNKNOWN, provenance levels, receipt
                                      immutability and conflict
D  projection truth                   internal children hidden from everyday UX but visible to
                                      recovery/detail/accounting; family cost; managed candidate not
                                      surfaced before ACCEPT
E  test harness itself                fixture roots cannot fall back to live data; tests really use
                                      migrated/restored databases; Git branch drift is real; process
                                      and SQLite handles do not manufacture passes
```

Then repeated whole-suite runs under load rather than isolated files — the `.git/worktrees`
contention bug appeared only in a full run and passed in isolation, so criterion 3 is not optional
for anything timing-sensitive.
