// A second supplier for the manager is CONFIGURATION, not a second manager.
//
// Codex already knows how to talk to an OpenAI-compatible endpoint -- model_providers is its own
// configuration surface -- so pointing it somewhere else needs a few arguments, not a parallel
// backend with its own session semantics, its own usage shape and its own routing branch to keep in
// step forever.
import assert from "node:assert/strict";
import test from "node:test";
import { CodexManagerBackend, providerLaunch } from "../src/manager/backend.js";

const OPENCODE_GO = {
  id: "opencode-go",
  name: "OpenCode Go",
  baseUrl: "https://opencode.ai/zen/go/v1",
  envKey: "OPENCODE_API_KEY",
  apiKey: "sk-not-a-real-key",
};

test("a provider is selected entirely through per-invocation overrides", () => {
  const launch = providerLaunch(OPENCODE_GO);
  const line = launch.args.join(" ");

  assert.equal(launch.args[0], "app-server");
  assert.match(line, /-c model_provider="opencode-go"/);
  assert.match(line, /model_providers\.opencode-go\.base_url="https:\/\/opencode\.ai\/zen\/go\/v1"/);
  assert.match(line, /model_providers\.opencode-go\.env_key="OPENCODE_API_KEY"/);
  assert.match(line, /model_providers\.opencode-go\.wire_api="chat"/);

  // Values are TOML-quoted. A base URL or a name containing a space would otherwise be parsed as
  // something else entirely, and the manager would quietly talk to the wrong endpoint.
  assert.match(line, /model_providers\.opencode-go\.name="OpenCode Go"/);
});

test("the operator's global Codex config is never involved", () => {
  // ~/.codex/config.toml governs every Codex session the operator runs. delegate-wave selecting a
  // provider for one job has no business editing it, and a key written there would outlive the job
  // that needed it.
  const launch = providerLaunch(OPENCODE_GO);
  assert.ok(launch.args.every((argument) => !/config\.toml/.test(argument)));
  // The credential travels in the environment of one child process and nowhere else.
  assert.deepEqual(Object.keys(launch.env), ["OPENCODE_API_KEY"]);
  assert.equal(launch.env.OPENCODE_API_KEY, "sk-not-a-real-key");
  assert.ok(launch.args.every((argument) => !argument.includes("sk-not-a-real-key")),
    "a key on the command line would be visible to every process listing on the machine");
});

test("an incomplete provider is refused rather than half-applied", () => {
  // A provider missing its endpoint would select itself and then fall back to whatever Codex's
  // default happens to be, so the manager would run somewhere nobody chose.
  assert.throws(() => providerLaunch({ id: "x", envKey: "K" }), /needs at least id, baseUrl and envKey/);
  assert.throws(() => providerLaunch({ baseUrl: "https://example.invalid", envKey: "K" }), /needs at least/);
  assert.throws(() => providerLaunch({ id: "x", baseUrl: "https://example.invalid" }), /needs at least/);
});

test("a provider with no key is still launchable, and simply carries none", () => {
  // Codex resolves env_key from the ambient environment when delegate-wave was not given a key.
  // Passing an empty variable would instead override a working one with nothing.
  const launch = providerLaunch({ ...OPENCODE_GO, apiKey: null });
  assert.deepEqual(launch.env, {});
});

test("the manager takes a provider without changing what it is", () => {
  // Same class, same contract, same neutral-directory requirement. Only the supplier moves.
  const withProvider = new CodexManagerBackend({
    model: "gpt-5.6-luna", workingDirectory: "/tmp/manager", provider: OPENCODE_GO,
  });
  const withPlan = new CodexManagerBackend({ model: "gpt-5.5", workingDirectory: "/tmp/manager" });
  assert.equal(withProvider.name, withPlan.name, "one manager, one name, one code path");
  assert.equal(withProvider.provider.id, "opencode-go");
  assert.equal(withPlan.provider, null);

  // The guarantee that makes it a manager at all survives either supplier.
  assert.throws(() => new CodexManagerBackend({ model: "gpt-5.6-luna", provider: OPENCODE_GO }),
    /neutral working directory/);
});
