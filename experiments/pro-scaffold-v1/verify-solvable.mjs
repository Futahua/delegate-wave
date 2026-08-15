// Prove each task's test suite is satisfiable before spending model budget on it.
//
// A test suite that no implementation can pass measures nothing except the experimenter's mistake,
// so every task ships with a reference solution here and must go green against it. The reference is
// NEVER placed in the task repository -- it exists only to validate the corpus.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runProcess } from "../../src/process.js";
import { TASKS } from "./tasks.mjs";
import { REFERENCE } from "./reference.mjs";

let allGood = true;
for (const task of TASKS) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `solvable-${task.id}-`));
  // Ship the task, then overwrite the broken sources with the reference solution.
  for (const [rel, body] of Object.entries({ ...task.files, ...(REFERENCE[task.id] ?? {}) })) {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  const testFile = Object.keys(task.files).find((f) => f.startsWith("test/"));
  const result = await runProcess("node", ["--test", testFile], { cwd: dir, timeoutMs: 180000 });
  const failing = [...(result.stdout + result.stderr).matchAll(/^✖ (.+?) \(/gm)]
    .map((m) => m[1]).filter((name) => !/failing tests/.test(name));
  const ok = result.exitCode === 0;
  if (!ok) allGood = false;
  console.log(`${task.id.padEnd(20)} reference ${ok ? "PASSES" : "FAILS"}  ${failing.slice(0, 3).join(" | ")}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

// And the shipped implementation must genuinely fail, or the task is free.
console.log("");
for (const task of TASKS) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `broken-${task.id}-`));
  for (const [rel, body] of Object.entries(task.files)) {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  const testFile = Object.keys(task.files).find((f) => f.startsWith("test/"));
  const result = await runProcess("node", ["--test", testFile], { cwd: dir, timeoutMs: 180000 });
  const failing = [...(result.stdout + result.stderr).matchAll(/^✖ (.+?) \(/gm)]
    .map((m) => m[1]).filter((name) => !/failing tests/.test(name));
  const broken = result.exitCode !== 0;
  if (!broken) allGood = false;
  console.log(`${task.id.padEnd(20)} shipped   ${broken ? "FAILS" : "PASSES (task is free!)"}  ${[...new Set(failing)].slice(0, 3).join(" | ")}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\ncorpus ${allGood ? "usable" : "NOT usable"}`);
process.exit(allGood ? 0 : 1);
