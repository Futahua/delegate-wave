import { requireFile, fail, pass } from "./_harness.js";

const body = requireFile("notes.md");
if (!body.endsWith("\n")) fail("notes.md must end with a newline");
const got = body.split(/\r?\n/);
while (got.length && !got.at(-1).trim()) got.pop();
if (got.at(-1).trim() !== "# end") fail(`last content line is '${got.at(-1)}', expected '# end'`);
// Every original line must survive byte-identically, in order: this task is specifically about
// making a minimal edit without tidying anything on the way past.
const original = ["first line   ", "", "", "", "second line\t", "", "third line"];
for (let i = 0; i < original.length; i += 1) {
  if (got[i] !== original[i]) {
    fail(`original line ${i + 1} was altered: ${JSON.stringify(got[i])}`);
  }
}
pass("# end appended with no collateral change");
