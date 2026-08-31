import assert from "node:assert/strict";
import test from "node:test";
import { renderBrief, renderExploration } from "../src/manager/contracts.js";

const repositoryPath = "D:\\Programs\\evTEMP\\dw-visual-demo";

test("exploration instructions replace only the registered checkout with worktree-relative paths", () => {
  const instruction = renderExploration({
    repositoryPath,
    objective: "Inspect D:/Programs/evTEMP/dw-visual-demo/router.js with D:/Shared/reference.txt",
    exploration: {
      question: "Read d:/programs/evTEMP/dw-visual-demo/router.js and test.js",
      deliver: ["cite D:\\Programs\\evTEMP\\dw-visual-demo\\test.js"],
    },
  });

  assert.doesNotMatch(instruction, /D:[\\/]Programs[\\/]evTEMP[\\/]dw-visual-demo/i);
  assert.match(instruction, /Question: Read router\.js and test\.js/);
  assert.match(instruction, /cite test\.js/);
  assert.match(instruction, /D:\/Shared\/reference\.txt/,
    "an unrelated external path is not prohibited by this narrow correction");
  assert.match(instruction, /current directory is the assigned read-only repository worktree/);
});

test("registered checkout rewriting requires a path boundary", () => {
  const checkoutFile = renderExploration({
    repositoryPath,
    objective: "context",
    exploration: { question: "Read D:/Programs/evTEMP/dw-visual-demo/router.js", deliver: [] },
  });
  const checkoutRoot = renderExploration({
    repositoryPath,
    objective: "context",
    exploration: { question: "Inspect D:/Programs/evTEMP/dw-visual-demo", deliver: [] },
  });
  const sibling = renderExploration({
    repositoryPath,
    objective: "context",
    exploration: {
      question: "Compare D:/Programs/evTEMP/dw-visual-demo-backup/reference.txt",
      deliver: [],
    },
  });
  const external = renderExploration({
    repositoryPath,
    objective: "context",
    exploration: { question: "Compare D:/Shared/reference.txt", deliver: [] },
  });

  assert.match(checkoutFile, /Question: Read router\.js/);
  assert.match(checkoutRoot, /Question: Inspect \./);
  assert.match(sibling, /D:\/Programs\/evTEMP\/dw-visual-demo-backup\/reference\.txt/);
  assert.match(external, /D:\/Shared\/reference\.txt/);
});

test("implementation instructions make the objective context and existing brief fields actionable", () => {
  const instruction = renderBrief({
    repositoryPath,
    objective: "PLAN two explorers, SYNTHESIS, REVIEW, and report IDs for D:/Programs/evTEMP/dw-visual-demo",
    brief: {
      diagnosis: "D:\\Programs\\evTEMP\\dw-visual-demo\\router.js uses exact lookup",
      instructions: "Edit D:/Programs/evTEMP/dw-visual-demo/router.js and test.js",
      acceptance: ["router.js and test.js contain the fix"],
      relevant_evidence: ["D:/Programs/evTEMP/dw-visual-demo/test.js lacks query coverage"],
      uncertainties: ["query edge cases outside router.js are unspecified"],
      worker_tier: "ordinary",
    },
  });

  assert.match(instruction, /Wider human objective \(context only; not your role\)/);
  assert.match(instruction, /Only Diagnosis, What to do, Established facts, Known unknowns/);
  assert.match(instruction, /Those are not your work/);
  assert.match(instruction, /Never dispatch, emulate, fabricate or report Delegate Wave/);
  assert.match(instruction, /Diagnosis: router\.js uses exact lookup/);
  assert.match(instruction, /Edit router\.js and test\.js/);
  assert.doesNotMatch(instruction, /D:[\\/]Programs[\\/]evTEMP[\\/]dw-visual-demo/i);
});
