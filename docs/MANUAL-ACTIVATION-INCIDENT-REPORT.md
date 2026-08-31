# First manual Hermes activation incident

Date: 2026-08-31

Scope: four Hermes-created autonomous sessions used to prepare and run the first manually activated Delegate Wave presentation demo

Evidence: `docs/MANUAL-ACTIVATION-INCIDENT-EVIDENCE.md`

## Executive summary

The primary failure was in the initiating Hermes session, not a spontaneous Delegate Wave failure. Hermes session `20260831_105217_d7f17f` received one request to create and run one disposable demonstration. It instead used a repository-scoped Delegate Wave session to perform control-plane setup, started the demo before that setup session settled, attempted to direct queued child jobs through prose replies, and launched a third recovery session through the same occupied scheduler. The resulting four Delegate Wave sessions overlapped and interfered with one another.

The presentation demo never executed. Hermes' orchestration produced a disposable repository, two logical registrations for the same Windows path, an unrelated accepted candidate in `driver-probe`, nine zero-attempt child jobs, and several contradictory terminal states. No demo explorer, implementation worker, or validator ran.

The physical product repositories were not changed. The disposable repository remains clean at `d833095855c0618b2bc1f5bd32434a5314d17b0e`, and the physical `driver-probe` checkout remains clean at `c166e7f74c2e03757996507d26059a398b25be37`. The accepted setup candidate nevertheless contains an out-of-scope `inspect.js` commit and remains `READY_FOR_INTEGRATION`; it must not be integrated.

## Root causal chain: Hermes orchestration

Hermes reports 193 current messages and 104 tool calls; the database preserves 380 message rows including archived pre-compaction originals and compressed duplicates. The sanitized transcript is [manual-activation-hermes-transcript.json](manual-activation-hermes-transcript.json). Its sequence establishes the causal chain:

1. Hermes selected `driver-probe-d3e3f1` as a host for operational setup even though the requested output belonged entirely outside that repository.
2. After the first configuration failure, Hermes reran the same architecture instead of changing the execution method.
3. Hermes began setup session `asess_95bc...` at `03:57:25Z` and repeatedly polled it.
4. At `04:02:44Z`, while setup attempt 2 was still running and before setup was accepted, Hermes started demo session `asess_17c...` against the newly created but malformed registration.
5. Hermes watched the demo create six zero-attempt exploration jobs while the setup worker held execution capacity.
6. Hermes tried to control scheduler behavior through `session_answer` prose naming particular child jobs, although that interface answers manager questions and does not directly dispatch arbitrary jobs.
7. At `04:06:29Z`, with setup attempt 3 still active, Hermes created recovery session `asess_63ce...` through `driver-probe`, adding another managed workflow to the same congested scheduler.
8. Hermes later told the demo to settle failed, but `session_answer` returned `WORKING`; Hermes polled once and then stopped, leaving the session waiting.
9. Hermes' final user report claimed no worker wrote to another product repository, even though the authoritative setup candidate diff contained `inspect.js` in driver-probe. The physical checkout was clean only because the candidate was not integrated.

Delegate Wave has real defects exposed by this sequence, especially non-idempotent exploration commissioning and inconsistent cleanup. They are contributing causes. The initiating cause was Hermes using Delegate Wave as both the workload under demonstration and the mechanism for constructing, repairing, supervising, and diagnosing that workload concurrently.

This is an incident-level causal assessment, not a completed source-code diagnosis of every subsystem. The transcript does not prove that Hermes had a usable direct shell or project-registration mutation tool. Its reported capability gap should have caused a narrow setup blocker, not selection of an unrelated repository to obtain a worker. The upstream Codex handoff also contributed: it prescribed a 60–90-second real multi-agent demonstration, repository provisioning, and desktop preflight without verifying that Hermes exposed the required operational capabilities. Those assumptions must be corrected along with Hermes' execution decisions.

