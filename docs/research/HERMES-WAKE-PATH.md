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
