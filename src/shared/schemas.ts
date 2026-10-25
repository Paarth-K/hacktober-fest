// Canonical domain schemas for Local Code Companion.
// Owned by P4. UI, engine, observer and AI all import from here (via src/shared/index.ts).
// Changing a field here is a contract change: post a coord/ note before doing it.
import { z } from "zod";

export const IdSchema = z.string().min(1).max(200);
/** ISO-8601 timestamp string, e.g. new Date().toISOString(). */
export const IsoDateSchema = z.string().min(1);

// ---------- Paths ----------

/**
 * Workspace-relative, POSIX-style, safe path: no leading slash, no backslashes,
 * no drive letters, no "." / ".." / empty segments, no NUL.
 */
export function isSafeRelPath(p: string): boolean {
  if (typeof p !== "string" || p.length === 0 || p.length > 1024) return false;
  if (p.includes("\\") || p.includes("\0")) return false;
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

export const RelPathSchema = z
  .string()
  .refine(isSafeRelPath, { message: "path must be a safe workspace-relative POSIX path" });

// ---------- Project / tasks ----------

export const CheckCommandSchema = z.object({
  id: IdSchema,
  label: z.string().min(1).max(200),
  /** Exact command text shown to the user and run verbatim (cwd = workspace root). */
  command: z.string().min(1).max(1000),
  timeoutMs: z.number().int().positive().max(30 * 60_000).default(120_000),
});
export type CheckCommand = z.infer<typeof CheckCommandSchema>;

export const ProjectSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(200),
  /** Absolute path of the workspace folder on this machine. */
  rootPath: z.string().min(1),
  goal: z.string().max(10_000).default(""),
  checkCommands: z.array(CheckCommandSchema).default([]),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
});
export type Project = z.infer<typeof ProjectSchema>;

export const MilestoneSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  title: z.string().min(1).max(200),
  order: z.number().int().nonnegative(),
});
export type Milestone = z.infer<typeof MilestoneSchema>;

export const TaskStatusSchema = z.enum([
  "not_started",
  "activity_detected",
  "needs_verification",
  "verified_complete",
  "user_confirmed",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export const TASK_STATUSES = TaskStatusSchema.options;
/** The only statuses that count toward percentComplete. */
export const COMPLETE_STATUSES: readonly TaskStatus[] = ["verified_complete", "user_confirmed"];

export const AcceptanceCriterionSchema = z.object({
  id: IdSchema,
  text: z.string().min(1).max(500),
  met: z.boolean().default(false),
  metBy: z.enum(["none", "check", "user"]).default("none"),
  /** CheckCommand.id that verifies this criterion, if linked. */
  checkCommandId: IdSchema.optional(),
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

export const StatusHistoryEntrySchema = z.object({
  at: IsoDateSchema,
  from: TaskStatusSchema.nullable(),
  to: TaskStatusSchema,
  reason: z.string().max(1000),
  actor: z.enum(["system", "user", "check"]),
  verificationRunId: IdSchema.optional(),
});
export type StatusHistoryEntry = z.infer<typeof StatusHistoryEntrySchema>;

export const TaskSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  milestoneId: IdSchema.optional(),
  title: z.string().min(1).max(300),
  order: z.number().int().nonnegative(),
  status: TaskStatusSchema,
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).max(5),
  /** ChangeBatch ids the user accepted (or explicitly linked) for this task. */
  linkedChangeBatchIds: z.array(IdSchema).default([]),
  /** EvidenceRef ids from linked change batches. */
  evidenceIds: z.array(IdSchema).default([]),
  verificationRunIds: z.array(IdSchema).default([]),
  statusHistory: z.array(StatusHistoryEntrySchema).default([]),
  /** Set when a previously passing linked check now fails; cleared on next pass. */
  regressedAt: IsoDateSchema.optional(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  lastActivityAt: IsoDateSchema.optional(),
});
export type Task = z.infer<typeof TaskSchema>;

export const ProgressSnapshotSchema = z.object({
  projectId: IdSchema,
  total: z.number().int().nonnegative(),
  byStatus: z.record(TaskStatusSchema, z.number().int().nonnegative()),
  /** 0..100, = (verified_complete + user_confirmed) / total * 100. 0 when total = 0. */
  percentComplete: z.number().min(0).max(100),
  criteriaMet: z.number().int().nonnegative(),
  criteriaTotal: z.number().int().nonnegative(),
  /** Tasks with activity but no verification run yet. */
  unverifiedActivityTaskIds: z.array(IdSchema),
  stalledTaskIds: z.array(IdSchema),
  regressedTaskIds: z.array(IdSchema),
  lastActivityAt: IsoDateSchema.optional(),
  computedAt: IsoDateSchema,
});
export type ProgressSnapshot = z.infer<typeof ProgressSnapshotSchema>;

export const VerificationResultSchema = z.enum(["pass", "fail", "timeout", "error"]);
export type VerificationResult = z.infer<typeof VerificationResultSchema>;

export const VerificationRunSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  taskIds: z.array(IdSchema),
  checkCommandId: IdSchema,
  /** Exact command text that was run. */
  command: z.string(),
  startedAt: IsoDateSchema,
  finishedAt: IsoDateSchema.optional(),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative().optional(),
  /** Last ~4KB of combined stdout/stderr. */
  outputTail: z.string().default(""),
  result: VerificationResultSchema,
});
export type VerificationRun = z.infer<typeof VerificationRunSchema>;

