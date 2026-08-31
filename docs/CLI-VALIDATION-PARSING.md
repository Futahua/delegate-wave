# CLI validation parsing correction

Starting point: `b03f12edd5068da0341d291343d760b31237d41b`, branch
`codex/backpack-presentation-v1`.

## Reconciliation of the preserved local file

Before this change, `src/cli.js` had SHA-256
`AC5FB824A0A0ACCAB77D0C00727FF5BB7BA32CD00E01F5ECFEDAE328BAD12BA9`.
Git reported mixed working-tree line endings, but an empty content diff.
Its Git-normalized blob and `HEAD:src/cli.js` were both
`e89303fc1766d8e5bbd6d0b7f96088d3547cf53b`. There was no uncommitted code logic
to discard or merge. The requested CLI correction is now intentionally included;
the earlier hardening commits left this file untouched.

## Behavior

Project registration now uses a strict, command-specific argument parser before
loading credentials or sending any HTTP request. Other CLI commands are unchanged.

```text
--validate "npm test"                       accepted: one complete command
--validate="npm test"                       accepted: same complete command
--validate "npm test" --validate "npm run build"
                                            accepted: two ordered commands
--validate npm test                         refused: unexpected positional word
--validate node --test                      refused: unknown registration option
--validate                                 refused: missing value
--validate ""                              refused: empty value
```

Unknown registration options, duplicate scalar options, and surplus positional
arguments are rejected with a quoting hint. Repeated `--validate` and `--protect`
remain supported. Each command string is preserved exactly; words are never
guessed, joined, or silently discarded. A single executable is still a valid
check, and omitting checks remains supported. Existing server-side shell-composition
rejection and validation execution are unchanged.

This fixes the incident's silent `npm test` to `npm` truncation by refusing the
ambiguous invocation. It does not automatically repair existing registrations.

## Local verification

Focused command: 44 tests passed, none failed.

```text
node --test test/cli-project-add.test.js test/control.test.js test/validation-execution.test.js
```

The new suite contains 13 tests. Its spawned-CLI regression talks to a real HTTP
Control API with a disposable SQLite database and repository: malformed argv
produces zero requests/registrations, correct quoted commands are stored exactly,
and a repeated request ID returns the same project. The test does not run those
registered commands or start a worker. Existing validation-execution tests cover
the runner separately.

Full `npm test`: 707 tests, 704 passed, 2 failed, 1 skipped. Both failures match
the previously established baseline: incompatible Hermes interpreter rejection
and ENQUEUED-wake fencing. No new regression failed.

Syntax and whitespace checks passed. Results are local Windows evidence, not CI.
No installed runtime, preserved incident database, or physical demo was changed.
Mechanical external-side-effect/candidate scope remains a separate open area.
