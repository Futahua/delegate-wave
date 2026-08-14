# Windows Control API Supervisor — Normative Specification

Status: bootstrap slice

The supervisor supplies process availability only. It does not own scheduler truth and cannot
authorize or reconstruct domain state.

## Task boundary

**SUP-001** The Windows supervisor MUST load protected credentials and run the existing
`delegate-wave serve` entry point in the same process. It MUST NOT instantiate a second scheduler
implementation.

**SUP-002** The task MUST run at interactive user logon with `InteractiveToken` and
`LeastPrivilege`. It MUST NOT request elevation.

**SUP-003** The task MUST refuse concurrent instances, have no execution-time limit, start when
available, retry abnormal failure a bounded five times at one-minute intervals, and have an
independent one-minute trigger. The periodic trigger MUST be harmless while the process is live and
MUST recover externally terminated instances that Windows does not classify for restart-on-failure.

**SUP-004** Task metadata, arguments, and temporary installation files MUST NOT contain Control API
credentials or credential environment-variable names. Persistent Windows user-environment variables
MUST NOT contain Control authority credentials after provisioning.

**SUP-005** Initial installation MUST encrypt Control credentials with Windows DPAPI scoped to the
current user before deleting their persistent user-environment values. Later installation MAY reuse
the existing protected bundle. Decryption MUST occur only inside the supervisor/operator/MCP process
that requires the corresponding credential.

## Authority and recovery

**SUP-006** Supervisor install, start, stop, status, and uninstall operations MUST remain explicit
local CLI operations. They MUST NOT be exposed through the Control API or Hermes MCP tools.

**SUP-007** Process start, death, restart, task deletion, and task status MUST NOT themselves cause a
job, attempt, validation, approval, or integration lifecycle transition.

**SUP-008** Restart recovery MUST rely on SQLite, Git, and deterministic reconciliation. It MUST NOT
consult an LLM.

**SUP-009** Removing the Windows task MUST NOT delete or mutate the managed data root, repositories,
worktrees, artifacts, or audit history.

**SUP-010** `supervisor stop` MUST disable future triggers before ending the current task instance.
`supervisor start` MUST enable the task before requesting a run. Unexpected death recovery MUST NOT
override an explicit operator stop. Stop MUST wait for the exact recorded task-process PID to exit
before reporting success, so an immediate start cannot race the old listener.

**SUP-011** DPAPI protection MUST NOT be represented as isolation from hostile code running as the
same Windows user. Untrusted validation requires a separate OS identity, container, or VM boundary.

## Traceability

| Normative rule | Enforced by | Tested by |
|---|---|---|
| SUP-001–003 | fixed task action and XML settings | task-definition conformance test; live restart dogfood |
| SUP-004–005 | generated XML, DPAPI store, and user-environment cleanup | secret-free XML and DPAPI provision/load tests |
| SUP-006 | CLI-only dynamic supervisor module; absent API/MCP routes | lifecycle command test and existing route allowlist tests |
| SUP-007–009 | supervisor has no dispatcher/storage imports or cleanup actions | static implementation review; live state comparison |
| SUP-010 | disable/end and enable/run ordering plus task-process PID receipt | lifecycle/PID-wait tests and live stop/start dogfood |
| SUP-011 | explicit documented execution-class limit | specification and operator-document review |

## Deferred

Windows service accounts, system-boot execution without an interactive login, remote supervision,
Credential Manager integration, and multi-user process ownership are outside this slice.
