import fs from "node:fs";
import path from "node:path";
const root = "D:/AssistantSystem/delegate-wave/artifacts";
const jobs = [
  ["hermes #1 TOTALS",   "hermes-proposal-v1-424ed2/job_76398db4-b17b-4809-837b-b7f8e0649dd4.2"],
  ["hermes #2 CONTRIB",  "hermes-proposal-v1-424ed2/job_b3e6b78e-10eb-48cd-93da-85757c0d5265.1"],
  ["baseline #1 SUMMARY","baseline-v1-c44b49/job_55787119-c4cd-438c-a965-39e3b406cf0d.1"],
  ["baseline #2 REVENUE","baseline-v1-c44b49/job_c38fe357-a34b-4a19-9872-2fd84f6a869d.1"],
  ["baseline #3 PRICING","baseline-v1-c44b49/job_eb472f56-02ce-41ec-9213-83f49e506775.1"],
];
for (const [label, rel] of jobs) {
  const file = path.join(root, rel, "opencode-events.jsonl");
  if (!fs.existsSync(file)) { console.log(`${label}: MISSING`); continue; }
  const steps = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean)
    .map(JSON.parse).filter((e) => e.type === "step_finish");
  if (!steps.length) { console.log(`${label}: no step_finish`); continue; }
  console.log(`--- ${label}  (${steps.length} steps)`);
  console.log("    first step keys:", JSON.stringify(Object.keys(steps[0].part ?? steps[0])));
  const p = steps[0].part ?? steps[0];
  console.log("    tokens:", JSON.stringify(p.tokens));
  console.log("    cost  :", JSON.stringify(p.cost));
}
