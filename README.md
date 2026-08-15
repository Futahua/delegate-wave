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

## The idea

**Agents are trusted operators, not trusted authorities.**

Workers are extensions of you, so they get broad machine capability: shell, code execution, package
managers, developer tooling, the filesystem. Denying a coding agent a shell just makes it worse at
the job, and this system's value never rested on the worker being unable to reach a file.

What is governed is not what a worker may *do* but what becomes *true*.

```text
worker says "tests passed"        != validation passed
worker writes a file              != delegate-wave state changed
worker commits something          != integrated
worker moves a ref                != authoritative integration
worker says "$0"                  != cost evidence
worker edits delegate-wave itself != a new version is installed
```

Capability is broad by default. Permanence is governed.

## What holds

- **SQLite and Git are the truth.** A worker's claim of success is an observation, never authority.
- **The candidate is captured, not claimed.** Workers may use Git freely, including local commits;
  delegate-wave compares the resulting tree to the recorded base and builds its own single candidate
  commit. Worker history never becomes the integration object.
- **Validation decides.** An executor exiting zero proves nothing; your commands do.
- **One attempt, one identity, one epoch.** A late callback from a killed worker cannot mutate state.
- **Integration is compare-and-swap.** It refuses when the branch moved underneath it.
- **Cost is honest.** Unmeasured usage is `UNKNOWN`, never zero, and unmeasured spend blocks a budget
  rather than passing it.
- **Hermes can propose, never approve.** Its credential holds `read + propose` and nothing else.
- **Every attempt gets a disposable worktree.** Not to contain a hostile worker -- for recoverability
  and clean candidate capture, the same reason you use a branch despite trusting yourself.

## Executors

```text
opencode-go/deepseek-v4-flash   ordinary work        -> Harness
opencode-go/deepseek-v4-pro     escalation           -> Harness
opencode-go/gpt-5.6-luna        review and debugging -> OpenCode
```

Harness is preferred for the models its DeepSeek adapter can run; the review lane belongs to OpenCode
by design, and OpenCode is also the fallback whenever Harness is unavailable. The executor is chosen
per attempt, before it starts, and recorded on the attempt.

### Capability profiles

```text
trusted     default. Shell, PowerShell, code execution, subprocesses, developer tooling,
            skills, and filesystem access beyond the worktree.
restricted  attempt-root filesystem fence; no shell, code runtime, or skills. For work against
            something you do not trust, and for experiments with hidden verifiers.
```

Request the narrow one per job with `--capability-profile restricted`. Neither profile changes who
computes the Git diff, who runs validation, what counts as cost evidence, or what may be integrated.

## Install

Requires Node 24+, Git, and an OpenCode installation with a configured provider.

```bash
npm install -g .
```

Install the pinned Harness build into the managed data root:

```bash
npm --prefix D:\AssistantSystem\delegate-wave\harness install @deepseek-ai/dsh@0.1.0-rc.6
```

The version is pinned deliberately: the profile patch names specific plugin ids and the usage reader
depends on a specific event shape. A different build may honour neither, so a mismatch falls back to
OpenCode rather than running on assumptions.

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

Finally, seal the model-provider key the workers use:

```bash
$env:DELEGATE_WAVE_EXECUTOR_API_KEY = '<your provider key>'
delegate-wave supervisor add-role --role executor
delegate-wave supervisor stop; delegate-wave supervisor start
```

It is stored as its own scoped record, and scrubbed from inherited child environments: a worker
receives it only because a backend passed it deliberately for that one attempt. Without it, Harness
cannot run and every job falls back to OpenCode.

## Everyday use

```bash
delegate-wave status                      # working / needs a decision / ready to check / done / reverted
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
delegate-wave backup create --label before-upgrade
delegate-wave backup list
delegate-wave backup restore --backup DIR         # database AND every repository head
delegate-wave backup restore --backup DIR --database-only
delegate-wave integration rollback --proposal ID  # put an integrated branch back
delegate-wave restore resolve             # clear an unresolved restore once repos are reconciled
```

None of these require touching SQLite or Git by hand. Rollback is compare-and-swap and refuses if
something else moved the branch.

A default restore is all-or-nothing: it checks every recorded repository head first and refuses
before touching the database if any cannot be returned, so you keep an untouched system and a clear
reason instead of a half-applied recovery. `--database-only` restores operational truth alone and is
explicitly incoherent, because you asked for that. In the rare case a repository fails *during* a
restore, the system stays unhealthy until `restore resolve` -- it will not quietly decide the two
truths agree again.

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
- Under the default `trusted` profile, workers have broad machine access and **no containment is
  claimed**. That is deliberate: they are extensions of you, and the threat model is mistakes, not
  malice. The disposable worktree is what makes a mistake cheap to undo.
- Under `restricted`, the fence is a trusted in-process boundary, not a kernel one. It is sufficient
  only because that profile has no shell, subprocess, or code runtime. Real isolation would need a
  separate OS identity, a container, or a VM.
- DPAPI protects credentials at rest. It is not a sandbox against code running as the same Windows
  user.
- Integration never runs through your working checkout.
