# Dogfood run 3 — a structurally doomed run, recorded before the rerun

Job `job_a76a88d1-bff7-4347-bea4-7f5d11c88b00`, 2026-08-18. Objective: build the
creator-facing dashboard in the Delegate Wave Backpack.

This run did not finish. It is recorded because two of its findings are about the
system rather than about the task, and one of them is not yet fixed.

## What happened

| | |
|---|---|
| manager turns | 4 (1 PLAN, 3 SYNTHESIS) |
| exploration rounds | 3 |
| investigations commissioned | 8 |
| investigations that SUCCEEDED | 8 |
| investigations whose report reached the manager | 0 |
| cheap jobs | 9 |
| cheap spend | $0.0328 |
| **strong-manager tokens** | **77,613** |
| candidates produced | 0 |
| human interventions during the run | 0 |
| outcome | ESCALATE |

The manager escalated asking for the contents of `package.json`,
`src/bridge/bridge.ts`, and the frontend entry files — the exact material eight
successful investigations had already produced and it had never been shown.

## Finding 1 — the report seam (fixed, `da26aeb` + `d6739af`)

`readFinalText` recognised only Harness's `assistant/message`. OpenCode writes
`type: "text"` with the payload under `part`. Every report was filtered out
before `result_text_artifact` was written, so eight successful investigations
arrived as UNKNOWN.

The EXPLORE lane had therefore never worked against a real OpenCode worker. Every
test used a Harness-shaped fake, so the fixture could not express the failure.
The fix's own first regression test had the same defect in miniature — it proved
`JSONL → readFinalText → string` while the failure spanned
`worker result → runJob → readFinalText → result_text_artifact → evidence pack →
SYNTHESIS prompt`. The production-path test now covers the whole seam and dies
under two independent mutations of the OpenCode parsing.

## Finding 2 — the scarce resource has no brake (NOT fixed, deliberately)

The `$0.50` family ceiling bounded cheap-worker dollars correctly and was never
close to binding: $0.0328 of $0.50.

**Cheap-work budget bounded correctly; strong-manager consumption was unbounded
and reached 77,613 tokens during a structurally doomed run.**

That is the wrong way round. This system exists to spend strong-model tokens
sparingly; the resource it actually meters is the abundant one. There is no
strong-manager quota authority, no per-run token ceiling, and no rule that stops
a run whose exploration rounds keep returning nothing.

Much of the 77,613 is explained by the missing reports — three exploration rounds
re-asked what had already been answered. That is why no brake is being built
before the rerun: adding one now changes the experiment and would confound the
only clean measurement available.

The rerun establishes what a *healthy* run costs. If a successful run still burns
50–80k strong tokens, the number is structural rather than incidental, and a
strong-side quota authority becomes a design requirement rather than a nicety.

## What this run does and does not prove

It does **not** satisfy PR #16's gate. No task completed end-to-end.

It does establish that the system **failed safely**, which is the property that
was expensive to build and cheap to lose:

- UNKNOWN stayed UNKNOWN. No report was invented to fill the gap.
- Synthesis told the manager plainly that its questions were unanswered.
- The manager escalated rather than implementing on guesswork.
- No candidate was fabricated; the integration gate never opened.
- The budget held; every spend was attributed.

A system that had guessed would have produced a confident, wrong dashboard and
consumed the review attention this architecture exists to conserve.

## Experiment conditions for run 4

- Same neutral Backpack base and the same objective, unmodified.
- The aborted manual UI attempt (`manual-ui-aborted`, one 36K bundle at
  `Papers/Backpack projects/_archive/`) is deleted. Workers here are not
  filesystem-sandboxed, and a worktree's `.git` file names its origin repository,
  so an adjacent bundle was reachable in principle.
- `--model gpt-5.5`. The installed codex-cli 0.125.0 cannot run `gpt-5.6-terra`.
  The CLI is deliberately **not** upgraded mid-experiment; recovering the intended
  model label is not worth adding a variable.
- No manual repair. If the run gets into trouble the ledger and artifacts are
  preserved, the defect is fixed deterministically, and a fresh job is started.
- The eight good reports from run 3 are **not** fed forward.

Compare run 4 against run 3 on strong tokens, exploration rounds, cheap jobs,
revisions, human interventions, and final semantic quality — not on whether the
dashboard happens to look good.

## Known adjacent variable, not acted on

`Papers/Backpack projects/As you Go/` is a working Backpack for a different
application, sitting beside the dogfood repository and reachable by the same
traversal. It is not a solution to this objective and the objective never
references it, but it is a shape reference a curious worker could read. It is the
operator's own project and was left in place; noted so the comparison is honest.
