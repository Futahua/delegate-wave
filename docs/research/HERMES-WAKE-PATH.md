# Hermes wake-path findings — 2026-08-25

Evidence for C5b: waking Hermes when an autonomous session needs semantic attention.
Recorded as measurements, not as conclusions stronger than the probes support.

Measured against the installed Hermes Agent 0.19.0 at
`D:/Letters/MatTroiSeConMoc/HermesAI/.hermes/hermes-agent`, via the documented stdio
gateway `python -m tui_gateway.entry`.

## 1. Canonical continuation via the TUI gateway — PROVEN

A cold durable session S can be continued through the documented stdio gateway:

```text
session.resume(S)
  -> runtime session id R, carrying S's history

prompt.submit(R, prompt)
  -> the agent runs with S's context
  -> user + assistant rows append to durable S
  -> no new stored Hermes session is created
```

Measured: session `20260824_233004_5d8271` went from `message_count` 6 to 8, the
transcript tail was the submitted question followed by the correct answer recalled from
S's earlier context, and the total stored-session count did not change.

This differs from the CLI `--resume` path, which restores context into a NEW session
(measured separately: the original stayed at 6 messages, a new session appeared, and its
`parent_session_id` was null -- not even modelled as a continuation).

**Therefore C5b requires no Hermes fork and no webhook-based fresh run.** It also needs no
daemon: the gateway is a stdio JSON-RPC host that can be spawned only when there is
something actionable to deliver.

## 2. Concurrent resume is NOT serialized — PROVEN

Two independent gateway processes can resume the same durable session simultaneously.

Observed:

- gateway A had an active turn in S
- gateway B successfully called `session.resume(S)` -- no refusal
- B's returned history snapshot did NOT contain A's in-flight turn
- both gateways independently completed turns
- both pairs of rows eventually appended to S
- no ownership refusal and no automatic serialization occurred

The resulting durable ordering happened to be clean because A finished first. That is
timing, not a guarantee. The real hazard is the stale snapshot: B reasoned from a
transcript that did not include work already in flight.

**Consequence: wake delivery must not rely on `session.resume` / `prompt.submit` for
single-writer semantics.** A deterministic idle/ownership gate is required before starting
a wake turn.

## 3. No receiver-side idempotency — PROVEN

Submitting the same opaque event marker twice produced two independent agent turns
(`DUP-A` and `DUP-B`). Hermes does not deduplicate `prompt.submit` by event id.

However `session.history` exposes durable transcript entries, and an exact opaque wake
marker was findable there afterwards.

**Therefore a delegate-wave wake outbox cannot honestly claim exactly-once from
`prompt.submit` alone.** The available reconciliation is:

```text
event E pending or ambiguous
  -> inspect canonical session history
  -> marker E already durable:  do not submit again; recover its outcome
     marker E absent:           submission may be retried
```

Whether that closes the crash window depends on WHEN the user row becomes durable relative
to the `prompt.submit` acknowledgement. Probe 2 is required before freezing the outbox
state machine.

## 4. `session.status` is not a machine idle gate — OBSERVED

`session.status` returns formatted human-readable text (`"Hermes TUI Status\n\nSession
ID: ..."`) rather than a stable busy/idle field. Parsing prose to decide whether it is safe
to write to a session would be brittle.

`session.active_list` was the next candidate; section 5 records that it is process-local
and therefore also unusable.

## Gateway surface observed

```text
session.resume   session.history   session.status      session.active_list
session.create   session.info      session.interrupt   session.steer
session.activate session.list      session.most_recent session.branch
prompt.submit    prompt.background prompt.submit.truncate
```

`session.steer` exists, which is presumably the "redirect a running turn" behaviour to
avoid; the measured `prompt.submit` did not steer A's live turn.

## What sections 1-4 left open

Both questions are answered below: crash/durability ordering in section 6, and
`session.active_list` in section 5. The outbox state machine is frozen in section 6.

## 5. Cross-process active discovery — NOT AVAILABLE

`session.active_list` is process-local.

Proven with gateway A verifiably running a long turn in durable session S (the probe
aborts unless A is still mid-turn, because an idle A would not test the question): a fresh
gateway B returned `{"sessions":[]}`. B could not see stored session S, A's running state,
or A's runtime id.

