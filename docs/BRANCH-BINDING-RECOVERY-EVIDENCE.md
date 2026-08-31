# Branch binding and validator contract — recovery run evidence — 2026-08-31

Evidence for two correctness fixes and the real task that exercised them end to end.
Every number below was read back from the operational database or from Git after the
fact, not from a tool's own report of itself.

## What was wrong

Two independent defects, found by one failed session.

**1. Autonomous sessions could not say which branch they were for.** `session_start`
carried no ref. `AutonomousSessionService.start()` called `createJob()`, and a root
`createJob()` always resolved `project.integration_branch`. A session asked for
`codex/live-work-ui` was rooted on `main`, and `session_answer` could only record
clarification prose — it could not move `jobs.base_sha`. The session then spent money
and produced apparently valid evidence against a world nobody had selected.

The original session is preserved as a witness, and it states the defect in one row:

    job_288d515c-0dfa-4abb-9a5c-184796c6b881
      goal text  "... branch codex/live-work-ui, starting head f0839192847..."
      base_sha   f48b8346fa290fb27e526de1d02e08a2ef5f2001   (main)
      state      NEEDS_ATTENTION / session WAITING_FOR_HERMES

**2. The Backpack's validation contract contradicted itself.** The registered plan ran
`npm run build`, which was `tsc --noEmit && vite build` with `outDir: 'public'` and
`emptyOutDir: true`, and then asserted `git diff --exit-code -- public`. The build
regenerated the tracked runtime assets and the next command condemned it for doing
exactly what it is configured to do. Any UI source change failed validation on
principle. That is what the original session failed on, three times.

## What changed

    delegate-wave           d0239b6  bind autonomous sessions to an immutable branch and base
    delegate-wave           ea5bbff  bind a root job to a local branch, not any resolvable revision
    delegate-wave-backpack  3cf40ba  separate bundle verification from public/ deployment

`d0239b6` adds structured `branch` / `expected_base_sha` to `session_start`, records
`jobs.target_branch`, makes children inherit branch and base, and routes every
branch-sensitive read through the job's binding rather than the project default —
including `SafeIntegrator.prepare()`, which still resolved `project.integration_branch`
and would have published a correctly bound session's work onto the wrong branch. The
column is backfilled explicitly by `migrate()` (schema 37); no read site has a fallback.

`ea5bbff` closes a narrower hole: `resolveRevision()` accepts anything `rev-parse`
accepts, so a tag or bare sha could bind and later be republished as
`refs/heads/<sha>`. Root binding now resolves under `refs/heads/` specifically.

`3cf40ba` redefines what `npm run build` means rather than adding a new script name,
so the already-registered validation plan becomes coherent without a control-plane
change — there is no supported `project.update` for a stored command list.

    build         typecheck + production bundle into an ignored .verify-dist/
    build:public  regenerate the Papers-served public/

`public/` is generated build output that is also the live runtime surface: Papers serves
that subtree directly and rereads it on entry. So verification and deployment cannot be
the same command.

## Deployment evidence

    supervisor      stopped and started via the supported commands
                    old PID 51892 (17:53:11, pre-fix code)
                    new PID 33564 (21:11:50, ea5bbff)
    doctor          healthy, integrity ok, no running attempts,
                    no missing repositories, no unresolved integrations
    schema_version  36 -> 37
    backup          backups/2026-08-31T14-11-39-219Z-pre-schema-37-branch-binding
                    taken at schema 36 before the migration

Migration backfilled 257 historical jobs with zero NULLs remaining, using each job's own
project's registered branch rather than a blanket value:

    main 154 | integration 61 | workspace 34 | agent/fencing-canary 5
    ab/deepseek 2 | ab/luna 1

The witness job took `target_branch = main` and kept `base_sha = f48b8346...`
unchanged. The migration recorded history rather than rewriting it.

Both Hermes stacks were restarted so the MCP children would reload. The desktop app was
closed through its main window, not killed. Four stale MCP children (18672, 15948,
23948, 41840, all spawned before the fix) were replaced by 24284 and 32244 at 21:30.
The live `session_start` schema exposes `branch` and `expected_base_sha`.

The Papers-bound Backpack checkout was fast-forwarded `f083919 -> 3cf40ba`. Its
`public` tree object hash was `d1edf39aa1a6d33f91148bfad7742cc9aa769617` before and
after, so the served surface is byte-identical and `build:public` was not run.

