// "Vibe" flow: rough prompt -> Gemma clarifies (if vague) and refines -> coding agent CLI runs in the
// workspace -> Gemma reports what actually changed (grounded in observed diffs).
import { z } from "zod";
import { CitationSchema, IdSchema, IsoDateSchema, LevelSchema, RelPathSchema } from "./schemas.js";

export const CodingAgentIdSchema = z.enum(["claude", "codex"]);
export type CodingAgentId = z.infer<typeof CodingAgentIdSchema>;

export const CodingAgentInfoSchema = z.object({
  id: CodingAgentIdSchema,
  name: z.string(),
  available: z.boolean(),
  version: z.string().optional(),
  /** Why unavailable, or what permissions it runs with. */
  detail: z.string().optional(),
});
export type CodingAgentInfo = z.infer<typeof CodingAgentInfoSchema>;

export const VibePhaseSchema = z.enum([
  "clarifying", // Gemma is judging the prompt
  "awaiting_answers", // Gemma asked questions; waiting for the user
  "refining", // Gemma is writing the refined prompt
  "ready", // refined prompt ready for review/edit
  "running", // coding agent is working
  "reporting", // Gemma is writing the change report
  "done",
  "failed",
  "cancelled",
]);
export type VibePhase = z.infer<typeof VibePhaseSchema>;

export const ClarifyQuestionSchema = z.object({
  id: IdSchema,
  question: z.string().min(1).max(500),
  /** Why Gemma asks; helps the user answer well. */
  why: z.string().max(300).optional(),
  /** Optional quick-pick answers. */
  options: z.array(z.string().max(200)).max(5).optional(),
});
export type ClarifyQuestion = z.infer<typeof ClarifyQuestionSchema>;

export const GemmaSourceSchema = z.object({
  provider: z.string(),
  /** real = live local model; template = deterministic fallback (no model). */
  mode: z.enum(["real", "template"]),
  model: z.string().optional(),
  detail: z.string().optional(),
});
export type GemmaSource = z.infer<typeof GemmaSourceSchema>;

export const VibeAgentEventSchema = z.object({
  at: IsoDateSchema,
  kind: z.enum(["text", "tool", "stderr", "status"]),
  text: z.string().max(2000),
});
export type VibeAgentEvent = z.infer<typeof VibeAgentEventSchema>;

export const VibeFileChangeSchema = z.object({
  path: RelPathSchema,
  kind: z.enum(["create", "modify", "delete"]),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  /** Gemma's one-line description of this file's change (empty for template reports). */
  what: z.string().max(500).default(""),
});

export const VibeReportSchema = z.object({
  summary: z.string(),
  changes: z.array(VibeFileChangeSchema),
  /** Parts of the request the diffs show were addressed. */
  addressed: z.array(z.string()),
  /** Parts of the request not visible in the diffs. */
  notAddressed: z.array(z.string()),
  risks: z.array(z.string()),
  /** Design tradeoffs visible in the diffs (only when supported). */
  tradeoffs: z.array(z.string()).default([]),
  nextSteps: z.array(z.string()),
  /** One question to help the developer learn from this change, with its answer. */
  learningQuestion: z.object({ question: z.string(), answer: z.string() }).optional(),
  citations: z.array(CitationSchema),
  invalidCitations: z.array(z.object({ path: z.string(), startLine: z.number(), endLine: z.number() })).default([]),
  omissions: z.array(z.string()).default([]),
  source: GemmaSourceSchema,
  markdown: z.string(),
  generatedAt: IsoDateSchema,
});
export type VibeReport = z.infer<typeof VibeReportSchema>;

export const VibeRunSchema = z.object({
  agent: CodingAgentIdSchema,
  /** Display form of the command (prompt elided). */
  command: z.string(),
  /** User allowed the agent to run shell commands without asking. */
  allowCommands: z.boolean().default(false),
  startedAt: IsoDateSchema,
  finishedAt: IsoDateSchema.optional(),
  exitCode: z.number().int().nullable().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  /** The agent's own final message (untrusted; shown verbatim, never used as verification). */
  finalMessage: z.string().max(8000).optional(),
  outcome: z.enum(["running", "completed", "failed", "timeout", "cancelled"]),
});
export type VibeRun = z.infer<typeof VibeRunSchema>;

