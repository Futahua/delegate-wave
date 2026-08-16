// The seam between "who runs cheap agents" and "who decides what is true".
//
// delegate-wave's thesis is about economics and evidence, not about process management. Launching a
// coding agent, giving it a workspace, keeping its session alive and delivering a follow-up message
// are generic problems that maintained projects already solve. Owning them here would be rebuilding
// a terminal multiplexer to reach a conclusion about token budgets.
//
// So everything generic lives behind this interface, and the manager policy is written against the
// interface rather than against any runtime:
//
//   AgentRuntime          provisions a workspace, runs an agent in it, reports what it said
//   delegate-wave core    snapshots the resulting tree, validates it, prices it, integrates it
//
// The division of authority is the important part. A runtime may create the workspace, own the
// terminal, keep the session and stream the output. It never says what changed, never says whether
// validation passed, and never says what may be integrated -- those come from the tree the runtime
// produced, measured independently. A runtime is trusted to DO things and never trusted to REPORT
// what became true.
//
//   ┌──────────────────────┐        ┌───────────────────────────┐
//   │ AgentRuntime         │  tree  │ delegate-wave             │
//   │ workspace + process  │──────► │ snapshot, validate, price │
//   │ session + messaging  │        │ candidate, protected, CAS │
//   └──────────────────────┘        └───────────────────────────┘
//
// Two implementations exist deliberately. DirectRuntime is the baseline that keeps the experiment
// clean: managed-versus-direct compared on identical execution machinery, so a difference is
// attributable to the manager rather than to a runtime swap. OrcaRuntime is the leverage: if it
// carries the same work, the bespoke half of this file stops being ours to maintain.
import fs from "node:fs";
import path from "node:path";
import { createDetachedWorktree, removeWorktree } from "../git.js";

// What a runtime can do beyond the minimum. The manager policy branches on these rather than on the
// runtime's identity, so a new runtime that supports resume gets the cheaper revision path without
// the policy learning its name.
export const RUNTIME_CAPABILITIES = Object.freeze({
  // Can a finished agent session be given a correction and continue, instead of a fresh agent
  // rediscovering the repository from nothing? Taskplane's persistent-worker model; materially
  // cheaper when available, and never assumed.
  //
  // Note the deliberate narrowing. Taskplane achieves persistence by running review INSIDE the
  // worker's turn, which delegate-wave cannot copy: our review judges an immutable captured tree, and
  // a worker that keeps editing after review makes the reviewed tree stop being the integrated one.
  // What survives is conversation reuse ACROSS attempts -- same agent, new captured tree.
  // CORRECTNESS MUST NOT DEPEND ON THIS. Resume is an economic optimization: it avoids paying twice
  // to rediscover the repository. A runtime without it must reach the same outcome, only more
  // expensively, via a fresh worker carrying the previous evidence and a revision brief. A managed
  // run that quietly produced worse RESULTS on a non-resumable runtime would have smuggled a
  // performance feature into the definition of correct.
  resumable: false,
  // Does the runtime create and own the workspace directory? When false, delegate-wave provisions a
  // detached worktree itself.
  //
  // Kept separate from spawn() deliberately. A runtime whose own workspace creation cannot be pinned
  // to an exact base commit can still be useful by running its agent inside a delegate-wave-owned
  // worktree, and splitting these two concerns is what leaves that door open.
  ownsWorkspace: false,
  // How instructions reach the agent, borrowed from Agent Orchestrator's persisted `session_mode`.
  //
  //   oneshot  one instruction, one process, completion is that process exiting
  //   chat     instructions are turns against a provider conversation; completion is the provider
  //            declaring the turn ended
  //   tui      instructions are keystrokes written into a pseudo-terminal; completion can only be
  //            inferred, so a runtime in this mode needs an explicit done-signal before it may be
  //            trusted to trigger candidate capture -- observed quiescence is not task completion
  //
  // Recorded rather than assumed, because the three have genuinely different completion semantics
  // and a policy that treated them alike would snapshot a quiet-but-unfinished worktree.
  sessionMode: "oneshot",
});

export class AgentRuntime {
  get name() { return "abstract"; }

  get capabilities() { return { ...RUNTIME_CAPABILITIES }; }

  // Returns { path, handle }. `handle` is opaque runtime state passed back to disposeWorkspace.
  async provisionWorkspace() { throw new Error(`${this.name} runtime cannot provision a workspace`); }

  async disposeWorkspace() { /* runtimes that own nothing have nothing to release */ }

  // Starts one agent and returns a session handle. Does not wait.
  async spawn() { throw new Error(`${this.name} runtime cannot spawn an agent`); }

