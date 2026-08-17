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

## Waves B–E

Pending.

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
