# Approved-integration dogfood report

Date: 2026-08-14  
Candidate: `bc205948faef32ebae2608cf82717f6c06967322`

## Outcome

The approved-integration vertical slice was built with `delegate-wave` workers, repaired under its
quarantine boundary, and independently audited with Luna. The final local conformance run passes
38/38 tests. The final fresh Luna audit returned `NO BLOCKERS`.

This version was not allowed to integrate itself. It must be reviewed and merged through the
normal GitHub path. After that merge, a small documentation change can be the first candidate
promoted through the new proposal/approval/integration commands.

## Identical write-task comparison

Both workers received the same base SHA, goal, permissions, validation command, and one-attempt
limit.

| Worker | Wall time | Artifact-summed cost | Result |
|---|---:|---:|---|
| DeepSeek V4 Flash | about 351 s | $0.0121223816 | Valid candidate; independent `npm test` passed |
| Luna | about 117 s | $0.01796458 | Invalid candidate; JavaScript syntax error, validation failed |

Luna was faster but did not produce valid implementation work. DeepSeek Flash remains the default
implementation worker for this evidence set. Luna remains the stronger focused reviewer.

The DeepSeek worker could not run tests inside its restricted model session because shell access
was denied. That claim was not treated as evidence: `delegate-wave` ran `npm test` independently
after the executor exited.

## Review and repair sequence

1. Luna reviewed the passing DeepSeek candidate and found mutable validation-plan, approval
   selection, operation-intent, immutability, and test-coverage gaps.
2. DeepSeek reviewed the invalid Luna candidate and confirmed its syntax error plus design gaps.
3. A DeepSeek refinement produced a commit but failed independent validation (19/27); it was
   quarantined.
4. A narrower DeepSeek repair exhausted its reasoning budget without editing; the attempt was
   quarantined.
5. The two useful worker commits were imported onto the human-controlled feature branch and the
   failures were repaired deterministically.
6. Luna audit one found three blockers: checked-out-branch TOCTOU, malformed stored-plan fallback,
   and false failure after a successful CAS.
7. Luna audit two found malformed project-plan fallback and ambiguous receive-pack outcome
   handling, plus missing adversarial coverage.
8. The final fresh Luna audit, against the corrected commit and 38-test suite, returned
   `NO BLOCKERS`.

## Cost accounting

Costs below are sums of every `step_finish.part.cost` in each immutable OpenCode JSONL artifact,
not merely the last model message. This corrected an earlier undercount that reported only the
final step.

| Attempt | Model/role | Cost |
|---|---|---:|
| Initial implementation | DeepSeek Flash | $0.0121223816 |
| Identical implementation | Luna | $0.01796458 |
| DeepSeek candidate review | Luna | $0.00648747 |
| Luna candidate review | DeepSeek Flash | $0.0056229124 |
| Broad refinement (failed validation) | DeepSeek Flash | $0.010660846 |
| Narrow repair (reasoning limit, no edit) | DeepSeek Flash | $0.0076629448 |
| Corrected candidate audit 1 | Luna | $0.00756927 |
| Corrected candidate audit 2 | Luna | $0.00716177 |
| Final audit | Luna | $0.00908012 |
| **Total** | | **$0.0843322948** |

The result supports the current routing policy:

```text
implementation / ordinary repo work  -> DeepSeek Flash
focused state-machine review          -> Luna
hard implementation escalation       -> DeepSeek Pro
architecture / conflicts / acceptance -> Codex or human
```

## Final evidence

- `npm run check`: 38 passed, 0 failed.
- `git diff --check`: clean.
- Real temporary Git repositories, linked worktrees, local receive-pack, force-with-lease, SQLite,
  shell validation, and injected crash/acknowledgement failures are exercised.
- A repository configured with permissive `receive.denyCurrentBranch=ignore` is still protected by
  the per-invocation refusing receive-pack.
- A checkout created after the scheduler's final precheck is refused by the ref transaction.
- Malformed project validation is rejected before worker claim; malformed proposal validation is
  rejected before authority consumption.
- Ambiguous or post-CAS receipt failures remain fail-closed and are never mislabeled as ordinary
  failed operations.
- The user's checkout is not modified by successful integration.

## Deliberately deferred

The slice fails closed on an integration intent whose ref outcome is uncertain. A later recovery
feature must reconcile `BRANCH_ADVANCE_INTENDED` against Git and append the correct terminal
record; this version does not guess or retry. Daemon/API, Hermes/MCP, T3, concurrency, deployment,
and automatic approval remain out of scope.
