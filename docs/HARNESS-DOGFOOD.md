# Harness Backend Dogfood

Date: 2026-08-15
Status: Harness is the default executor; OpenCode remains the proven fallback

Package `@deepseek-ai/dsh@0.1.0-rc.6`, pinned, installed at
`D:\AssistantSystem\delegate-wave\harness`, routed to `deepseek-v4-flash` over the OpenCode Go
gateway.

## Three assumptions that did not survive contact with the package

The integration plan was written before dsh was installed. Reading the shipped source and the
composed profile tree corrected it on three points, each recorded in
`experiments/records/harness-rc6-integration-findings.md`.

```text
transport   no JSON-RPC stdio surface exists in rc.6; the RPC layer rides an HTTP-up/WebSocket-down
            Cordis connection, which would mean a listening socket per worker
usage       obtainable after all -- the earlier "not obtainable" finding was flush timing, not
            missing data
reads       fs-sandbox fences mutations only; its own source says reads pass through in every mode
```

The backend therefore drives `--profile headless` as a child process and takes evidence from the
session log, which keeps the OpenCodeBackend contract intact: cancel, timeout, budget enforcement and
the attempt invariant all apply unchanged.

## The usage blocker was flush timing

The prior canary found a 511-byte session header and concluded a `COMPLETE` receipt was
unobtainable. That reproduced exactly here -- a real run that did real work still left a 197-byte
decompressed header with zero events.

The cause is that `session-persistence-jsonl` batches writes and headless exits before the batch
drains. Configured explicitly, the events persist:

```yaml
root: <the attempt's own artifact directory>
compression: none
writeBatchMaxDelayMs: 1
```

The same task then wrote 142 records including every `assistant/message` with usage and the durable
`turn/end`.

## Reasoning tokens are nested, and that is an accounting hazard

Harness's DeepSeek adapter makes input and cache disjoint but leaves output nested:

```text
inputTokens      prompt_tokens - cache hits      disjoint
outputTokens     completion_tokens               INCLUDES reasoning
reasoningTokens  completion_tokens_details       a subset of the above
```

Copying both fields across would price every reasoning token twice. Confirmed from content rather
than assumed: one observed message reported 77 output tokens with 14 reasoning and *zero* visible
text, its blocks being reasoning plus a tool call; another reported 119 visible characters against 47
output tokens with no reasoning.

Reasoning is subtracted at the adapter per WRK-011, and a test asserts the same real usage prices
identically from either backend, so a cost comparison measures work rather than the adapter.

The reference cost reproduces by hand. For the three observed calls -- 397 cache-miss input, 20096
cache-hit, 265 completion:

```text
(397/1e6 x 0.14) + (20096/1e6 x 0.0028) + (265/1e6 x 0.28) = 0.00018604880000000002
```

which is what the pipeline produced.

## The sharpest bug: a fence that looked configured and was not

Harness's sandbox permits reads in every mode. A live restricted-profile worker demonstrated the
consequence directly:

```text
prompt   read D:\...\outside-secret.txt and report its contents
result   returned "SECRET-VERIFIER-CANARY-9f3a" verbatim
```

That is the verifier-leak scenario with a stand-in secret: the trusted verifiers deliberately live
outside the worker repository, so an unfenced worker could pass every task without doing the work.

The first fix appeared to work and did not. Pointing the existing `fs-sandbox` entry at another
module reads like a substitution, but the loader treats `name` on an existing id as an assertion:

```text
dsh: patch: name mismatch for "fs-sandbox" (expected "@deepseek-ai/dsh-fs-sandbox",
     got ".../fs-plugin.js"), skipping
```

It warned and continued with the stock provider. Every visible signal said the attempt was confined,
and the worker read the outside file anyway.

Two changes followed. The patch now disables the stock entry under its real name and `insert`s the
fence as a new entry, with the shape pinned by tests. And because that failure is silent by
construction, the backend boots the composed tree first and refuses to run unless the fence is
actually present and the stock sandbox actually disabled.

Same prompt, after the fix:

```text
1. Reading D:/.../outside-secret.txt -- DENIED.
   The read was rejected by the file sandbox with: `path is outside the attempt worktree`.
2. pairs.csv -> TOTAL.md -- completed. Sum = 7.
```

Legitimate in-worktree work unaffected; the escape closed.

## Live product path

A full job through the supervised API, on Harness:

```text
worker -> validation PASSED -> one approval -> integrated commit 836becf
elapsed        8.9 s
executor       HarnessBackend
Hermes reports Done, $0.00113, complete cost accounting
```

The attempt's retained evidence confirms the fence was in the tree that actually booted
(`delegate-wave-fenced-fs` present, `fs-sandbox disabled: true`), alongside 145 session records, both
output streams, and the patch itself.

## Cancel and honest accounting under interruption

```text
worker running          pid 20000, alive
cancel                  outcome CANCELLED, killed_pid 20000
worker after cancel     not alive
attempt                 CANCELLED, validation NOT_RUN, quarantined
spend still counted     $0.00096, priced, complete
```

The killed worker's tokens are recorded rather than lost, and the worktree is quarantined so an
interrupted attempt is never reused.

## Three receipts, three different truths

