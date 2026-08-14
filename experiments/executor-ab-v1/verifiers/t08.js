import { baseline, expectExact, expectOnlyChanged, pass } from "./_harness.js";

expectOnlyChanged(["notes.clean.md"]);

// The transformation is deterministic, so the whole output is derived from the frozen source and
// compared exactly. Checking only that "there are not too many blank lines" would accept an answer
// that deleted every blank line instead of collapsing each run to one.
const source = baseline("notes.md");
const expected = source
  .split("\n")
  .map((line) => line.replace(/[ \t]+$/, ""))
  .join("\n")
  .replace(/\n{3,}/g, "\n\n");

expectExact("notes.clean.md", expected);
pass("notes.clean.md is exactly the trimmed, collapsed source with notes.md untouched");
