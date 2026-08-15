// Which executor backend performs ordinary work.
//
// Harness is preferred. It is the executor this product wants: reasoning effort is pinned rather
// than inherited from a route default, usage arrives as durable per-call evidence rather than being
// scraped from a transcript, and its capability profile is selectable -- `trusted` by default, so a
// worker keeps the shell and tooling that make it good at the job.
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
import {
  HarnessBackend, HARNESS_PACKAGE, HARNESS_VERSION, wireModel, DEFAULT_CAPABILITY_PROFILE,
} from "./backend.js";

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

// Chooses the backend for one attempt, given the model that attempt will actually run.
//
// Selection is per attempt and happens BEFORE execution, because the right executor depends on the
// model. Harness routes through the DeepSeek adapter and can only run DeepSeek models; the review
// model is not one, so a Harness-only server would fail every Luna job with "no wire model" even
// though the product advertises that lane. One server-wide backend is too coarse to express this.
//
// Returns the choice and its justification together, so the reason a fallback happened is a
// recorded fact rather than something to be inferred from which executor's artifacts appeared.
export function selectBackendForModel(model, {
  harnessHome = HARNESS_HOME, apiKey = null, prefer = "harness",
  profile = DEFAULT_CAPABILITY_PROFILE,
} = {}) {
  const openCode = () => new OpenCodeBackend({ attach: process.env.DELEGATE_WAVE_OPENCODE_ATTACH });

  if (prefer !== "harness") {
    return { backend: openCode(), selected: "opencode", reason: `explicitly requested (${prefer})`, fellBack: false };
  }

  // Not every model can run on Harness, and that is a routing fact rather than a degradation: the
  // review lane belongs to OpenCode by design, not because Harness failed at anything.
  if (!harnessSupportsModel(model)) {
    return {
      backend: openCode(),
      selected: "opencode",
      reason: `${model} does not route through the Harness DeepSeek adapter`,
      fellBack: false,
    };
  }

  const readiness = harnessReadiness({ harnessHome, apiKey });
  if (!readiness.ready) {
    return { backend: openCode(), selected: "opencode", reason: readiness.reason, fellBack: true };
  }
  return {
    backend: new HarnessBackend({ harnessHome, apiKey, profile }),
    selected: "harness",
    reason: `Harness ${readiness.version} (${profile})`,
    fellBack: false,
  };
}

// Chooses a backend per attempt, and remembers when Harness has proven unusable at runtime.
//
// Startup readiness cannot catch everything: a profile that will not compose, or a fence that the
// loader refuses, fails inside `run()` on an attempt that has already begun. That attempt terminates
// honestly -- there is no mid-attempt failover, because two executors behind one attempt identity
// would break the attempt invariant. But the NEXT attempt should not repeat a failure already
// observed, so a runtime failure is recorded and subsequent attempts route to OpenCode.
//
// Each attempt still gets a fresh worktree; nothing about an interrupted attempt is reused.
export class BackendRouter {
  constructor({
    harnessHome = HARNESS_HOME, apiKey = null, prefer = "harness",
    profile = DEFAULT_CAPABILITY_PROFILE,
  } = {}) {
    this.harnessHome = harnessHome;
    this.apiKey = apiKey;
    this.prefer = prefer;
    this.profile = profile;
    this.harnessDisabled = null;
  }

  select(model, { profile = this.profile } = {}) {
    if (this.harnessDisabled) {
      return {
        backend: new OpenCodeBackend({ attach: process.env.DELEGATE_WAVE_OPENCODE_ATTACH }),
        selected: "opencode",
        reason: `Harness disabled after a runtime failure: ${this.harnessDisabled}`,
        fellBack: true,
      };
    }
    return selectBackendForModel(model, {
      harnessHome: this.harnessHome, apiKey: this.apiKey, prefer: this.prefer, profile,
    });
  }

  // Called when a Harness attempt failed for a reason that will recur. Never mid-attempt: the
  // attempt that hit this has already terminated by the time it is recorded.
  disableHarness(reason) {
    if (!this.harnessDisabled) this.harnessDisabled = String(reason ?? "unknown").slice(0, 300);
  }
}

// Whether the Harness DeepSeek adapter can run this model at all.
export function harnessSupportsModel(model) {
  try {
    wireModel(model);
    return true;
  } catch {
    return false;
  }
}
