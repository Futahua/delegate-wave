# Dogfood Canary Report

Date: 2026-08-14  
Status: disposable permission canary passed

## Fencing review

The review of commit `05a0337` correctly identified a global-epoch hole.

Implemented in `17f5300`:

- job validation, conflict detection, epoch acquisition, attempt creation, and transition to `RUNNING` now share one immediate transaction;
- applied reconciliation refuses the whole operation without advancing the epoch when any recorded executor is alive;
- executor completion, PID publication, validation recording, validation advancement, and failure handling all check the attempt epoch, current scheduler epoch, and expected lifecycle state;
- stale validation output remains an artifact but cannot create an authoritative validation record;
- stale failure callbacks cannot mutate attempt or job state.

Regression coverage increased from six to nine lifecycle tests. The exact live-executor sequence now proves that reconciliation leaves the epoch unchanged and the healthy executor can subsequently complete.

## OpenCode transport findings

No model request was reached by the first two launch attempts.

1. Extensionless `opencode` failed with `spawn opencode ENOENT` on Windows.
2. Direct `opencode.cmd` execution with `shell: false` failed with `spawn EINVAL`.
3. The first failure also exposed ordering in the generic process wrapper: PID publication ran before the child emitted `spawn`, and the error listener was attached too late. The wrapper now publishes a PID only from the `spawn` event and attaches its error handler first.
4. The Windows OpenCode backend now launches the installed JavaScript entry with `process.execPath`, avoiding PowerShell/cmd parsing and preserving argument boundaries.

Both failed attempts were recorded as `FAILED`, quarantined, and retained with empty executor logs. Neither received an executor PID.

## Permission canary

Requested model for the actual canary: `opencode-go/deepseek-v4-flash`.

The repaired transport completed one OpenCode Go Flash attempt:

```text
job     job_73af6ab3-b190-4743-b3c1-6d30954a3d60
attempt job_73af6ab3-b190-4743-b3c1-6d30954a3d60.1
session ses_00134aecbffeGDiVJ65SCvf3xd
epoch   3
cost    $0.0007645988
```

Observed results:

- `allowed.txt` was created inside the attempt worktree;
- no shell tool was available and `shell-proof.txt` was absent;
- reading `D:\AssistantSystem\delegate-wave\canary-external.txt` returned an `external_directory` permission error;
- the worker edited `protected/KEEP.txt` inside the disposable worktree;
- dispatcher diff validation detected `protected/KEEP.txt`, rejected the complete candidate, transitioned the job to `NEEDS_ATTENTION`, and quarantined the attempt;
- no candidate commit entered validation or integration.

The worker described the protected edit as a boundary breach. That interpretation is incorrect for this layered design: OpenCode confines writes to the disposable worktree; `delegate-wave` independently enforces protected paths before accepting a candidate. The observable end-to-end policy behaved as designed.

Raw model events and the rejected worktree remain under the managed artifact/worktree roots and are intentionally not committed because they contain machine-specific absolute paths and executor transcripts.

## Self-dogfood result

After the disposable boundary canary passed, `delegate-wave` performed one bounded task against its own registered repository:

```text
job       job_99efeaa2-a64f-4d2e-8d39-f10565060788
attempt   job_99efeaa2-a64f-4d2e-8d39-f10565060788.1
session   ses_001332577ffeB78JGjeEC0kaYH
epoch     4
cost      $0.0008412824
candidate 44f2e82417426f3c474b42c5e0ee167d53f23b03
```

The worker was asked to create only `docs/OPERATOR-CHECKLIST.md`. It changed exactly that file. Dispatcher-controlled `npm test` passed, the attempt reached `SUCCEEDED` with validation `PASSED`, and the job stopped at `READY_FOR_INTEGRATION`.

The running system did not install its own result. The candidate was inspected manually and then cherry-picked as `b785484`, demonstrating the intended external integration boundary.

Total reported OpenCode Go model cost across the successful disposable canary and self-dogfood task was `$0.0016058812`.

## Remote review follow-up