`session.status` returns human-formatted prose and is not accepted as a machine ownership
signal.

**No supported read-only gateway surface currently proves that another process owns or
runs a durable session.**

## 6. Wake receiver contract — FROZEN

```text
canonical continuation                       PROVEN
crash reconciliation via canonical history   PROVEN
opaque marker discovery via session.history  PROVEN
receiver-side prompt.submit idempotency      ABSENT
cross-process idle/ownership observation     ABSENT
```

The invariant:

> A `prompt.submit` acknowledgement alone is not delivery evidence.
> Canonical durable history is the delivery authority.

Measured crash boundaries:

```text
before submit                                    marker absent
submit fired, caller killed without waiting      marker absent
submit acknowledgement received, killed at once  marker absent
user marker durable, killed before assistant     marker present, assistant absent
message.complete observed                        marker + assistant present
```

Therefore:

```text
PENDING -> PREPARING -> SUBMITTED -> reconcile canonical history

marker absent                   no durable turn        retry permitted
marker + assistant response     completed              suppress retry
marker + no assistant response  PARTIAL                automatic retry FORBIDDEN
```

PARTIAL is not a harmless failure. Tools or external side effects -- including a
`session_answer` back into delegate-wave -- may already have happened before the final
assistant row was lost. Resubmitting on that evidence would violate the same rule the rest
of this system runs on: evidence must authorise the mutation.

## 7. Existing Hermes cross-process lease machinery — ROOT CAUSE

Hermes already contains a durable active-session registry at
`~/.hermes/runtime/active_sessions.json`, with cross-process locking, PID ownership,
process-start-time identity, stale-owner detection, an `ActiveSessionLease`, and TUI
gateway integration through `try_acquire_active_session(...)`.

It implements global CAPACITY limiting, not per-session exclusivity. With
`max_concurrent_sessions` unset:

```python
max_sessions = resolve_max_concurrent_sessions(config)
if max_sessions is None:
    return ActiveSessionLease(...)      # granted immediately, nothing recorded
```

So the registry file may never be created, two gateway processes may resume and run the
same durable session, each reasons from its own independently loaded snapshot, and both
append turns to the same stored session. That exactly explains the concurrency probe.

## 8. The precise upstream Hermes change

Do not invent an ownership subsystem. Strengthen the existing registry so a live lease for
the same durable `session_id` is exclusive INDEPENDENT of `max_concurrent_sessions`.

The correctness boundary is the mutation, not a preflight:

```text
prompt.submit
  -> existing first-turn lease acquisition
  -> atomic per-session ownership check
  -> another live owner holds this session?
       yes: stable machine-readable BUSY, no turn started, no durable rows
       no:  record/acquire lease and proceed
```

A separate `session.acquire` or read-only "is idle?" call may be useful for UX but must not
be the correctness mechanism: check-then-submit reintroduces the race, because the user can
start a turn in the interval.

These two concerns must stay uncoupled:

```text
per-session mutex          correctness
max_concurrent_sessions    capacity policy
```

Acceptance tests:

1. A acquires S and starts a long turn.
2. B resumes S.
3. B `prompt.submit` -> typed BUSY, zero model turn, zero durable rows.
4. A completes/releases.
5. B `prompt.submit` -> acquires S and succeeds.
6. A's stale lease cannot submit after ownership transferred.
7. Kill A holding the lease -> PID/process-start staleness eventually permits B.
8. With `max_concurrent_sessions` unset, per-session exclusivity still applies.
9. Different sessions remain concurrently runnable when global capacity allows.

## Consequence for the delegate-wave build

Do NOT gate delivery on a precomputed `ownership_state = PROVEN_IDLE`. A preflight
observation goes stale exactly like the check-then-submit race above. Let the future
`prompt.submit` be the atomic gate:

```text
wake pending
  -> spawn TUI gateway
  -> session.resume(S)
  -> reconcile marker against canonical history
  -> prompt.submit

typed BUSY   no delivery occurred; leave PENDING and retry later
accepted     SUBMITTED; canonical history then owns the truth
```

