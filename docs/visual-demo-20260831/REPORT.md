# Original presentation regression rerun — evidence

Run submitted through a new physical Hermes desktop conversation on 2026-08-31
at 10:03:29.183 UTC. This is the original presentation workload rerun, not the
earlier RESULT.txt spine test, not an animation mock, and not a benchmark arm.

## Frozen environment and scope

- DW repository at run start: `c97937d0531bc3f7dd7857aea8e763ba8014aed4`.
- Supervisor runtime: `3911c27d9641565c99ec13f0ebecf412c1cc3333`, PID 9872.
- Dashboard interpreter PID 25712; MCP children 18672 and 15948 use Current/src/cli.js.
- Papers PID 10644 uses `--papers-data-dir=D:/Letters/MatTroiSeConMoc/Papers/Data`.
- Doctor healthy before launch; no restart, installation, source change or DB surgery.
- Operator provisioned `D:/Programs/evTEMP/dw-visual-demo-20260831` before delegation.
  This fresh path differs from the suggested original-name suffix. The original
  failed demo repo and sessions were not reused or overwritten.
- Registered project `dw-visual-demo-20260831-67840c`, protected package.json,
  validation stored as `["npm test"]`; baseline npm test passed.
- Baseline/main: `9135bb3d8982844bceb8e81282a51a7e4931a6cd`.
- MANUAL, maximum_cost 1.0; no integration or remote push authorized for the demo.
  Subsequent evidence-only commit/push is separate from the disposable repo.

## Identities

- Hermes conversation: `20260831_170329_5d10a3`.
- Hermes title: Run Backpack Delegate Wave MANUAL demo.
- DW session: `asess_568b38a2-9fa0-4b87-ad5d-9dfb6741a273`.
- Root: `job_a8708c35-db11-4d73-878f-6d7ab0f9b95e`.
- Explorer A: `job_c1f33c86-d015-4273-a1ae-3930c5500791.1`.
- Explorer B: `job_2a35b3ce-a848-43b9-8859-df2635cdb285.1`.
- Implementation: `job_a8708c35-db11-4d73-878f-6d7ab0f9b95e.1`.
- PLAN: `mturn_d704d204-a807-4fe3-8765-5282bbe6ab06` -> EXPLORE.
- SYNTHESIS: `mturn_e571869b-3946-454e-840d-ad7624793333` -> IMPLEMENT.

## Observed defects, not hidden by a successful candidate

1. **Manager path handoff mismatch.** Explorer A's generated instruction names
   the absolute original checkout/router.js. Explorer tools restrict external
   directory access; the executor runs in a DW worktree instead. Both explorers
   encountered denied original-checkout reads and recovered using their own
   worktrees. Explorer A spent additional effort checking provenance. This is
   not scheduler contention or the old service_tier bootstrap failure. Relative
   worktree paths plus explicit checkout identity would avoid this detour.
2. **Implementation role-confused narration.** The implementation worker's
   public text says it is dispatching Explorer A/B and commissioning one
   implementation worker. Those phases had already happened in the real manager
   path. These sentences are not evidence of additional real commissions.
   The unmodified full objective in its instructions repeats the manager-level
   sequence; the worker appears to reenact it instead of only performing its
   assigned implementation. Its transcript must not be treated as authoritative
   orchestration history.

## Concurrency and presentation evidence

Explorer A started 10:04:19.148 and finished 10:05:28.307 UTC (69.159 s).
Explorer B started 10:04:19.187 and finished 10:04:46.471 UTC (27.284 s).
Real overlap: **27.284 seconds**, starts separated by 39 ms. Both succeeded,
then SYNTHESIS completed before implementation started at 10:05:38.805 UTC.

Screenshots show real Papers content, full-width bounded expanded worker cards,
rich Markdown and internal scrollbars. They do not prove smooth frame-by-frame
or letter-by-letter animation. Live expanded cards were stacked, not side by
side; no captured screenshot proves both collapsed live workers side by side.
The user interacted with Papers during observation; some attempted UI scrolling
was refused due to intervening user input, and was not forced.

