import { requireFile, fail, pass } from "./_harness.js";

// The task requests a fixed field format rather than free prose, so this checks the stated
// requirement exactly instead of grading writing quality by keyword presence.
const body = requireFile("API.md");
const expected = {
  lastIndex: "items",
  tally: "items",
  sum: "numbers",
};

for (const [name, parameter] of Object.entries(expected)) {
  // The lookahead must also match end-of-input, or the final section never matches. JavaScript has
  // no \Z, so end-of-input is spelled as a position with nothing after it.
  const section = new RegExp(
    `^##[ \\t]+${name}[ \\t]*$([\\s\\S]*?)(?=^##[ \\t]|$(?![\\s\\S]))`,
    "m",
  ).exec(body);
  if (!section) fail(`no '## ${name}' section`);
  const text = section[1];
  const parameters = /^Parameters:\s*(.+)$/m.exec(text);
  if (!parameters) fail(`${name}: no 'Parameters:' line`);
  if (!parameters[1].includes(parameter)) {
    fail(`${name}: Parameters says '${parameters[1].trim()}', expected to name ${parameter}`);
  }
  const returns = /^Returns:\s*(.+)$/m.exec(text);
  if (!returns) fail(`${name}: no 'Returns:' line`);
  if (returns[1].trim().split(/\s+/).length < 3) {
    fail(`${name}: Returns is too short to describe a return value`);
  }
}

// Documenting a function that does not exist is a confabulation, not thoroughness.
if (/^##\s+median\s*$/m.test(body)) fail("API.md documents a function that does not exist");
pass("API.md documents each export with its parameters and return value");
