// A configuration proves what delegate-wave asked the executor to do; only runtime evidence may
// claim what actually ran, and absence remains unknown.
//
// Three levels, and the middle one is the whole point. `applied` is mechanically strong evidence
// that intent reached the runtime -- a composed patch, an argv -- and no evidence at all about what
// a remote provider served. Collapsing it into "actual" is how a measurement starts confirming its
// own configuration.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeDataRoot } from "../src/db.js";
import { FakeBackend } from "../src/backend.js";
import { Dispatcher } from "../src/service.js";
import { assessExperimentalCondition, deriveProvenanceStatus, PROVENANCE_STATUS } from "../src/provenance.js";
import { runProcess } from "../src/process.js";

async function command(name, args, cwd) {
  const result = await runProcess(name, args, { cwd });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

// A fake worker that reports whatever provenance a test wants. Explicit rather than inferred, so the
// experiment logic is testable without pretending a fake run proves real runtime identity.
function backendWithProvenance(provenance, { profile = null, effort = null } = {}) {
  const backend = new FakeBackend(async ({ worktreePath }) => {
    fs.writeFileSync(path.join(worktreePath, "out.txt"), "done\n");
    return { exitCode: 0, stdout: "ok", stderr: "", provenance };
  });
  backend.profile = profile;
  backend.reasoningEffort = effort;
  return backend;
}

async function fixture(t, backend) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wave-prov-"));
  const root = path.join(temp, "data");
  const repo = path.join(temp, "repo");
  fs.mkdirSync(repo);
  await command("git", ["init", "-b", "main"], repo);
  await command("git", ["config", "user.name", "Test"], repo);
  await command("git", ["config", "user.email", "test@example.invalid"], repo);
  fs.writeFileSync(path.join(repo, "input.txt"), "before\n");
  await command("git", ["add", "."], repo);
  await command("git", ["commit", "-m", "initial"], repo);
  initializeDataRoot(root);
  const service = new Dispatcher({ root, backend });
  t.after(async () => {
    try { service.close(); } catch { /* closed */ }
    const listed = await runProcess("git", ["-C", repo, "worktree", "list", "--porcelain"]);
    for (const worktree of listed.stdout.split(/\r?\n/)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length))
      .filter((worktree) => path.resolve(worktree) !== path.resolve(repo))) {
      await runProcess("git", ["-C", repo, "worktree", "unlock", worktree]);
      await runProcess("git", ["-C", repo, "worktree", "remove", "--force", worktree]);
    }
    for (let n = 0; n < 20; n += 1) {
      try { fs.rmSync(temp, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 50)); }
    }
  });
  const project = await service.addProject({ name: "Prov", repoPath: repo, validation: [] });
  return { service, project };
}

async function runOnce(service, project, model = "opencode-go/deepseek-v4-pro") {
  const job = await service.createJob({ projectId: project.id, goal: "work" });
  await service.runJob(job.id, { model });
  return service.status(job.id).attempts.at(-1);
}

test("requested, applied and observed all agreeing is VERIFIED and a valid sample", async (t) => {
  const { service, project } = await fixture(t, backendWithProvenance({
    appliedModel: "deepseek-v4-pro", appliedEffort: "high", appliedExecutor: "harness",
    appliedCapabilityProfile: "trusted", appliedSource: "harness-profile-patch",
    observedModel: "deepseek-v4-pro", observedEffort: "high", observedSource: "provider-report",
  }, { profile: "trusted", effort: "high" }));

  const attempt = await runOnce(service, project);
  const record = service.getRuntimeProvenance(attempt.id);
  assert.equal(record.status, PROVENANCE_STATUS.VERIFIED);

  const verdict = service.assessExperimentalCondition(attempt.id, {
    executor: "harness", model: "deepseek-v4-pro", effort: "high",
    capabilityProfile: "trusted", requireObserved: ["model", "effort"],
  });
  assert.equal(verdict.valid, true, verdict.reasons.join("; "));
});

test("a runtime that served a different model is CONTRADICTED and invalid", async (t) => {
  const { service, project } = await fixture(t, backendWithProvenance({
    appliedModel: "deepseek-v4-pro", appliedExecutor: "harness", appliedSource: "harness-profile-patch",
    observedModel: "deepseek-v4-flash", observedSource: "provider-report",
  }));

  const attempt = await runOnce(service, project);
  const record = service.getRuntimeProvenance(attempt.id);
  assert.equal(record.status, PROVENANCE_STATUS.CONTRADICTED);
  assert.match(record.detail, /observed model deepseek-v4-flash but ran deepseek-v4-pro/);

  const verdict = service.assessExperimentalCondition(attempt.id, { model: "deepseek-v4-pro" });
  assert.equal(verdict.valid, false);
  assert.ok(verdict.reasons.some((reason) => /CONTRADICTED/.test(reason)));
});

