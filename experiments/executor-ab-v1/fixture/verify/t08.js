import { requireFile, read, fail, pass } from "./_harness.js";

const body = requireFile("notes.clean.md");
const got = body.split(/\r?\n/);
if (got.some((l) => /\s$/.test(l))) fail("a line still has trailing whitespace");
if (/\n[ \t]*\n[ \t]*\n/.test(body)) fail("a run of blank lines was not collapsed");
const content = got.filter((l) => l.trim());
if (JSON.stringify(content) !== JSON.stringify(["first line", "second line", "third line"])) {
  fail(`content or order changed: ${JSON.stringify(content)}`);
}
// The task asks for a new file, so the source must survive untouched.
if (!/\n\n\n/.test(read("notes.md"))) fail("notes.md itself was modified");
pass("notes.clean.md trimmed and collapsed with order preserved");
