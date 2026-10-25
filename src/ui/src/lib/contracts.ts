import { z } from "zod";

export const taskStatusSchema = z.enum([
  "not_started",
  "activity_detected",
  "needs_verification",
  "verified_complete",
  "user_confirmed"
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const acceptanceCriterionSchema = z.object({
  id: z.string(),
  text: z.string(),
  met: z.boolean(),
  metBy: z.enum(["none", "check", "user"]),
  checkCommandId: z.string().optional()
});

export const statusHistorySchema = z.object({
  status: taskStatusSchema,
  timestamp: z.string(),
  reason: z.string()
});

export const taskSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  milestoneId: z.string().optional(),
  title: z.string(),
  order: z.number(),
  status: taskStatusSchema,
  acceptanceCriteria: z.array(acceptanceCriterionSchema),
  evidenceIds: z.array(z.string()),
  verificationRunIds: z.array(z.string()),
  statusHistory: z.array(statusHistorySchema),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastActivityAt: z.string().optional()
});
export type Task = z.infer<typeof taskSchema>;

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  rootPath: z.string(),
  goal: z.string(),
  checkCommands: z.array(z.object({ id: z.string(), command: z.string() })),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type Project = z.infer<typeof projectSchema>;

export const progressSchema = z.object({
  projectId: z.string(),
  total: z.number(),
  byStatus: z.record(taskStatusSchema, z.number()),
  percentComplete: z.number().min(0).max(100),
  criteriaMet: z.number(),
  criteriaTotal: z.number(),
  stalledTaskIds: z.array(z.string()),
  regressedTaskIds: z.array(z.string()),
  lastActivityAt: z.string().nullable(),
  computedAt: z.string()
});
export type ProgressSnapshot = z.infer<typeof progressSchema>;

export const fileChangeSchema = z.object({
  path: z.string(),
  kind: z.enum(["created", "modified", "deleted", "renamed"]),
  hunks: z.array(z.object({ startLine: z.number(), endLine: z.number() }))
});

export const changeBatchSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  timestamp: z.string(),
  source: z.string(),
  changes: z.array(fileChangeSchema),
  omissions: z.array(z.string()),
  suggestedTaskLinks: z.array(z.object({
    taskId: z.string(),
    score: z.number(),
    reason: z.string()
  }))
});
export type ChangeBatch = z.infer<typeof changeBatchSchema>;

export const verificationRunSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  taskIds: z.array(z.string()),
  command: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  exitCode: z.number().nullable(),
  durationMs: z.number(),
  outputTail: z.string(),
  result: z.enum(["pass", "fail", "timeout", "error"])
});
export type VerificationRun = z.infer<typeof verificationRunSchema>;

export const explanationSchema = z.object({
  summary: z.string(),
  behaviorChanges: z.array(z.string()),
  concepts: z.array(z.string()),
  concerns: z.array(z.string()),
  evidence: z.array(z.object({ path: z.string(), startLine: z.number(), endLine: z.number(), valid: z.boolean() })),
  uncertainties: z.array(z.string()),
  quiz: z.object({ question: z.string(), answer: z.string() }).optional(),
  provider: z.string(),
  mode: z.enum(["live", "mock", "offline"])
});
export type Explanation = z.infer<typeof explanationSchema>;

export const breakdownSchema = z.object({
  tasks: z.array(z.object({ title: z.string(), acceptanceCriteria: z.array(z.string()) })),
  provider: z.string(),
  mode: z.enum(["live", "mock", "offline"])
});
export type BreakdownSuggestion = z.infer<typeof breakdownSchema>;

export const preferencesSchema = z.object({
  pinned: z.boolean(),
  compact: z.boolean(),
  level: z.enum(["beginner", "intermediate", "expert"]),
  theme: z.enum(["system", "light", "dark"]),
  editorCommand: z.string()
});
export type Preferences = z.infer<typeof preferencesSchema>;

export const stateSnapshotSchema = z.object({
  project: projectSchema.nullable(),
  tasks: z.array(taskSchema),
  progress: progressSchema.nullable(),
  changes: z.array(changeBatchSchema),
  verifications: z.array(verificationRunSchema),
  explanation: explanationSchema.nullable(),
  breakdown: breakdownSchema.nullable(),
  preferences: preferencesSchema
});
export type CompanionState = z.infer<typeof stateSnapshotSchema>;

const envelopeBase = {
  sessionId: z.string(),
  eventId: z.string(),
  timestamp: z.string()
};

export const incomingEnvelopeSchema = z.discriminatedUnion("type", [
  z.object({ ...envelopeBase, type: z.literal("state_snapshot"), payload: stateSnapshotSchema }),
  z.object({ ...envelopeBase, type: z.literal("progress_updated"), payload: progressSchema }),
  z.object({ ...envelopeBase, type: z.literal("change_batch"), payload: changeBatchSchema }),
  z.object({ ...envelopeBase, type: z.literal("task_updated"), payload: taskSchema }),
  z.object({ ...envelopeBase, type: z.literal("verification_result"), payload: verificationRunSchema }),
  z.object({ ...envelopeBase, type: z.literal("explanation"), payload: explanationSchema }),
  z.object({ ...envelopeBase, type: z.literal("breakdown_suggestion"), payload: breakdownSchema }),
  z.object({ ...envelopeBase, type: z.literal("report_exported"), payload: z.object({ markdown: z.string(), savedPath: z.string().optional() }) }),
  z.object({ ...envelopeBase, type: z.literal("engine_error"), payload: z.object({ code: z.string(), message: z.string() }) })
]);
export type IncomingEnvelope = z.infer<typeof incomingEnvelopeSchema>;

export type OutgoingType =
  | "select_task" | "create_task" | "update_task" | "reorder_tasks"
  | "link_change_to_task" | "request_breakdown" | "accept_breakdown"
  | "run_verification" | "export_report" | "preferences_changed"
  | "request_explanation" | "ask_followup" | "confirm_task"
  | "open_file" | "window_mode_changed";

export interface OutgoingEnvelope {
  sessionId: string;
  eventId: string;
  type: OutgoingType;
  timestamp: string;
  payload: unknown;
}