test("applied-but-unobserved is UNVERIFIED, and a protocol requiring observation rejects it", async (t) => {
  // The ordinary state for a local executor whose provider reports no identity. It is not a
  // malfunction, and it is also not proof of what ran.
  const { service, project } = await fixture(t, backendWithProvenance({
    appliedModel: "deepseek-v4-pro", appliedEffort: "high", appliedExecutor: "harness",
    appliedCapabilityProfile: "trusted", appliedSource: "harness-profile-patch",
  }, { profile: "trusted", effort: "high" }));

  const attempt = await runOnce(service, project);
  const record = service.getRuntimeProvenance(attempt.id);
  assert.equal(record.status, PROVENANCE_STATUS.UNVERIFIED);
  assert.equal(record.applied_effort, "high", "the composed configuration is still known");
  assert.equal(record.observed_effort, null, "and is not promoted to an observation");
  assert.match(record.detail, /configuration was proven via harness-profile-patch/);

  // A protocol that only compares executors is satisfied by applied evidence.
  assert.equal(
    service.assessExperimentalCondition(attempt.id, { executor: "harness", effort: "high" }).valid,
    true,
  );
  // One comparing reasoning efforts is not.
  const strict = service.assessExperimentalCondition(attempt.id, {
    executor: "harness", effort: "high", requireObserved: ["effort"],
  });
  assert.equal(strict.valid, false);
  assert.ok(strict.reasons.some((reason) => /effort cannot be independently established/.test(reason)));
});

test("a fallback executor is a different condition, not a degraded sample", async (t) => {
  // Harness `trusted` has a shell; OpenCode does not. Pooling them would compare two things.
  const { service, project } = await fixture(t, backendWithProvenance({
    appliedModel: "deepseek-v4-pro", appliedExecutor: "opencode", appliedSource: "opencode-argv",
  }));
  const attempt = await runOnce(service, project);
  const verdict = service.assessExperimentalCondition(attempt.id, { executor: "harness" });
  assert.equal(verdict.valid, false);
  assert.ok(verdict.reasons.some((reason) => /executor was opencode; the protocol requires harness/.test(reason)));
});

test("two attempts keep two provenance records; neither overwrites the other", async (t) => {
  const { service, project } = await fixture(t, backendWithProvenance({
    appliedModel: "deepseek-v4-pro", appliedExecutor: "harness", appliedSource: "harness-profile-patch",
  }));
  const first = await runOnce(service, project);

  // A second attempt on a different job, as a fallback would produce.
  service.backend = backendWithProvenance({
    appliedModel: "deepseek-v4-pro", appliedExecutor: "opencode", appliedSource: "opencode-argv",
  });
  const second = await runOnce(service, project);

  assert.notEqual(first.id, second.id);
  assert.equal(service.getRuntimeProvenance(first.id).applied_executor, "harness");
  assert.equal(service.getRuntimeProvenance(second.id).applied_executor, "opencode");
});

test("an attempt with no provenance receipt is an invalid sample, not a verified one", async (t) => {
  // Historical attempts predate this receipt. Their attempts.model column records what was
  // REQUESTED, and reading it as evidence of what ran would retroactively verify runs nobody
  // observed.
  const { service, project } = await fixture(t, backendWithProvenance({
    appliedModel: "deepseek-v4-pro", appliedExecutor: "harness", appliedSource: "harness-profile-patch",
  }));
  const attempt = await runOnce(service, project);
  service.db.exec("DROP TRIGGER IF EXISTS trg_runtime_provenance_immutable_delete");
  service.db.prepare("DELETE FROM attempt_runtime_provenance WHERE attempt_id = ?").run(attempt.id);

  assert.equal(service.getRuntimeProvenance(attempt.id), null);
  assert.ok(service.db.prepare("SELECT model FROM attempts WHERE id = ?").get(attempt.id).model);

  const verdict = service.assessExperimentalCondition(attempt.id, { model: "deepseek-v4-pro" });
  assert.equal(verdict.valid, false);
  assert.equal(verdict.status, PROVENANCE_STATUS.UNVERIFIED);
  assert.ok(verdict.reasons.some((reason) => /no runtime provenance was recorded/.test(reason)));
});