Everything else in C5b -- `session_watches`, `wake_outbox`, marker reconciliation, PARTIAL
handling, the gateway subprocess adapter -- can be built and tested before Hermes gains
per-session exclusivity. Only the final delivery step depends on it.

## 9. What C5b built against this contract — 2026-08-25

Everything above except the mutation. Schema 33 adds two tables; three new modules sit beside the
session driver.

```text
session_watches       who is waiting to be told, and about what        src/session/watcher.js
wake_outbox           one thing to say, and what is known about it     src/session/wake.js
HermesGateway         spawned per delivery, never resident             src/session/hermes-gateway.js
```

Where each measured finding landed:

```text
1  canonical continuation      resume() -> runtime handle; submit(handle) appends to durable S
2  concurrent resume unsafe    partial unique index: one delivery open per hermes_session_id
3  no receiver idempotency     opaque marker written once at enqueue, never regenerated
4  status is not an idle gate  never consulted; no preflight ownership state is computed
5  no cross-process discovery  not depended on
6  crash boundaries            classifyHistory(): ABSENT / DELIVERED / PARTIAL / AMBIGUOUS
7  capacity != exclusivity     the reason allowSubmit defaults to false
8  the upstream fix            SESSION_NOT_OWNED matched exactly; BUSY leaves the wake PENDING
7  PID + process-start leases  reused for delegate-wave's own reclaim rule (schema 34)
```

The withheld step is one flag. `WakeDeliverer` is constructed only when
`DELEGATE_WAVE_HERMES_AGENT_DIR` names a Hermes agent directory, and it withholds `prompt.submit`
unless `DELEGATE_WAVE_WAKE_SUBMIT=1`. Reconciliation, resume, marker discovery and PARTIAL handling
all run either way -- a withheld wake returns to PENDING with `WAKE_SUBMISSION_WITHHELD` recorded, so
a queue standing still reads as a decision rather than as a broken watcher. Turn the flag on when
section 8 lands upstream, not before.

Additions beyond the frozen text, all consequences of it rather than departures:

- **PARTIAL blocks its watch.** A durable marker with no assistant turn means what happened in that
  conversation is unknown. More automatic wakes into it would compound an ambiguity rather than
  resolve it, so the watch moves to BLOCKED and only a person re-arms it -- naming the specific
  PARTIAL wake they inspected, which is compare-and-swapped against the row actually holding the
  watch shut. A bare acknowledgement would accept a decision about a different ambiguity than the
  one that was read.
- **AMBIGUOUS is a fourth verdict.** Attribution stops at the next user turn. An assistant row that
  arrives after somebody else has spoken is not an answer to this marker, and reading it as one
  loses the wake in total silence -- nobody told, nothing retried, evidence saying it went fine.
  Recorded in the PARTIAL state, because the handling is identical, with its own explanation,
  because what a person must do about it is not.
- **Reclaim requires a proven death, never an elapsed interval.** A delivery that is slow and one
  that was abandoned are indistinguishable by clock. An age-based rule releases the slow one, its
  original owner then submits, and a second process submits the same marker -- the exact failure
  this subsystem exists to prevent. Schema 34 records the owning runtime and its gateway child as
  (pid, process start time), and a row is only reclaimed when both are positively DEAD. UNKNOWN
  never authorises anything. This is the identity principle Hermes already uses for its own leases.

### Two corrections to the first implementation

Both were found in review, and both would only have caused damage once submission was enabled.

- **The turn timeout was a turn kill.** `waitForTurn` had a five-minute deadline, after which
  `deliver()` returned and its `finally` closed the gateway -- and closing the gateway kills the turn
  it hosts, which is how the PARTIAL boundary was produced during these measurements in the first
  place. So a wake that took too long to answer was destroyed by the thing waiting for it, and the
  wreckage was then recorded as evidence. The wait is now unbounded by default and ends when the turn
  completes or the child dies; a deadline is available but documented as what it is, a cancellation
  policy.
- **BUSY was inferred rather than matched.** The predicate accepted code 4030 and any message
  containing "busy". In Hermes 0.19.0, 4030 is "llm.oneshot requires a template" and "path outside
  spawn-trees root". The upstream lease must emit an exact machine-readable reason --
  `SESSION_NOT_OWNED` -- and that is what is matched, alongside Hermes' existing 4009. An unrecognised
  code is an error, which stops and asks, rather than a retry.

