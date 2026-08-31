import { parseArgs } from "node:util";

// Strict only for project registration: never turn an accidentally unquoted
// validation command into a weaker plan by silently dropping extra argv tokens.
export function parseProjectAddArgs(argv) {
  const repeatable = new Set(["validate", "protect"]);
  const names = ["name", "path", "branch", "validate", "protect", "request-id"];
  try {
    const { values, positionals, tokens } = parseArgs({
      args: argv, strict: true, allowPositionals: true, tokens: true,
      options: Object.fromEntries(names.map((name) => [name, { type: "string", multiple: repeatable.has(name) }])),
    });
    if (positionals.length !== 2 || positionals[0] !== "project" || positionals[1] !== "add") {
      throw new Error("Unexpected positional arguments for project add");
    }
    for (const name of names) {
      if (!repeatable.has(name) && tokens.filter((token) => token.kind === "option" && token.name === name).length > 1) {
        throw new Error(`Duplicate --${name}`);
      }
      const items = repeatable.has(name) ? values[name] ?? [] : values[name] === undefined ? [] : [values[name]];
      if (items.some((value) => !value.trim())) throw new Error(`--${name} requires a non-empty value`);
    }
    for (const name of ["name", "path"]) {
      if (values[name] === undefined) throw new Error(`Missing --${name}`);
    }
    return values;
  } catch (error) {
    throw new Error(`${error.message}. Quote each complete validation command: --validate "npm test". `
      + "Repeat --validate for separate commands; do not pass command words as extra arguments.");
  }
}
