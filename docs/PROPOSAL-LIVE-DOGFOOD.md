# First live Hermes-initiated work loop

Date: 2026-08-14

The complete alpha product path, executed on the live supervised installation with real credentials
and a real inexpensive worker.

```text
natural-language request -> bounded proposal -> human authorization -> cheap worker
-> deterministic validation -> integration approval -> integration -> Hermes reports completed
```

## Provisioning

Provisioning a third credential originally required rerunning `provision()`, which rewrites the whole
store and therefore needs every role's plaintext -- but after the DPAPI migration those secrets exist
only inside the protected store. `supervisor add-role` was added to seal one new role while copying
the others across as ciphertext.

```text
add-role proposer -> { added: true }
store roles       -> observer, operator, proposer
distinct ciphertexts = 3
existing operator/observer ciphertexts unchanged
records decrypted during add-role = 0
supplied plaintext cleared afterwards = true
proposer token differs from operator and observer = true
```

The proposal credential was generated with `crypto.randomBytes(32)` inside the sealing process and
was never printed, logged, or written in the clear.

## Restart and schema migration

```text
stopped PID 42664 -> started PID 48504, PID receipt matched
live schema_version 9 -> 10
work_proposals, work_proposal_decisions, 4 immutability triggers, 2 indexes created
```

## The loop

Hermes ran as a clean `delegate-wave mcp` process with no credential in its environment, so it
selected the proposer DPAPI record itself. This is the composition the automated suite deliberately
does not cover.

```text
propose_work -> wprop_62488ff0
  origin_principal hermes-proposer
  origin_channel   hermes-mcp-proposal
  state            PENDING
  jobs created     0

operator CLI proposal authorize
  decision   AUTHORIZED
  decided_by admin via local-cli
  job        job_76398db4

job run --model opencode-go/deepseek-v4-flash
  attempt 2 SUCCEEDED in 11.2 s
  validation PASSED (git ls-files --error-unmatch TOTALS.md)
  candidate 6e804c5

approval grant -> integration run
  INTEGRATION_SUCCEEDED 48855a86
  integration branch advanced, 1 file changed, 8 insertions

Hermes get_work_proposal -> AUTHORIZED, job_76398db4
Hermes get_job           -> SUCCEEDED, validation PASSED
```

The worker read `inventory.csv` and produced a correct `TOTALS.md` (widget 2, gadget 5, total 7) with
no collateral changes.

## First attempt failed, and the failure was handled correctly

Attempt 1 failed in 2.3 s with `worker completed without changing files`. The cause was environmental
rather than a defect: with no model specified, OpenCode selected its own default Google provider, and
the supervised task environment carries `GOOGLE_API_KEY` while the provider SDK expects
`GOOGLE_GENERATIVE_AI_API_KEY`.

```text
ProviderAuthError: Google Generative AI API key is missing
```

The dispatcher quarantined the worktree, recorded a failure signature, ran no validation, and left no
partial state. Attempt 2 with explicit routing succeeded.

Operational consequence: the supervised task must not rely on the executor's default provider.
Route explicitly with `--model`, or set a project/global default, until model routing is configured.

## Authority observations

```text
Hermes tool surface: get_overview, list_projects, get_project_summary, get_job,
                     get_attention_needed, get_integration, propose_work,
                     list_work_proposals, get_work_proposal
tools that approve, authorize, run, integrate, or reconcile: none
proposal created no job
every state transition performed by the operator credential
```

## Operator friction worth noting before the 10-20 job dogfood

- `job run` takes `--job`, while `proposal authorize` takes `--id`. Inconsistent flag naming cost a
  failed invocation.
- Nothing surfaces that a proposal is awaiting a decision except explicitly running
  `proposal list`; there is no attention-style prompt.
- The expiry is one hour from creation. A proposal left overnight will need to be re-proposed.

## Deterministic worker routing

The attempt-1 failure was fixed by making routing explicit at the dispatcher rather than by
configuring the executor's ambient provider. No Google or Gemini credential was added.

`runJob()` resolves the model before the attempt row is written, so the resolved provider/model is
persisted as evidence, and `OpenCodeBackend` now throws rather than omitting `--model` -- omitting it
is what let OpenCode fall back to its own default provider.

```text
default bulk implementation and ordinary investigation  opencode-go/deepseek-v4-flash
focused review and debugging                            opencode-go/gpt-5.6-luna     (explicit)
hard implementation escalation                          opencode-go/deepseek-v4-pro  (explicit)
```

Live proof on the supervised installation, with no Google credential present:

```text
Hermes propose_work -> wprop_85a37ef9 (no model named anywhere)
operator authorize  -> job_b3e6b78e
job run             -> NO --model flag supplied
  resolved model    opencode-go/deepseek-v4-flash
  attempt           SUCCEEDED in 12.1 s
  validation        PASSED
  ProviderAuthError occurrences in executor events: 0
integration         INTEGRATED (7a923a9)
```

The equivalent run before this change failed in 2.3 s with
`ProviderAuthError: Google Generative AI API key is missing`.

## Credential inheritance after the live cutover

Review found that the live proposal credential was inheritable by child processes. With a proposer
record present the supervised runtime deliberately decrypts it into the server environment, but the
child scrubber removed only three hardcoded names and did not include the proposer token or
principal. Repository-controlled code reached through validation could therefore read a `read +
propose` bearer token and call the loopback Control API.

The root cause was structural: the scrub list, the persistent-environment cleanup script, and the
provisioning name list were three separately maintained copies, so declaring a credential role did
not automatically cover it. The scrub set is now a single exported list, the cleanup script is
generated from the declared roles, and `supervisor.js` fails at import if any declared role variable
is missing from the scrub set.

Live verification on the supervised installation, with all three credentials present in the server
process, using a validation command committed to the repository under test:

```text
validation command  node leakcheck.js
probes              7 Control authority variables
result              absent
exit code           0
validation_state    PASSED
```

The same probe run against the pre-fix scrubber would have reported the proposer token.

`add-role` now also clears supplied credential material from both the process environment and
`HKCU\Environment` on the already-present path, not only on a successful seal.

## Operator friction resolved

`proposal show|authorize|reject` now take `--proposal`, matching `integration` and `approval`.
`--id` is still accepted so existing invocations keep working.

## Note on concurrent MCP requests

A live check appeared to show a freshly created proposal missing from the overview count. It was not
a defect, and an earlier note in this repository explained it incorrectly as database connection
staleness. The MCP adapter holds no database connection; it reaches the Control API over HTTP.

The real mechanism is that `runMcpStdio()` attaches an async `line` handler without serializing
requests, so JSON-RPC requests written to stdin before the previous one settles may execute
concurrently. Sending `propose_work` and `get_overview` in one batch can therefore let the overview
request race the proposal it was meant to observe.

That is acceptable behaviour for independent JSON-RPC calls and is left unchanged. It only means a
live check must await the proposal response before reading a count that depends on it.
