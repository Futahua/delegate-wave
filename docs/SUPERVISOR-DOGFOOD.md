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
