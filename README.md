# delegate-wave

`delegate-wave` is a small deterministic dispatcher for bounded coding jobs. SQLite owns operational state, Git owns candidate code, and OpenCode sessions are disposable executors.

A successful write job stops at `READY_FOR_INTEGRATION` so a human or Codex can inspect it first. The approved-integration slice then lets an operator propose the candidate, grant an exact-digest approval, and run an integration that cherry-picks the candidate onto the integration branch in a disposable worktree. Integration is never automatic: a human must grant the approval.

## Requirements

- Node.js 24 or newer
- Git
- OpenCode configured with the desired provider/model

No npm dependencies are required.

## Quick start

```powershell
cd 'D:\Letters\MatTroiSeConMoc\delegate-wave'
npm link
$env:DELEGATE_WAVE_CONTROL_TOKEN = '<generate-a-local-secret>'
$env:DELEGATE_WAVE_CONTROL_PRINCIPAL = '<your-local-principal>'
delegate-wave serve
```

Keep that foreground server running. In another terminal, set the same token and use the CLI:

```powershell
$env:DELEGATE_WAVE_CONTROL_TOKEN = '<same-local-secret>'
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

delegate-wave integration propose --job <job-id>
delegate-wave approval grant --proposal <proposal-id> [--maximum-cost <amount>]
delegate-wave integration run --proposal <proposal-id>

delegate-wave doctor
delegate-wave reconcile          # preview only
delegate-wave reconcile --apply  # fence and orphan dead executors
```

Mutating commands accept `--request-id <id>` for exact transport retries; otherwise the CLI generates one. The server—not CLI arguments—binds approval identity and the `local-cli` origin. The managed data root defaults to `D:\AssistantSystem\delegate-wave` on Windows. Override it on the server for testing with `DELEGATE_WAVE_DATA_ROOT`.

## Current safety boundary

The OpenCode worker receives runtime permissions that allow reading and editing only inside its attempt worktree. Shell commands, external directories, web access, skills, questions, and subagents are denied. Validation commands are registered by the human when adding the project and are run by the dispatcher after the worker exits.

Attempts are isolated as locked, detached Git worktrees. Failed attempts are marked quarantined in SQLite and retained for inspection. Two failures stop the job at `NEEDS_ATTENTION` by default.

The CLI is now strictly a Control API client. It does not open SQLite, instantiate the dispatcher, or execute a worker itself. If the local server is unavailable it fails closed. Mutating requests have durable immutable intent/result receipts, so duplicate, concurrent, disconnected, and post-restart retries cannot silently repeat a side effect.

`doctor` checks SQLite integrity, missing repositories, lifecycle-active attempts, and integration operations without immutable terminal records. An unresolved integration makes health false. `reconcile` is read-only unless `--apply` is supplied. Applied reconciliation starts a new fencing epoch only after proving that recorded scheduler, executor, and validator processes are dead; an uncertain executor or validator start fails closed for operator attention.

## Not implemented yet

- automatic integration (approved integration is intentionally explicit)
- semantic escalation across jobs
- persistent OpenCode server lifecycle
- MCP, Hermes, or T3 adapters
- policy receipts and capability management

Those remain outside the trusted bootstrap rather than being represented as finished.

The implemented normative rules and traceability tables are in [docs/BOOTSTRAP-SPEC.md](docs/BOOTSTRAP-SPEC.md), [docs/APPROVED-INTEGRATION-SPEC.md](docs/APPROVED-INTEGRATION-SPEC.md), and [docs/CONTROL-API-SPEC.md](docs/CONTROL-API-SPEC.md). PR #4 worker costs and review evidence are recorded in [docs/CONTROL-API-DOGFOOD.md](docs/CONTROL-API-DOGFOOD.md).
