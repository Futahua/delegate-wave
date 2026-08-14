# Windows Supervisor Dogfood

Date: 2026-08-14

The Windows Task Scheduler integration was installed on the live machine as
`\delegate-wave-control`. It runs the repository's existing `src/cli.js serve` entry point under the
interactive user with least privilege. The exported task contains the executable, repository path,
logon/periodic triggers, and restart policy. A mechanical scan confirmed it contains neither Control
credential names nor any configured credential value.

## First acceptance attempt: assumption disproved

The initial task used a logon trigger plus `RestartOnFailure` (five retries at one-minute intervals).
The task-owned Node process was verified by PID and command line, then force-terminated. Windows
recorded result `-1`, returned the task to `Ready`, and did not restart it within 85 seconds.

This proves that `RestartOnFailure` is not sufficient for externally terminated long-running tasks on
this machine. The failed test changed no delegate-wave job, attempt, approval, validation, or
integration state.

## Corrected acceptance

The task gained an independent one-minute trigger and retained `MultipleInstancesPolicy=IgnoreNew`.
While the API is live, repeated triggers cannot start a concurrent instance. After termination, the
next trigger can start a replacement even when Windows did not classify the exit for
`RestartOnFailure`.

Observed live sequence:

```text
task-owned API PID 37564
overview healthy = true
projects = 15
        ↓ force terminate verified PID
replacement PID 44216 after approximately 46 seconds
overview healthy = true
projects = 15
```

The restored process command line was the exact installed `node ...\src\cli.js serve` action. No LLM
was called during installation, failure classification, restart, or health verification.

## Scope

This proves task import, explicit start, forced-process recovery, credential-free metadata, and
post-recovery API health in the current Windows environment. The accepted task also contains an
interactive-user logon trigger, but this dogfood did not reboot or log off the user's machine. Actual
next-logon behavior remains an operator observation rather than a performed destructive test.

## Review hardening: explicit stop

Review identified that `/End` alone left the one-minute trigger enabled. The lifecycle commands now
use this ordering:

```text
stop  = disable, then end
start = enable, then run
```

The live task was explicitly stopped at PID 44216. After 70 seconds there was still no listener on
port 47321, and Task Scheduler reported both task status and scheduled state as `Disabled`. Starting
it again re-enabled the task before requesting the run.

## Review hardening: protected credential startup

Review also identified that persistent Windows user-environment values are plaintext under
`HKCU\Environment`, allowing repository-controlled validation to bypass inherited-environment
scrubbing by reading the registry directly.

The live installation was migrated to a current-user DPAPI-protected bundle at:

```text
D:\AssistantSystem\delegate-wave\config\control-secrets.dpapi
```

Acceptance checks established:

```text
persistent Control/Hermes user-environment values = absent
protected bundle contains a configured plaintext secret = false
protected bundle contains a Control credential name = false
task action = node ...\src\cli.js supervisor run
clean operator CLI process can decrypt and call doctor = true
post-migration doctor healthy = true
```

The DPAPI change closes plaintext registry persistence; it does not claim to isolate arbitrary code
running as the same Windows user. That stronger boundary remains an execution-class requirement.

During the post-migration restart, `/End` returned before the previous process had released port
47321. An immediate `/Run` therefore exited with `EADDRINUSE` even though the periodic trigger would
eventually recover it. The supervisor now writes a process-only PID receipt and waits for that exact
PID to die before `stop` reports success. The receipt is synchronization evidence only; it never
causes a delegate-wave job/attempt lifecycle transition.

The corrected live sequence recorded PID 38648, confirmed the PID receipt matched the listener,
performed an immediate stop followed by start, and returned healthy on replacement PID 38736 with no
manual delay or `EADDRINUSE` failure.

## Second review round: scoped decryption and non-orphaning uninstall

Review found that the first protected-credential migration preserved at-rest protection but defeated
the credential separation established in PR #5. The store held one bundle carrying both tokens, and
`load()` decrypted the whole bundle and returned every value. Although the MCP startup path assigned
only the observer token into `process.env`, the Hermes Node process had already received the
decrypted operator token in memory.

The store now protects each role as an independent DPAPI record, and `load(role)` unseals exactly one
of them:

