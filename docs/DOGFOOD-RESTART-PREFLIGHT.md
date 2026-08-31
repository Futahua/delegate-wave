# Physical dogfood restart preflight — 2026-08-31

Approved application source: `c3c732ee3f403420278b0a62d8881ac6d9fc389d`.
This is deployment evidence, not a completed end-to-end run.

## Changes and observations

- With explicit user approval, changed only the two Delegate Wave MCP executable
  paths in local Hermes `Products/Hermes/State/config.yaml` from the absent
  `D:/Letters/MatTroiSeConMoc/delegate-wave/src/cli.js` to
  `D:/Letters/MatTroiSeConMoc/Products/DelegateWave/Current/src/cli.js`.
  Credentials, tool filters, and repository-access settings were not changed.
  The private configuration is not included in this repository.
- Used the supported `supervisor stop` and `supervisor start` commands; both
  returned success. New runtime PID 45460 started at 14:23:06 local time
  (Asia/Saigon), after the approved commit. The process uses the Current path.
- `node src/cli.js doctor` returned healthy, database integrity `ok`, no running
  attempts, no missing repositories, and no unresolved integrations.
- The restarted runtime spawned a Hermes external-turn gateway (parent PID
  45460, child PID 1340, interpreter PID 46416) and fresh MCP processes 46672
  and 13516 using the corrected Current path at 14:23:23.
- The Papers-owned Hermes dashboard interpreter PID 44660 still owns two old
  MCP processes, 40304 and 8352, started at 10:50:47 with the obsolete path.
  The fresh runtime bridge does not prove this separate desktop/dashboard
  path has refreshed its MCP contracts.

## Safety and remaining gate

Before restart, no unfinished attempts existed. One historical session still
said WORKING (`asess_23a7ce73-5792-414b-9eaa-c91a4bda740c`), but its root job
and manager run were already CANCELLED. No manual incident-record cleanup,
candidate integration, or session cancellation was performed.

The desktop automation safety tool refused an Alt+F4 request for Hermes,
citing possible interruption of active sessions or loss of unsaved state.
No alternative process-kill or indirect close was attempted. Hermes remained
open. Refreshing the affected desktop/dashboard process remains unverified.

No new demo session was commissioned and no end-to-end success is claimed.
Next: safely restart the affected Hermes desktop/dashboard path, verify its
fresh MCP process paths, then provision and register a disposable repository
as operator before asking Hermes to delegate work strictly inside that repo.
Trace the durable wake back to the exact originating conversation and verify
automatic continuation in the UI. Do not use a repository session to perform
external provisioning.
