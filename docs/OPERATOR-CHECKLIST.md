# delegate-wave Operator Checklist (Windows)

Concise daily operating checklist. Shell access is out of scope; run every command in PowerShell.

## 1. Init

```powershell
npm link
$env:DELEGATE_WAVE_CONTROL_TOKEN = '<generate-a-local-secret>'
$env:DELEGATE_WAVE_CONTROL_PRINCIPAL = '<your-local-principal>'
delegate-wave serve
```

For normal reboot-surviving operation, ensure the same values are stored in the Windows user
environment, stop the foreground server, and run:

```powershell
delegate-wave supervisor install
delegate-wave supervisor start
delegate-wave supervisor status
```

The task runs only in the interactive user's least-privilege session, starts at logon, refuses
duplicate instances, and checks once per minute that an instance can run. It also requests five
one-minute retries for failures that Windows classifies as abnormal. Its task XML does not contain
credentials. `delegate-wave serve` remains useful for foreground diagnosis.

In a client terminal:

```powershell
$env:DELEGATE_WAVE_CONTROL_TOKEN = '<same-local-secret>'
delegate-wave init
```

Data root defaults to `D:\AssistantSystem\delegate-wave`. Set `DELEGATE_WAVE_DATA_ROOT` on the server for a scratch run. CLI mutations print their request ID before sending. If a failure says the outcome may be uncertain, rerun the exact command with the printed `--request-id`; do not issue a fresh request.

## 2. Register a project

```powershell
delegate-wave project add `
  --name Backpack `
  --path 'D:\Projects\Backpack' `
  --validate 'npm test' `
  --protect '.github/**' `
  --protect 'production/**'

delegate-wave project list
```

Validation commands run under dispatcher control after the worker exits; register only trusted, reproducible commands.

## 3. Run one cheap job (OpenCode Go Flash)

```powershell
delegate-wave job create --project <project-id> --goal 'Fix the export bug'
delegate-wave job run --job <job-id> --model opencode-go/deepseek-v4-flash
```

The worker may read/edit only inside its attempt worktree. Two failures stop the job at `NEEDS_ATTENTION` by default.

## 4. Inspect status

```powershell
delegate-wave job status --job <job-id>
delegate-wave job list --project <project-id>
```

## 5. Doctor

```powershell
delegate-wave doctor
```

Checks SQLite integrity, missing repositories, and nonterminal attempts. Investigate any `error` or `warning` before proceeding.

If the Control API is unavailable, CLI commands fail. Do not bypass the API by editing SQLite or invoking dispatcher internals.

If the supervised API does not return after logon:

```powershell
delegate-wave supervisor status
delegate-wave supervisor start
```

Task installation, stopping, and removal are explicit local operator actions and are not exposed to
Hermes or the Control API.

## 6. Reconcile preview

```powershell
delegate-wave reconcile       # read-only preview
delegate-wave reconcile --apply   # only after reviewing the preview
```

Applied reconciliation starts a new fencing epoch only after proving recorded scheduler, executor, and validator processes are dead. An uncertain executor or validator start fails closed for operator attention instead of being guessed dead.

## 7. READY_FOR_INTEGRATION requires manual review

A successful write job stops at `READY_FOR_INTEGRATION` and is **never** integrated automatically. A human or Codex must inspect the candidate commit, create an integration proposal, and grant an exact approval receipt. Run `delegate-wave integration run --proposal <id>` only after approval; the dispatcher uses its managed detached worktree and compare-and-swap rather than modifying the user's checkout.