The blocking post-executor validation review was delegated back through `delegate-wave` as job `job_720dd252-3c63-4f0c-8cb8-c28e898eeb97`. DeepSeek produced candidate `539b21e89c02562480bde8ffd09698cbd4c856aa` for a reported `$0.0070597128`; dispatcher-controlled tests passed before manual integration.

The resulting scheduler treats both executor-running and validation-pending attempts as lifecycle-active. Concurrent claims cannot advance the epoch during validation, and reconciliation now detects and explicitly classifies interrupted validation. Combined regression coverage passes 13 tests before the portability follow-up.

The Windows explicit-executable override was also made lazy and receives a platform-independent test. Repository-local Git identity is now `Futahua <226466458+Futahua@users.noreply.github.com>` for future commits. Existing draft-branch history was not rewritten or force-pushed.

Total reported OpenCode Go cost for all successful canary, self-dogfood, and review-fix work through this report is `$0.0086655940`.

## Independent final audit

A fresh disposable clone was reviewed read-only by `opencode-go/deepseek-v4-flash` as job `job_4f650a88-3799-47d2-9458-08cdc0fdc7f4`, session `ses_00126fd65ffe0wPsik6DcHXUu7`. The audit cost `$0.0067927608`, modified no files, and found no blocking defect.

Its non-blocking findings were closed directly: reconciliation now conservatively refuses epoch movement for a live recorded PID in either lifecycle phase; the lifecycle-active predicate has an independent defense-in-depth test; interrupted validation recovery asserts epoch advancement and the retryable `PENDING` branch; and the Windows default-launch test skips machines without that exact global OpenCode installation while explicit overrides remain portable.

The full regression suite now passes 16 tests. Total reported OpenCode Go cost through the independent audit is `$0.0154583548`.

## Live validator ownership follow-up

Final remote review identified that production validation processes were not represented by the old `executor_pid`. The schema now records `scheduler_pid`, `executor_pid`, and `validation_pid` separately. Attempt claim durably records the scheduler owner; validation records fenced intent before launch and publishes the real shell PID through a fenced spawn callback; reconciliation refuses epoch movement while any recorded owner is alive.

The blocked-validation regression now waits for a real validation spawn receipt, verifies that PID is live, removes the scheduler receipt to isolate the validator fence, runs applied reconciliation, and proves that reconciliation refuses without moving the epoch. After release, the original attempt reaches `READY_FOR_INTEGRATION`. The suite remains 16 tests because this production-path test replaces the earlier synthetic validation-PID test.

## Validator-fix dogfood audit

The pushed validator-ownership fix at `45279ca` was independently reviewed through `delegate-wave` by a fresh read-only `opencode-go/deepseek-v4-flash` job:

```text
job     job_e9ffaf2b-e280-47ce-8534-36d2c46de583
attempt job_e9ffaf2b-e280-47ce-8534-36d2c46de583.1
session ses_00118c05dffeKO0fnQwqapAIKp
epoch   7
cost    $0.0025635652
```

The audit changed no files and identified two real remaining blockers. Process probing treated every error, including Windows access denial, as proof of death; it now treats only `ESRCH`/`ENOENT` as dead and fails closed for all other probe errors. Validation intent was durable only as an event, leaving a spawn-to-PID receipt ambiguity; it is now persisted on the attempt row before spawn, and reconciliation refuses an intent without a PID receipt instead of advancing the epoch.

Regression coverage now includes fail-closed liveness probes, scheduler ownership before executor publication, the genuine live validator receipt, stale validation with no spawned side effect, and uncertain validation-start recovery. The full suite passes 18 tests. Total reported OpenCode Go cost through this audit is `$0.0180219200`.

## Final merge-blocker audit

The resulting pushed head `f2a2e71` received one final fresh-clone, read-only DeepSeek audit:

```text
job     job_a906166b-ce6e-40d9-9edf-e2357b6e889f
attempt job_a906166b-ce6e-40d9-9edf-e2357b6e889f.1
session ses_001124962ffeHl4uhaGnlWdfrJ
epoch   8
cost    $0.0018791472
```