```text
ordinary CLI  -> operator record only
Hermes MCP    -> observer record only
supervisor    -> operator and observer, each by a separate scoped load
```

The deterministic regression instruments the ciphertext handles and asserts the operator decrypt path
is never invoked during clean MCP startup, and that the observer result contains no operator value.

Review also found that `uninstall()` deleted the task without stopping the running API. Microsoft
documents that deleting a scheduled task does not interrupt a program already started from that task,
so a running API could have kept listening on 47321 as an unmanaged orphan while the supervisor
reported success. Uninstall now runs the shared stop sequence — disable, `/End`, wait for the recorded
runtime PID — before `/Delete`, and fails without deleting the task if that PID does not exit.

Per SUP-009, uninstall still does not remove the protected credential store; purging credentials is
left as a separate explicit operation.

These two fixes are deterministic and covered by the suite; no additional model call was used.

## Legacy store migration and live recovery

The scoped-record change was initially left without a migration path, which put the live machine one
restart away from a rejected credential store. The correct resolution is an explicit one-time
migration: the supervisor process — already entitled to every role — decrypts the legacy bundle once,
immediately re-protects each role independently, replaces the store by same-volume rename, and
discards the combined plaintext. This never exposes the operator token to MCP.

Review noted that the first version of this replacement copied over the live path, which truncates it
before rewriting and is not the atomic swap the description claimed. Because this file gates reboot
recovery, the store is now written to a sibling temporary, flushed with `fsync`, and moved into place
by rename, so a crash mid-write leaves the previous store readable rather than a truncated one.

`load()` deliberately does not migrate. It fails closed with a directive to run
`supervisor migrate-secrets`, because a lazy migration inside `load()` would let the Hermes MCP
process decrypt the combined bundle. A regression asserts that a legacy store refuses an observer
load without decrypting anything and without mutating the store.

Live migration of `D:\AssistantSystem\delegate-wave\config\control-secrets.dpapi`:

```text
pre-migration format = legacy bare base64 blob, 629 bytes
migrate-secrets -> { migrated: true, roles: [operator, observer] }
post-migration store = {version: 1, records: {operator, observer}}, 994 bytes
operator and observer ciphertexts distinct = true
observer load returns only DELEGATE_WAVE_CONTROL_OBSERVER_TOKEN = true
observer value equals operator value = false
```

The migration rewrote only the credential file, so the running API was never interrupted by it. The
restart was then performed against the already-migrated store:

```text
stopped PID 38736, listener count on 47321 = 0
started replacement PID 42664, PID receipt matched the listener
clean operator CLI doctor on new process = healthy
clean Hermes MCP get_overview on new process = 15 projects, bounded result
task enabled = true, state = running, logon and time triggers enabled
```

The decryptable legacy backup taken before migration was removed once migration was verified, since
a combined bundle is the artifact this change exists to eliminate.

## Current-head validation

There are no hosted checks, so the deterministic suite is the validation evidence and it is recorded
against the exact head it was run on:

```text
src/ tree       ff117f7fbee71eab5a72072b5e99af9dad3563dd
test/ tree      2995082771380f7866b0540e6ddfa5328c8be359
command         npm run check
result          83/83 pass, 0 fail, 0 skipped, 0 todo
duration        approximately 32 s
```

The tree hashes identify the exact validated source; verify with `git rev-parse HEAD:src` and
`HEAD:test`. Only documentation changed after the run, since this record is part of the same commit.

That count includes the scoped-decryption, legacy-migration, non-orphaning-uninstall, and
store-replacement regressions added after the first review round. Earlier PR text citing 72/72 or
76/76 predates those batches and should not be used as this head's evidence.

Live re-verification after the store-replacement change, with the API still on PID 42664:

```text
migrate-secrets on an already-scoped store -> { migrated: false }
store bytes unchanged (sha256 prefix 47CEBB1225866CE2, 994 bytes)
no temporary residue in the config directory
clean operator CLI doctor healthy = true
clean Hermes MCP get_overview = 15 projects, bounded result
```

The actual next-logon trigger remains unobserved by deliberate choice; the machine was not rebooted
or logged off.
