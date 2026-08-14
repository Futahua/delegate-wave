import { baseline, expectExact, expectOnlyChanged, pass } from "./_harness.js";

expectOnlyChanged(["notes.md"]);

// This is the strict no-collateral task, so the entire result is compared byte-for-byte against the
// frozen source plus the single authorized addition. Checking the original lines and the final line
// separately would accept an extra line inserted between them.
const source = baseline("notes.md");
expectExact("notes.md", `${source.endsWith("\n") ? source : `${source}\n`}# end\n`);
pass("notes.md is exactly the original bytes plus the '# end' line");