test("validity is decided without reading task outcome", async (t) => {
  // If provenance could be assessed after seeing the result, an invalid-sample rule would become a
  // post-outcome selection channel -- the same defect as discarding tasks once both arms have run.
  const { service, project } = await fixture(t, backendWithProvenance({
    appliedModel: "deepseek-v4-pro", appliedExecutor: "harness", appliedSource: "harness-profile-patch",
    observedModel: "deepseek-v4-pro", observedSource: "provider-report",
  }));
  const attempt = await runOnce(service, project);

  const beforeOutcome = service.assessExperimentalCondition(attempt.id, {
    executor: "harness", model: "deepseek-v4-pro", requireObserved: ["model"],
  });
  // Now make the task outcome as bad as possible; the sample's validity must be unchanged.
  service.db.prepare("UPDATE attempts SET validation_state = 'FAILED', terminal_state = 'FAILED' WHERE id = ?")
    .run(attempt.id);
  const afterOutcome = service.assessExperimentalCondition(attempt.id, {
    executor: "harness", model: "deepseek-v4-pro", requireObserved: ["model"],
  });
  assert.deepEqual(afterOutcome, beforeOutcome);
  assert.equal(afterOutcome.valid, true);
});

test("identity evidence and cost evidence fail independently", async (t) => {
  // A silent worker: nothing is written for usage, but provenance is fully reported.
  const backend = new FakeBackend(async ({ worktreePath }) => {
    fs.writeFileSync(path.join(worktreePath, "out.txt"), "done\n");
    return {
      exitCode: 0, stdout: "ok", stderr: "",
      provenance: {
        appliedModel: "deepseek-v4-pro", appliedExecutor: "harness", appliedSource: "harness-profile-patch",
        observedModel: "deepseek-v4-pro", observedSource: "provider-report",
      },
    };
  });
  const { service, project } = await fixture(t, backend);
  const attempt = await runOnce(service, project);

  assert.equal(service.getAttemptUsage(attempt.id).status, "UNKNOWN", "cost is unknown");
  assert.equal(service.getRuntimeProvenance(attempt.id).status, PROVENANCE_STATUS.VERIFIED, "identity is not");
  // Neither receipt may stand in for the other's health.
  assert.equal(service.assessExperimentalCondition(attempt.id, { model: "deepseek-v4-pro" }).valid, true);
});

test("the capability profile recorded is the one the backend composed", async (t) => {
  const { service, project } = await fixture(t, backendWithProvenance({
    appliedModel: "deepseek-v4-pro", appliedExecutor: "harness", appliedSource: "harness-profile-patch",
    // The backend composed `restricted` even though nothing on the job asked for it.
    appliedCapabilityProfile: "restricted",
  }, { profile: "restricted" }));

  const job = await service.createJob({ projectId: project.id, goal: "work" });
  assert.equal(service.getJob(job.id).capability_profile, null, "the job requested nothing in particular");
  await service.runJob(job.id, { model: "opencode-go/deepseek-v4-pro" });
  const attempt = service.status(job.id).attempts.at(-1);

  assert.equal(service.getRuntimeProvenance(attempt.id).applied_capability_profile, "restricted");
  assert.equal(
    service.assessExperimentalCondition(attempt.id, { capabilityProfile: "trusted" }).valid,
    false,
    "the composed profile decides, not the job's request",
  );
});

test("a second, contradictory receipt cannot overwrite the first", async (t) => {
  // The table carries immutability triggers, but the writer used INSERT OR REPLACE. SQLite resolves
  // a primary-key collision by deleting and re-inserting, and does not fire delete triggers for that
  // unless recursive_triggers is on -- so the guarantee the reader trusts was watching a receipt get
  // rewritten and saying nothing.
  const { service, project } = await fixture(t, backendWithProvenance({
    appliedModel: "deepseek-v4-pro", appliedExecutor: "harness", appliedSource: "harness-profile-patch",
  }));
  const attempt = await runOnce(service, project);
  const first = service.getRuntimeProvenance(attempt.id);
  assert.equal(first.applied_executor, "harness");

  service.recordRuntimeProvenance({
    attemptId: attempt.id,
    model: "opencode-go/deepseek-v4-flash",
    backend: { constructor: { name: "OpenCodeBackend" } },
    selection: { selected: "opencode" },
    backendResult: { provenance: { appliedModel: "deepseek-v4-flash", appliedExecutor: "opencode" } },
    requestedProfile: null,
  });

  const after = service.getRuntimeProvenance(attempt.id);
  assert.deepEqual(after, first, "the first account of what ran must survive intact");
  // The disagreement is not discarded either; it becomes evidence of its own.
  assert.equal(
    service.db.prepare(
      "SELECT COUNT(*) AS count FROM events WHERE kind = 'PROVENANCE_CONFLICT' AND entity_id = ?",
    ).get(attempt.id).count,
    1,
  );
});

