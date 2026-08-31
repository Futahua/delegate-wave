# Hermes dashboard restart — 2026-08-31

Scope: approved graceful interruption of the old demo turn, then restart only
the Papers-owned dashboard. No new demo was commissioned during this operation.

## Preconditions and restart

- Visible composer was empty in the preceding inspection.
- Authorized `session.interrupt` for runtime `5db80d40` returned interrupted.
- Subsequent live `session.active_list` reported both dashboard sessions idle,
  including durable session `20260831_105217_d7f17f` (old demo).
- Revalidated dashboard root PID 29944, parent Papers PID 10644, command and
  port. Stopped only that process tree, including old MCP PIDs 40304 and 8352.
- Relaunched the same Hermes executable on loopback port 9119 with `--no-open`
  and `--skip-build`, existing Papers dashboard token, and explicit
  `Products/Hermes/State` home. The token was not printed or changed. No build,
  installation, source modification, or database editing was performed.
- Replacement launcher PID 14608, interpreter chain 5876 -> 25712, started
  16:43:35 local time. Its MCP children 18672 and 15948 started 16:43:37 using
  `D:/Letters/MatTroiSeConMoc/Products/DelegateWave/Current/src/cli.js`.
- Old MCP PIDs were absent. Authenticated dashboard HTTP access succeeded.
- Delegate Wave supervisor remained PID 9872 with its original 14:37:20 start
  time. Its process tree was not stopped. Doctor remained healthy with no
  running attempts, missing repositories, or unresolved integrations.

The replacement dashboard was launched operationally with the existing Papers
authentication, not spawned by Papers itself. It is the same loopback service
that Papers can authenticate/adopt; this distinction is preserved in the PID
evidence rather than claiming the replacement has Papers as its OS parent.

## Historical wake observation

Wake `wake_931c6517-422f-496e-b036-dac9df4236b2` was not resubmitted.
Delegate Wave still records ENQUEUED, receiver PENDING, one attempt, no error.
Read-only inspection of Hermes `session_external_turns` proves the same stable
event ID targets `20260830_033752_70e11c` and remains PENDING with no owner PID,
claim timestamp, started/finished timestamps, outcome, or error. No conversation
lease was present for that target. This is durable unclaimed work, not evidence
of delivery or completion.

The restarted dashboard's live list instead showed the old demo conversation
`20260831_105217_d7f17f`, runtime `fecb04cc`, idle. Its latest preview referred
to answering the old demo session and declining further exploration. That is
historical conversation activity, not the target failure wake and not a new
dogfood run. No prompt was submitted by this restart operation.

The dashboard MCP freshness gate is satisfied. The historical failure wake's
durable state is understood but delivery remains unproven. A subsequent bounded
dogfood must use distinct session/event IDs and must not count this traffic as
demo success.
