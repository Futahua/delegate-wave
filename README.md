# delegate-wave

A personal dispatcher that turns "change this" into reviewed, validated, integrated work done by
inexpensive coding models, on one Windows machine, for one person.

You talk to Hermes. Hermes proposes bounded work. You authorize once. Cheap workers do it,
deterministic validation checks it, and one approval integrates it. Hermes tells you what changed and
what it cost.

## The loop

```text
you              "add a totals file to the report project"
Hermes           proposes bounded work, with a cost ceiling and an expiry
you              authorize once            <- decision 1
delegate-wave    runs a worker in an isolated worktree
                 runs your validation commands
                 proposes an integration
you              approve once              <- decision 2
delegate-wave    integrates, compare-and-swap
Hermes           "Done. TOTAL.md added, commit fbd66a3, about $0.0008."
```

Two decisions. Everything between them is mechanical, and nothing consequential happens without one
of them.

## What holds

- **SQLite and Git are the truth.** A worker's claim of success is an observation, never authority.
- **Validation decides.** An executor exiting zero proves nothing; your commands do.
- **One attempt, one identity, one epoch.** A late callback from a killed worker cannot mutate state.
- **Integration is compare-and-swap.** It refuses when the branch moved underneath it.
- **Cost is honest.** Unmeasured usage is `UNKNOWN`, never zero, and unmeasured spend blocks a budget
  rather than passing it.
- **Hermes can propose, never approve.** Its credential holds `read + propose` and nothing else.

## Install

Requires Node 24+, Git, and an OpenCode installation with a configured provider.

```bash
npm install -g .
```

Set up the managed data root and the Control API credentials once:

```bash
$env:DELEGATE_WAVE_CONTROL_TOKEN = '<generate a long random secret>'
$env:DELEGATE_WAVE_CONTROL_OBSERVER_TOKEN = '<a different secret>'
delegate-wave supervisor install
```

That seals both credentials into a current-user DPAPI store, removes them from your persistent
environment, and installs a least-privilege Windows logon task that keeps the Control API running.

To let Hermes propose work, add the third credential:

```bash
$env:DELEGATE_WAVE_CONTROL_PROPOSER_TOKEN = '<a third secret>'
delegate-wave supervisor add-role --role proposer
delegate-wave supervisor stop; delegate-wave supervisor start
```

Until that record exists, Hermes is read-only.

## Everyday use

```bash
delegate-wave status                      # working / needs a decision / ready to check / done
delegate-wave proposal list               # what Hermes has proposed
delegate-wave proposal authorize --proposal ID   # decision 1: runs the work
delegate-wave integration approve --proposal ID  # decision 2: integrates it
```

Through Hermes, the same thing is one tool call: `get_status`, then `propose_work`.

## When something goes wrong

```bash
delegate-wave doctor                      # is the installation healthy
delegate-wave reconcile --apply           # resolve abandoned attempts after a crash
delegate-wave job cancel --job ID         # stop a running job
delegate-wave backup create               # snapshot the operational database
delegate-wave backup list
delegate-wave integration rollback --proposal ID   # put an integrated branch back
```

None of these require touching SQLite or Git by hand. Rollback is compare-and-swap and refuses if
something else moved the branch.

## Registering a project

```bash
delegate-wave project add --name my-project --path D:\code\my-project \
  --branch integration \
  --validate "npm test" \
  --protect .github --protect package-lock.json
```

`--validate` commands are what actually decide whether a candidate is acceptable. `--protect` paths
reject any candidate that touches them.

## Models

Routing is explicit, not automatic:

```text
opencode-go/deepseek-v4-flash   ordinary work, the default
opencode-go/gpt-5.6-luna        focused review and debugging
opencode-go/deepseek-v4-pro     hard implementation escalation
```

Pass `--model` to `job run` to choose. A job that names no model resolves to Flash before the attempt
is created, so an executor's ambient default is never used.

## Limits worth knowing

- One machine, one user, one integration branch, serial integration.
- Workers get read and edit inside their attempt worktree, and nothing else: no shell, no network, no
  access outside the worktree. That fence is a trusted in-process boundary, not a kernel one; it is
  sufficient only because workers cannot execute code.
- DPAPI protects credentials at rest. It is not a sandbox against code running as the same Windows
  user.
- Integration never runs through your working checkout.
