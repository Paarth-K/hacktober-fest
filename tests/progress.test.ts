import { describe, expect, it } from "vitest";
import { applyActivity, applyVerification, computeProgress, confirmByUser, setCriterionByUser } from "../src/core/progress.js";
import { loadDemoFixture } from "../src/shared/fixtures.js";
import type { Task, VerificationRun } from "../src/shared/schemas.js";

const AT = "2026-10-25T22:00:00.000Z";
const task = (over: Partial<Task> = {}): Task => ({
  id: "t1", projectId: "p", title: "Add login", order: 0, status: "not_started",
  acceptanceCriteria: [{ id: "c1", text: "login works", met: false, metBy: "none", checkCommandId: "chk" }],
  linkedChangeBatchIds: [], evidenceIds: [], verificationRunIds: [], statusHistory: [], createdAt: AT, updatedAt: AT, ...over,
});
const run = (result: VerificationRun["result"], over: Partial<VerificationRun> = {}): VerificationRun => ({
  id: `run_${result}_${Math.random()}`, projectId: "p", taskIds: [], checkCommandId: "chk", command: "npm test",
  startedAt: AT, finishedAt: AT, exitCode: result === "pass" ? 0 : 1, durationMs: 10, outputTail: "", result, ...over,
});
const check = { id: "chk", label: "tests" };

describe("progress maths", () => {
  it("counts only verified_complete + user_confirmed", () => {
    const f = loadDemoFixture();
    const p = computeProgress("proj_demo", f.tasks, { now: new Date(AT) });
    expect(p.total).toBe(5);
    expect(p.percentComplete).toBe(40);
    expect(p.byStatus).toEqual({ not_started: 1, activity_detected: 1, needs_verification: 1, verified_complete: 1, user_confirmed: 1 });
    expect(p.criteriaMet).toBe(2);
    expect(p.criteriaTotal).toBe(6);
    expect(p.regressedTaskIds).toEqual(["task_crud"]);
    expect(p.unverifiedActivityTaskIds).toEqual(["task_login"]);
  });

  it("empty project is 0%", () => {
    expect(computeProgress("p", []).percentComplete).toBe(0);
  });

  it("activity never raises percentComplete", () => {
    const before = computeProgress("p", [task()]).percentComplete;
    const t = applyActivity(task(), "cb1", ["ev1"], AT);
    expect(t.status).toBe("activity_detected");
    expect(t.statusHistory.at(-1)).toMatchObject({ from: "not_started", to: "activity_detected" });
    expect(computeProgress("p", [t]).percentComplete).toBe(before);
    // activity on an in-flight task leaves its status alone
    expect(applyActivity({ ...t, status: "needs_verification" }, "cb2", [], AT).status).toBe("needs_verification");
  });

  it("detects stalled tasks", () => {
    const old = task({ id: "a", status: "activity_detected", lastActivityAt: "2026-10-25T21:00:00.000Z" });
    const fresh = task({ id: "b", status: "activity_detected", lastActivityAt: "2026-10-25T21:59:00.000Z" });
    const p = computeProgress("p", [old, fresh], { now: new Date(AT), stallMinutes: 15 });
    expect(p.stalledTaskIds).toEqual(["a"]);
  });
});

describe("status rules", () => {
  it("passing linked check -> verified_complete; failing does not", () => {
    const t = applyActivity(task(), "cb1", [], AT);
    const failed = applyVerification(t, run("fail"), check);
    expect(failed.status).toBe("needs_verification");
    expect(failed.acceptanceCriteria[0]!.met).toBe(false);
    const passed = applyVerification(failed, run("pass"), check);
    expect(passed.status).toBe("verified_complete");
    expect(passed.acceptanceCriteria[0]).toMatchObject({ met: true, metBy: "check" });
    expect(passed.statusHistory.at(-1)).toMatchObject({ to: "verified_complete", actor: "check" });
  });

  it("not all criteria met -> stays not complete", () => {
    const t = task({ acceptanceCriteria: [
      { id: "c1", text: "a", met: false, metBy: "none", checkCommandId: "chk" },
      { id: "c2", text: "b", met: false, metBy: "none" },
    ] });
    const passed = applyVerification(applyActivity(t, "cb", [], AT), run("pass"), check);
    expect(passed.status).toBe("activity_detected");
    expect(setCriterionByUser(passed, "c2", true, AT).status).toBe("verified_complete");
  });

  it("regression: previously passing check now fails", () => {
    const verified = applyVerification(applyActivity(task(), "cb", [], AT), run("pass"), check);
    const regressed = applyVerification(verified, run("fail"), check);
    expect(regressed.status).toBe("needs_verification");
    expect(regressed.regressedAt).toBeDefined();
    expect(regressed.statusHistory.at(-1)!.reason).toMatch(/Regression/);
    expect(computeProgress("p", [regressed]).regressedTaskIds).toEqual(["t1"]);
    const fixed = applyVerification(regressed, run("pass"), check);
    expect(fixed.regressedAt).toBeUndefined();
    expect(fixed.status).toBe("verified_complete");
  });

  it("timeout and error never complete", () => {
    expect(applyVerification(task({ status: "activity_detected" }), run("timeout"), check).status).toBe("needs_verification");
    expect(applyVerification(task({ status: "activity_detected" }), run("error"), check).status).toBe("needs_verification");
  });

  it("unrelated check does not touch the task", () => {
    const t = task();
    expect(applyVerification(t, run("pass", { checkCommandId: "other" }), { id: "other", label: "x" })).toBe(t);
  });

  it("user ticks -> user_confirmed; confirm_task -> user_confirmed", () => {
    const t = task({ acceptanceCriteria: [{ id: "c1", text: "a", met: false, metBy: "none" }] });
    const ticked = setCriterionByUser(t, "c1", true, AT);
    expect(ticked.status).toBe("user_confirmed");
    expect(setCriterionByUser(ticked, "c1", false, AT).status).toBe("needs_verification");
    expect(confirmByUser(task(), "looks good", AT)).toMatchObject({ status: "user_confirmed" });
  });
});
