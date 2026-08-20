# Dogfood runs 6 and 7 — the loop stops being the problem

Same objective throughout, read byte-for-byte from the previous run's ledger row
(1458 chars). `--model gpt-5.5`, `opencode-go/deepseek-v4-flash` workers,
`max_attempts: 2` (revision cap 1, derived), ceiling $0.50, base `f48b834`.

| | run 3 | run 4 | run 5 | run 6 | run 7 |
|---|---|---|---|---|---|
| manager turns | 4 | 4 | 6 | 4 | **3** |
| strong tokens | 77,613 | 81,495 | 159,725 | 92,413 | **74,128** |
| per turn | 19,403 | 20,374 | 26,621 | 23,103 | 24,709 |
| exploration rounds | 3 | 3 | 3 | 1 | **1** |
| attempts | 8 ok | 1 ok, 2 fail | 6 ok | 3 ok, 2 fail | **4 ok** |
| reports captured | 0/8 | 1/3 | 4/6 | 3/5 | **4/4** |
| cheap spend | $0.0328 | $0.0034 | $0.0625 | $0.0405 | $0.0414 |
| candidate | no | no | 2 | no | **1** |
| validation reached | no | no | ran, failed | **never** | **ran** |

## Run 6 — the unsatisfiable brief

Job `job_91ee2d6f-eb16-4e11-9230-803bab5badd5`.

Both implementation attempts finished with `reason: "length"`, zero output
tokens, no tool call in the truncated step, and **zero changed files in either
worktree**. Not tool-call truncation and not simple runaway reasoning: the
worker tried to call `bash`, was refused —

> `Model tried to call unavailable tool 'bash'. Available tools: invalid, read,
> glob, grep, edit, write, todowrite.`

— and then reasoned to exactly its 32,000-token cap. `write` and `edit` were
available the entire time and it never attempted either.

It was obeying an impossible instruction. The manager's brief said *"run npm ci
if needed before build/test"* with acceptance *"npm run build succeeds"* and
*"npm test succeeds"*. The worker had no shell.

Two causes, both delegate-wave's:

1. The manager was never told what the worker could do. Fixed in `7459848` by
   sending the capability envelope as evidence — deliberately not as a rule in
   the standing instructions, since it is not an invariant: the Harness
   `trusted` profile has a shell and the OpenCode reader does not.
2. The evidence pack rendered the validation plan **joined with `&&`** — a shell
   command line nothing anywhere runs. Run 5's manager read it as one and
   concluded *"the harness used an invalid PowerShell command with && before npm
   ran"*, spending two revisions on a build no worker could attempt. That
   complaint was an accurate reading of a fiction delegate-wave supplied.

`5a4211f` then gave implementation workers a shell, matching the Harness path
whose default profile is `trusted` for the stated reason that *"denying a coding
agent a shell makes it worse at its job"*. The investigator keeps its denial.

Run 6's real result: **fixing the worker plane cut strong consumption 42%
(159,725 → 92,413) without touching the manager**, because truthful worker
evidence collapsed exploration from three rounds to one.

## Run 7 — validation runs; two defects of mine remain

Job `job_ae4a233b-3905-4909-97ed-9bc2619b7b81`. Four operational deltas plus one
environmental condition (starting at 98% weekly quota — a change in
circumstances, not in software).

**All four attempts succeeded with reports captured.** The implementation
produced a real candidate: `src/App.tsx`, `src/main.tsx`, `src/normalize.ts`,
`src/relay.ts`, `src/styles.css`, `test/normalize.test.ts`.

**Validation executed on the production path for the first time**, and
`afeba64`'s distinction worked exactly as designed: `npm ci` was recorded
`CHECK_FAILED exit=1`, not `CHECK_DID_NOT_RUN`. The command really did run and
really did fail.

It failed on a defect in that same commit:

> `'C:\Program' is not recognized as an internal or external command`

`npm` resolves to `C:\Program Files\nodejs\npm.CMD`. cmd re-parses everything
after `/c` and split it on the first space. This was the `cmd.exe` caveat raised
in review, which was set aside on the grounds that run 7's four commands would
not exercise it — and it was exercised immediately, not by metacharacters but by
a space in a path. Fixed in `bfa5519`. The earlier claim that `/d /s /c` removed
cmd grammar entirely was too strong; the quoting narrows what cmd interprets, it
does not eliminate it.

Then the manager, shown a truncated diff and that failed check, answered:

> *"The diff view is explicitly truncated and the deterministic checks did not
> actually validate the candidate because npm ci failed from an environment
> quoting issue. I cannot accept or revise based on a partial diff…"*

It diagnosed delegate-wave's own bug from the validation log and refused to judge
on insufficient evidence. Correct instinct — but it chose EXPLORE, which a REVIEW
turn does not accept, and the run ended. Nothing had ever told it the phase-to-
action mapping. Fixed in `6c23244`, which also names RETHINK as the route it
actually wanted and states that refusing to judge on thin evidence is correct, so
the lesson taken is not "accept on partial evidence".

### Shell egress after `5a4211f`

`external_directory: deny` is a per-tool permission and does not fence a
subprocess, so a shell-enabled worker can leave its worktree. Checked: **one
shell invocation across all four attempts** — `git status && git log --oneline
-5` — inside the worktree, nothing flagged. No experimental contamination.

## Where the cost actually goes

Cache read grows monotonically with turn index and is indifferent to phase; fresh
input is phase-dependent, with PLAN and REVIEW an order of magnitude above
SYNTHESIS. Run 7's three turns: 6,528 → 17,792 → 21,888 cache, against 12,097 /
5,679 / 10,088 fresh. Marginal manager cost rises through accumulated context and
again through candidate-bearing REVIEW prompts.

Quota remains unmeasurable at this granularity. `usedPercent` reported 98 across
every sample of both runs, on a 10,080-minute window with 1% resolution: a 74,128
token run did not move it. That is below measurement resolution, **not** evidence
of zero consumption.

## What is left

The orchestration loop is no longer the constraint. Every defect in runs 6 and 7
was a truthfulness or contract defect in delegate-wave's own execution layer, and
each was found by the system reporting honestly rather than by inspection.
Remaining: a run that carries a candidate through validation to a manager
decision on real evidence.
