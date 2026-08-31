# Reconcile a WORKING session over cancelled work

The restart preflight exposed a historical autonomous session whose state was
WORKING while its root job and manager run were CANCELLED. This was not inert:
the driver rediscovered it on every pass, and advancing the terminal manager
left the session WORKING.

`AutonomousSessionService.tick()` now checks authoritative cancellation before
manager advancement for a WORKING session. A CANCELLED root or manager prevents
any new manager advancement. While any family attempt or commission remains
live, the session waits for teardown. Once those are gone, it atomically writes:

- session state FAILED, with an explicit CANCELLED outcome (the existing
  autonomous-session state vocabulary has no CANCELLED member);
- one `AUTONOMOUS_SESSION_CANCELLED_RECONCILED` event containing the session ID
  and observed root/manager statuses.

The next driver pass no longer selects the session. Repeated ticks emit nothing.
The reconciliation does not rewrite root/child jobs, manager history, attempts,
or cancellation receipts. It is not another cancellation operation. Its event
is deliberately distinct from `AUTONOMOUS_SESSION_FAILED`, so it cannot
authorize a successful replay of the typed `session_fail` operation.

## Regressions

- Create and bootstrap a session; cancel its root through Dispatcher and let
  ManagerService observe that cancellation. Close the database, reopen with new
  service objects, and run a fresh SessionDriver over the same durable data.
- Prove discovery followed by terminal reconciliation, zero manager advances,
  empty pending set, unchanged historical rows, one receipt, and no writes on
  subsequent ticks. Typed fail still refuses this independently failed session.
- Cover root-only and manager-only cancellation. Inject a live child attempt
  or commission to verify the teardown guard; no manager turn is allowed and
  terminalization waits until teardown finishes. These guard checks are unit
  simulations; the restart regression uses the real on-disk ledger.

## Local verification

- Focused: `node --test test/autonomous-session.test.js test/manager.test.js
  test/control.test.js test/mcp.test.js` — 70/70 passed when run without a
  concurrent full suite.
- Full `npm test` — 709 tests: 706 passed, 2 failed, 1 skipped. The failures
  remain the established incompatible-Hermes-interpreter and ENQUEUED-wake
  fencing cases. The new cancellation regressions passed.
- An earlier overlapping focused run reported 69/70: the existing driver
  completion deadline observed SEMANTICALLY_ACCEPTED before COMPLETED. It
  passed in the full run and the isolated focused rerun; this transient result
  is retained here rather than hidden.
- JavaScript syntax and `git diff --check` passed. These are local results,
  not published CI checks.

## Deployment gate

This patch has not been loaded into the running supervisor. The historical
operational session has not been manually edited or cancelled. Normal driver
reconciliation will apply after a reviewed runtime restart; that transition can
also produce the existing FAILED wake for a watched session.

The desktop/dashboard MCP PIDs 40304 and 8352 still used the obsolete path on
this check. The separate runtime wake bridge uses the corrected Current path.
Hermes still needs a safe restart and process-path verification. No demo was
launched, no product candidates were integrated, and no incident data was
deleted.