  // Delivers a follow-up instruction to a live or resumable session. Only valid when
  // capabilities.resumable is true; the policy checks before calling.
  async send() { throw new Error(`${this.name} runtime does not support resuming a worker session`); }

  // Resolves when the agent finishes. Returns the normalized worker result.
  async wait() { throw new Error(`${this.name} runtime cannot wait on an agent`); }

  async cancel() { /* best effort; the dispatcher's own kill path remains authoritative */ }

  // A neutral usage observation for this session, in the shape src/usage.js finalizes. Absence of
  // evidence stays absence: a runtime that cannot report usage returns null and the finalizer
  // records UNKNOWN rather than zero.
  observeUsage() { return null; }
}

// The baseline runtime: delegate-wave's own worktrees plus the existing Harness/OpenCode backends.
//
// This is intentionally a thin wrapper rather than a reimplementation. It exists so the manager
// policy has exactly one way to reach a cheap agent, and so the direct-versus-managed comparison
// runs on the same executor code on both arms.
export class DirectRuntime extends AgentRuntime {
  constructor({ backend, repoPath }) {
    super();
    if (!backend) throw new Error("DirectRuntime requires an executor backend");
    this.backend = backend;
    this.repoPath = repoPath;
  }

  get name() { return "direct"; }

  // Harness headless runs one prompt and exits, so a correction cannot reach the same agent. Stated
  // as a capability rather than worked around: a policy that silently restarted when it meant to
  // resume would report a resume it did not perform.
  //
  // `oneshot`: one instruction, one process, and completion is that process exiting. Candidate
  // capture therefore fires on a real terminal event rather than on an inference about idleness.
  get capabilities() { return { resumable: false, ownsWorkspace: false, sessionMode: "oneshot" }; }

  async provisionWorkspace({ repoPath, startSha, workspacePath }) {
    await createDetachedWorktree(repoPath ?? this.repoPath, workspacePath, startSha);
    return { path: workspacePath, handle: { repoPath: repoPath ?? this.repoPath } };
  }

  async disposeWorkspace({ workspacePath, handle }) {
    if (!handle?.repoPath) return false;
    return removeWorktree(handle.repoPath, workspacePath);
  }

  async spawn({ attemptId, workspacePath, artifactDir, instruction, model, mode, onSpawn }) {
    // The promise is started here and awaited in wait(), so the interface stays spawn/wait even
    // though the underlying backend is a single blocking call. Errors are captured rather than
    // thrown now: a backend that throws may still have consumed tokens, and the dispatcher records
    // usage before turning the throw into a lifecycle outcome.
    const session = {
      attemptId, workspacePath, artifactDir, runtime: this.name, backend: this.backend,
      settled: null,
    };
    session.pending = this.backend.run({
      attemptId,
      worktreePath: workspacePath,
      artifactDir,
      // TEMPORARY, and stated honestly: only the instruction travels today. `goal` is set to the
      // instruction because the current backends still read `goal`, which means the human objective
      // is NOT separately available to them yet.
      //
      // When the instruction seam lands, this becomes two distinct inputs -- `objective` and
      // `instruction` -- and a backend must render the instruction. Falling back to the objective for
      // managed work would hand the worker the human's sentence in place of the manager's brief,
      // which is the exact collapse the whole layer exists to undo, reintroduced as a default.
      instruction,
      goal: instruction,
      model,
      mode,
      onSpawn,
    }).then(
      (value) => { session.settled = { value, error: null }; return session.settled; },
      (error) => { session.settled = { value: null, error }; return session.settled; },
    );
    return session;
  }

  async wait(session) {
    const settled = await session.pending;
    if (settled.error) return { error: settled.error, result: null };
    return { error: null, result: { ...settled.value, finalText: readFinalText(settled.value, session.artifactDir) } };
  }

  observeUsage(session) {
    return this.backend.observeUsage ? this.backend.observeUsage({ artifactDir: session.artifactDir }) : null;
  }
}