## The recovery run

The same task that failed before, on a correctly bound session.

    session   asess_cf49f553-2fd1-48f4-982e-ee25abb5cfa4   MANUAL
    root      job_a39196f0-231f-46a0-8abe-bf530a182f8d
    project   delegate-wave-backpack-b2f046
    bound to  codex/live-work-ui @ 3cf40bafeca8035875ce6bf7a22441633faab137
    manager   gpt-5.6-luna | workers opencode-go/deepseek-v4-flash
    window    14:59:58Z -> 15:13:17Z
    cost      0.073213 reference USD across 5 usage receipts

Manager turns:

    1  PLAN       COMPLETED  EXPLORE
    2  SYNTHESIS  COMPLETED  IMPLEMENT
    3  REVIEW     COMPLETED  REVISE   subject .1
    4  REVIEW     COMPLETED  ACCEPT   subject .2

    ACCEPTED | explore 1/3 | revision 1/2 | no escalation | no stop code

Exploration children, all inheriting branch and base, all read-only:

    job_1f0dcd6c...  attempt ...70ceaefc83cd.1  SUCCEEDED  PASSED  0 files
    job_f4f2260a...  attempt ...8ebaef621128.1  SUCCEEDED  PASSED  0 files
    job_e87a5060...  attempt ...eeec88a69763.1  SUCCEEDED  PASSED  0 files

Implementation attempts, both exactly in scope:

    .1  2193545949abfc954f9af148dc4eb501baed84fa  start 3cf40baf...
    .2  c667a4eb5f5a64255c5ac8554c3a3efbb5da7dfa  start 2193545949ab...  ACCEPTED

    src/timeline/SessionTimeline.tsx
    src/ui/styles.css
    test/session-timeline.behavior.test.tsx

Validation, both attempts, every command:

    npm ci                            exit=0  PASSED
    npm run build                     exit=0  PASSED   -> .verify-dist/
    git diff --exit-code -- public    exit=0  PASSED
    npm test                          exit=0  PASSED

The third line is the point. It is the exact command that failed the original session
three times, and it now passes twice on the same real task.

Final state and publication:

    session                SEMANTICALLY_ACCEPTED
    root                   READY_FOR_INTEGRATION
    integration_proposals  0
    staged_integrations    0
    branch head            3cf40baf...  unmoved
    candidate vs base      3 files, +49 -6, public/ diff empty
    wake_e9c7cf6d...       reason=READY  state=DELIVERED  attempts=1  no error

The wake delivered on the first attempt while the dashboard reported
`Gateway Status: Stopped`, confirming that routed delivery uses the durable
external-turn inbox rather than that gateway.

## What this does and does not prove

Proven: a session binds to a requested branch, children inherit it, worker worktrees are
cut from it, and the corrected validator contract lets a real UI source change pass.
The three exploration children are the first meaningful runtime boundary the old code
would have crossed wrongly, and they crossed it correctly.

Not proven: publication. No integration proposal or staged integration exists, the
branch head has not moved, and `SafeIntegrator`'s bound-branch fix is covered by tests
but has not yet moved a real ref under a real session.

## Not done, deliberately

- The candidate `c667a4eb...` is unpushed. It exists as a commit object; the branch head
  is unchanged. Integration is a separate decision.
- `npm run build:public` has not been run. It belongs after an accepted integration, as
  its own deployment commit, because the bundle is content-hashed and a rebuild rewrites
  hundreds of asset filenames.
- The original session is untouched: still `WAITING_FOR_HERMES`, still `main @ f48b8346`.
  It was not answered, failed, resumed or cancelled at any point.

## Honest limitations

- **No CI.** Neither repository has status checks. Every test result here is local
  evidence produced on this machine, not independently reproduced.
- **Two pre-existing test failures** in delegate-wave, unrelated to this work and
  reproducible at `f78808a` with the changes stashed: `hermes-external-turns` "fails
  closed for an incompatible Hermes interpreter" and `wake` "an ENQUEUED wake fences a
  later pending wake". The suite is otherwise 719 passing.
- **`JOBS_COLUMNS` still declares `target_branch TEXT`, not `TEXT NOT NULL`.** The
  invariant is enforced at `insertJobRow()` and the migration proves no NULL remains.
  Aligning storage with it needs a table rebuild, deferred deliberately.