Hermes had loaded `managed-repository-delegation`, whose evidence workflow explicitly required terminal evidence before claiming creation or scope compliance. It then repeatedly polled, read raw activity artifacts, and began dependent work without a terminal setup result. A diagnostic `delegate_task` call at `03:59:52Z` to parse a spillover file failed with HTTP 429 and returned no usable analysis. The final report disclosed that failure, but the extra diagnostic delegation did not resolve the setup gate.

The archive also records a backend-interruption resume message and later transcript compaction. These are confirmed context discontinuities; this audit has not established that either caused the scheduling failures. Raw archived rows are retained so reviewers can distinguish original observations from lossy compaction placeholders.

## Sessions

| Session | Job | Final session state | Job state | Result |
| --- | --- | --- | --- | --- |
| `asess_dd8a54fc-5d24-4e49-a9e6-8caa7bf72ffc` | `job_db5fc7f9-443b-41bd-8f2c-b0733bd6433e` | `FAILED` | `PENDING` | Manager configuration rejected `service_tier = "default"`; no attempt started, but the job was left pending. |
| `asess_95bc02c3-9661-42e5-8600-4fca856b36f8` | `job_8b4749b6-7b72-4da7-a956-6daa967887a2` | `SEMANTICALLY_ACCEPTED` | `READY_FOR_INTEGRATION` | External setup mostly completed, but the accepted driver-probe candidate contains unrelated `inspect.js`; registration was repaired by duplicating a case-variant path. |
| `asess_17c5b717-84a4-4b22-a075-dfe0901ebe8e` | `job_f2739b79-a4f3-4328-98ce-94f751cd0489` | `WAITING_FOR_HERMES` | `NEEDS_ATTENTION` | Intended demo. Six exploration jobs were created and none acquired an attempt. No implementation or validation occurred. |
| `asess_63ce4989-066b-4dd7-9b0f-5f7f32fa3eff` | `job_1b6c3b12-6ea9-42e1-af71-872b742ba9ed` | `FAILED` | `PENDING` | Recovery was launched while another attempt held the bootstrap scheduler. Three child jobs received no attempts. |

## Findings

### 1. Hermes chose the wrong execution boundary

Hermes chose `session_start(project_id = driver-probe-d3e3f1)` for an objective that created and registered a repository outside the assigned worktree. Delegate Wave therefore classified the first externally successful attempt as failed because it changed no assigned-worktree files. Those external side effects survived the failure and were repeated by later attempts.

The system needs either a first-class operational/control-plane job type or an explicit refusal to run external orchestration as a repository candidate.

### 2. Bootstrap failure left contradictory durable state

The first session failed before its manager started because Codex rejected `service_tier = "default"`. Its parent job remained `PENDING`. Session bootstrap must either preflight before durable job creation or terminally close the job when manager startup fails.

### 3. CLI argument handling silently weakened validation

The initial registration stored `validation_json = ["npm"]` after the worker supplied an unquoted multiword command. The CLI accepted the extra token instead of rejecting ambiguous input. Multiword validation commands need lossless parsing or a hard error on trailing arguments.

### 4. Windows path identity was not canonicalized

The retired registration uses `D:\Programs\evTEMP\backpack-live-animation-demo`; its replacement uses `d:\Programs\evTEMP\backpack-live-animation-demo`. SQLite treated them as different unique strings although they resolve to the same Windows directory. Project identity must use a canonical, case-insensitive Windows path key.

### 5. Hermes started the demo before setup settled

Setup attempt 2 ran from `04:02:15Z` to `04:04:38Z`. Hermes called `session_start` for the demo at `04:02:44Z`. It therefore targeted a registration that was malformed and then retired while the demo was active. Hermes should have required a settled setup result and re-read the authoritative project record before starting the demo.

### 6. Pending explorations consumed rounds without running

The demo manager created pairs at `04:02:57Z`, `04:03:04Z`, and `04:03:11Z`. All six jobs remained `PENDING` with zero attempts. Each manager tick treated absent reports as grounds to spend another exploration round instead of waiting for already-created work.

An exploration round must remain active while any commissioned child is queued or running. Repeated ticks must be idempotent and must not create a new pair.

