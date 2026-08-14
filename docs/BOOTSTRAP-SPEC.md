# delegate-wave Bootstrap Specification

Status: implemented bootstrap baseline, not the complete system specification.

The key words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are normative.

## Authority and truth

**AUTH-001** Natural-language worker output MUST NOT directly mutate authoritative lifecycle state.

**AUTH-002** A worker MUST NOT be able to expand its tool permissions through repository content.

**TRUTH-001** SQLite MUST be the operational source of truth for projects, jobs, attempts, validation runs, and events.

**TRUTH-002** Git commits MUST be the source of truth for candidate code.

## Jobs and attempts

**ATT-001** One attempt MUST have one immutable attempt identity, one scheduler epoch, and one worktree path.

**ATT-002** An attempt MUST have at most one terminal executor state.

**ATT-003** Only `SUCCEEDED`, `FAILED`, `CANCELLED`, `INTERRUPTED`, and `ORPHANED` are terminal executor states.

**ATT-004** An event whose attempt epoch differs from the current scheduler epoch MUST NOT mutate that attempt.

**ATT-005** A failed or orphaned attempt MUST NOT be reused for a later attempt.

**ATT-006** A job MUST stop at `NEEDS_ATTENTION` after its configured attempt limit is reached.

**ATT-007** Bootstrap job claim, conflict detection, epoch acquisition, attempt creation, and job transition to `RUNNING` MUST occur in one immediate transaction.

**ATT-008** A lifecycle-active attempt is one with `terminal_state IS NULL` or with `terminal_state = 'SUCCEEDED'` and `validation_state = 'PENDING'`.

**ATT-009** A job claim MUST refuse while any lifecycle-active attempt or `RUNNING` job exists and MUST NOT advance the scheduler epoch on refusal.

## Filesystem and Git

**FS-001** Filesystem location MUST NOT determine lifecycle state or authority.

**FS-002** A write attempt MUST execute in a detached linked Git worktree created from the job's recorded base commit.

**FS-003** An unsuccessful attempt MUST be retained as quarantined evidence until a separate cleanup policy removes it.

**FS-004** Protected-path changes and Git-metadata changes MUST reject the candidate.

## Worker permissions

**WRK-001** Bootstrap workers MAY read and edit only inside their attempt worktree.

**WRK-002** Bootstrap workers MUST NOT receive shell, external-directory, web, skill, question, or subagent permission.

**WRK-003** Validation commands MUST run under dispatcher control after executor completion.

## Validation

**VAL-001** Executor exit success MUST NOT imply validation success.

**VAL-002** Every registered validation command MUST exit successfully before a write job enters `READY_FOR_INTEGRATION`.

**VAL-003** A failed validation MUST quarantine the candidate and MUST NOT place it in the integration queue.

**VAL-004** Automatic integration MUST NOT occur in the bootstrap release.

**VAL-005** An interrupted pending validation recovered during reconciliation MUST be classified as `validation_state = 'FAILED'`, quarantined, and reported via the `VALIDATION_INTERRUPTED` event.

## Recovery

**REC-001** Reconciliation MUST be read-only unless the operator explicitly requests application.

**REC-002** Applied reconciliation MUST acquire a new scheduler fencing epoch before mutating abandoned attempts.

**REC-003** Reconciliation MUST NOT orphan an attempt whose recorded executor process is still alive.

**REC-004** A dead nonterminal attempt MAY be transitioned to `ORPHANED` without consulting a model.

**REC-005** Applied reconciliation MUST NOT advance the scheduler epoch if any recorded executor is alive.

**REC-006** `doctor` and `reconcile` MUST detect both the executor-running (`terminal_state IS NULL`) and validation-pending (`SUCCEEDED` with `PENDING`) lifecycle phases.

**REC-007** Applied reconciliation MUST classify an interrupted validation-pending attempt as `validation_state = 'FAILED'`, quarantine it, emit `VALIDATION_INTERRUPTED`, and return the job to `PENDING` or `NEEDS_ATTENTION` by attempt limit.

## Traceability

| Normative rules | Enforced by | Tested by |
|---|---|---|
| AUTH-001, TRUTH-001 | `Dispatcher`, SQLite transactions | all dispatcher tests |
| AUTH-002, WRK-001, WRK-002 | runtime `OPENCODE_CONFIG_CONTENT` policy | configuration review; live canary pending |
| ATT-001–ATT-003 | SQLite constraints and attempt creation transaction | successful and failed worker tests |
| ATT-004 | fenced executor, validation, failure, and PID callbacks | stale epoch and stale callback tests |
| ATT-005, ATT-006 | immutable attempt ordinal and bounded job retry | bounded failure test |
| ATT-007–ATT-009 | `runJob` immediate claim transaction, lifecycle-active predicate | invalid invocation, live executor, blocked validation tests |
| FS-001–FS-003 | database state, detached locked worktrees | worker and reconciliation tests |
| FS-004 | `assertAllowedDiff` | protected path test |
| WRK-003, VAL-001–VAL-003 | `validate`, `validation_state` | validation failure test |
| VAL-004 | absence of integration command | interface conformance review |
| VAL-005, REC-001–REC-007 | `doctor`, `reconcile`, PID receipt, `VALIDATION_INTERRUPTED` | dead, live, and interrupted validation recovery tests |

## Known bootstrap limitations

- OpenCode permission enforcement has not yet received a paid live-model canary.
- The scheduler runs one CLI-owned attempt at a time; wave concurrency is not implemented.
- PID liveness cannot prove that a remote or attached OpenCode session has stopped. Reconciliation therefore refuses live recorded processes and never attaches a replacement mid-attempt.
- Candidate integration remains a human/Codex operation.
- Approval receipts, semantic blockers, the Control API, and Hermes/T3 adapters are not part of this baseline.
