// Prove the hard tier is usable before spending model budget on it.
//
// Three checks per task, not two. The first tier only had to be satisfiable and non-free; this one
// additionally claims that the obvious fix is insufficient, and that claim has to be verified or the
// task is measuring nothing:
//
//   reference  must PASS  -- the suite is satisfiable
//   shipped    must FAIL  -- the task is not free
//   partial    must FAIL  -- stopping at the visible defect is not enough
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runProcess } from "../../src/process.js";
import { HARD_TASKS } from "./tasks-hard.mjs";
import { REFERENCE_HARD } from "./reference-hard.mjs";
import { PARTIAL_HARD } from "./partial-hard.mjs";

const ROUNDS = [
  { label: "reference", overlay: REFERENCE_HARD, wantPass: true },
  { label: "shipped", overlay: {}, wantPass: false },
  { label: "partial", overlay: PARTIAL_HARD, wantPass: false },
];

let allGood = true;
for (const round of ROUNDS) {
  for (const task of HARD_TASKS) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hard-${task.id}-`));
    for (const [rel, body] of Object.entries({ ...task.files, ...(round.overlay[task.id] ?? {}) })) {
      fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    }
    const testFile = Object.keys(task.files).find((f) => f.startsWith("test/"));
    const result = await runProcess("node", ["--test", testFile], { cwd: dir, timeoutMs: 300000 });
    const failing = [...new Set([...(result.stdout + result.stderr).matchAll(/^✖ (.+?) \(/gm)]
      .map((m) => m[1]).filter((name) => !/failing tests/.test(name)))];

    const passed = result.exitCode === 0;
    const correct = passed === round.wantPass;
    if (!correct) allGood = false;
    const verdict = correct ? "  " : "<-- WRONG";
    console.log(`${task.id.padEnd(18)} ${round.label.padEnd(10)} ${passed ? "passes" : "fails "}  ${verdict}  ${failing.slice(0, 2).join(" | ")}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log("");
}

console.log(`hard corpus ${allGood ? "usable" : "NOT usable"}`);
process.exit(allGood ? 0 : 1);