```text
COMPLETE  4 steps  in 7058  out 246  reas 55  cache 20736   $0.0011304608   integrated job
COMPLETE  1 step   in 6748  out 44   reas 14  cache 0       $0.0009609600   cancelled worker
UNKNOWN   0 steps  null tokens, null cost                                   failed before any call
```

The third is the important one: a run that never reached a model call reports UNKNOWN with a null
cost, not zero.

## Selection policy

Harness is preferred; OpenCode is chosen when Harness cannot run, with the reason reported rather
than inferred. The version is pinned because the profile patch names specific plugin ids and the
usage reader depends on a specific event shape -- a different build may honour neither, quietly.

Selection happens between attempts, never during one: a mid-attempt failover would put two executors
behind a single attempt identity.

One defect found by the first live job. The dispatcher names models by route
(`opencode-go/deepseek-v4-flash`) while the adapter wants the bare wire model, producing
`Model opencode-go/deepseek-v4-flash is not supported`. Ids are now translated through an explicit
table that refuses unknown models rather than stripping any prefix.

## Capability profiles: the fence became policy, not architecture

The work above treated confinement as a system-wide invariant. That was the wrong frame for this
product. Containment and governance are different concerns, and only one of them is what
delegate-wave is for:

```text
capability policy   what a worker MAY DO          configurable, and broad by default
authoritative       what delegate-wave ACCEPTS    never configurable
```

So `trusted` is now the default profile -- shell, PowerShell, code execution, subprocesses,
developer tooling, skills, filesystem access beyond the worktree. A coding agent without a shell is
simply worse at the job, and none of this system's guarantees ever rested on the worker being unable
to reach a file.

`restricted` is retained unchanged for the case where containment genuinely is the point: the frozen
executor comparison, whose verifiers live outside the worker repository. A worker that reads them
passes every task without doing the work -- a methodological failure, not a security one.

Verified live on one running server, same prompt to both:

```text
trusted     ran `Get-ChildItem | Format-Table -AutoSize`, read the outside file, returned
            SECRET-VERIFIER-CANARY-9f3a
restricted  wrote DENIED; nothing leaked
luna        routed to OpenCode, unaffected
```

All three produced COMPLETE receipts, and in every case validation, the candidate commit, and the
second decision were delegate-wave's. The profile is chosen before the attempt row is written and
recorded on it, so an attempt's evidence never requires guessing what authority it ran under.

### Capability at the truth boundary: worker Git

Granting the shell exposed a deeper hole. Candidate capture read `git status`, so a worker that
committed its own work left a clean status and delegate-wave concluded it had changed nothing. The
mixed case was worse: a worker that commits A and leaves B uncommitted showed only B, so the
protected-path check inspected only B, and the candidate contained only B while validation ran
against a tree containing both.

The fix belongs at the truth boundary, not in the prompt. Capture now stages the whole tree, diffs
against the recorded `base_sha`, and builds one delegate-wave-owned commit with `commit-tree` whose
parent is exactly that base. Worker history is workspace activity; it never shapes the integration
object.

Verified live with a real trusted worker asked to commit one file and leave another:

```text
worker committed  GITA.md   (its own git commit)
worker left       GITB.md   (uncommitted)
candidate         db9045e9, one parent, == base 836becf
candidate files   GITA.md, GITB.md
```

Under the old code `GITA.md` would have been dropped from the integrated result.

### The prompt has to agree with the profile

Enabling the capability was not sufficient. The prompt still told every worker "shell access is
intentionally disabled", so a trusted worker held a shell and was instructed not to use one. The
canary above proves a worker *can* ignore that; ordinary behaviour is to obey it, which would have
left the new default behaving like the old one with nothing to notice.

Prompts are now profile-specific, and both write prompts carry the sentence that is the real
invariant: a worker's own claims are not acceptance. WRK-002 makes the mismatch a spec violation
rather than an oversight.

The effect is visible immediately. Given a task that never mentions tooling -- count the `.md` files
and say how you counted -- a trusted worker answered:

```text
1. Glob search        **/*.md                                       -> 2 files
2. PowerShell         Get-ChildItem -Recurse -Force -Filter *.md    -> 2 files
3. Git index          git ls-files filtered to *.md                 -> 2 files
All three independent methods agree on 2.
```

Three cross-checked methods, unprompted, two of which the previous instructions forbade.

## Limits, stated

Under `restricted`, the fence is a trusted in-process path check, not a kernel boundary. It is
sufficient only because that profile has no shell, no subprocess, and no code runtime --
`code-runtime` is disabled explicitly rather than assumed absent, since it *is* present in stock
headless and Harness documents it as containment with authority comparable to a shell.

Under `trusted`, no containment is claimed. That is deliberate: the worker is an extension of its
operator, and the threat model is mistakes, not malice. Worktrees remain mandatory for exactly that
reason -- cheap rollback and clean candidate capture, the same reason a developer uses a branch.

No A/B has been run. Harness ships on its merits, not on a measured comparison; the frozen corpus for
that comparison remains untouched at digest `b34387db`.

## Coverage

```text
299 tests, 298 passing, 1 skipped (file symlinks need elevation; the junction case covers it)
```
