# Windows Control API Supervisor — Normative Specification

Status: bootstrap slice

The supervisor supplies process availability only. It does not own scheduler truth and cannot
authorize or reconstruct domain state.

## Task boundary

**SUP-001** The Windows supervisor MUST run the existing `delegate-wave serve` entry point. It MUST
NOT instantiate a second scheduler implementation.

**SUP-002** The task MUST run at interactive user logon with `InteractiveToken` and
`LeastPrivilege`. It MUST NOT request elevation.

**SUP-003** The task MUST refuse concurrent instances, have no execution-time limit, start when
available, retry abnormal failure a bounded five times at one-minute intervals, and have an
independent one-minute trigger. The periodic trigger MUST be harmless while the process is live and
MUST recover externally terminated instances that Windows does not classify for restart-on-failure.

**SUP-004** Task metadata, arguments, and temporary installation files MUST NOT contain Control API
credentials or credential environment-variable names. Credentials MUST come from the Windows user
environment at process creation.

**SUP-005** Installation MUST fail before creating the task when the operator credential is absent
from the installing user's environment.

## Authority and recovery

**SUP-006** Supervisor install, start, stop, status, and uninstall operations MUST remain explicit
local CLI operations. They MUST NOT be exposed through the Control API or Hermes MCP tools.

**SUP-007** Process start, death, restart, task deletion, and task status MUST NOT themselves cause a
job, attempt, validation, approval, or integration lifecycle transition.

**SUP-008** Restart recovery MUST rely on SQLite, Git, and deterministic reconciliation. It MUST NOT
consult an LLM.

**SUP-009** Removing the Windows task MUST NOT delete or mutate the managed data root, repositories,
worktrees, artifacts, or audit history.

## Traceability

| Normative rule | Enforced by | Tested by |
|---|---|---|
| SUP-001–003 | fixed task action and XML settings | task-definition conformance test; live restart dogfood |
| SUP-004–005 | generated XML and pre-install credential check | secret-free XML/install and missing-token tests |
| SUP-006 | CLI-only dynamic supervisor module; absent API/MCP routes | lifecycle command test and existing route allowlist tests |
| SUP-007–009 | supervisor has no dispatcher/storage imports or cleanup actions | static implementation review; live state comparison |

## Deferred

Windows service accounts, system-boot execution without an interactive login, remote supervision,
credential provisioning, and multi-user process ownership are outside this slice.