export const VibeSessionSchema = z.object({
  id: IdSchema,
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  originalPrompt: z.string().min(1).max(20_000),
  agent: CodingAgentIdSchema,
  phase: VibePhaseSchema,
  vague: z.boolean().optional(),
  vaguenessReason: z.string().max(1000).optional(),
  questions: z.array(ClarifyQuestionSchema).default([]),
  /** Explanation level for the Learn pane. */
  level: LevelSchema.default("beginner"),
  /** Follow-up questions asked in the Learn pane, answered by Gemma from this change's diffs. */
  qa: z.array(z.object({ question: z.string().max(2000), answer: z.string().max(6000), at: IsoDateSchema, pending: z.boolean().default(false) })).default([]),
  /** Pause at the refined prompt for review (else the agent runs as soon as the prompt is refined). */
  review: z.boolean().default(false),
  allowCommands: z.boolean().default(false),
  /** Progress-tracking task created for this prompt (evidence + criteria live there). */
  taskId: IdSchema.optional(),
  /** Clarification rounds so far (Gemma re-checks after answers; max 2). */
  clarifyRounds: z.number().int().nonnegative().default(0),
  answers: z.record(z.string(), z.string().max(2000)).default({}),
  refinedPrompt: z.string().max(20_000).optional(),
  assumptions: z.array(z.string().max(500)).default([]),
  /** Who did clarify/refine. */
  gemma: GemmaSourceSchema.optional(),
  run: VibeRunSchema.optional(),
  events: z.array(VibeAgentEventSchema).default([]),
  changeBatchIds: z.array(IdSchema).default([]),
  /** Test command detected from the workspace (package.json "test" -> npm test, Cargo.toml -> cargo test, ...). */
  suggestedCheck: z.string().max(500).optional(),
  /** Verification runs the user started from this session's report (real exit codes). */
  verificationRunIds: z.array(IdSchema).default([]),
  report: VibeReportSchema.optional(),
  error: z.string().max(2000).optional(),
});
export type VibeSession = z.infer<typeof VibeSessionSchema>;

/** Compact row for the history list. */
export const VibeHistoryItemSchema = z.object({
  id: IdSchema,
  createdAt: IsoDateSchema,
  originalPrompt: z.string(),
  agent: CodingAgentIdSchema,
  phase: VibePhaseSchema,
  filesChanged: z.number().int().nonnegative(),
  /** Result of the last user-run verification, if any. */
  verified: z.enum(["pass", "fail", "none"]),
});
export type VibeHistoryItem = z.infer<typeof VibeHistoryItemSchema>;

// ---------- messages (merged into ClientMessage / ServerMessage in events.ts) ----------

const msg = <T extends string, P extends z.ZodTypeAny>(type: T, payload: P) => z.object({ type: z.literal(type), payload });

export const VibeClientMessages = [
  msg(
    "vibe_start",
    z.object({
      prompt: z.string().min(1).max(20_000),
      agent: CodingAgentIdSchema,
      /** Stop at the refined prompt for review instead of running the agent right away. */
      review: z.boolean().default(false),
      /** Automatic permissions for the agent (Claude Code --permission-mode auto). */
      allowCommands: z.boolean().default(false),
      level: LevelSchema.default("beginner"),
    }),
  ),
  msg("vibe_answer", z.object({ vibeId: IdSchema, answers: z.record(z.string(), z.string().max(2000)) })),
  /** Skip the questions; Gemma refines with stated assumptions. */
  msg("vibe_skip_questions", z.object({ vibeId: IdSchema })),
  /** Run the (possibly user-edited) refined prompt. */
  msg("vibe_run", z.object({ vibeId: IdSchema, prompt: z.string().min(1).max(20_000), agent: CodingAgentIdSchema, allowCommands: z.boolean().default(false) })),
  msg("vibe_cancel", z.object({ vibeId: IdSchema })),
  /** Rewrite the explanation, optionally at a different level. */
  msg("vibe_regenerate_report", z.object({ vibeId: IdSchema, level: LevelSchema.optional() })),
  /** Ask Gemma a question about this change (answered from its diffs, at the session level). */
  msg("vibe_ask", z.object({ vibeId: IdSchema, question: z.string().min(1).max(2000) })),
  /** User clicked "Run tests" on the report: run this exact command in the workspace (saved as a project check). */
  msg("vibe_verify", z.object({ vibeId: IdSchema, command: z.string().min(1).max(1000) })),
  /** Forget the current session and start over (history is kept). */
  msg("vibe_reset", z.object({})),
  /** Reopen a past session from history. */
  msg("vibe_open", z.object({ vibeId: IdSchema })),
] as const;

export const VibeServerMessages = [
  /** Full session; sent on every phase change. */
  msg("vibe_updated", VibeSessionSchema),
  /** Incremental live agent output. */
  msg("vibe_agent_event", z.object({ vibeId: IdSchema, event: VibeAgentEventSchema })),
  msg("coding_agents", z.array(CodingAgentInfoSchema)),
] as const;
