import { requireFile, expectOnlyChanged, fail, pass } from "./_harness.js";

expectOnlyChanged(["API.md"]);

// Every field the task requests is graded. An earlier version asked for a free-prose description
// after the category and never checked it, so `Returns: number` satisfied a format the task said
// required more. A field that is not graded should not be requested.
const expected = {
  lastIndex: { parameters: ["items"], returns: "number" },
  tally: { parameters: ["items"], returns: "object" },
  sum: { parameters: ["numbers"], returns: "number" },
};
const CATEGORIES = ["number", "string", "boolean", "object", "array", "null"];

const body = requireFile("API.md");
const sections = [...body.matchAll(/^##[ \t]+(\S+)[ \t]*$/gm)].map((match) => match[1]);

// The section set must equal the export set exactly: rejecting one known-bad name would still admit
// any other invented section.
const documented = [...sections].sort();
const exported = Object.keys(expected).sort();
if (JSON.stringify(documented) !== JSON.stringify(exported)) {
  fail(`sections are ${JSON.stringify(documented)}, expected exactly ${JSON.stringify(exported)}`);
}

for (const [name, want] of Object.entries(expected)) {
  const section = new RegExp(
    `^##[ \\t]+${name}[ \\t]*$([\\s\\S]*?)(?=^##[ \\t]|$(?![\\s\\S]))`,
    "m",
  ).exec(body);
  if (!section) fail(`no '## ${name}' section`);
  const text = section[1];

  const parameters = /^Parameters:[ \t]*(.*)$/m.exec(text);
  if (!parameters) fail(`${name}: no 'Parameters:' line`);
  const named = parameters[1].split(/[,\s]+/).filter(Boolean);
  if (JSON.stringify(named) !== JSON.stringify(want.parameters)) {
    fail(`${name}: Parameters is ${JSON.stringify(named)}, expected ${JSON.stringify(want.parameters)}`);
  }

  const returns = /^Returns:[ \t]*(.*)$/m.exec(text);
  if (!returns) fail(`${name}: no 'Returns:' line`);
  const category = returns[1].trim().toLowerCase();
  if (!CATEGORIES.includes(category)) {
    fail(`${name}: Returns must be exactly one of ${CATEGORIES.join(", ")}, got ${JSON.stringify(returns[1].trim())}`);
  }
  if (category !== want.returns) fail(`${name}: Returns says ${category}, expected ${want.returns}`);
}
pass("API.md documents exactly the exports with correct parameters and return categories");
