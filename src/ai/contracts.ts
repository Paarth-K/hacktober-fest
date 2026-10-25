import { z } from 'zod';

// P3-local boundary schemas; adapters can map the canonical P4 contract here.
export const EvidenceRefSchema = z.object({
  id: z.string().min(1), path: z.string().min(1),
  startLine: z.number().int().positive(), endLine: z.number().int().positive(),
  changeBatchId: z.string().min(1),
}).refine(ref => ref.endLine >= ref.startLine, 'Invalid line range');
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;
export const ContextPacketSchema = z.object({
  excerpts: z.array(z.object({ evidence: EvidenceRefSchema, text: z.string() })),
  omissions: z.array(z.string()).default([]),
  verificationRuns: z.array(z.object({
    id: z.string(), command: z.string(), result: z.enum(['pass', 'fail', 'timeout', 'error']),
    exitCode: z.number().int().nullable(),
  })).default([]),
});
export type ContextPacket = z.infer<typeof ContextPacketSchema>;
export const ExplanationRequestSchema = z.object({
  sessionId: z.string(), taskId: z.string().optional(), task: z.string().max(8000).optional(),
  changeBatchIds: z.array(z.string()), level: z.enum(['beginner', 'intermediate', 'expert']),
  question: z.string().max(4000).optional(), includeQuiz: z.boolean().default(false),
  context: ContextPacketSchema,
});
export type ExplanationRequest = z.input<typeof ExplanationRequestSchema>;
export const ExplanationBodySchema = z.object({
  summary: z.string().min(1).max(3000),
  behaviorChanges: z.array(z.string().max(1500)).max(12),
  concepts: z.array(z.string().max(1500)).max(12),
  concerns: z.array(z.string().max(1500)).max(12),
  evidence: z.array(EvidenceRefSchema).max(30),
  uncertainties: z.array(z.string().max(1500)).max(20),
  quiz: z.array(z.object({ question: z.string().min(1).max(1000), answer: z.string().min(1).max(1500) })).min(1).max(3).optional(),
});
export const ExplanationResponseSchema = ExplanationBodySchema.extend({
  provider: z.string(), mode: z.enum(['mock', 'live']),
});
export type ExplanationResponse = z.infer<typeof ExplanationResponseSchema>;
export const TaskBreakdownRequestSchema = z.object({ goal: z.string().min(1).max(8000), promptText: z.string().max(12000).optional() });
export type TaskBreakdownRequest = z.infer<typeof TaskBreakdownRequestSchema>;
export const TaskBreakdownBodySchema = z.object({ tasks: z.array(z.object({
  title: z.string().min(1).max(200), acceptanceCriteria: z.array(z.string().min(1).max(1000)).min(1).max(5),
})).min(3).max(10) });
export const TaskBreakdownSuggestionSchema = TaskBreakdownBodySchema.extend({ provider: z.string(), mode: z.enum(['mock', 'live']) });
export type TaskBreakdownSuggestion = z.infer<typeof TaskBreakdownSuggestionSchema>;
export interface ProviderStatus {
  provider: string;
  state: 'real' | 'mock' | 'offline';
  model?: string;
  detail?: string;
}
export interface ModelProvider {
  readonly name: string;
  status(): Promise<ProviderStatus>;
  explain(request: ExplanationRequest): Promise<ExplanationResponse>;
  breakdown(request: TaskBreakdownRequest): Promise<TaskBreakdownSuggestion>;
}
