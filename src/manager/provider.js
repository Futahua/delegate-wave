// Describes one OpenAI-compatible provider well enough for Codex to use it.
//
// Read from the executor's own registry rather than hardcoded: the base URL and the environment
// variable name are the provider's facts, not delegate-wave's, and a stale copy here would send the
// manager's turns somewhere that no longer exists.
//
// The key is looked up but never logged, never written to config, and never passed to anything
// except the one child process that needs it.
//
// Shared by the CLI and the served runtime deliberately. It lived in the CLI alone, so `manage`
// resolved a provider and `serve()` did not -- every session under the supervisor reached the app
// server without one and lost its first turn. Two copies of a fact is how that happens; one copy is
// the fix.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export async function resolveManagerProvider(id) {
  const home = os.homedir();
  const registryPath = path.join(home, ".cache", "opencode", "models.json");
  let entry = null;
  try { entry = JSON.parse(fs.readFileSync(registryPath, "utf8"))[id] ?? null; } catch { entry = null; }
  if (!entry?.api) {
    throw new Error(
      `Unknown manager provider "${id}": no entry with an api URL in ${registryPath}. `
      + "Pass a bare model name to use the Codex plan instead.",
    );
  }
  const envKey = entry.env?.[0] ?? "OPENCODE_API_KEY";
  let apiKey = process.env[envKey] ?? null;
  if (!apiKey) {
    try {
      const auth = JSON.parse(fs.readFileSync(path.join(home, ".local", "share", "opencode", "auth.json"), "utf8"));
      apiKey = auth[id]?.key ?? null;
    } catch { apiKey = null; }
  }
  if (!apiKey) {
    throw new Error(`No credential for provider "${id}": set ${envKey}, or authenticate it in OpenCode.`);
  }
  return { id, name: entry.name ?? id, baseUrl: entry.api, envKey, wireApi: "responses", apiKey };
}

// The provider a model name implies, or null for a bare Codex-plan model.
//
// Defensive on purpose for the served runtime: a control API that refused to start because an
// executor registry was missing would take every read-only surface down with it. The reason is
// returned instead, so a session that later fails has a stated cause rather than a mystery.
export async function providerForModel(model) {
  if (typeof model !== "string" || !model.includes("/")) return { provider: null, reason: "bare model" };
  const id = model.slice(0, model.indexOf("/"));
  try {
    return { provider: await resolveManagerProvider(id), reason: null };
  } catch (error) {
    return { provider: null, reason: error.message };
  }
}
