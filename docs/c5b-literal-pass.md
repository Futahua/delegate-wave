# C5b — literal pass

2026-08-27. An ordinary sentence typed into a Hermes Desktop conversation was
delegated, worked, validated, integrated, and reported back into that same
still-open conversation with no user intervention. Verified only through
production interfaces.

The request, typed verbatim with no mention of delegate-wave:

> When the run-filter search box has text, pressing Escape should clear the
> filter and restore the original run ordering. Client-side only, and add a
> regression test.

## Exact combination

| | |
|---|---|
| sender | delegate-wave `0e0b3cf6b6d70b89c527ddde6ce8de3f67ded06d` (`c5b-sender-frozen-2`) |
| receiver | hermes-agent-fork `aef1b17e90b489927082512896dc4c0a558b6f80`, branch `session-external-turns` |
| Hermes home | `.c5b-live-3` (config + auth only; zero prior conversations) |
| data root | `delegate-wave-c5b-live-2`, port 47332, `DELEGATE_WAVE_WAKE_ENQUEUE=1` |
| Desktop userData | `.c5b-desktop-userdata-2` (fresh) |
| project | `backpack-c5b-live-c7fcfe` -> `dogfood/backpack-c5`, branch `workspace` |
| validation plan | `npm ci` · `npm run typecheck` · `npm test` · `npm run build` |

## The run

| | |
|---|---|
| conversation (H3) | `20260827_165956_09b74a` |
| autonomous session | `asess_23a635bc-c4b0-4156-9e9a-d7f07d5d10db` — `COMPLETED` / `AUTO` |
| watch | `wtch_3c980a2b-3f22-4a8c-9630-63718727e468` — `CLOSED`, `notified_state COMPLETED` |
| wake | `wake_3bb7a2fa-51e9-4d78-ad4e-074b62becbdd` — reason `COMPLETED`, state `DELIVERED` |
| staged integration | `sint_53b51ef0-6c63-4d48-be1a-08a2a50b6afd` — `PUBLISHED` / `PASSED`, `attempt_number 1` |
| external turn | same event id, `target_session_key` = H3, `PENDING -> FINISHED`, outcome `completed` |
| target base | `0eb8ce91d973e9cf14a69827277d09a22d5eb585` |
| published | `23b58f0c0e364dd09e073f43f0f55c91bb63876c` |
| delivered change | `src/ui/RunList.tsx` +3, `test/overview-filter.test.tsx` +40 |

Two numbers carry most of the evidence.

`submitted_at = null` alongside `state = DELIVERED` means the wake travelled the
external-turn inbox, not the legacy direct-submit path. The escape hatch did not
rescue the experiment.

`staged_integrations` holds exactly ONE row. The same query two hours earlier
returned 1,421 rows for a session that never finished, and 9,123 for another --
a deterministic publication failure retried roughly 60 times a minute while the
asking conversation was told nothing.

## What actually blocked it, four times

None of it was the transport, the lease, the inbox, or the canonical-history
classifier. All four failures were missing contracts, and all four were silent:

1. `session_start` ran with no watch, because the callback address was an
   OPTIONAL MODEL ARGUMENT and a model omitted it. Work completed; nobody was
   told. Now transport context in MCP `_meta`, and a session with no return
   address refuses to start.
2. The CLI can never render a wake: the notification poller exists only in
   `tui_gateway`, not in `hermes_cli`. Every probe had driven the gateway
   directly, so the wrong surface was never noticed.
3. Publication validation ran in a fresh detached worktree with no
   `node_modules`, so `npm run typecheck` passed for the worker and failed
   forever for the integrator. The plan must be self-contained.
4. That failure wrote `SEMANTICALLY_ACCEPTED`, which `pending()` treats as
   runnable, so it retried indefinitely -- and because AUTO +
   `SEMANTICALLY_ACCEPTED` is deliberately "mid-flight", mid-flight is not
   wake-worthy, and the loop was therefore also silent.

## The rule this yields

> No autonomous state may remain indefinitely active without either demonstrated
> forward progress, a bounded terminal failure, or a durable notification path.

Every one of the four blockers violates it, and it would have caught each of them
before a machine spent fifty minutes proving it the expensive way.

## Frozen

This path is closed to cleanup-motivated change. The lease, external-turn state
machine, canonical-history classifier, wake sender and receiver poller have now
survived both the 12-case real-process matrix and the literal Desktop dogfood.
Changing them should require a concrete failure or a separately stated feature.