No follow-up prompt, session answer, manual tick, forced wake or cancellation
was used to advance the run. Read-only SQLite snapshots and viewing Papers are
observational, not control-path progress polling. No artificial sleeps or events
were introduced into the runtime.

## Result: partial regression, review escalated

The repository work itself succeeded:

- Implementation attempt ran 10:05:38.805–10:07:10.066 UTC (91.261 s).
- Candidate commit `2799378846726b8adfcefad818ff4a67fe9d9f18`, tree
  `f4040650b2273ec1ea3f7a333e83229ef41fc072`.
- Diff: one router lookup line changed and three assertions added; only
  `router.js` and `test.js` changed.
- Dispatcher validation `npm test` PASSED. Independent inspection in the
  preserved candidate worktree also passed.
- Base disposable repository remained on `9135bb3`; no staged integration row,
  integration, publication or remote exists.

However, REVIEW `mturn_c3495dc7-994b-4d96-b55f-9cd6767f06f8` truthfully chose
ESCALATE, not ACCEPT. It recognized that the worker report claimed its PLAN,
SYNTHESIS, REVIEW and child IDs were "emulated" and incorrectly claimed no
candidate commit existed. The authoritative dispatcher record contradicts the
worker on the latter: it created and retained commit `2799378`. The manager did
not accept fabricated genuine-session evidence or silently publish. Session
state is therefore `WAITING_FOR_HERMES`, not a settled accepted MANUAL candidate.

The distinct waiting wake `wake_b4f3021e-4161-4c38-ae86-06854de1d548` targeted
the originating Hermes conversation, was claimed and finished automatically,
and DW verified it DELIVERED. No `session_answer` was sent; the escalation is
left intact for review rather than being patched through prose.

Submission to REVIEW completion was 229.991 seconds; DW session creation to
REVIEW completion was 192.713 seconds. The requested natural path therefore
reached genuine PLAN -> concurrent EXPLORE -> SYNTHESIS -> IMPLEMENT ->
validation -> REVIEW, but failed the final ACCEPT/settled criterion.

## Usage and cost bases

Manager turns (gpt-5.6-luna) recorded 93,140 total tokens including cache and
reasoning, with reference costs $0.0058726 PLAN, $0.00222286 SYNTHESIS and
$0.0022412 REVIEW (`opencode-go-2026-08-20` v1; not provider billing).

Workers (opencode-go/deepseek-v4-flash), executor-computed / reference:

- Explorer A: input 8,816; output 5,718; cache read 36,096; five steps;
  $0.005966072 / $0.0029363488.
- Explorer B: input 6,891; output 2,205; cache read 32,768; five steps;
  $0.003200696 / $0.0016738904.
- Implementation: input 13,365; output 5,472; cache read 115,712; nine steps;
  $0.007361804 / $0.0037272536.

All three receipts are COMPLETE with zero malformed events. Worker reference
pricing is `deepseek-direct-2026-08-14-v2`; executor-computed values are not an
invoice. Hermes conversation accounting is subscription-included: input 41,948,
output 1,152, cache read 33,792, reasoning 72; actual billed cost is unknown.

## Final integrity

- DW repository source/runtime files remained unchanged from `c97937d`; only
  this evidence directory is added after the run.
- Papers, Hermes, Backpack and all other product repositories were not changed.
- Supervisor runtime remained `3911c27`; no process was restarted.
- Original failed session/repository evidence remained untouched.
- No product integration occurred. The later evidence commit/push documents the
  run and is not an integration or remote push of the disposable candidate.

## Evidence files

- `evidence.json`: scoped durable DW records and public Hermes transcript;
  hidden reasoning fields excluded.
- `exploration-live.png`: live bounded expanded exploration card.
- `explorers-expanded.png`: rich Markdown and internal transcript scrolling.
- `implementation-live.png`: genuine SYNTHESIS followed by one implementation.
- `implementation-narration.png`: role-confused worker narration retained.
The live review-escalation screenshot was observed but could not be saved after
the UI automation tool reached its usage limit. The authoritative REVIEW turn,
public response artifact, action and wake state remain in `evidence.json`.
