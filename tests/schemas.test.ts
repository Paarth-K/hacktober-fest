import { describe, expect, it } from "vitest";
import { loadDemoFixture } from "../src/shared/fixtures.js";
import { ClientEnvelopeSchema, ClientMessageSchema, ServerEnvelopeSchema, makeEnvelope } from "../src/shared/events.js";
import { ChangeBatchSchema, isSafeRelPath } from "../src/shared/schemas.js";

describe("shared contract", () => {
  it("demo fixture validates", () => {
    const f = loadDemoFixture();
    expect(f.tasks.map((t) => t.status)).toEqual(["verified_complete", "user_confirmed", "activity_detected", "needs_verification", "not_started"]);
    expect(f.changeBatches[0]!.changes.map((c) => c.kind)).toEqual(["create", "modify", "delete"]);
  });

  it("safe relative paths", () => {
    for (const ok of ["a.ts", "src/auth/login.ts", ".github/x.yml", "a b/c.ts"]) expect(isSafeRelPath(ok), ok).toBe(true);
    for (const bad of ["", "/etc/passwd", "../x", "a/../b", "a\\b", "C:/x", "c:\\x", "./a", "a//b", "a/", "a\0b"]) expect(isSafeRelPath(bad), bad).toBe(false);
  });

  it("rejects change batches with unsafe paths", () => {
    const b = loadDemoFixture().changeBatches[0]!;
    expect(ChangeBatchSchema.safeParse({ ...b, changes: [{ ...b.changes[0]!, path: "../secret" }] }).success).toBe(false);
  });

  it("envelopes round-trip and unknown types are rejected", () => {
    const env = makeEnvelope("ui_1", { type: "confirm_task", payload: { taskId: "t1" } });
    expect(ClientEnvelopeSchema.parse(JSON.parse(JSON.stringify(env)))).toMatchObject({ type: "confirm_task", eventId: env.eventId });
    expect(ClientMessageSchema.safeParse({ type: "set_status", payload: { status: "verified_complete" } }).success).toBe(false);
    const s = makeEnvelope("sess", { type: "task_deleted", payload: { taskId: "t1" } });
    expect(ServerEnvelopeSchema.safeParse(s).success).toBe(true);
  });

  it("update_task cannot carry status or met flags", () => {
    const parsed = ClientMessageSchema.parse({ type: "update_task", payload: { taskId: "t", status: "verified_complete", acceptanceCriteria: [{ text: "x", met: true }] } });
    expect(parsed.payload).not.toHaveProperty("status");
    expect((parsed.payload as { acceptanceCriteria: object[] }).acceptanceCriteria[0]).not.toHaveProperty("met");
  });
});
