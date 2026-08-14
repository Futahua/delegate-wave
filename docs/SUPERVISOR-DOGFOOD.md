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