- **The clarification guard is heuristic and partial by design.** It catches a 40-hex sha
  that is not the bound base, and path-shaped branch names the repository does not
  contain. A bare one-word name like `main` is not detected. The real safety is the
  immutable binding, and the fact that `session_start` and `session_answer` both return
  it.
- **The intent file handed to Hermes was initially corrupted by me** — extracted through
  a cp1252 stdin, which mangled em-dashes and middle dots. Hermes detected it and
  refused to proceed. The run was interrupted before `session_start`, the file was
  regenerated from the database as pure ASCII, and nothing reached Delegate Wave in a
  corrupted state. No cost was incurred by that error.
- **`npm ci` warns that esbuild's postinstall is not covered by allowScripts.** The build
  succeeds regardless in this environment. If a future worktree fails for a missing
  esbuild binary, that is the cause.

## Post-recovery publication and deployment

Everything above describes what was known at `85e4b0d`, where publication was still
listed as unproven. It is left unchanged. This section records what happened after.

The accepted MANUAL candidate was published through the proposal/approval integration
path -- the only path available to a MANUAL session, since `SafeIntegrator` runs solely
under `modePolicy(session.mode).mayPublish`.

    proposal_83a61344-7750-4f39-a280-b1a4e4045ef1
      integration_branch         codex/live-work-ui
      expected_integration_head  3cf40bafeca8...
      candidate_commit           c667a4eb5f5a...
      validation plan            npm ci | npm run build
                                 git diff --exit-code -- public | npm test

The branch named on that proposal is the job's bound branch, not the project's
registered `integration_branch`, which is still `main`.

### The first attempt was refused, and the refusal is evidence

    integration run -> COMMAND_FAILED
      Integration branch codex/live-work-ui is checked out in another worktree
    ref unchanged | approval consumed

This is worth recording rather than treating as friction. The guard reads
`proposal.integration_branch`, so it examined `codex/live-work-ui` -- the branch the work
was actually based on -- found it checked out in the Papers-bound tree, and stopped.

Before the binding fix the proposal would have named `main`. `main` is not checked out,
so the same guard would have passed and the candidate would have been published there.
The old code does not fail at this point; it succeeds at the wrong thing. A refusal here
is the binding being load-bearing in a place nobody designed as a branch check.

### Integration

The Papers-bound checkout was temporarily detached at the same commit (no file changes,
tree clean), a fresh approval granted, and the integration re-run.

    WORKTREE_CREATED           integration/.../proposal_83a61344...
    CANDIDATE_CHERRY_PICKED    06e1c94fbcd2...
    VALIDATION_RUN             npm ci                          => 0
    VALIDATION_RUN             npm run build                   => 0
    VALIDATION_RUN             git diff --exit-code -- public  => 0
    VALIDATION_RUN             npm test                        => 0
    VALIDATION_PASSED          4
    BRANCH_ADVANCE_INTENDED    refs/heads/codex/live-work-ui
                               3cf40bafeca8... -> 06e1c94fbcd2...
    BRANCH_ADVANCED            06e1c94fbcd2...
    INTEGRATION_SUCCEEDED / PROPOSAL_INTEGRATED

    refs/heads/codex/live-work-ui   3cf40bafeca8... -> 06e1c94fbcd2...
    refs/heads/main                 f48b8346fa29... unchanged
    rollbacks for this proposal     0

Those four commands ran against the *integrated* tree, not merely the candidate. The
checkout was then reattached to the branch at the new head, clean.

`integration_proposals.state` still reads `OPEN` on the row. That is by design, not a
stale write: state is derived from the immutable records ledger, and the stored column is
only a fallback. Note also that an integration run consumes its approval even when it is
refused, so the retry needed a second grant.

### Deployment

    d9a1d41234e057dd3ef24aad734f745c2a71f8b1
      generated public/ only, from `npm run build:public` at 06e1c94
      R public/assets/index-BwYLEx6P.js -> index-Byh2zyrj.js
      R public/assets/index-Do3Y5_NX.css -> index-D_czpyF7.css
      M public/index.html
      nothing outside public/

    remote codex/live-work-ui = d9a1d41234e0...

Only the two entry chunks moved; the roughly 300 content-hashed grammar chunks kept their
hashes. The shipped stylesheet contains the `validator-receipt` rules, so the change is in
the surface Papers serves rather than merely committed. An already-open Backpack frame
still holds the previous bundle until it is re-entered.

