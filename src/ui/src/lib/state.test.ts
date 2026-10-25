import { describe, expect, it } from "vitest";
import { makeEnvelope } from "../../../shared/index.js";
import { loadDemoFixture } from "../../../shared/fixtures.js";
import { applyEngineEvent, initialUiState, type UiState } from "./state.js";

function demoState(): UiState {
  const fixture = loadDemoFixture();
  return {
    ...initialUiState,
    project: fixture.project,
    tasks: fixture.tasks,
    changeBatches: fixture.changeBatches,
    verificationRuns: fixture.verificationRuns,
    progress: {
      projectId: fixture.project.id,
      total: 5,
      byStatus: { not_started: 1, activity_detected: 1, needs_verification: 1, verified_complete: 1, user_confirmed: 1 },
      percentComplete: 40,
      criteriaMet: 2,
      criteriaTotal: 6,
      unverifiedActivityTaskIds: ["task_login"],
      stalledTaskIds: [],
      regressedTaskIds: ["task_crud"],
      lastActivityAt: "2026-10-25T21:28:00.000Z",
      computedAt: "2026-10-25T21:30:00.000Z",
    },
  };
}

describe("applyEngineEvent", () => {
  it("adds activity without changing verified completion", () => {
    const state = demoState();
    const batch = { ...state.changeBatches[0]!, id: "cb_new" };
    const next = applyEngineEvent(state, makeEnvelope("engine", { type: "change_batch", payload: batch }));
    expect(next.changeBatches).toHaveLength(state.changeBatches.length + 1);
    expect(next.progress?.percentComplete).toBe(40);
  });

  it("deduplicates change batches by stable id", () => {
    const state = demoState();
    const next = applyEngineEvent(state, makeEnvelope("engine", { type: "change_batch", payload: state.changeBatches[0]! }));
    expect(next.changeBatches).toHaveLength(state.changeBatches.length);
  });
});
