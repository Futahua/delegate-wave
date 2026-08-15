// Which executor backend performs ordinary work.
//
// Harness is preferred. It is the executor this product wants: reasoning effort is pinned rather
// than inherited from a route default, the filesystem is confined to the attempt worktree by
// delegate-wave's own fence, and usage arrives as durable per-call evidence rather than being
// scraped from a transcript.
//
// OpenCode remains the fallback, unchanged and undiminished. It is the executor with a production
// record here, so when Harness cannot run -- not installed, no credential, a profile that will not
// compose -- the answer is to fall back before the attempt begins, with the reason recorded.
//
// The one rule that matters: selection happens BETWEEN attempts, never during one. A mid-attempt
// failover would put two executors behind a single attempt identity, breaking the invariant that
// one attempt has one identity, one epoch, one worktree, and at most one terminal result. A Harness
// attempt that dies is a failed attempt, and its worktree is never reused.
import fs from "node:fs";
import path from "node:path";
import { OpenCodeBackend } from "../backend.js";
import { HarnessBackend, HARNESS_PACKAGE, HARNESS_VERSION } from "./backend.js";

export const HARNESS_HOME = process.env.DELEGATE_WAVE_HARNESS_HOME
  || path.join("D:", "AssistantSystem", "delegate-wave", "harness");

// Reports why Harness can or cannot run, without constructing anything.
export function harnessReadiness({ harnessHome = HARNESS_HOME, apiKey = null } = {}) {
  const entry = path.join(harnessHome, "node_modules", HARNESS_PACKAGE, "lib", "bin.js");
  if (!fs.existsSync(entry)) {
    return { ready: false, reason: `${HARNESS_PACKAGE}@${HARNESS_VERSION} is not installed at ${harnessHome}` };
  }
  let installed = null;
  try {
    installed = JSON.parse(fs.readFileSync(
      path.join(harnessHome, "node_modules", HARNESS_PACKAGE, "package.json"), "utf8",
    )).version;
  } catch {
    return { ready: false, reason: "the installed Harness package has no readable version" };
  }
  // Pinned, not floated: the profile patch names specific plugin ids and the usage reader depends on
  // a specific event shape. A different build may honour neither, and would do so quietly.
  if (installed !== HARNESS_VERSION) {
    return { ready: false, reason: `Harness is pinned to ${HARNESS_VERSION} but ${installed} is installed` };
  }
  if (!apiKey) return { ready: false, reason: "no Harness API key was supplied" };
  return { ready: true, reason: null, version: installed };
}

// Chooses the backend for ordinary work.
//
// Returns the choice and its justification together, so the reason a fallback happened is a
// recorded fact rather than something to be inferred from which executor's artifacts appeared.
export function selectBackend({ harnessHome = HARNESS_HOME, apiKey = null, prefer = "harness" } = {}) {
  const openCode = () => new OpenCodeBackend({ attach: process.env.DELEGATE_WAVE_OPENCODE_ATTACH });

  if (prefer !== "harness") {
    return { backend: openCode(), selected: "opencode", reason: `explicitly requested (${prefer})`, fellBack: false };
  }

  const readiness = harnessReadiness({ harnessHome, apiKey });
  if (!readiness.ready) {
    return { backend: openCode(), selected: "opencode", reason: readiness.reason, fellBack: true };
  }
  return {
    backend: new HarnessBackend({ harnessHome, apiKey }),
    selected: "harness",
    reason: `Harness ${readiness.version}`,
    fellBack: false,
  };
}
