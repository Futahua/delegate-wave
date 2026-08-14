import fs from "node:fs";
import path from "node:path";
const root = "D:/AssistantSystem/delegate-wave/artifacts";
const jobs = [
  ["hermes #1 TOTALS",    "hermes-proposal-v1-424ed2/job_76398db4-b17b-4809-837b-b7f8e0649dd4.2"],
  ["hermes #1 attempt1*", "hermes-proposal-v1-424ed2/job_76398db4-b17b-4809-837b-b7f8e0649dd4.1"],
  ["hermes #2 CONTRIB",   "hermes-proposal-v1-424ed2/job_b3e6b78e-10eb-48cd-93da-85757c0d5265.1"],
  ["baseline #1 SUMMARY", "baseline-v1-c44b49/job_55787119-c4cd-438c-a965-39e3b406cf0d.1"],
  ["baseline #2 REVENUE", "baseline-v1-c44b49/job_c38fe357-a34b-4a19-9872-2fd84f6a869d.1"],
  ["baseline #3 PRICING", "baseline-v1-c44b49/job_eb472f56-02ce-41ec-9213-83f49e506775.1"],
];
let grand = { input: 0, output: 0, reasoning: 0, read: 0, write: 0, cost: 0 };
console.log("job                     steps   input  output  reason  cacheRd  cost($)");
for (const [label, rel] of jobs) {
  const file = path.join(root, rel, "opencode-events.jsonl");
  if (!fs.existsSync(file)) { console.log(`${label.padEnd(22)}  (no artifact)`); continue; }
  const steps = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean)
    .map(JSON.parse).filter((e) => e.type === "step_finish").map((e) => e.part ?? e);
  const t = steps.reduce((a, s) => ({
    input: a.input + (s.tokens?.input ?? 0),
    output: a.output + (s.tokens?.output ?? 0),
    reasoning: a.reasoning + (s.tokens?.reasoning ?? 0),
    read: a.read + (s.tokens?.cache?.read ?? 0),
    write: a.write + (s.tokens?.cache?.write ?? 0),
    cost: a.cost + (s.cost ?? 0),
  }), { input: 0, output: 0, reasoning: 0, read: 0, write: 0, cost: 0 });
  for (const k of Object.keys(grand)) grand[k] += t[k];
  console.log(
    label.padEnd(22),
    String(steps.length).padStart(4),
    String(t.input).padStart(7), String(t.output).padStart(7),
    String(t.reasoning).padStart(7), String(t.read).padStart(8),
    t.cost.toFixed(6).padStart(9),
  );
}
console.log("\nTOTAL".padEnd(23), String("").padStart(4),
  String(grand.input).padStart(7), String(grand.output).padStart(7),
  String(grand.reasoning).padStart(7), String(grand.read).padStart(8),
  grand.cost.toFixed(6).padStart(9));
console.log("\n* attempt 1 = the ProviderAuthError failure (should show zero/absent usage)");
