// Prepare, validate, publish. The branch moves once, to a tree already proven green.
//
// The obvious design is to integrate, run the tests, and roll back if they fail. This is not that.
// Rollback as a happy-path mechanism means every ordinary failure briefly moves a real branch, and
// "briefly" is indistinguishable from "permanently" to anything that fetched, cloned or built from
// it in between. Here an ordinary failure never touches the branch at all.
//
//   candidate C, base B, current target head H
//         -> disposable worktree at H
//         -> reconcile C onto H            (fast-forward when B == H, replay otherwise)
//         -> prepared commit R, tree T
//         -> run the validation plan against R's exact tree
//         -> green? compare-and-swap H -> R
//         -> CAS lost because H moved again? discard, retry from the new head, bounded
//
// THIS LAYER HAS NO SEMANTIC AUTHORITY.
//
// It knows a candidate commit, a target sha, an expected old sha, a result commit and validation
// evidence. It does not decide whether a conflict resolution preserves what the user meant -- that
// is ManagerService's judgment and, above it, Hermes'. A conflict here is reported as a fact, not
// resolved as an opinion. Keeping the integrator dumb is what stops "it merged cleanly" from being
// mistaken for "it still does what was asked".
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { recordEvent, transaction } from "../db.js";
import {
  cherryPick, createDetachedWorktree, isAncestor, listWorktrees, removeWorktree,
  resolveRevision, updateRefCas,
} from "../git.js";
import { runProcess, runShell } from "../process.js";

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${crypto.randomUUID()}`;

// Bounded on purpose. A branch under constant concurrent traffic could otherwise keep invalidating
// a freshly prepared integration forever, spending real validation time on every round.
export const MAX_PUBLISH_ATTEMPTS = 3;

export class ConflictRequiresJudgment extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = "ConflictRequiresJudgment";
    this.detail = detail;
  }
}

export class SafeIntegrator {
  constructor({ dispatcher }) {
    if (!dispatcher) throw new Error("SafeIntegrator requires a dispatcher");
    this.dispatcher = dispatcher;
    this.db = dispatcher.db;
  }

  record(attemptId) {
    return this.db.prepare("SELECT * FROM staged_integrations WHERE id = ?").get(attemptId) ?? null;
  }

  update(attemptId, fields) {
    const keys = Object.keys(fields);
    this.db.prepare(
      `UPDATE staged_integrations SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ?
       WHERE id = ?`,
    ).run(...keys.map((k) => fields[k]), now(), attemptId);
  }

  // The whole operation: prepare a proven tree, then publish it, retrying from a moved head.
  async integrate({ jobId, sessionId = null, candidateAttemptId }) {
    const job = this.dispatcher.getJob(jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);
    const project = this.dispatcher.getProject(job.project_id);
    const candidate = this.db.prepare("SELECT * FROM attempts WHERE id = ?").get(candidateAttemptId);
    if (!candidate) throw new Error(`Unknown attempt: ${candidateAttemptId}`);
    if (!candidate.result_commit) throw new Error(`Attempt ${candidateAttemptId} has no candidate commit`);
    if (candidate.validation_state !== "PASSED") {
      throw new Error(`Attempt ${candidateAttemptId} did not pass validation; it cannot be integrated`);
    }

    let lastOutcome = null;
    for (let attemptNumber = 1; attemptNumber <= MAX_PUBLISH_ATTEMPTS; attemptNumber += 1) {
      const staged = await this.prepare({
        job, project, candidate, sessionId, attemptNumber,
      });
      if (staged.validation_state !== "PASSED") {
        // Never touched the branch. The candidate and everything built from it are preserved for
        // the manager to reason about.
        return { published: false, reason: "VALIDATION_FAILED", attempt: this.record(staged.id) };
      }
      const published = await this.publish(staged.id);
      if (published.published) return { published: true, attempt: this.record(staged.id) };
      lastOutcome = published.reason;
      // CAS refused because the head moved after validation. The prepared tree is now a tree for a
      // world that no longer exists, so it is discarded rather than forced.
      this.update(staged.id, { publish_state: "SUPERSEDED", outcome: published.reason });
    }
    return { published: false, reason: lastOutcome ?? "RETRY_EXHAUSTED", attempts: MAX_PUBLISH_ATTEMPTS };
  }

  // Builds and proves the integrated tree, without going near the real branch.
  async prepare({ job, project, candidate, sessionId = null, attemptNumber = 1 }) {
    // The branch this job was bound to at creation, which every later step reads back off the
    // staged row. Resolving the project's current default here would publish a session's work onto
    // a branch it was never based on -- the failure this whole binding exists to make impossible.
    const targetRef = job.target_branch;
    const observed = await resolveRevision(project.repo_path, targetRef);

    const attemptId = id("sint");
    transaction(this.db, () => {
      this.db.prepare(`INSERT INTO staged_integrations(
        id, session_id, job_id, project_id, target_ref, candidate_commit, candidate_base_sha,
        observed_target_sha, publish_state, attempt_number, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PREPARING', ?, ?, ?)`).run(
        attemptId, sessionId, job.id, project.id, targetRef,
        candidate.result_commit, job.base_sha, observed, attemptNumber, now(), now(),
      );
    });

    const worktree = path.join(
      this.dispatcher.paths.worktrees ?? path.join(this.dispatcher.root, "worktrees"),
      `integrate-${attemptId}`,
    );
    try {
      await createDetachedWorktree(project.repo_path, worktree, observed);
      const prepared = await this.reconcile({ worktree, project, candidate, observed, attemptId });
      const tree = (await runProcess("git", ["-C", worktree, "rev-parse", `${prepared}^{tree}`])).stdout.trim();

      // A reconciliation must not introduce a protected-path change the original worker could not
      // have made. Measured as the delta from the OBSERVED TARGET to the prepared tree, so a
      // protected file the target itself already changed concurrently is not blamed on this session
      // -- only what this integration would newly impose.
      await this.assertReconciliationRespectsProtectedPaths({ project, observed, prepared, worktree });

      const plan = JSON.parse(project.validation_json || "[]");
      const planDigest = crypto.createHash("sha256").update(JSON.stringify(plan)).digest("hex");
      this.update(attemptId, {
        prepared_commit: prepared, prepared_tree: tree,
        validation_plan_digest: planDigest, publish_state: "PREPARED",
      });

      // Validated against the tree that will be published, in the worktree that holds exactly it.
      const passed = await this.validatePrepared({ worktree, plan, attemptId, project, prepared });
      this.update(attemptId, { validation_state: passed ? "PASSED" : "FAILED" });
      if (!passed) this.update(attemptId, { publish_state: "FAILED", outcome: "validation failed on the prepared tree" });
      return this.record(attemptId);
    } catch (error) {
      this.update(attemptId, { publish_state: "FAILED", outcome: error.message });
      if (error instanceof ConflictRequiresJudgment) throw error;
      return this.record(attemptId);
    } finally {
      // The staged worktree is disposable by construction; nothing depends on it after this.
      await removeWorktree(project.repo_path, worktree).catch(() => {});
      fs.rmSync(worktree, { recursive: true, force: true });
    }
  }

  // Fast-forward when nothing moved, replay when it did, and refuse to guess when it conflicts.
  async reconcile({ worktree, project, candidate, observed, attemptId }) {
    // Branch drift is ordinary concurrent activity. When the candidate was built on exactly the
    // head we are publishing onto, the candidate commit IS the integrated result.
    if (candidate.start_sha === observed || await isAncestor(project.repo_path, observed, candidate.result_commit)) {
      await runProcess("git", ["-C", worktree, "reset", "--hard", candidate.result_commit]);
      return candidate.result_commit;
    }
    try {
      return await cherryPick(worktree, candidate.result_commit);
    } catch (error) {
      // A conflict is a FACT reported upward, never an opinion resolved here. Whether some
      // resolution still means what the user asked for is ManagerService's judgment, and beyond it
      // Hermes'. The branch has not moved and will not move on this path.
      await runProcess("git", ["-C", worktree, "cherry-pick", "--abort"]).catch(() => {});
      const conflict = new ConflictRequiresJudgment(
        `candidate ${candidate.result_commit.slice(0, 8)} conflicts with ${observed.slice(0, 8)}`,
        {
          attemptId,
          candidateCommit: candidate.result_commit,
          observedTargetSha: observed,
          gitError: error.message,
        },
      );
      throw conflict;
    }
  }

  async validatePrepared({ worktree, plan, attemptId, project, prepared }) {
    for (const command of plan) {
      const result = await runShell(command, { cwd: worktree, timeoutMs: 15 * 60_000 });
      recordEvent(this.db, {
        kind: "STAGED_INTEGRATION_VALIDATION", entityType: "job", entityId: this.record(attemptId).job_id,
        payload: { attemptId, command, exitCode: result.exitCode, preparedCommit: prepared },
      });
      if (result.exitCode !== 0) return false;
    }
    return true;
  }

  // The only step that touches the real branch, and the only one that can.
  async publish(attemptId) {
    const staged = this.record(attemptId);
    if (!staged) throw new Error(`Unknown staged integration: ${attemptId}`);
    if (staged.publish_state === "PUBLISHED") {
      // Already done. A restart that re-drives this must not move the ref a second time.
      return { published: true, reason: "ALREADY_PUBLISHED" };
    }
    if (staged.publish_state !== "PREPARED" || staged.validation_state !== "PASSED") {
      throw new Error(
        `staged integration ${attemptId} is ${staged.publish_state}/${staged.validation_state}; `
        + "only a PREPARED attempt with PASSED validation may publish",
      );
    }
    const project = this.dispatcher.getProject(staged.project_id);

    // The tree that was proven must be the tree that lands. Comparing commits alone would miss a
    // rebuild that produced a different tree under the same id, or a prepared commit rewritten
    // between validation and publication.
    const tree = (await runProcess("git",
      ["-C", project.repo_path, "rev-parse", `${staged.prepared_commit}^{tree}`])).stdout.trim();
    if (tree !== staged.prepared_tree) {
      this.update(attemptId, {
        publish_state: "FAILED",
        outcome: `prepared tree changed since validation: proved ${staged.prepared_tree}, found ${tree}`,
      });
      throw new Error(
        `refusing to publish ${attemptId}: the validated tree is not the tree that would land`,
      );
    }

    // A branch checked out somewhere has a working tree and an index that a ref move would
    // desynchronise, which is how an automatic integration silently eats someone's uncommitted
    // work. Refused mechanically rather than stashed, reset or checked out over.
    const checkedOut = (await listWorktrees(project.repo_path))
      .find((entry) => entry.branch === `refs/heads/${staged.target_ref}` || entry.branch === staged.target_ref);

    if (checkedOut) {
      // The ordinary shape of a working repository: a clone with the target branch checked out.
      //
      // A raw ref update here would leave that worktree's index and files describing a commit that
      // is no longer its head, which is how an automatic integrator quietly corrupts someone's
      // checkout -- and git's own receive-pack refuses it for exactly that reason. But refusing
      // outright would make the commonest repository arrangement permanently ineligible for
      // automatic integration, so a fast-forward that git performs coherently is used instead.
      //
      // Only a fast-forward, and only into a clean worktree. Anything else would mean resolving or
      // discarding work that is not ours.
      const published = await this.publishByFastForward({ staged, project, worktree: checkedOut.path });
      if (!published.published) return published;
      return this.recordPublication(staged);
    }

    try {
      await updateRefCas(
        project.repo_path, `refs/heads/${staged.target_ref}`,
        staged.prepared_commit, staged.observed_target_sha,
      );
    } catch (error) {
      // Lost the race: something landed between validation and publication. The ref is untouched.
      return { published: false, reason: "CAS_REFUSED", detail: error.message };
    }

    return this.recordPublication(staged);
  }

  recordPublication(staged) {
    transaction(this.db, () => {
      this.update(staged.id, {
        publish_state: "PUBLISHED",
        published_from_sha: staged.observed_target_sha,
        published_to_sha: staged.prepared_commit,
      });
      recordEvent(this.db, {
        kind: "STAGED_INTEGRATION_PUBLISHED", entityType: "job", entityId: staged.job_id,
        payload: {
          attemptId: staged.id, targetRef: staged.target_ref,
          from: staged.observed_target_sha, to: staged.prepared_commit, tree: staged.prepared_tree,
        },
      });
    });
    return { published: true, reason: "PUBLISHED" };
  }

  // Whether somebody is mid-thought in that worktree.
  //
  // A preflight check, not a lock. Nothing can lock an arbitrary filesystem against a person with an
  // editor open, so there is an unavoidable window between asking and acting. The invariant that
  // matters is therefore not "we checked" but "we never silently destroy what we find": the actual
  // move is a fast-forward, which git itself refuses when it would overwrite local modifications.
  // Its own seam so the race can be tested rather than assumed away.
  async targetDirtiness(worktree) {
    return (await runProcess("git", ["-C", worktree, "status", "--porcelain"])).stdout.trim();
  }

  // Publication into a live checkout, performed by git so ref, index and files move together.
  async publishByFastForward({ staged, project, worktree }) {
    // Dirty means somebody is mid-thought in there. Never stash, reset or check out over it: the
    // candidate is preserved and whether this genuinely needs the person is a judgment above here.
    const dirty = await this.targetDirtiness(worktree);
    if (dirty) {
      this.update(staged.id, {
        publish_state: "FAILED",
        outcome: `target ${staged.target_ref} is checked out at ${worktree} with uncommitted changes`,
      });
      return { published: false, reason: "TARGET_DIRTY", detail: worktree };
    }

    // The head must still be what was validated against, and the prepared commit must genuinely
    // descend from it -- otherwise "fast-forward" would be discarding something.
    const head = await resolveRevision(worktree, "HEAD");
    if (head !== staged.observed_target_sha) return { published: false, reason: "CAS_REFUSED", detail: head };
    if (!await isAncestor(project.repo_path, head, staged.prepared_commit)) {
      return { published: false, reason: "NOT_FAST_FORWARDABLE", detail: head };
    }

    const merged = await runProcess("git", ["-C", worktree, "merge", "--ff-only", staged.prepared_commit]);
    if (merged.exitCode !== 0) {
      return { published: false, reason: "CAS_REFUSED", detail: merged.stderr.trim() };
    }
    // Believe git, not the exit code: confirm the head is exactly the proven commit.
    const landed = await resolveRevision(worktree, "HEAD");
    if (landed !== staged.prepared_commit) {
      return { published: false, reason: "CAS_REFUSED", detail: landed };
    }
    return { published: true, reason: "PUBLISHED" };
  }

  // What this integration would NEWLY impose on protected paths.
  //
  // Measured from the observed target to the prepared tree, not from the candidate's own base. A
  // protected file that the target itself changed concurrently is that commit's business and is
  // already in the branch; blaming this session for it would refuse integrations for other people's
  // changes. What must not happen is a reconciliation introducing a protected-path modification the
  // original worker was never allowed to make -- resolving a conflict is not a licence to edit
  // whatever the resolution touches.
  //
  // Rename sources count. A rule that only saw destinations would let a protected file be moved
  // away, which changes it as surely as editing it.
  async assertReconciliationRespectsProtectedPaths({ project, observed, prepared, worktree }) {
    const protectedPaths = JSON.parse(project.protected_json || "[]");
    if (!protectedPaths.length) return;
    const diff = await runProcess("git", [
      "-C", worktree, "diff", "--name-status", "-M", `${observed}..${prepared}`,
    ]);
    if (diff.exitCode !== 0) throw new Error(`could not read the integration delta: ${diff.stderr.trim()}`);

    const touched = new Set();
    for (const raw of diff.stdout.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      // A rename line carries status, source and destination; every other status carries one path.
      const parts = line.split(/\t/);
      if (parts.length >= 3) { touched.add(parts[1]); touched.add(parts[2]); }
      else if (parts.length === 2) touched.add(parts[1]);
    }
    // The same rule the worker's own diff is held to, so reconciliation cannot be a way around it.
    this.dispatcher.assertAllowedDiff([...touched], protectedPaths);
  }

  // What a restart makes of an interrupted publication.
  //
  // Answered from the record and the ref, never inferred from history: a commit reachable from the
  // branch does not mean THIS attempt put it there, and a prepared commit that never landed looks
  // identical to one that landed and was then superseded.
  async reconcileStaged(attemptId) {
    const staged = this.record(attemptId);
    if (!staged) throw new Error(`Unknown staged integration: ${attemptId}`);
    if (staged.publish_state === "PUBLISHED") return { state: "PUBLISHED", published: true };
    if (!staged.prepared_commit) return { state: staged.publish_state, published: false };

    const project = this.dispatcher.getProject(staged.project_id);
    const head = await resolveRevision(project.repo_path, staged.target_ref);
    // The only evidence that this exact preparation landed is the head being exactly it. Anything
    // else -- including the commit being an ancestor -- is a different question.
    return { state: staged.publish_state, published: head === staged.prepared_commit, head };
  }
}
