// Progress engine: pure status rules + ProgressSnapshot maths.
// Invariant: only a passing linked check or explicit user action can produce
// verified_complete / user_confirmed. Activity never raises percentComplete.
import { COMPLETE_STATUSES, TASK_STATUSES } from "../shared/schemas.js";
import type { CheckCommand, ProgressSnapshot, Task, TaskStatus, VerificationRun } from "../shared/schemas.js";

export function isComplete(status: TaskStatus): boolean {
  return COMPLETE_STATUSES.includes(status);
}

export function computeProgress(
  projectId: string,
  tasks: Task[],
  opts: { now?: Date; stallMinutes?: number } = {},
): ProgressSnapshot {
  const now = opts.now ?? new Date();
  const stallMs = (opts.stallMinutes ?? 15) * 60_000;
  const byStatus = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
  let criteriaMet = 0;
  let criteriaTotal = 0;
  let lastActivity: number | undefined;
  for (const t of tasks) {
    byStatus[t.status]++;
    criteriaTotal += t.acceptanceCriteria.length;
    criteriaMet += t.acceptanceCriteria.filter((c) => c.met).length;
    if (t.lastActivityAt) lastActivity = Math.max(lastActivity ?? 0, Date.parse(t.lastActivityAt));
  }
  const done = byStatus.verified_complete + byStatus.user_confirmed;
  const total = tasks.length;
  const percentComplete = total === 0 ? 0 : Math.round((done / total) * 1000) / 10;

  const inFlight = (t: Task) => t.status === "activity_detected" || t.status === "needs_verification";
  const unverifiedActivityTaskIds = tasks.filter((t) => inFlight(t) && t.verificationRunIds.length === 0).map((t) => t.id);
  // Stalled: in-flight task idle for >= stallMs while some other task moved more recently than that.
  const stalledTaskIds =
    lastActivity === undefined
      ? []
      : tasks
          .filter((t) => inFlight(t) && t.lastActivityAt)
          .filter((t) => {
            const last = Date.parse(t.lastActivityAt!);
            return now.getTime() - last >= stallMs && lastActivity! - last >= stallMs;
          })
          .map((t) => t.id);
  const regressedTaskIds = tasks.filter((t) => t.regressedAt).map((t) => t.id);

  return {
    projectId,
    total,
    byStatus,
    percentComplete,
    criteriaMet,
    criteriaTotal,
    unverifiedActivityTaskIds,
    stalledTaskIds,
    regressedTaskIds,
    lastActivityAt: lastActivity === undefined ? undefined : new Date(lastActivity).toISOString(),
    computedAt: now.toISOString(),
  };
}

// ---------- Status transitions (return new Task objects; never mutate) ----------

function withStatus(task: Task, to: TaskStatus, reason: string, actor: "system" | "user" | "check", at: string, verificationRunId?: string): Task {
  if (task.status === to) return { ...task, updatedAt: at };
  return {
    ...task,
    status: to,
    updatedAt: at,
    statusHistory: [...task.statusHistory, { at, from: task.status, to, reason, actor, ...(verificationRunId ? { verificationRunId } : {}) }],
  };
}

/** A change batch was linked to the task by the user. Activity only; never completes. */
export function applyActivity(task: Task, changeBatchId: string, evidenceIds: string[], at: string): Task {
  const next: Task = {
    ...task,
    linkedChangeBatchIds: task.linkedChangeBatchIds.includes(changeBatchId) ? task.linkedChangeBatchIds : [...task.linkedChangeBatchIds, changeBatchId],
    evidenceIds: [...new Set([...task.evidenceIds, ...evidenceIds])],
    lastActivityAt: at,
    updatedAt: at,
  };
  if (task.status === "not_started") return withStatus(next, "activity_detected", `Linked change batch ${changeBatchId}`, "user", at);
  return next;
}

