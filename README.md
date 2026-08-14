# delegate-wave

`delegate-wave` is a small deterministic dispatcher for bounded coding jobs. SQLite owns operational state, Git owns candidate code, and OpenCode sessions are disposable executors.

This bootstrap release deliberately **does not integrate candidate commits automatically**. A successful write job stops at `READY_FOR_INTEGRATION` so a human or Codex can inspect it first.

## Requirements

- Node.js 24 or newer
- Git
- OpenCode configured with the desired provider/model

No npm dependencies are required.

## Quick start

```powershell
cd 'D:\Letters\MatTroiSeConMoc\delegate-wave'
npm link
delegate-wave init

delegate-wave project add `
  --name Backpack `
  --path 'D:\Projects\Backpack' `
  --validate 'npm test' `
  --protect '.github/**' `
  --protect 'production/**'

delegate-wave project list
delegate-wave job create --project <project-id> --goal 'Fix the export bug'
delegate-wave job run --job <job-id> --model <provider/model>
delegate-wave job status --job <job-id>
delegate-wave doctor
delegate-wave reconcile          # preview only
delegate-wave reconcile --apply  # fence and orphan dead executors
```

The managed data root defaults to `D:\AssistantSystem\delegate-wave` on Windows. Override it for testing with `DELEGATE_WAVE_DATA_ROOT`.

## Current safety boundary

The OpenCode worker receives runtime permissions that allow reading and editing only inside its attempt worktree. Shell commands, external directories, web access, skills, questions, and subagents are denied. Validation commands are registered by the human when adding the project and are run by the dispatcher after the worker exits.

Attempts are isolated as locked, detached Git worktrees. Failed attempts are marked quarantined in SQLite and retained for inspection. Two failures stop the job at `NEEDS_ATTENTION` by default.

`doctor` checks SQLite integrity, missing repositories, and lifecycle-active attempts. `reconcile` is read-only unless `--apply` is supplied. Applied reconciliation starts a new fencing epoch only after proving that recorded scheduler, executor, and validator processes are dead; an uncertain executor or validator start fails closed for operator attention.

## Not implemented yet

- automatic or approved integration
- semantic escalation across jobs
- persistent OpenCode server lifecycle
- Control API, MCP, Hermes, or T3 adapters
- policy receipts and capability management

Those remain outside the trusted bootstrap rather than being represented as finished.

The implemented normative rules and traceability table are in [docs/BOOTSTRAP-SPEC.md](docs/BOOTSTRAP-SPEC.md).
