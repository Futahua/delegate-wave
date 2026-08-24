// A failure that cannot be read is a failure that will be diagnosed twice.
//
// The C5 dogfood died with `failure_signature` set to sixty-four hex characters and nothing else.
// The cause was in the worker's own transcript -- `Error: unknown tool ""`, twelve times -- so it had
// been captured and made unreadable in the same moment. These tests fix the two halves of that: the
// signature stays a stable digest, and the readable account lives beside it.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyFailure, describeFailure, writeFailureDetail, FAILURE_STAGES } from "../src/failure.js";

test("an empty tool name is a tool-dispatch failure, named as one", () => {
  // The exact string the executor produced when the streamed tool identity was lost.
  const classified = classifyFailure('Error: unknown tool ""');
  assert.equal(classified.stage, FAILURE_STAGES.WORKER_TOOL_DISPATCH);
  assert.equal(classified.code, "UNKNOWN_TOOL");
});

test("a repeat loop is recognised as the symptom it is", () => {
  const classified = classifyFailure(
    "Repeated tool call detected: consecutive_calls 5. The repeated calls are not making progress.",
  );
  assert.equal(classified.stage, FAILURE_STAGES.WORKER_TOOL_DISPATCH);
  assert.equal(classified.code, "REPEATED_TOOL_CALL");
});

test("an unrecognised failure keeps its words rather than being forced into a category", () => {
  // A wrong stage sends the next person to the wrong layer, which is worse than admitting the shape
  // is new.
  const classified = classifyFailure("the flux capacitor disagreed with itself");
  assert.equal(classified.stage, FAILURE_STAGES.UNCLASSIFIED);
  assert.equal(classified.code, "UNCLASSIFIED");
});

test("classification never invents a tool from arguments that look like one", () => {
  // The tempting workaround: the arguments in the real failure were perfectly good PowerShell, so a
  // "helpful" layer could infer the tool. Tool identity is authority-bearing -- inferring it would
  // let a provider bug choose which capability runs. This must stay a failure.
  const classified = classifyFailure(
    'Error: unknown tool "" with arguments {"command":"Get-ChildItem -Force"}',
  );
  assert.equal(classified.code, "UNKNOWN_TOOL", "still a failure");
  assert.notEqual(classified.code, "OK");
  // Nothing in the classification names a tool it could be run as.
  assert.equal(JSON.stringify(classified).includes("pwsh"), false);
  assert.equal(JSON.stringify(classified).includes("shell"), false);
});

test("the detail artifact is written, bounded, and content-addressed", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "failure-detail-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const written = writeFailureDetail({
    artifactDir: dir,
    message: 'Error: unknown tool ""',
    stage: FAILURE_STAGES.WORKER_TOOL_DISPATCH,
    code: "UNKNOWN_TOOL",
    evidence: ["attempt: job_x.1", "signature: abc123"],
  });
  assert.ok(written);
  const body = fs.readFileSync(written, "utf8");
  assert.match(body, /stage: WORKER_TOOL_DISPATCH/);
  assert.match(body, /code: UNKNOWN_TOOL/);
  assert.match(body, /unknown tool/);
  assert.match(body, /attempt: job_x\.1/);

  // Identical failures share one file rather than accumulating copies.
  const again = writeFailureDetail({
    artifactDir: dir,
    message: 'Error: unknown tool ""',
    stage: FAILURE_STAGES.WORKER_TOOL_DISPATCH,
    code: "UNKNOWN_TOOL",
    evidence: ["attempt: job_x.1", "signature: abc123"],
  });
  assert.equal(again, written);
  assert.equal(fs.readdirSync(dir).length, 1);

  // A runaway transcript cannot turn an error report into a disk problem.
  const huge = writeFailureDetail({
    artifactDir: dir, message: "x".repeat(500_000),
    stage: FAILURE_STAGES.UNCLASSIFIED, code: "UNCLASSIFIED",
  });
  assert.ok(fs.statSync(huge).size < 10_000);
});

test("failing to record a failure does not become a second failure", () => {
  // An unwritable directory must not turn a diagnosable failure into a crash on the failure path.
  const written = writeFailureDetail({
    artifactDir: "\u0000:/definitely/not/a/directory",
    message: "something broke", stage: FAILURE_STAGES.UNCLASSIFIED, code: "UNCLASSIFIED",
  });
  assert.equal(written, null);
});

test("the signature stays the key, and the words stay beside it", () => {
  // describeFailure reports both. The digest is what repeat-detection is keyed on, so it must
  // survive intact; the stage and code are what a person reads.
  const described = describeFailure({
    failure_signature: "8d639f4a11b80d7af6950be715a0110f73525485ae148532f80b29948df01f79",
    failure_stage: FAILURE_STAGES.WORKER_TOOL_DISPATCH,
    failure_code: "UNKNOWN_TOOL",
    failure_detail_artifact: "D:/artifacts/failure-abc.txt",
  });
  assert.equal(described.signature, "8d639f4a11b80d7af6950be715a0110f73525485ae148532f80b29948df01f79");
  assert.equal(described.stage, "WORKER_TOOL_DISPATCH");
  assert.equal(described.code, "UNKNOWN_TOOL");
  assert.ok(described.detail);

  // An attempt that did not fail describes nothing.
  assert.equal(describeFailure({ failure_signature: null }), null);
  assert.equal(describeFailure(null), null);
});

test("a historical attempt with only a signature still reports honestly", () => {
  // The failed C5 receipt is deliberately never rewritten. It must still render without pretending
  // to know a stage it was never given.
  const described = describeFailure({ failure_signature: "8d639f4a11b8" });
  assert.equal(described.stage, "UNCLASSIFIED");
  assert.equal(described.code, "UNCLASSIFIED");
  assert.equal(described.detail, null);
  assert.equal(described.signature, "8d639f4a11b8");
});