/** Recompute status from criteria after a criterion changed. */
export function deriveStatusFromCriteria(task: Task, reason: string, actor: "user" | "check" | "system", at: string, verificationRunId?: string): Task {
  const crit = task.acceptanceCriteria;
  const allMet = crit.length > 0 && crit.every((c) => c.met);
  if (allMet) {
    const anyCheck = crit.some((c) => c.metBy === "check");
    return withStatus(task, anyCheck ? "verified_complete" : "user_confirmed", reason, actor, at, verificationRunId);
  }
  if (isComplete(task.status)) {
    // Was complete, a criterion is no longer met -> needs verification.
    return withStatus(task, "needs_verification", reason, actor, at, verificationRunId);
  }
  return { ...task, updatedAt: at };
}

export function setCriterionByUser(task: Task, criterionId: string, met: boolean, at: string): Task {
  const c = task.acceptanceCriteria.find((x) => x.id === criterionId);
  if (!c) throw new Error(`criterion ${criterionId} not found on task ${task.id}`);
  const next: Task = {
    ...task,
    acceptanceCriteria: task.acceptanceCriteria.map((x) => (x.id === criterionId ? { ...x, met, metBy: met ? "user" : "none" } : x)),
  };
  return deriveStatusFromCriteria(next, `${met ? "Ticked" : "Unticked"} criterion "${c.text}"`, "user", at);
}

export function confirmByUser(task: Task, reason: string | undefined, at: string): Task {
  return withStatus(task, "user_confirmed", reason?.trim() ? `User confirmed: ${reason.trim()}` : "User confirmed task manually", "user", at);
}

/**
 * Apply a finished verification run to a task.
 * - pass: criteria linked to run.checkCommandId become met (metBy check); clears regression.
 * - fail/timeout/error: criteria linked to this check become unmet; if any was previously met by
 *   this check, it's a regression -> needs_verification with reason.
 * Tasks with no linked criterion are only affected if listed in run.taskIds (records the run;
 * a failing run moves in-flight tasks to needs_verification).
 */
export function applyVerification(task: Task, run: VerificationRun, check: Pick<CheckCommand, "id" | "label">): Task {
  const at = run.finishedAt ?? run.startedAt;
  const linked = task.acceptanceCriteria.filter((c) => c.checkCommandId === check.id);
  const explicitlyTargeted = run.taskIds.includes(task.id);
  if (linked.length === 0 && !explicitlyTargeted) return task;

  let next: Task = {
    ...task,
    verificationRunIds: task.verificationRunIds.includes(run.id) ? task.verificationRunIds : [...task.verificationRunIds, run.id],
    updatedAt: at,
  };
  const label = `"${check.label}" (${run.command})`;

  if (run.result === "pass") {
    next = {
      ...next,
      regressedAt: undefined,
      acceptanceCriteria: next.acceptanceCriteria.map((c) => (c.checkCommandId === check.id ? { ...c, met: true, metBy: "check" } : c)),
    };
    if (linked.length === 0) return next; // passing check not linked to any criterion proves nothing specific
    return deriveStatusFromCriteria(next, `Check ${label} passed (exit ${run.exitCode})`, "check", at, run.id);
  }

  const regressed = linked.some((c) => c.met && c.metBy === "check");
  next = {
    ...next,
    acceptanceCriteria: next.acceptanceCriteria.map((c) => (c.checkCommandId === check.id && c.metBy === "check" ? { ...c, met: false, metBy: "none" } : c)),
    ...(regressed ? { regressedAt: at } : {}),
  };
  const outcome = run.result === "fail" ? `failed (exit ${run.exitCode})` : run.result === "timeout" ? "timed out" : "errored";
  const reason = regressed ? `Regression: check ${label} previously passed, now ${outcome}` : `Check ${label} ${outcome}`;
  if (task.status === "not_started" && !regressed) return next;
  if (task.status === "user_confirmed" && linked.length === 0) return next;
  return withStatus(next, "needs_verification", reason, "check", at, run.id);
}