### 7. Global scheduler contention was discovered too late

The setup session occupied execution while the demo and recovery sessions continued creating work. Admission should expose queued capacity before manager turns are consumed. A blocked queue must not look like six failed dispatches.

### 8. Hermes used advisory replies as scheduler commands

Hermes instructed the demo to execute two specific existing jobs and later to settle as failed. `session_answer` is an answer to a manager escalation, not a direct child-job dispatch or terminal-state API. The manager could not force execution of the named jobs, and the terminal instruction was not applied. At `04:10:06Z`, after the settle-failed reply, the manager escalated again and remained `WAITING_FOR_HERMES`.

Terminal Hermes decisions need explicit typed actions, not prose that a later manager turn may reinterpret.

### 9. Hermes launched recovery through the congested scheduler

Hermes called `session_start` on `driver-probe` for a one-record control-plane recovery while setup attempt 3 was live. The recovery manager created three zero-attempt exploration jobs and failed because that setup attempt owned the scheduler. Moreover, restoring the requested retired project would have restored the malformed `npm` validation.

### 10. Candidate review accepted contradictory evidence

Setup attempts 2 and 3 each committed the same unrelated `inspect.js` to a driver-probe candidate. Attempt 3 was accepted even though the review input showed that diff, the objective prohibited touching driver-probe, and no deterministic checks were configured. The reviewer incorrectly used absence from a different exploration worktree as evidence that the candidate did not contain the file.

Candidate review must treat the recorded candidate diff as authoritative and reject any file outside the allowed change set.

### 11. Validation was attached to the wrong repository

The setup job reported `validation_state = PASSED`, but driver-probe had no deterministic checks. This proved nothing about the disposable repository or its `npm test`. External worker testimony was treated as if it were durable validation evidence.

### 12. Backpack did not receive a real live-animation workload

The intended demo produced no attempts, worker narration, implementation diff, test run, or validation run. Visible live activity belonged to setup/revision work, which did produce worker transcripts. This invalidates the intended demonstration, but does not explain or excuse the reported whole-text popping in those setup transcripts. Incremental delivery and animation require a separate renderer/transport investigation; these session records alone cannot determine that cause.

## Required engineering actions

1. Teach the Hermes Delegate Wave integration to serialize dependent session creation and require terminal, verified setup before starting dependent work.
2. Prevent Hermes from using repository jobs for control-plane setup/recovery, or add a dedicated operational API for those actions.
3. Make autonomous-session creation atomic with manager bootstrap failure handling.
4. Canonicalize Windows repository paths before uniqueness checks.
5. Reject ambiguous CLI trailing arguments for `--validate`.
6. Make exploration commissioning idempotent while child jobs are queued or running.
7. Represent scheduler capacity and queueing explicitly to managers and Hermes.
8. Introduce typed wait, dispatch, cancel, and settle-failed operations instead of overloading `session_answer` prose.
9. Reject candidates whose authoritative diff violates the allowed file set, regardless of worker testimony.
10. Bind validation evidence to the repository and commit actually being accepted.
11. Add cleanup/reconciliation for failed sessions whose parent or child jobs remain pending without attempts.
12. Require Hermes final reports to reconcile claims against authoritative candidate diffs and session states.

## Regression scenarios

- Manager bootstrap fails after job creation: both session and job reach consistent terminal states.
- Two ticks while an exploration pair is queued: still exactly two child jobs and one exploration round.
- Windows registrations differing only in drive-letter or path casing: second registration is rejected as the same repository.
- Multiword validation passed without correct quoting: command is preserved exactly or rejected, never truncated.
- Hermes issues settle-failed: the next durable state is terminal and no later manager turn runs.
- Candidate changes a forbidden file while claiming an external-only result: review rejects it from authoritative diff evidence.
- Operational setup produces only external side effects: it is not evaluated as a repository candidate.

## Current disposition

At evidence capture time, `doctor` reported healthy and no attempts were running. The database still retained the contradictory pending/attention records described above. This report performs no cleanup; preserving the incident state is intentional for review.
