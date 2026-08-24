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

`session.active_list` remains the next supported candidate and has not yet been tested.

## Gateway surface observed

```text
session.resume   session.history   session.status      session.active_list
session.create   session.info      session.interrupt   session.steer
session.activate session.list      session.most_recent session.branch
prompt.submit    prompt.background prompt.submit.truncate
```

`session.steer` exists, which is presumably the "redirect a running turn" behaviour to
avoid; the measured `prompt.submit` did not steer A's live turn.

## Still unknown

- Crash/durability ordering (probe 2): when the user row becomes durable relative to the
  `prompt.submit` response, and whether an interrupted turn is recoverable or left partial.
- Whether `session.active_list` gives a usable ownership signal.

Until probe 2 is done, do not freeze the outbox state machine: it is not yet known whether
`PENDING -> SENT` suffices or whether
`PENDING -> CLAIMED -> SUBMITTED -> TURN_DURABLE -> COMPLETED` with restart reconciliation
between each state is required.
