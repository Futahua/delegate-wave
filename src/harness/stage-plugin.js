// Cordis plugin entry: a narrow tool catalog on the first model request, widened afterwards.
//
// This exists to test one claim and nothing else: that the tool surface visible on request #1
// changes how the model plans the rest of the session. The reported result behind it ran `pwsh` and
// `read` on the opening request and the full Standard catalog from the second onward, on Windows,
// with no persistent shell anywhere in it -- so nothing here needs a PTY.
//
// Harness supports this directly. `ctx.tools.restrict(filter)` is an agent-scoped visibility mask
// that returns the exact disposer lifting it, which is precisely "narrow, then widen". The mask is
// live visibility composition rather than an authority boundary, and that is the right level: this
// is a question about what the model SEES, not about what it is permitted to do. Capability is
// unchanged -- the restriction is lifted before the worker has done anything durable with it.
//
// Widening is triggered by the first tool RESULT rather than by a request counter. A request counter
// would widen after an opening request that called nothing, which is the case where the model has
// not yet committed to an approach and the anchoring effect being measured would not exist. The
// trigger therefore matches what the claim is about: the catalog changes once the model has actually
// used the narrow one.
//
// Every transition is written to a JSONL marker file, because "the model saw two tools first" is the
// experimental condition itself. An experiment whose independent variable is only asserted is not
// worth running, so the marker is what the runner asserts against afterwards.
import fs from "node:fs";

export const name = "delegate-wave-first-request-stage";

export function apply(ctx, config = {}) {
  const first = config.first ?? ["pwsh", "read"];
  const markerPath = config.markerPath ?? null;

  const mark = (event, extra = {}) => {
    if (!markerPath) return;
    try {
      fs.appendFileSync(markerPath, `${JSON.stringify({ event, ...extra })}\n`);
    } catch {
      // Evidence is best-effort: a marker that cannot be written must not take the attempt with it.
    }
  };

  // Keyed by agent so a session that runs subagents stages each one independently rather than
  // letting the first subagent's tool call widen the catalog for a sibling that has not started.
  const lifts = new Map();

  ctx.on("agent/created", ({ agent }) => {
    // restrict() throws from a plain context -- the mask is per-agent, so it has to be registered
    // through the agent's own context rather than the plugin's.
    const lift = agent.ctx.tools.restrict({ allow: first });
    lifts.set(agent, lift);
    const visible = agent.ctx.tools.schemas(agent).map((s) => s.name).sort();
    mark("narrowed", { allow: [...first], visible, count: visible.length });
  });

  ctx.on("tools/result", (exec) => {
    const agent = exec.agent;
    const lift = agent ? lifts.get(agent) : null;
    if (!lift) return;
    lifts.delete(agent);
    lift();
    const visible = agent.ctx.tools.schemas(agent).map((s) => s.name).sort();
    mark("widened", { after: exec.name, visible, count: visible.length });
  });

  ctx.on("dispose", () => {
    for (const lift of lifts.values()) lift();
    lifts.clear();
  });
}

export default { name, apply };
