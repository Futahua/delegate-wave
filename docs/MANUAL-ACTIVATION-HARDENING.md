# Manual activation hardening

Implemented from `874a3c480bba70b8b5b3422a4b2dcbe57e57060e` on
`codex/backpack-presentation-v1`. This change does not clean or migrate the
preserved incident data, restart services, or rerun the demonstration.

## Changed invariants

1. Scheduler contention raises retryable `SCHEDULER_BUSY`. Exploration yields
   back to the session driver in `EXPLORING`; subsequent passes reuse the same
   round and children. No synthesis turn or new exploration round is purchased
   while those children are scheduler-blocked. Already-live children are awaited
   through later reconciliation rather than dispatched again.
2. Session start initializes the manager before returning success, but never
   waits for workers. A bootstrap exception atomically records `FAILED` on both
   session and root job, with `MANAGER_BOOTSTRAP_FAILED` evidence. The local
   driver cannot race that initial bootstrap.
3. `POST /v1/sessions/:id/fail`, control command `session.fail`, and Hermes tool
   `session_fail` accept a reason only for `WAITING_FOR_HERMES`. The operation
   fences the manager, uses existing family cancellation, closes queued children
   and open commissions, then records a failed session/root/manager. Completed
   attempt evidence is retained. Clarification cannot resume a manager being
   terminally closed. Authentication supplies the cancellation identity, and
   HTTP request IDs retain the existing idempotency guarantees.
4. Project retirement checks autonomous session liveness and direct running jobs
   in the retirement transaction. `SEMANTICALLY_ACCEPTED` remains nonterminal for
   modes that publish; settled MANUAL/PLAN sessions do not block retirement.
5. Registration resolves filesystem aliases using `realpathSync.native`, then
   compares a normalized, explicitly Windows-case-folded identity against every
   existing registration, including retired ones. Duplicate registration is
   rejected with the existing ID. Restore the original project explicitly; this
   does not silently replace its branch or validation configuration.
6. Hermes' start contract and the manager standing instructions explicitly reject
   using repository jobs to create/register/repair another repository or operate
   Delegate Wave. They require escalation before commissioning such work.
   `session_answer` remains clarification only and points terminal intent to
   `session_fail`. These instructions are not represented as an OS sandbox.

## Verification

Windows, Node `v24.14.1`, npm `11.17.0`, 2026-08-31. All execution tests use
disposable repositories and test backends, not the incident database or paid agents.

| Run | Total | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: | ---: |
| Isolated starting commit: full `npm test` | 677 | 674 | 2 | 1 |
| Isolated starting commit: autonomous-session suite | 26 | 26 | 0 | 0 |
| Updated focused suites | 75 | 75 | 0 | 0 |
| Updated full `npm test` | 688 | 685 | 2 | 1 |

Focused command:

```text
node --test test/repository-path.test.js test/manager-explore.test.js test/autonomous-session.test.js test/mcp.test.js test/control.test.js
```

`npm run syntax` and `git diff --check` pass. The contention regression drives
actual `SessionDriver.pass()` calls: A/B are created once, three blocked passes
retain one PLAN turn and zero child attempts, and the same children run and reach
normal synthesis/review after the unrelated attempt settles. Additional tests
cover both queued-family closure and a live attempt's late result being fenced.

The two previously reported asynchronous driver failures did **not** reproduce:
all 26 original autonomous-session tests passed at the starting commit and after
the changes. The full suite is nevertheless **not green**. These same unrelated
failures reproduced before and after this patch:

- `test/hermes-external-turns.test.js`: "external-turn bridge fails closed for an
  incompatible Hermes interpreter" — missing expected rejection.
- `test/wake.test.js`: "an ENQUEUED wake fences a later pending wake for the same
  conversation" — expected `[]`, received a `PARTIAL` wake result.

No expectation was relaxed or test skipped to conceal these failures.

## Deliberately unchanged

- The pre-existing local `src/cli.js` modification is not part of this commit.
  Its SHA-256 before and after is
  `AC5FB824A0A0ACCAB77D0C00727FF5BB7BA32CD00E01F5ECFEDAE328BAD12BA9`.
  Baseline and updated working-tree tests used that same preserved file. The
  multiword `--validate` parser issue remains a separate task.
- Candidate-scope enforcement is not replaced with natural-language matching.
- No incident jobs, registrations, sessions, or accepted candidates were repaired
  or deleted. No demo was launched and no runtime was reloaded.
- Bootstrap coordination uses the existing single-runtime driver architecture;
  this does not add a multi-controller distributed lease protocol.
