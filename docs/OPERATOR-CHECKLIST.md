# delegate-wave Operator Checklist (Windows)

Concise daily operating checklist. Shell access is out of scope; run every command in PowerShell.

## 1. Init

```powershell
npm link
delegate-wave init
```

Data root defaults to `D:\AssistantSystem\delegate-wave`. Override for a scratch run with `$env:DELEGATE_WAVE_DATA_ROOT = 'D:\path\wave-test'`.

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

## 6. Reconcile preview

```powershell
delegate-wave reconcile       # read-only preview
delegate-wave reconcile --apply   # only after reviewing the preview
```

Applied reconciliation starts a new fencing epoch only after proving recorded scheduler, executor, and validator processes are dead. An uncertain executor or validator start fails closed for operator attention instead of being guessed dead.

## 7. READY_FOR_INTEGRATION requires manual review

A successful write job stops at `READY_FOR_INTEGRATION` and is **never** integrated automatically. A human or Codex must inspect the candidate commit, create an integration proposal, and grant an exact approval receipt. Run `delegate-wave integration run --proposal <id>` only after approval; the dispatcher uses its managed detached worktree and compare-and-swap rather than modifying the user's checkout.
