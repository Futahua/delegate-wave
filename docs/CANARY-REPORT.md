# Dogfood Canary Report

Date: 2026-08-14  
Status: in progress

## Fencing review

The review of commit `05a0337` correctly identified a global-epoch hole.

Implemented in `17f5300`:

- job validation, conflict detection, epoch acquisition, attempt creation, and transition to `RUNNING` now share one immediate transaction;
- applied reconciliation refuses the whole operation without advancing the epoch when any recorded executor is alive;
- executor completion, PID publication, validation recording, validation advancement, and failure handling all check the attempt epoch, current scheduler epoch, and expected lifecycle state;
- stale validation output remains an artifact but cannot create an authoritative validation record;
- stale failure callbacks cannot mutate attempt or job state.

Regression coverage increased from six to nine lifecycle tests. The exact live-executor sequence now proves that reconciliation leaves the epoch unchanged and the healthy executor can subsequently complete.

## OpenCode transport findings

No model request was reached by the first two launch attempts.

1. Extensionless `opencode` failed with `spawn opencode ENOENT` on Windows.
2. Direct `opencode.cmd` execution with `shell: false` failed with `spawn EINVAL`.
3. The first failure also exposed ordering in the generic process wrapper: PID publication ran before the child emitted `spawn`, and the error listener was attached too late. The wrapper now publishes a PID only from the `spawn` event and attaches its error handler first.
4. The Windows OpenCode backend now launches the installed JavaScript entry with `process.execPath`, avoiding PowerShell/cmd parsing and preserving argument boundaries.

Both failed attempts were recorded as `FAILED`, quarantined, and retained with empty executor logs. Neither received an executor PID.

## Permission canary

Requested model for the actual canary: `opencode-go/deepseek-v4-flash`.

The paid permission canary has not yet started successfully. Permission behavior therefore remains configured but empirically unproven until the repaired Node-entry transport completes one attempt.

The intended single-call probe is:

- ordinary edit inside the attempt worktree: allowed;
- protected-path edit: worker may propose it, dispatcher must reject the candidate;
- shell execution: denied by OpenCode policy;
- external absolute read: denied by OpenCode policy.
