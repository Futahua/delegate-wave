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

## Original hardening verification (638c761)

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

## Session-control review corrections (b1f4967)

Follow-up to review of `638c761e6c0d825caea848956449357da554c2bc`:

- Both `session_answer` and `session_fail` now take the calling conversation from
  transport `_meta`, never model arguments. The Control API checks the durable
  `(session_id, hermes_session_id)` watch before mutation or cached-response
  lookup. Only server-authenticated operator scope bypasses that ownership check;
  an argument claiming operator scope does not. This uses the existing trusted
  Hermes metadata transport, not separate cryptographic credentials per chat.
- A valid `session_fail` retry against an already failed session returns its
  stored outcome, without new domain events or cancellation receipts. This is
  semantic retry safety across fresh MCP-generated request IDs, not just HTTP
  request-ID deduplication. Other nonwaiting states still refuse the transition.
- The root cancellation handles live family attempts once. Additional closure
  applies only to PENDING/NEEDS_ATTENTION children with no attempts. Completed
  child outcomes and attempt rows are retained, including genuine failures.

The new end-to-end regression uses `HermesMcpAdapter`, a real `ControlClient` and
HTTP server, durable watches, and the real session service with a fake manager.
It checks A/B ownership, operator authority, a lost successful MCP response, a
retry with a distinct generated request ID, and unchanged domain evidence on
retry. Separate tests cover missing/spoofed model-supplied identity and preservation
of terminal child history. The older HTTP-only idempotency test is now explicitly
named as an operator/request-ID test rather than evidence of MCP retry safety.

Focused command (75 passed, 0 failed):

```text
node --test test/autonomous-session.test.js test/mcp.test.js test/mcp-caller-identity.test.js test/mcp-live.test.js test/control.test.js
```

Full `npm test`: 691 tests, 688 passed, 2 failed, 1 skipped. The two failures are
the same Hermes-interpreter compatibility and ENQUEUED-wake fencing failures
listed above. The original asynchronous driver failures did not reproduce.

`npm run syntax` and `git diff --check` passed. These are local Windows test results, not independently
published CI checks. No workflow or CI configuration was added in this narrow pass.

## Terminal replay and retry-queue follow-up

Follow-up to review of `b1f496756d1dc769fd853ee61ec6d86d4b19a883`:

- `FAILED` is no longer sufficient for semantic replay. An existing
  `AUTONOMOUS_SESSION_FAILED` terminal event must identify both this root job and
  this session. That event is written atomically with successful typed fail;
  a fail-request intent is not enough. Independent bootstrap, manager, or
  integration failure does not authorize `session_fail` replay.
- After root family cancellation, every child still PENDING or NEEDS_ATTENTION
  is closed, including children with historical failed attempts. Already-terminal
  FAILED/SUCCEEDED/CANCELLED child jobs and all settled attempt rows stay intact.

New regressions exercise actual bootstrap/tick failures and refuse replay without
changing history, even in the presence of an unfinished fail intent or another
session's terminal receipt. A dispatcher-backed retry test produces PENDING after
one failed attempt with a three-attempt allowance and NEEDS_ATTENTION with a
one-attempt allowance. Typed fail closes both jobs while retaining the failed
attempt rows byte-for-byte and leaving no open family jobs, attempts or commissions.
The existing real MCP lost-response/fresh-request-ID replay regression remains.

Local verification: the same focused command above passed 78/78. Full `npm test`
ran 694 tests: 691 passed, 2 failed, 1 skipped. Failures remain the same baseline
Hermes-interpreter compatibility and ENQUEUED-wake fencing tests. Syntax and
whitespace checks passed. These are local results, not CI checks. No installation,
runtime reload, incident cleanup, or demonstration was performed.

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