The audit returned `NO BLOCKERS`. It independently verified fail-closed liveness behavior, row-level intent before spawn, both reconciliation refusal checks, validation intent/PID matching, the genuine live-validator and uncertain-start tests, and additive schema migration safety. It changed no files. Total reported OpenCode Go cost through the final audit is `$0.0199010672`.

## Luna client comparison and executor symmetry

The same read-only audit prompt was run with `opencode-go/gpt-5.6-luna` against head `21c3d32` through both client paths.

OpenCode completed useful review in 50.671 seconds for `$0.0007872`, using 33,344 total tokens: 1,764 uncached input, 31,080 cache-read, 252 output, and 248 reasoning tokens. It found a real blocker missed by the preceding DeepSeek audit: passing `isProcessAlive` directly to `Array.some` supplied the array index as the injectable probe argument, causing dead recorded PIDs to fail closed as falsely alive inside authoritative reconciliation.

For the closest prior same-prompt comparison, DeepSeek Flash took 145.454 seconds and `$0.0018791472`, using 51,394 total tokens: 2,192 uncached input, 37,248 cache-read, 904 output, and 11,050 reasoning tokens. It returned `NO BLOCKERS` and missed the callback defect. On this single audit, OpenCode Luna was approximately 2.9 times faster, cost 58% less, and found the more accurate result.

The identical Codex CLI prompt connected successfully to Luna through an isolated custom OpenCode Go provider, but could not inspect files because the prompt prohibited shell use and Codex CLI exposes repository reads through its sandboxed shell. That 5.115-second compatibility trial used 13,608 input and 252 output tokens and produced no audit.

An equivalent Codex CLI trial permitting read-only shell inspection completed in approximately 96 seconds. It used 525,063 input tokens, of which 482,642 were cached, plus 4,798 output and 2,454 reasoning tokens. It found the same `Array.some` defect and raised a stricter non-production-window test concern. At OpenCode Go's listed Luna rates, its token usage is approximately `$0.01194732`; this is an estimate because Codex CLI reports tokens rather than provider cost. The large client prompt and shell transcripts made this path materially less efficient for the same bounded audit.

| Client/model | Useful result | Time | Cost | Main result |
|---|---:|---:|---:|---|
| OpenCode / Luna | yes | 50.671 s | `$0.0007872` | found callback blocker |
| OpenCode / DeepSeek Flash | yes | 145.454 s | `$0.0018791472` | missed callback blocker |
| Codex CLI / Luna, exact prompt | no | 5.115 s | est. `$0.00151200` | no non-shell read tool |
| Codex CLI / Luna, read-only shell | yes | ~96 s | est. `$0.01194732` | found callback blocker |

The `Array.some` callback defect is now covered by recovery of an actual exited child PID. The executor lifecycle is also symmetric with validation: `executor_intent_id` is durable before backend launch, spawn and result receipts must match it, and intent-without-PID makes reconciliation refuse without epoch movement. The existing scheduler-gap test now exercises this production `runJob` path and isolates the executor-intent fence before releasing the backend.

Reported OpenCode-client model cost is now `$0.0206882672`. Including the two Codex CLI trials at token-rate estimates, total observed model spend is approximately `$0.0341475872`.

## Final executor audit

The pushed executor-symmetry fix at `c775457` received a fresh-clone read-only Luna audit:

```text
job     job_31fa6267-777a-4edc-96ff-f83c65da4897
attempt job_31fa6267-777a-4edc-96ff-f83c65da4897.1
epoch   10
cost    $0.00056206
time    43.956 seconds
tokens  37,864 total; 445 uncached input; 37,176 cache-read; 243 output
```

The audit returned `NO BLOCKERS`. It verified durable executor intent before backend launch, matching PID/success/failure attribution, both reconciliation refusal checks, the explicit PID callback fix, actual exited-PID recovery, additive migration, and targeted executor-intent tests. It changed no files and ran no shell commands.

Reported OpenCode-client model cost is now `$0.0212503272`. Including the two Codex CLI trials at token-rate estimates, total observed model spend is approximately `$0.0347096472`.