test("a requested value never satisfies an experimental condition on its own", async (t) => {
  // The module's own rule, previously broken by the module itself: assess fell back to `requested`
  // when `applied` was absent, so a condition could pass because delegate-wave ASKED for something
  // with no evidence it was ever applied.
  const { service, project } = await fixture(t, backendWithProvenance({
    // The backend reports nothing it can prove.
  }, { profile: "trusted", effort: "high" }));
  const attempt = await runOnce(service, project, "opencode-go/deepseek-v4-pro");
  const record = service.getRuntimeProvenance(attempt.id);

  // Intent was recorded, which is right: it explains what we were trying to do.
  assert.equal(record.requested_model, "opencode-go/deepseek-v4-pro");
  assert.equal(record.requested_effort, "high");
  assert.equal(record.requested_capability_profile, "trusted");
  // But nothing was established.
  assert.equal(record.applied_model, null);
  assert.equal(record.applied_effort, null);

  for (const expected of [
    { capabilityProfile: "trusted" },
    { model: "deepseek-v4-pro" },
    { effort: "high" },
  ]) {
    const verdict = service.assessExperimentalCondition(attempt.id, expected);
    assert.equal(verdict.valid, false, `${JSON.stringify(expected)} must not pass on intent alone`);
    assert.ok(
      verdict.reasons.some((reason) => /cannot be established from runtime evidence/.test(reason)),
      `expected an unestablished reason, got: ${verdict.reasons.join("; ")}`,
    );
  }

  // The executor is the one dimension the DISPATCHER can prove without the backend's help: it
  // constructed that object and called it. So it is established -- as FakeBackend -- and the
  // condition fails because it is the wrong executor, not because nothing is known.
  const executorVerdict = service.assessExperimentalCondition(attempt.id, { executor: "harness" });
  assert.equal(executorVerdict.valid, false);
  assert.ok(executorVerdict.reasons.some((reason) => /executor was FakeBackend/.test(reason)));
});

test("observed evidence can establish a dimension that applied evidence missed", async (t) => {
  // The one direction the hierarchy allows: observation supersedes a missing applied value for the
  // exact dimension it independently establishes.
  const { service, project } = await fixture(t, backendWithProvenance({
    appliedExecutor: "harness", appliedSource: "harness-profile-patch",
    observedModel: "deepseek-v4-pro", observedSource: "provider-report",
  }));
  const attempt = await runOnce(service, project);
  assert.equal(service.getRuntimeProvenance(attempt.id).applied_model, null);
  assert.equal(
    service.assessExperimentalCondition(attempt.id, { model: "deepseek-v4-pro" }).valid,
    true,
    "an independently observed model establishes the model",
  );
});

test("status derivation is a pure function of what is known", () => {
  const base = { requested_model: "m", requested_effort: "high", applied_model: "m", applied_effort: "high" };
  assert.equal(deriveProvenanceStatus({ ...base }).status, PROVENANCE_STATUS.UNVERIFIED);
  assert.equal(
    deriveProvenanceStatus({ ...base, observed_model: "m", observed_effort: "high" }).status,
    PROVENANCE_STATUS.VERIFIED,
  );
  assert.equal(deriveProvenanceStatus({ ...base, observed_model: "m" }).status, PROVENANCE_STATUS.PARTIAL);
  assert.equal(deriveProvenanceStatus({ ...base, observed_model: "other" }).status, PROVENANCE_STATUS.CONTRADICTED);
  // A route prefix is not a different model.
  assert.equal(
    deriveProvenanceStatus({ requested_model: "route/m", applied_model: "route/m", observed_model: "m" }).status,
    PROVENANCE_STATUS.VERIFIED,
  );
  // With no effort ever requested, an observed model alone is enough to be verified.
  assert.equal(
    deriveProvenanceStatus({ requested_model: "m", applied_model: "m", observed_model: "m" }).status,
    PROVENANCE_STATUS.VERIFIED,
  );
  assert.equal(assessExperimentalCondition(null, {}).valid, false);
});
