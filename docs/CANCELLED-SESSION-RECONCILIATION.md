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

## Physical deployment verification — 2026-08-31, Asia/Saigon

After user approval of `3911c27d9641565c99ec13f0ebecf412c1cc3333`, the supported
supervisor stop/start commands both succeeded. PID 9872 started at 14:37:20
from `Products/DelegateWave/Current/src/cli.js`. Doctor before and after restart
reported healthy, integrity `ok`, no running attempts, no missing repositories,
and no unresolved integrations.

Read-only inspection after startup found the actual historical session
`asess_23a7ce73-5792-414b-9eaa-c91a4bda740c` changed by the normal driver to
FAILED at `2026-08-31T07:37:25.169Z`, with outcome
`CANCELLED: authoritative root job or manager run was cancelled`.
Exactly one `AUTONOMOUS_SESSION_CANCELLED_RECONCILED` receipt exists on root
`job_24c03f69-c073-4a41-94d9-a5ba98d0a258`, identifying both root and manager
as CANCELLED. No manual tick or database mutation was used.

The watch became CLOSED with notified_state FAILED. Historical failure wake
`wake_931c6517-422f-496e-b036-dac9df4236b2` targets the original Hermes session
`20260830_033752_70e11c`. At inspection it was ENQUEUED, protocol 2, one attempt,
receiver PENDING, and no recorded error. This is not proof of delivery or
automatic continuation, and it must not be counted as demo traffic.

Obsolete MCP PIDs 40304 and 8352 remain under dashboard interpreter PID 44660.
This is the Papers-owned Hermes dashboard, distinct from the runtime wake
bridge and the Hermes desktop window. Closing/reopening only the desktop
window does not establish that this dashboard interpreter restarted.
No further close/kill was attempted following the earlier desktop safety
refusal. A safe dashboard restart remains necessary; unsent input and any
active conversation should be saved/settled first. No demo launched.

### Dashboard restart safety check

After explicit approval to restart only the Papers-owned dashboard, subject
to no active Hermes turn, inspection found the visible composer empty (no
unsent input to save). The UI still showed the old demo as working. The HTTP
history list's `is_active: false` was not used as proof of runtime idleness.

A read-only authenticated WebSocket `session.active_list` call to the actual
dashboard at port 9119 returned:

- runtime session `05b6318c`, durable `20260830_160645_168615`: idle;
- runtime session `5db80d40`, durable `20260831_105217_d7f17f`, title
  `Create and run Delegate Wave demo`: working.

The live-list implementation derives working from the session's in-memory
`running` flag. This does not prove provider activity, but it prevents claiming
the requested idle precondition is satisfied. No interrupt, process kill,
restart, or wake resubmission was performed. Graceful interruption of that
specific old turn needs authorization before verifying idle and restarting.

Dashboard tree remains 29944 -> 45720 -> 44660, with obsolete MCP children
40304 and 8352. Delegate Wave supervisor PID 9872 and its bridge were left
untouched. Doctor remained healthy. Historical wake
`wake_931c6517-422f-496e-b036-dac9df4236b2` was still ENQUEUED / receiver PENDING,
one attempt, no error. No demonstration was launched.
