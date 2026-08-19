# Dogfood run 4 — the report seam holds; two deeper defects surface

Job `job_d619fc7c-5981-4c99-8035-91fa2d4f7c9b`, 2026-08-19. Same project, same
objective as [run 3](DOGFOOD-RUN-3.md), read byte-for-byte out of run 3's ledger
row (1458 chars, unmodified). `--model gpt-5.5`. Base clean at `f48b834`.

This run did not finish either. It failed differently, which is the point.

## Run 4 against run 3

| | run 3 | run 4 |
|---|---|---|
| manager turns | 4 | 4 |
| **strong-manager tokens** | **77,613** | **81,495** |
| explorations commissioned | 8 | 7 |
| attempts | 8 SUCCEEDED | 1 SUCCEEDED, 2 FAILED |
| cheap spend | $0.0456 | $0.0060 |
| human interventions during the run | 0 | 0 |
| outcome | ESCALATE | budget-frozen |

## What the report fix bought

Confirmed in production. The one worker that started wrote a real
`result_text_artifact` and a `COMPLETE` receipt — 19,395 in / 2,233 out /
$0.006, `deepseek-direct-2026-08-14-v2`. The defect that cost run 3 its whole
exploration lane is fixed on the live path, not only in a fixture.

## Finding 1 — shared executor state cannot survive fan-out

Three OpenCode workers launched within 8ms of each other at 05:27:55. OpenCode
keeps one state database per user, at `~/.local/share/opencode/opencode.db`,
which had reached **717 MB**. One worker won the `PRAGMA journal_mode = WAL`
upgrade; two died on it, before any provider request.

delegate-wave's entire shape is to fan out several cheap workers at once. That
is incompatible with an executor holding one global mutable database, and the
contention window widens as that database grows.

Fixed by isolation rather than by throttling: each attempt now gets its own
`OPENCODE_DB` under the data root's scratch space. Serializing launches would
have traded away the parallelism that makes cheap workers worth having, in order
to accommodate state that was never meant to be shared. Verified against the
installed binary (opencode-ai 1.14.28) that `OPENCODE_DB` is honoured and that
it is honoured **only for absolute paths or `:memory:`** — a relative value is
silently ignored, which would have restored the shared database with no symptom
until two workers next collided.

The database is placed in scratch, not in the artifact directory (retained
evidence should not carry the executor's own machinery) and emphatically not in
the worktree, where it would enter the candidate diff.

## Finding 2 — UNKNOWN was carrying two different meanings

The two dead workers produced `status = UNKNOWN` usage receipts, correctly under
the semantics then in force. Those receipts are durable, so every subsequent
admission failed:

> *has 2 attempt(s) with unpriced usage, so spend against the 0.5 ceiling cannot
> be established*

The manager kept working — it commissioned four more investigations at 05:28:38
and 05:28:45 — and not one could be admitted. **Two workers that never reached a
provider permanently froze the family budget of a run that had already bought
81,495 strong-manager tokens.**

The reservation could not settle them. `service.js` documents that an admitted
attempt cannot be bounded — "an attempt admitted with $0.01 of headroom may spend
many times the ceiling before it exits" — so a reservation is authority, not a
provable upper bound, and cannot stand in for a measurement.

The corrected invariant:

> UNKNOWN = provider execution may have occurred, but usage cannot be
> established.
>
> A failure positively known to have happened before provider execution was
> possible must not poison the family budget.

`NO_PROVIDER_CONTACT` is deliberately hard to claim. Only an executor adapter may
assert it, from a signature in its own startup path; a nonzero exit, an empty
log, and a null exit code are each insufficient, and all three together are still
insufficient, because that is exactly what a worker that spent money and then
crashed before flushing looks like. The observation carries mandatory verbatim
evidence. Every number on the row is a derived zero rather than NULL — which is
what distinguishes it from UNKNOWN in the stored record — while `reported_*`
stays NULL, because the executor reported nothing and the zero is delegate-wave's
own finding.

Run 4's receipts were **not** rewritten. They were correct observations under the
old semantics and remain evidence. Migration 22→23 was verified against a copy of
the live database: 68 receipts preserved (58 COMPLETE, 7 PARTIAL, 3 UNKNOWN),
109 jobs, 102 attempts, reference-cost sum identical to eight decimal places, no
foreign-key violations, `integrity_check` ok.

## Finding 3 — strong-manager consumption tracks turns, not progress

Run 4 spent **more** strong tokens than run 3 (81,495 vs 77,613) while completing
one eighth of the cheap work and dying three rounds in. Both runs took 4 manager
turns at roughly 20k tokens each, of which 19,840 per turn is cache read.

Manager consumption is currently a function of turns and context size, not of
useful progress. The [run 3 record](DOGFOOD-RUN-3.md) noted that cheap-work
dollars are metered while strong tokens are not; run 4 shows the unmetered side
is also the one uncorrelated with output.

**Still not fixed, deliberately.** A brake introduced now would confound run 5,
which exists to establish what the manager does when the worker plane actually
functions. That measurement is the input to designing the brake.

## Test accounting

456 tests: 455 passed, 0 failed, 1 skipped. The skip is
`a symlink pointing out of the worktree is judged by its destination` in
`test/harness-fence.test.js`, whose stated reason is *"this environment does not
permit creating file symlinks"* — a Windows privilege constraint, not a disabled
assertion.

## Conditions for run 5

Unchanged objective, unchanged base, `--model gpt-5.5`, no manual repair, and run
4's reports are not fed forward. The experiment now reads:

```
run 3: report seam broken
run 4: report seam fixed; shared executor state and settlement semantics exposed
run 5: report seam fixed + isolated executor state + correct pre-provider settlement
```