// ---------- Observed changes ----------

export const DiffHunkSchema = z.object({
  oldStart: z.number().int().nonnegative(),
  oldLines: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(),
  newLines: z.number().int().nonnegative(),
  /** Unified-diff body lines, each prefixed with " ", "+" or "-". */
  lines: z.array(z.string()),
});
export type DiffHunk = z.infer<typeof DiffHunkSchema>;

export const FileChangeKindSchema = z.enum(["create", "modify", "delete"]);
export type FileChangeKind = z.infer<typeof FileChangeKindSchema>;

export const FileChangeSchema = z.object({
  path: RelPathSchema,
  kind: FileChangeKindSchema,
  /** Bounded excerpt of previous content; absent when no baseline was captured. */
  before: z.string().optional(),
  /** Bounded excerpt of new content; absent for deletes. */
  after: z.string().optional(),
  hunks: z.array(DiffHunkSchema),
  /** True when the observer had no baseline, so "before" and hunks are not a true diff. */
  baselineMissing: z.boolean().default(false),
  truncated: z.boolean().default(false),
});
export type FileChange = z.infer<typeof FileChangeSchema>;

export const OmissionReasonSchema = z.enum([
  "ignored_dir",
  "secret",
  "binary",
  "too_large",
  "outside_workspace",
  "symlink",
  "budget",
  "unreadable",
]);
export const OmissionSchema = z.object({
  /** Workspace-relative path when safe to report; otherwise a short label. */
  path: z.string().max(1024),
  reason: OmissionReasonSchema,
  detail: z.string().max(500).optional(),
});
export type Omission = z.infer<typeof OmissionSchema>;

export const EvidenceRefSchema = z.object({
  id: IdSchema,
  path: RelPathSchema,
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  changeBatchId: IdSchema,
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const SuggestedTaskLinkSchema = z.object({
  taskId: IdSchema,
  /** 0..1 heuristic confidence. */
  score: z.number().min(0).max(1),
  reason: z.string().max(300),
});
export type SuggestedTaskLink = z.infer<typeof SuggestedTaskLinkSchema>;

export const ChangeSourceSchema = z.enum(["watcher", "fixture", "manual"]);

export const ChangeBatchSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  timestamp: IsoDateSchema,
  source: ChangeSourceSchema,
  changes: z.array(FileChangeSchema),
  omissions: z.array(OmissionSchema).default([]),
  evidence: z.array(EvidenceRefSchema).default([]),
  /** Hints only; never applied without user action. Empty when confidence is low. */
  suggestedTaskLinks: z.array(SuggestedTaskLinkSchema).default([]),
  /** Set by the engine once the user accepts/reassigns; null = user dismissed. */
  linkedTaskId: IdSchema.nullable().optional(),
});
export type ChangeBatch = z.infer<typeof ChangeBatchSchema>;

// ---------- Context packets (observer -> AI) ----------

export const ContextExcerptSchema = z.object({
  path: RelPathSchema,
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  text: z.string(),
  evidenceId: IdSchema.optional(),
  kind: z.enum(["changed", "enclosing", "import", "search_hit"]).default("changed"),
});
export type ContextExcerpt = z.infer<typeof ContextExcerptSchema>;