### Three further corrections

- **BLOCKED must stop what is already queued.** The watcher stopped creating wakes for a blocked
  watch, but `claim()` selected PENDING rows from the outbox alone. A session that asks a question
  and then finishes enqueues two wakes; if the first goes PARTIAL, the second was still delivered
  into the conversation nobody can account for. The claim now requires the owning watch not to be
  BLOCKED -- and deliberately still permits CLOSED, because a terminal watch closes the instant it
  enqueues and excluding it would strand every completion wake ever written.
- **A dead gateway under a live owner wedged the row forever.** The ordinary failure, not an exotic
  one. `deliver()` left the row SUBMITTED and returned; the cross-process rule then refused -- rightly
  -- to touch a live owner's work, and the owner had already moved on. Nothing resolved it until the
  runtime happened to die. Now the owner reconciles its own abandoned row: immediately, with a fresh
  gateway, and on later passes too, because a row this process owns and is not driving is knowledge
  no probe could supply. The PID rule stays exclusively for another process recovering work whose
  owner actually disappeared.
- **The marker anchors on a user row.** A reverse search over every row could select an assistant
  reply that quoted the marker back -- a reasonable way to acknowledge one -- find nothing after it,
  and call a successful delivery PARTIAL.

- **An open wake for the same event is adopted, not duplicated.** `unblock()` clears the watch's
  notification marks on purpose, so a person who inspected an ambiguity can authorise another
  attempt at it. But the watch is one row and the outbox is many: a session that asked a question
  and then finished has the question PARTIAL and the completion still PENDING behind it, and
  clearing the marks made that queued completion look unannounced. The next watcher pass wrote a
  second copy, and the person would have been told twice about one thing. PENDING, PREPARING and
  SUBMITTED count as open; DELIVERED and PARTIAL deliberately do not, so clearing a PARTIAL with no
  queued successor still re-announces, which is the whole point of clearing it.

An earlier test masked the second of these: its fake liveness answered DEAD for every pid including
the deliverer's own, so "gateway dies mid-delivery" modelled owner-dead rather than the live-owner
case that actually happens. A process asking whether it is itself alive can only get one answer, and
the fake now says so.

### Enabling submission takes more than a flag

```text
DELEGATE_WAVE_HERMES_AGENT_DIR   a gateway exists to spawn
DELEGATE_WAVE_WAKE_SUBMIT=1      an operator asked for submission
gateway.capabilities reports     per_session_exclusive_submit = true
```

The third is checked per delivery and cannot be configured. A receiver that does not answer counts
as one that answers no, so today -- where no Hermes has a capability surface at all -- submission
stays withheld even with the flag set. That is the point: the flag must not survive a downgrade, an
unexpected PATH, or a copied config and do its damage in somebody's real conversation.

`SEMANTICALLY_ACCEPTED` also wakes, but only for the modes where it is terminal (MANUAL, PLAN) --
the same rule `SessionDriver.pending()` already applies. Without it the one mode whose entire purpose
is to stop with a finished result for a person would be the one that never told anyone it was ready.

### Verified against the live runtime, read-only

The adapter and the classifier were run against the real Hermes 0.19.0 gateway and the durable
session the sections above were measured in (`20260824_233004_5d8271`, now 20 messages). Nothing was
submitted.

```text
gateway.ready                 1956ms after spawn
session.resume                runtime handle 44724b94, durable 20260824_233004_5d8271
                              the handle is NOT the durable id, as section 1 requires
session.history               20 rows, roles user/tool/assistant
```

`classifyHistory` over that real transcript, with no fixtures involved:

```text
WAKE-CONCURRENT-901  DELIVERED   marker + assistant reply
DUP-A / DUP-B        DELIVERED   both duplicates land, which is section 3 restated
CRASH-D-731          DELIVERED   two user rows answered by one assistant turn
"900-word essay"     PARTIAL     a real abandoned turn: user row durable, no assistant reply
absent marker        ABSENT      retry permitted
```

The PARTIAL is not synthetic. It is the essay probe that was killed mid-turn during the original
measurements, still sitting in the transcript exactly as the crash-boundary table predicts.
