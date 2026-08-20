// Which runtime actually ran an attempt, and how strongly that is known.
//
// The sentence this module exists to enforce:
//
//   A configuration proves what delegate-wave asked the executor to do; only runtime evidence may
//   claim what actually ran, and absence remains unknown.
//
// Three levels, deliberately not two:
//
//   requested   what delegate-wave asked for
//   applied     what the local executor can mechanically prove it composed or launched
//   observed    what the runtime or provider independently reported back
//
// Collapsing `applied` into "actual" is the exact error Orca issue #10846 describes from the other
// side: a requested reasoning effort that silently vanishes from the launch args, with no way for
// the caller to tell it launched at the default. A dumped configuration is strong evidence that
// intent reached the runtime. It is no evidence at all about what a remote provider then served.
//
// This is measurement evidence, never task authority. Product work proceeds under PARTIAL or
// UNVERIFIED provenance exactly as before; only an experimental SAMPLE can be invalidated by it.

export const PROVENANCE_STATUS = Object.freeze({
  VERIFIED: "VERIFIED",
  PARTIAL: "PARTIAL",
  UNVERIFIED: "UNVERIFIED",
  CONTRADICTED: "CONTRADICTED",
});

// Strips a route prefix so `opencode-go/deepseek-v4-pro` and `deepseek-v4-pro` compare equal.
// Routing identity belongs to the dispatcher; model identity is what provenance is about.
export function bareModel(model) {
  if (typeof model !== "string" || !model) return null;
  const slash = model.lastIndexOf("/");
  return slash === -1 ? model : model.slice(slash + 1);
}

const present = (value) => value !== null && value !== undefined && value !== "";

// Derives the receipt's status from what is actually known.
//
//   CONTRADICTED  an observation disagrees with what was requested or applied. This outranks
//                 everything: a run that served a different model than it was told to is not
//                 "partially verified", it is evidence that the condition was not what we think.
//   VERIFIED      every dimension that could be checked was observed and agreed, and at least the
//                 model was observed. Effort is included when it was requested at all.
//   PARTIAL       something was established, something was not.
//   UNVERIFIED    nothing was independently observed.
export function deriveProvenanceStatus(record) {
  const contradictions = [];
  const modelReference = record.applied_model ?? record.requested_model;
  if (present(record.observed_model) && present(modelReference)
      && bareModel(record.observed_model) !== bareModel(modelReference)) {
    contradictions.push(`observed model ${record.observed_model} but ran ${modelReference}`);
  }
  const effortReference = record.applied_effort ?? record.requested_effort;
  if (present(record.observed_effort) && present(effortReference)
      && record.observed_effort !== effortReference) {
    contradictions.push(`observed effort ${record.observed_effort} but ran ${effortReference}`);
  }
  if (contradictions.length) {
    return { status: PROVENANCE_STATUS.CONTRADICTED, detail: contradictions.join("; ") };
  }

  const observedModel = present(record.observed_model);
  const observedEffort = present(record.observed_effort);
  const effortWasRequested = present(record.requested_effort);

  if (!observedModel && !observedEffort) {
    return {
      status: PROVENANCE_STATUS.UNVERIFIED,
      detail: present(record.applied_source)
        // Worth spelling out: this is the ordinary state for a local executor whose provider reports
        // no identity, and it is not a malfunction.
        ? `configuration was proven via ${record.applied_source}; the runtime reported no identity`
        : "no runtime identity evidence was captured",
    };
  }
  if (observedModel && (observedEffort || !effortWasRequested)) {
    return { status: PROVENANCE_STATUS.VERIFIED, detail: null };
  }
  const missing = [];
  if (!observedModel) missing.push("model");
  if (effortWasRequested && !observedEffort) missing.push("effort");
  return { status: PROVENANCE_STATUS.PARTIAL, detail: `${missing.join(" and ")} not independently observed` };
}

// Decides whether an attempt is a valid SAMPLE of an experimental condition.
//
// Deliberately reads nothing about outcomes. It does not look at validation, at the candidate, or at
// whether a manager accepted anything. If provenance could be assessed after seeing the result, an
// invalid-sample rule would become another post-outcome selection channel -- the same defect as
// discarding tasks after both arms have run.
//
//   run finishes -> condition validity decided from runtime evidence -> sample frozen -> outcome read
//
// `expected` names the condition the protocol requires. `requireObserved` lists the dimensions that
// must be independently observed rather than merely applied; a protocol comparing reasoning efforts
// needs observation, one comparing executors may not.
export function assessExperimentalCondition(record, expected = {}) {
  const reasons = [];
  if (!record) {
    return { valid: false, status: PROVENANCE_STATUS.UNVERIFIED, reasons: ["no runtime provenance was recorded for this attempt"] };
  }

  const status = record.status ?? deriveProvenanceStatus(record).status;
  if (status === PROVENANCE_STATUS.CONTRADICTED) {
    reasons.push(`runtime provenance is CONTRADICTED: ${record.detail ?? "observation disagrees with configuration"}`);
  }

  // `requested` explains INTENT and never satisfies a condition.
  //
  // Falling back to it would let a sample pass because delegate-wave asked for something, with no
  // evidence it was ever applied -- which is the precise failure this module exists to prevent,
  // committed by the module itself. Observed supersedes applied for the dimension it independently
  // establishes; below that there is nothing, and nothing means invalid.
  const established = (dimension, { observable = false } = {}) => (
    observable ? (record[`observed_${dimension}`] ?? record[`applied_${dimension}`]) : record[`applied_${dimension}`]
  );
  const unestablished = (dimension, requested) => (
    `${dimension} cannot be established from runtime evidence`
    + `${present(requested) ? ` (only the requested value ${requested} is known)` : ""}`
  );

  if (expected.executor) {
    // A fallback executor is a different capability condition, not a degraded version of the same
    // one: Harness `trusted` has a shell and OpenCode does not. Pooling them would compare two
    // things.
    const actual = established("executor");
    if (!present(actual)) reasons.push(unestablished("executor", record.requested_executor));
    else if (actual !== expected.executor) {
      reasons.push(`executor was ${actual}; the protocol requires ${expected.executor}`);
    }
  }
  if (expected.capabilityProfile) {
    const actual = established("capability_profile");
    if (!present(actual)) reasons.push(unestablished("capability profile", record.requested_capability_profile));
    else if (actual !== expected.capabilityProfile) {
      reasons.push(`capability profile was ${actual}; the protocol requires ${expected.capabilityProfile}`);
    }
  }
  if (expected.model) {
    const actual = bareModel(established("model", { observable: true }));
    const wanted = bareModel(expected.model);
    if (!present(actual)) reasons.push(unestablished("model", record.requested_model));
    else if (actual !== wanted) reasons.push(`model was ${actual}; the protocol requires ${wanted}`);
  }
  if (expected.effort) {
    const actual = established("effort", { observable: true });
    if (!present(actual)) reasons.push(unestablished("reasoning effort", record.requested_effort));
    else if (actual !== expected.effort) {
      reasons.push(`reasoning effort was ${actual}; the protocol requires ${expected.effort}`);
    }
  }

  for (const dimension of expected.requireObserved ?? []) {
    if (!present(record[`observed_${dimension}`])) {
      reasons.push(`${dimension} cannot be independently established; only the requested value is known`);
    }
  }

  return { valid: reasons.length === 0, status, reasons };
}
