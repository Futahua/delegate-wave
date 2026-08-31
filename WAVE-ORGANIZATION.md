# Wave organization — creator request, 2026-08-31

Scope: archive/restore/delete waves, rename waves and groups, create groups,
and drag waves between groups in the Delegate Wave Backpack. Archive access is
a box button beside the hamburger in the expanded sidebar. Hermes-created
groups remain defaults, not the only possible organization.

Implementation checkpoint: source work only; no runtime migration, restart or
Papers installation authorized. Keep host relay changes narrow and separate.

Safety: organization must not change original task intent, conversation watch
ownership, branch binding, execution, or repository files. Archive is reversible.
Delete requires an archived, settled wave and confirmation, removes it permanently
from the organizer, and retains execution/audit receipts in the ledger. The UI
must explicitly disclose that audit retention; this is not a database purge.
Running/waiting work cannot be hidden through archive/delete. Group removal
must never delete its waves. Names and membership live in the local DW database,
not browser storage; existing Hermes titles are fallback labels.

Checkpoints:
- [x] Durable organizer storage and operator-only API, isolated regressions.
- [x] Enumerated Papers relay with validation and authorization regressions.
- [x] Backpack buttons, inline names, groups, drag/drop plus keyboard move.
- [x] Full relevant tests (results below); source commits prepared separately.
- [ ] Separately authorized deployment and physical UI verification.

## Implementation and review handoff

Starting heads: DW `a13f74a7144a7cdb81bb67893563fb55d92ff8ca`, Papers
`03d6e714f0ce422bf68bdf5dd1d781f411ffa603`, Backpack
`3fbed199699b4439188ae914dd0a55a4e1905aa5`.

Schema 38 adds `wave_groups` and `wave_organization`. It does not rewrite sessions,
watches, jobs, attempts, or integration evidence. Custom names are display aliases;
the original task intent remains unchanged. Default group IDs remain the original
Hermes conversation IDs; a custom group is an independent `group_` ID. Removing a
custom group returns its waves to their original groups, including archived waves.

`GET /v1/wave-organization` requires READ; POST requires OPERATE and uses the existing
durable control-request receipt path. Mutation actions are `rename`, `move`,
`archive`, `restore`, `delete`, `group.create`, `group.rename`, `group.delete`.
Delete is a permanent organizer tombstone, not erasure of execution evidence. Raw
session/audit APIs retain the history. No worker, cancellation, integration or
Hermes operation is implied by organization. Archive/delete also refuse live family
attempts or open commissions, even if the session envelope appears terminal.

Names and moves are last-write-wins operator preferences. Metadata refreshes every
5 seconds while visible (15 while hidden), with no overlapping refreshes or reads
overwriting an in-flight mutation. Timed-out saves are reported as uncertain; no
automatic mutation retry is performed. A later refresh exposes the durable result.

## Local validation — 2026-08-31

- DW organizer + Control HTTP suites: **30/30**. Includes actual HTTP scope denial
  for observer/Hermes credentials, request-ID replay, schema-37 additive upgrade,
  persistence after reopen, archive/delete ordering and live-child refusal.
- DW full run: **728 tests; 724 passed, 3 failed, 1 skipped**. Two failures match
  the previously reported `hermes-external-turns` incompatible-interpreter and
  `wake` ENQUEUED-fencing tests. The third, `an answered session continues without
  Hermes calling anything else`, passed on an isolated rerun (1/1). Do not describe
  the full run as green or this rerun as proving the timing issue fixed.
- Papers: **483 passed, 4 skipped**, including 16 relay tests; typecheck passed.
- Backpack: **89/89**, typecheck and source-only build passed (bundle-size warning).
  `public/` unchanged. Browser inspection used the isolated test fixture: readable
  menus, archive/restore controls, keyboard move and physical pointer drag verified.
  No live session, paid worker or production database was used for these tests.
- Evidence is local, not independent CI. No deployment or runtime restart performed.

## Deployment checkpoint (not executed)

Obtain permission for the coordinated update. Preserve a DW database backup before
opening it with schema 38. Deploy/restart DW only when no turn is active, then deploy
the Papers relay and Backpack public bundle as separate deliberate steps. Do not
ship only the UI: old hosts refuse the two organizer operations and the UI will
show an update-required error. Keep the existing hidden launchers intact; do not
introduce visible terminals. Verify with a disposable settled wave, then restore
it; confirm real history and repository files remain unchanged. No data purges.
