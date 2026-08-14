# Control API Dogfood Record

Date: 2026-08-14

Scope: PR #4 local Control API and CLI migration.

## Worker routing result

Three implementation attempts were delegated through the existing dispatcher before Codex took
over. Each attempt created an isolated worktree, reached the model's reasoning-length limit, changed
no source files, and was deterministically recorded as `FAILED`/`NEEDS_ATTENTION`.

| Attempt | Model | Scope | Reported cost | Result |
|---|---|---|---:|---|
| `job_be3f568a-8b21-48bd-b830-2b5f91de3335.1` | DeepSeek V4 Flash | full PR | `$0.0091299236` | reasoning limit; no patch |
| `job_e8f0fc91-68ae-4eb1-888b-0375f48ebcd2.1` | DeepSeek V4 Pro | full PR | `$0.0557735830` | reasoning limit; no patch |
| `job_8ce34784-940a-4ca3-9740-d471eb260930.1` | DeepSeek V4 Flash | narrowed core | `$0.0078521660` | reasoning limit; no patch |

The bounded escalation policy worked: repeated cheap-worker failure did not cause an indefinite
retry loop. The reasoning model implemented the slice directly. This is evidence against routing a
large cross-cutting authority-boundary change to the current worker configuration as one job; it is
not evidence that DeepSeek is unsuitable for smaller implementation tasks.

Total failed implementation-worker spend: `$0.0727556726`.

## Deterministic evidence

`npm run check` passes 54/54 tests. New tests cover:

- one side effect for duplicate and concurrent request identities, including two CLI processes;
- durable uncertain intent that cannot redispatch;
- complete project → job → worker → proposal → approval → integration through HTTP;
- disconnect-after-send followed by exact replay;
- terminal replay after server restart;
- malformed, unknown, and spoofed requests rejected before dispatch;
- approval principal/origin bound by the server;
- unavailable Control API with no CLI storage fallback.

The post-review hardening tests additionally prove that the Control API token is absent from both
normal and integration validation, project/job inserts roll back when their event receipt fails,
success-receipt failure remains uncertain without a false failed record, explicit uncertain domain
errors remain nonterminal, and the CLI exposes the request identity needed for an exact retry.

## Independent focused review

OpenCode Go Luna reviewed only the uncommitted Control API authority/idempotency boundary in a
read-only 20-step session (`ses_000933ff9ffex0h1hyCR79wLby`). It returned `NO BLOCKERS` in about
54 seconds. Reported cost was `$0.00361360`.

The useful routing result remains narrow:

```text
DeepSeek Flash  → bounded ordinary implementation
Luna            → focused review/debugging
DeepSeek Pro    → selective escalation, not a rescue loop
Codex           → cross-cutting authority/state design when workers exhaust bounds
```

Total model spend recorded for this PR dogfood: `$0.0763692726`.

## Post-merge real API self-dogfood

PR #4 merged as `f29677b`. The real localhost Control API created and ran this documentation-only
DeepSeek Flash job through the CLI, the control token was scrubbed from child processes, and
`npm test` was the validation gate.
