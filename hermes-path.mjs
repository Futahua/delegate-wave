// The full product path, starting from a real Hermes proposal (not a CLI-created job).
import crypto from "node:crypto";
import { DpapiSecretStore } from "./src/supervisor.js";
import { ControlClient } from "./src/control/client.js";
import { runProcess } from "./src/process.js";
const op = await new DpapiSecretStore().load("operator");
const cl = new ControlClient({ token: op.DELEGATE_WAVE_CONTROL_TOKEN });
const rid = () => `req_${crypto.randomUUID()}`;
const repo = "D:/AssistantSystem/delegate-wave/canaries/v1-acceptance";
const git = async (...a) => (await runProcess("git", ["-C", repo, ...a])).stdout.trim();
const PROPOSAL = process.argv[2];

const before = await git("rev-parse", "integration");
// Decision 1: the operator authorizes Hermes's proposal. This is the only step that turns a
// proposal into a job -- Hermes cannot do it.
const authorized = await cl.post(`/v1/work/proposals/${PROPOSAL}/authorize`, {}, rid());
const jobId = authorized.decision?.job_id ?? authorized.job?.id;
console.log("decision 1 :", "authorized by", authorized.decision?.decided_by, "->", jobId);
console.log("digest     :", authorized.decision?.action_digest === authorized.action_digest ? "matches the proposal" : "DIFFERS");

let advanced;
try { advanced = await cl.post(`/v1/jobs/${jobId}/advance`, {}, rid()); }
catch (e) {
  if (e.code !== "REQUEST_IN_PROGRESS") throw e;
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 5000));
    const s = await cl.get(`/v1/jobs/${jobId}`);
    if (s.job.status !== "RUNNING") { advanced = { attempts: s.attempts, job: s.job }; break; }
  }
}
const at = advanced.attempts.at(-1);
console.log("worker     :", at.backend, "/", at.capability_profile, "|", at.terminal_state, "| validation:", at.validation_state);

const b1 = await cl.get("/v1/briefing");
const pending = b1.needs_your_decision.find((d) => d.job === jobId);
console.log("Hermes says: ready to approve =", Boolean(pending));

// Decision 2: the operator approves this exact candidate.
const proposalId = pending?.proposal ?? advanced.proposal?.id;
if (proposalId) await cl.post(`/v1/proposals/${proposalId}/approve`, {}, rid());
const after = await git("rev-parse", "integration");
console.log("decision 2 :", before.slice(0, 7), "->", after.slice(0, 7), after !== before ? "INTEGRATED" : "unchanged");

const b2 = await cl.get("/v1/briefing");
const done = b2.done.find((d) => d.job === jobId);
console.log("Hermes says:", done ? `Done, ${JSON.stringify(done.changed)}, $${done.cost.reference_cost_usd}, complete=${done.cost.complete}` : "NOT done");
