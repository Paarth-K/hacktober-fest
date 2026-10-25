// Validated demo fixtures shared by tests, the mock engine and UI development.
import raw from "../../fixtures/demo-state.json" with { type: "json" };
import { z } from "zod";
import {
  ChangeBatchSchema,
  ExplanationResponseSchema,
  MilestoneSchema,
  ProjectSchema,
  TaskBreakdownSuggestionSchema,
  TaskSchema,
  VerificationRunSchema,
} from "./schemas.js";

export const DemoFixtureSchema = z.object({
  project: ProjectSchema,
  milestones: z.array(MilestoneSchema),
  tasks: z.array(TaskSchema),
  changeBatches: z.array(ChangeBatchSchema),
  verificationRuns: z.array(VerificationRunSchema),
  explanation: ExplanationResponseSchema,
  breakdown: TaskBreakdownSuggestionSchema,
});
export type DemoFixture = z.infer<typeof DemoFixtureSchema>;

/** Returns a fresh deep copy each call so callers can mutate safely. */
export function loadDemoFixture(): DemoFixture {
  return DemoFixtureSchema.parse(structuredClone(raw));
}