export const ContextPacketSchema = z.object({
  changeBatchIds: z.array(IdSchema),
  excerpts: z.array(ContextExcerptSchema),
  /** Hunks per file from the referenced change batches (bounded). */
  diffs: z.array(z.object({ path: RelPathSchema, kind: FileChangeKindSchema, hunks: z.array(DiffHunkSchema) })),
  evidence: z.array(EvidenceRefSchema),
  omissions: z.array(OmissionSchema),
  /** Things the retriever looked for and could not find (e.g. missing symbol). */
  missing: z.array(z.string()).default([]),
  totalChars: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type ContextPacket = z.infer<typeof ContextPacketSchema>;

// ---------- AI ----------

export const LevelSchema = z.enum(["beginner", "intermediate", "expert"]);
export type Level = z.infer<typeof LevelSchema>;

export const ProviderModeSchema = z.enum(["real", "mock"]);
export type ProviderMode = z.infer<typeof ProviderModeSchema>;

export const CitationSchema = z.object({
  path: RelPathSchema,
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  evidenceId: IdSchema.optional(),
  note: z.string().max(500).optional(),
});
export type Citation = z.infer<typeof CitationSchema>;

export const QuizQuestionSchema = z.object({
  question: z.string().min(1).max(500),
  choices: z.array(z.string().max(300)).min(2).max(5).optional(),
  answerIndex: z.number().int().nonnegative().optional(),
  answer: z.string().max(1000),
  explanation: z.string().max(1500).default(""),
});
export type QuizQuestion = z.infer<typeof QuizQuestionSchema>;

export const ExplanationRequestSchema = z.object({
  sessionId: IdSchema,
  requestId: IdSchema,
  taskId: IdSchema.optional(),
  changeBatchIds: z.array(IdSchema),
  level: LevelSchema,
  question: z.string().max(2000).optional(),
  wantQuiz: z.boolean().default(false),
  /** Bounded context assembled by the observer/context module. */
  context: ContextPacketSchema,
  /** Optional task title + criteria so the explanation can relate to the goal. */
  task: z.object({ title: z.string(), acceptanceCriteria: z.array(z.string()) }).optional(),
  /** Verification evidence; the model may only mention test results present here. */
  verificationRuns: z.array(VerificationRunSchema).default([]),
});
export type ExplanationRequest = z.infer<typeof ExplanationRequestSchema>;

export const ExplanationResponseSchema = z.object({
  requestId: IdSchema,
  summary: z.string(),
  behaviorChanges: z.array(z.string()),
  concepts: z.array(z.object({ name: z.string(), explanation: z.string(), example: z.string().optional() })),
  concerns: z.array(z.string()),
  /** Citations validated against the context packet. */
  evidence: z.array(CitationSchema),
  /** Citations the model produced that were not in the context and were discarded. */
  invalidCitations: z.array(z.object({ path: z.string(), startLine: z.number(), endLine: z.number() })).default([]),
  uncertainties: z.array(z.string()),
  quiz: z.array(QuizQuestionSchema).max(3).optional(),
  provider: z.string(),
  mode: ProviderModeSchema,
  model: z.string().optional(),
  latencyMs: z.number().int().nonnegative().optional(),
});
export type ExplanationResponse = z.infer<typeof ExplanationResponseSchema>;

export const TaskBreakdownRequestSchema = z.object({
  requestId: IdSchema,
  goal: z.string().min(1).max(10_000),
  promptText: z.string().max(20_000).optional(),
});
export type TaskBreakdownRequest = z.infer<typeof TaskBreakdownRequestSchema>;

export const TaskBreakdownSuggestionSchema = z.object({
  requestId: IdSchema,
  tasks: z
    .array(
      z.object({
        title: z.string().min(1).max(300),
        acceptanceCriteria: z.array(z.string().min(1).max(500)).min(1).max(5),
      }),
    )
    .min(1)
    .max(10),
  provider: z.string(),
  mode: ProviderModeSchema,
  model: z.string().optional(),
});
export type TaskBreakdownSuggestion = z.infer<typeof TaskBreakdownSuggestionSchema>;

export const ModelStatusSchema = z.object({
  provider: z.string(),
  /** real = live model reachable; mock = deterministic MockProvider; offline = real provider configured but unreachable. */
  state: z.enum(["real", "mock", "offline"]),
  model: z.string().optional(),
  detail: z.string().optional(),
});
export type ModelStatus = z.infer<typeof ModelStatusSchema>;

// ---------- Preferences ----------

export const PreferencesSchema = z.object({
  level: LevelSchema.default("beginner"),
  alwaysOnTop: z.boolean().default(true),
  compact: z.boolean().default(false),
  theme: z.enum(["system", "light", "dark"]).default("system"),
  /** e.g. "code -g {file}:{line}". Empty = OS default opener. */
  editorCommand: z.string().max(500).default(""),
  stallMinutes: z.number().int().positive().max(24 * 60).default(15),
  modelProvider: z.enum(["auto", "mock", "ollama"]).default("auto"),
});
export type Preferences = z.infer<typeof PreferencesSchema>;
export const DEFAULT_PREFERENCES: Preferences = PreferencesSchema.parse({});
