# V1 release candidate: build order

Acceptance sentence:

> I tell Hermes what I want changed -> Hermes identifies the project and proposes bounded work -> I
> authorize once -> cheap workers perform it -> deterministic validation checks it -> a clean
> candidate reaches one consequential approval -> approval integrates it -> Hermes tells me Done,
> what changed, and what it cost -> ordinary failures and reboots are recoverable without manually
> repairing SQLite or Git.

## Order, chosen by dependency rather than by the list

1. cancel operation            durable intent, fencing, process kill, stale-callback rejection
2. budget and attempt limits   UNKNOWN usage never counts as zero
3. backup / restore / rollback recovery without hand-editing SQLite or Git
4. auto-advance                proposal -> one authorization -> worker -> validation -> integration
                               proposal -> one final approval -> integration
5. Hermes surface              Working / Needs your decision / Ready to check / Done, with cost
6. attempt-root fence          symlink and junction aware; needed before Harness sees a repo
7. HarnessBackend              JSON-RPC, WRK-011 normalization, timeout/cancel receipts
8. A/B                         same route, same account, explicit high on both arms
9. docs                        README, handoff, setup describing the finished workflow
10. gauntlet                   the seventeen scenarios, against real projects

Items 1-5 deliver the acceptance sentence on the executor we already have. Items 6-8 decide whether
the executor changes. That order means a Harness delay cannot block the product.