### What this does and does not add

Proven live: the MANUAL proposal/approval publication path honours the job's immutable
branch through a real compare-and-swap ref mutation. The selected branch survived from
`session_start` through exploration, implementation, validation, review and publication
without the project default reasserting itself anywhere.

Still not proven live: `SafeIntegrator.prepare()`. It is used by `mayPublish`/AUTO
sessions and remains test-covered only. The remaining exercise is an AUTO session in a
disposable repository with a trivial deterministic change, asserting that
`SafeIntegrator` stages against the bound branch at the bound head, that the CAS moves
`refs/heads/<bound branch>`, and that `project.integration_branch` does not move. That is
separate hardening, not a gap in this incident: the failure actually experienced --
requested `codex/live-work-ui`, rooted and published against `main` -- is demonstrated
fixed through a real publication path.

Three follow-ups on the shipped UI change, recorded here and deliberately not mixed into
this incident: the faded receipt needs a real visual contrast check; a multi-command
validation span is represented by only its last command, which is truthful but
incomplete; and the header renders `Validation` beside a role chip already reading
`validator`.

## Final hardening: SafeIntegrator under AUTO

The section above closed the incident while recording one remaining gap:
`SafeIntegrator.prepare()` was test-covered but had never moved a real ref, because it
runs only under `mayPublish` -- AUTO, ACCEPT_EDITS, BYPASS -- and the recovery run was
MANUAL. That gap is now closed, in a disposable repository rather than the live Backpack.

### The fixture, built so a wrong answer would be visible

    D:/Programs/evTEMP/dw-auto-safeintegrator-test

    refs/heads/main                4804b743b713...   registered integration_branch
    refs/heads/release/auto-proof  9eff452984365...  the branch the session binds to
    checked out                    main   (so the target branch is free to move)
    validation                     node --check app.js

`release/auto-proof` was cut first and `main` was then advanced by one commit adding
`drift.txt`. The two branches genuinely diverge, so anything resolving the project
default instead of the binding would root at `4804b743` and carry `drift.txt` into the
result. That is the discriminator; without it a wrong branch and a right branch would
look identical.

### The run

    session   asess_5ee6ce1a-1b1e-4fd1-8b6c-7b5d7aa51782   AUTO
    root      job_f712e35f-ca5e-449e-99d3-9211f4a08ab3
    bound to  release/auto-proof @ 9eff4529843650339698f8a983836b429f93b022

    1  PLAN       COMPLETED  EXPLORE
    2  SYNTHESIS  COMPLETED  IMPLEMENT
    3  REVIEW     COMPLETED  ACCEPT

    exploration child   inherited release/auto-proof @ 9eff4529, 0 files
    implementation      fae3e6afd882..., changed app.js only
    validation          node --check app.js => exit 0  PASSED

### The publication

    staged_integrations
      target_ref            release/auto-proof     <- bound branch, not the default
      observed_target_sha   9eff4529...            <- equals the bound base
      candidate_commit      fae3e6afd882...
      published_from_sha    9eff4529...            <- CAS moved from the head it observed
      publish_state         PUBLISHED, attempt 1, no retry

    refs/heads/release/auto-proof   9eff4529... -> fae3e6afd882...
    refs/heads/main                 4804b743... unchanged
    project.integration_branch      main          unchanged

    integration_proposals for this job: 0

That last line matters: zero proposals means this went through `SafeIntegrator`, not the
proposal/approval path proven earlier. Two different publication routes, both now
exercised against real refs.

The discriminator held. `drift.txt` is not reachable from the integrated commit, and the
landed content is exactly the requested one-line change on top of the bound base:

    export const NAME = "auto-proof";
    export const VERSION = "2";

### Status

Every publication site named in this document is now runtime-proven rather than partly
test-proven:

    session binding                  proven live
    child inheritance                proven live
    proposal/approval publication    proven live   06e1c94 on codex/live-work-ui
    SafeIntegrator AUTO publication  proven live   fae3e6a on release/auto-proof

Two limits on this particular run, recorded rather than glossed: the session was started
through the control API as operator, so it carried no `hermes_session_id` and was
unwatched -- no wake path was exercised here, that having been proven separately -- and
the fixture is a disposable repository, so nothing about it exercises Papers or the live
Backpack.