// Orca is NOT implemented, on purpose. See docs/research/EXTERNAL-ORCHESTRATION-LESSONS.md.
//
// A first draft of this class existed and was deleted. It was written against plausible-looking
// commands -- `orca agent start --instruction-file`, `orca worktree create --ref <sha> --path <p>` --
// and every one of them was wrong. Orca's actual documented surface is `orca terminal
// create|read|send|wait|stop` over PTY handles, and `orca worktree create` accepts neither a ref nor
// a path. An adapter built on invented commands would have failed in the field while looking like a
// considered integration in review.
//
// Three findings decide this, and only the first is about effort:
//
//  1. Completion is quiescence, not task completion. The documented wait is `terminal wait --for
//     tui-idle`, which proves observed TUI quiescence -- strictly stronger than request-acceptance,
//     since something really was observed, and strictly weaker than the agent having finished. A
//     model pausing to think is quiescent and unfinished. Candidate capture is the one moment where
//     being wrong is unrecoverable: snapshotting a quiet-but-unfinished worktree commits a mid-edit
//     tree as the attempt's complete work. Agent Orchestrator, which owns TUI sessions natively,
//     refuses to treat idle as terminal and requires explicit signal AND idle AND process exit to
//     converge.
//
//  2. Orca-OWNED `worktree create` cannot be pointed at a recorded base commit or a chosen path, and
//     snapshotCandidate measures every candidate against exactly such a commit. That is a statement
//     about Orca-owned workspaces through the documented surface, not about Orca: an adapter could
//     run an Orca session inside a delegate-wave-owned worktree instead, which is exactly why
//     provisionWorkspace and spawn are separate methods.
//
//  3. The orchestration contract is unreadable from outside the install. skills/orchestration/SKILL.md
//     states it is "a discovery stub, not the usage guide" and that commands "change between Orca
//     releases"; the real reference comes from `orca skills get orchestration` on the binary. Writing
//     an adapter to a contract we cannot read is how the deleted draft happened.
//
// The seam above is still worth having: it costs little and it is where a runtime WOULD attach. When
// Orca is installed, work this checklist before writing anything:
//
//   [ ] orca skills get orchestration      -- read the version-matched guide, not this comment
//   [ ] does any wait predicate mean "the agent signalled done", not "the TUI went quiet"?
//   [ ] can a worktree be created at an exact commit, at a path we choose?
//   [ ] does `terminal send` confirm the message was RECEIVED, or only that keystrokes were written?
//   [ ] does a handle survive an Orca restart, or only `terminal_handle_stale` + reacquire?
//   [ ] does it report which harness and model actually ran, as evidence rather than configuration?
//
// Until every box is ticked against the installed binary, DirectRuntime is the runtime.
export class OrcaRuntime extends AgentRuntime {
  constructor() {
    super();
    throw new Error(
      "OrcaRuntime is not implemented. Orca's documented completion signal is `terminal wait --for "
      + "tui-idle`, which cannot be used to trigger candidate capture, and its orchestration contract "
      + "is only readable from an installed binary via `orca skills get orchestration`. "
      + "See docs/research/EXTERNAL-ORCHESTRATION-LESSONS.md before implementing.",
    );
  }
}

// What the worker said it did, recovered from whichever evidence its executor left.
//
// This is testimony, not truth: the candidate tree says what actually changed. It matters anyway,
// because the reviewer needs to see the worker's claim next to the diff to notice when a worker
// believes it did something it did not do -- the specific failure that "tests pass, understood the
// task backwards" produces.
//
// Returns null when no final message can be located. A tail of stdout is NOT substituted: stdout is
// progress logging, and passing it off as the worker's report would put noise in front of scarce
// intelligence and charge for reading it.
export function readFinalText(result, artifactDir) {
  const sessionLog = result?.sessionLogPath ?? findSessionLog(artifactDir);
  if (sessionLog && fs.existsSync(sessionLog)) {
    const text = lastAssistantText(fs.readFileSync(sessionLog, "utf8"));
    if (text) return text;
  }
  if (result?.stdoutPath && fs.existsSync(result.stdoutPath)) {
    const text = lastAssistantText(fs.readFileSync(result.stdoutPath, "utf8"));
    if (text) return text;
  }
  return null;
}

function findSessionLog(artifactDir) {
  if (!artifactDir) return null;
  const root = path.join(artifactDir, "sessions");
  if (!fs.existsSync(root)) return null;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === "session.jsonl") return full;
    }
  }
  return null;
}

// Scans a JSONL transcript for the last assistant text, tolerating the shape differences between
// executors. Unparseable lines are skipped rather than counted: unlike usage accounting, a missing
// sentence of testimony does not corrupt a measurement.
function lastAssistantText(text) {
  const lines = String(text ?? "").split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith("{")) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const candidate = assistantTextOf(record);
    if (candidate) return candidate;
  }
  return null;
}

function assistantTextOf(record) {
  const type = record?.type ?? record?.event ?? null;
  if (type && !/assistant|message|agentMessage/i.test(String(type))) return null;
  const data = record?.data ?? record?.properties ?? record;
  const direct = data?.text ?? data?.message ?? null;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const content = data?.content ?? data?.parts ?? null;
  if (typeof content === "string" && content.trim()) return content.trim();
  if (Array.isArray(content)) {
    const joined = content
      .map((part) => (typeof part === "string" ? part : part?.text ?? ""))
      .filter(Boolean).join("\n").trim();
    if (joined) return joined;
  }
  return null;
}
