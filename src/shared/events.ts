// Typed messages between the UI (Tauri webview) and the Node engine over the
// loopback WebSocket. Every frame is one JSON EventEnvelope.
// UI -> engine: ClientMessage. Engine -> UI: ServerMessage.
import { z } from "zod";
import {
  ChangeBatchSchema,
  CheckCommandSchema,
  ExplanationResponseSchema,
  IdSchema,
  IsoDateSchema,
  LevelSchema,
  MilestoneSchema,
  ModelStatusSchema,
  PreferencesSchema,
  ProgressSnapshotSchema,
  ProjectSchema,
  RelPathSchema,
  TaskBreakdownSuggestionSchema,
  TaskSchema,
  VerificationRunSchema,
} from "./schemas.js";

const msg = <T extends string, P extends z.ZodTypeAny>(type: T, payload: P) =>
  z.object({ type: z.literal(type), payload });

const CriterionInputSchema = z.object({
  id: IdSchema.optional(),
  text: z.string().min(1).max(500),
  checkCommandId: IdSchema.optional(),
});

// ---------- UI -> engine ----------

export const ClientMessageSchema = z.discriminatedUnion("type", [
  /** Pick/replace the workspace and project. Starts the observer on rootPath. */
  msg(
    "set_project",
    z.object({
      rootPath: z.string().min(1),
      name: z.string().min(1).max(200).optional(),
      goal: z.string().max(10_000).optional(),
    }),
  ),
  msg(
    "update_project",
    z.object({
      name: z.string().min(1).max(200).optional(),
      goal: z.string().max(10_000).optional(),
      checkCommands: z.array(CheckCommandSchema.partial({ id: true, timeoutMs: true })).optional(),
    }),
  ),
  msg(
    "create_task",
    z.object({
      title: z.string().min(1).max(300),
      acceptanceCriteria: z.array(CriterionInputSchema).max(5).default([]),
      milestoneId: IdSchema.optional(),
    }),
  ),
  /** Edits title / criteria text / check links. Cannot set status or met flags. */
  msg(
    "update_task",
    z.object({
      taskId: IdSchema,
      title: z.string().min(1).max(300).optional(),
      acceptanceCriteria: z.array(CriterionInputSchema).max(5).optional(),
      milestoneId: IdSchema.nullable().optional(),
    }),
  ),
  msg("delete_task", z.object({ taskId: IdSchema })),
  msg("reorder_tasks", z.object({ taskIds: z.array(IdSchema) })),
  /** Explicit user tick/untick of one acceptance criterion. */
  msg("set_criterion_met", z.object({ taskId: IdSchema, criterionId: IdSchema, met: z.boolean() })),
  /** Accept/reassign a change batch to a task. taskId null = dismiss the suggestion. */
  msg("link_change_to_task", z.object({ changeBatchId: IdSchema, taskId: IdSchema.nullable() })),
  msg("request_breakdown", z.object({ goal: z.string().min(1).max(10_000), promptText: z.string().max(20_000).optional() })),
  /** The (possibly user-edited) suggestion tasks to add. Only now do they count. */
  msg(
    "accept_breakdown",
    z.object({
      requestId: IdSchema,
      tasks: z.array(z.object({ title: z.string().min(1).max(300), acceptanceCriteria: z.array(z.string().min(1).max(500)).max(5) })).min(1).max(20),
    }),
  ),
  /** User clicked Verify for one configured check command. */
  msg("run_verification", z.object({ checkCommandId: IdSchema, taskIds: z.array(IdSchema).default([]) })),
  msg("export_report", z.object({ saveToWorkspace: z.boolean().default(false) })),
  msg(
    "request_explanation",
    z.object({
      taskId: IdSchema.optional(),
      changeBatchIds: z.array(IdSchema).min(1),
      level: LevelSchema,
      wantQuiz: z.boolean().default(false),
    }),
  ),
  msg(
    "ask_followup",
    z.object({
      question: z.string().min(1).max(2000),
      taskId: IdSchema.optional(),
      changeBatchIds: z.array(IdSchema).default([]),
      level: LevelSchema,
      wantQuiz: z.boolean().default(false),
    }),
  ),
  msg("preferences_changed", PreferencesSchema.partial()),
  /** Explicit manual "this task is done" -> user_confirmed. */
  msg("confirm_task", z.object({ taskId: IdSchema, reason: z.string().max(500).optional() })),
  /** Ask the engine to validate a path is inside the workspace before opening it. */
  msg("open_file", z.object({ path: RelPathSchema, line: z.number().int().positive().optional() })),
  msg("select_task", z.object({ taskId: IdSchema.nullable() })),
  msg("window_mode_changed", z.object({ compact: z.boolean(), alwaysOnTop: z.boolean().optional() })),
  /** Ask for a fresh state_snapshot (e.g. after reconnect). */
  msg("request_snapshot", z.object({})),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ClientMessageType = ClientMessage["type"];

// ---------- engine -> UI ----------

export const EngineInfoSchema = z.object({
  version: z.string(),
  sessionId: IdSchema,
  mock: z.boolean(),
  dataDir: z.string(),
  observerRunning: z.boolean(),
});

export const StateSnapshotSchema = z.object({
  project: ProjectSchema.nullable(),
  milestones: z.array(MilestoneSchema),
  tasks: z.array(TaskSchema),
  progress: ProgressSnapshotSchema.nullable(),
  /** Most recent change batches (bounded, newest last). */
  changeBatches: z.array(ChangeBatchSchema),
  verificationRuns: z.array(VerificationRunSchema),
  preferences: PreferencesSchema,
  modelStatus: ModelStatusSchema,
  engine: EngineInfoSchema,
  selectedTaskId: IdSchema.nullable(),
});
export type StateSnapshot = z.infer<typeof StateSnapshotSchema>;

export const ServerMessageSchema = z.discriminatedUnion("type", [
  msg("state_snapshot", StateSnapshotSchema),
  msg("progress_updated", ProgressSnapshotSchema),
  msg("change_batch", ChangeBatchSchema),
  msg("task_updated", TaskSchema),
  msg("task_deleted", z.object({ taskId: IdSchema })),
  msg("verification_started", z.object({ runId: IdSchema, checkCommandId: IdSchema, command: z.string(), taskIds: z.array(IdSchema) })),
  msg("verification_result", VerificationRunSchema),
  msg("breakdown_suggestion", TaskBreakdownSuggestionSchema),
  /** Explanation, follow-up answer and quiz all arrive here (quiz in payload.quiz). */
  msg("explanation_result", ExplanationResponseSchema),
  msg("explanation_error", z.object({ requestId: IdSchema, error: z.string(), modelStatus: ModelStatusSchema })),
  msg("report_ready", z.object({ markdown: z.string(), savedPath: z.string().optional() })),
  msg("model_status", ModelStatusSchema),
  msg("preferences_updated", PreferencesSchema),
  msg(
    "open_file_result",
    z.object({ ok: z.boolean(), path: z.string(), absPath: z.string().optional(), line: z.number().int().positive().optional(), error: z.string().optional() }),
  ),
  /** Non-fatal error for a specific client request (replyTo set on envelope). */
  msg("error", z.object({ code: z.string(), message: z.string() })),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type ServerMessageType = ServerMessage["type"];

// ---------- Envelope ----------

const EnvelopeBase = {
  sessionId: IdSchema,
  /** Stable unique id; receivers dedupe on it. */
  eventId: IdSchema,
  timestamp: IsoDateSchema,
  /** eventId of the client message this answers, if any. */
  replyTo: IdSchema.optional(),
};

export const ClientEnvelopeSchema = z.intersection(z.object(EnvelopeBase), ClientMessageSchema);
export const ServerEnvelopeSchema = z.intersection(z.object(EnvelopeBase), ServerMessageSchema);
export type ClientEnvelope = z.infer<typeof ClientEnvelopeSchema>;
export type ServerEnvelope = z.infer<typeof ServerEnvelopeSchema>;
export type EventEnvelope = ClientEnvelope | ServerEnvelope;

export type PayloadOf<M extends { type: string; payload: unknown }, T extends M["type"]> = Extract<M, { type: T }>["payload"];

export function newId(prefix = "id"): string {
  const rand =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${rand}`;
}

export function makeEnvelope<M extends { type: string; payload: unknown }>(
  sessionId: string,
  message: M,
  replyTo?: string,
): M & { sessionId: string; eventId: string; timestamp: string; replyTo?: string } {
  return { sessionId, eventId: newId("evt"), timestamp: new Date().toISOString(), ...(replyTo ? { replyTo } : {}), ...message };
}
