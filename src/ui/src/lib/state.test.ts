import { describe, expect, it } from "vitest";
import { mockState } from "../fixtures/mock-project";
import { applyEngineEvent } from "./state";

describe("applyEngineEvent", () => {
  it("adds activity without changing verified completion", () => {
    const next = applyEngineEvent(mockState, {
      sessionId: "session",
      eventId: "event-new-change",
      type: "change_batch",
      timestamp: new Date().toISOString(),
      payload: { id: "new-change", sessionId: "session", timestamp: new Date().toISOString(), source: "filesystem", changes: [], omissions: [], suggestedTaskLinks: [] }
    });
    expect(next.changes).toHaveLength(mockState.changes.length + 1);
    expect(next.progress?.percentComplete).toBe(25);
  });

  it("deduplicates change batches by stable id", () => {
    const batch = mockState.changes[0];
    const next = applyEngineEvent(mockState, {
      sessionId: "session",
      eventId: "event-duplicate",
      type: "change_batch",
      timestamp: new Date().toISOString(),
      payload: batch
    });
    expect(next.changes).toHaveLength(mockState.changes.length);
  });
});
