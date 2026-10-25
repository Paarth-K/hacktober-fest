import { z } from 'zod';
import { ExplanationRequestSchema, ExplanationBodySchema, ExplanationResponseSchema, TaskBreakdownRequestSchema, TaskBreakdownBodySchema, TaskBreakdownSuggestionSchema, type ProviderStatus, type ExplanationRequest, type ExplanationResponse, type ModelProvider, type TaskBreakdownRequest, type TaskBreakdownSuggestion } from './contracts.js';
import { assertNoSecrets, boundContext, validateCitations, validateProseReferences } from './context.js';
import { EXPLANATION_SYSTEM, BREAKDOWN_SYSTEM } from '../skills/prompts.js';

export class ModelError extends Error {
  constructor(readonly code: 'offline' | 'timeout' | 'invalid_output' | 'configuration', message: string) { super(message); this.name = 'ModelError'; }
}
export interface OllamaOptions { baseUrl?: string; model?: string; timeoutMs?: number; fetch?: typeof fetch }
export function parseModelJson(text: string): unknown {
  if (Buffer.byteLength(text) > 100000) throw new ModelError('invalid_output', 'Model response exceeded the output budget');
  // Accept a single fenced JSON block, never arbitrary prose with a JSON fragment.
  const cleaned = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1');
  try { return JSON.parse(cleaned); } catch { throw new ModelError('invalid_output', 'Model did not return valid JSON'); }
}
export class OllamaProvider implements ModelProvider {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;
  constructor(options: OllamaOptions = {}) {
    const url = new URL(options.baseUrl ?? process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434');
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new ModelError('configuration', 'Ollama must use a local loopback URL');
    this.baseUrl = url.href.replace(/\/$/, '');
    this.model = options.model ?? process.env.OLLAMA_MODEL ?? '';
    if (!this.model) throw new ModelError('configuration', 'Set OLLAMA_MODEL to a locally installed tag from ollama list');
    this.timeoutMs = options.timeoutMs ?? 120000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new ModelError('configuration', 'Invalid model timeout');
    this.fetcher = options.fetch ?? fetch;
    this.name = `ollama:${this.model}`;
  }
  /** Cheap probe only; does not run inference and never throws. */
  async status(): Promise<ProviderStatus> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, 5000));
    try {
      const response = await this.fetcher(`${this.baseUrl}/api/tags`, { method: 'GET', redirect: 'error', signal: controller.signal });
      if (!response.ok) return { provider: this.name, model: this.model, state: 'offline', detail: `Ollama returned HTTP ${response.status}` };
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Missing body');
      const chunks: Uint8Array[] = []; let bytes = 0;
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 200000) { await reader.cancel(); throw new Error('Tags exceeded budget'); }
        chunks.push(chunk.value);
      }
      const tags = z.object({ models: z.array(z.object({ name: z.string(), model: z.string().optional() })).max(1000) }).parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const installed = tags.models.some(tag => tag.name === this.model || tag.model === this.model || tag.name === `${this.model}:latest`);
      return { provider: this.name, model: this.model, state: installed ? 'real' : 'offline', detail: installed ? 'Local Ollama reachable; configured model installed. Inference not tested by this probe.' : 'Local Ollama reachable; configured model is not installed.' };
    } catch {
      return { provider: this.name, model: this.model, state: 'offline', detail: controller.signal.aborted ? 'Ollama status probe timed out.' : 'Ollama status unavailable or invalid.' };
    } finally { clearTimeout(timer); }
  }
  private async generate(system: string, input: unknown, schema: z.ZodTypeAny): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(`${this.baseUrl}/api/chat`, {
        method: 'POST', redirect: 'error', signal: controller.signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, stream: false, format: 'json', think: false, options: { temperature: 0, num_predict: 2200 }, messages: [
          { role: 'system', content: system + '\nRequired JSON shape: ' + shapeFor(schema) },
          { role: 'user', content: JSON.stringify(input) },
        ] }),
      });
      if (!response.ok) throw new ModelError('offline', `Ollama returned HTTP ${response.status}`);
      // Bound the HTTP body as well as the model's JSON string.
      const reader = response.body?.getReader();
      if (!reader) throw new ModelError('invalid_output', 'Ollama returned no body');
      const chunks: Uint8Array[] = []; let bytes = 0;
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 200000) { await reader.cancel(); throw new ModelError('invalid_output', 'Ollama response exceeded output budget'); }
        chunks.push(chunk.value);
      }
      const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const content = z.object({ message: z.object({ content: z.string() }) }).parse(envelope).message.content;
      return schema.parse(parseModelJson(content));
    } catch (error) {
      if (error instanceof ModelError) throw error;
      if (controller.signal.aborted) throw new ModelError('timeout', 'Local model request timed out');
      if (error instanceof z.ZodError || error instanceof SyntaxError) throw new ModelError('invalid_output', 'Model response did not match the required schema');
      throw new ModelError('offline', 'Local Ollama is unavailable');
    } finally { clearTimeout(timer); }
  }
  async explain(input: ExplanationRequest): Promise<ExplanationResponse> {
    const request = ExplanationRequestSchema.parse(input);
    assertNoSecrets({ task: request.task, question: request.question });
    const context = boundContext(request.context);
    if (context.excerpts.some(e => !request.changeBatchIds.includes(e.evidence.changeBatchId))) throw new Error('Context evidence does not belong to a requested change batch');
    if (!context.excerpts.length) throw new ModelError('invalid_output', 'No safe source evidence is available for an explanation');
    const body = await this.generate(EXPLANATION_SYSTEM, { ...request, context }, ExplanationBodySchema) as z.infer<typeof ExplanationBodySchema>;
    try { validateCitations(body.evidence, context); } catch { throw new ModelError('invalid_output', 'Discarded explanation with unsupported citations'); }
    if (!body.evidence.length) throw new ModelError('invalid_output', 'Model explanation is missing source citations');
    // Do not surface unsupported verification claims as grounded teaching.
    const prose = [body.summary, ...body.behaviorChanges, ...body.concepts, ...body.concerns, ...body.uncertainties, ...(body.quiz ?? []).flatMap(q => [q.question, q.answer])].join('\n');
    try { validateProseReferences(prose, context); } catch { throw new ModelError('invalid_output', 'Discarded explanation with an unsupported prose reference'); }
    if (/\b(?:tests?|checks?|build)\s+(?:(?:have|has|all)\s+)*(?:passed|succeeded|is passing)|\b(?:verified_complete|user_confirmed)\b|\b(?:task|project)\s+is\s+(?:complete|done)\b/i.test(prose)) {
      throw new ModelError('invalid_output', 'Discarded explanation containing an unsupported completion or verification assertion');
    }
    if (request.includeQuiz && !body.quiz?.length) throw new ModelError('invalid_output', 'Requested quiz was missing');
    return ExplanationResponseSchema.parse({ ...body, ...(request.includeQuiz ? {} : { quiz: undefined }), uncertainties: [...body.uncertainties, ...context.omissions, 'Explanation is based on bounded excerpts; it does not verify correctness.'].slice(0, 20), provider: this.name, mode: 'live' });
  }
  async breakdown(input: TaskBreakdownRequest): Promise<TaskBreakdownSuggestion> {
    const request = TaskBreakdownRequestSchema.parse(input);
    assertNoSecrets(request);
    const body = await this.generate(BREAKDOWN_SYSTEM, request, TaskBreakdownBodySchema) as z.infer<typeof TaskBreakdownBodySchema>;
    return TaskBreakdownSuggestionSchema.parse({ ...body, provider: this.name, mode: 'live' });
  }
}
function shapeFor(schema: z.ZodTypeAny): string {
  return schema === TaskBreakdownBodySchema
    ? '{"tasks":[{"title":"string","acceptanceCriteria":["string"]}]} (3–10 tasks; 1–5 criteria each)'
    : '{"summary":"string","behaviorChanges":["string"],"concepts":["string"],"concerns":["string"],"evidence":[{"id":"supplied id","path":"supplied path","startLine":1,"endLine":1,"changeBatchId":"supplied batch"}],"uncertainties":["string"],"quiz":[{"question":"string","answer":"string"}]} (quiz only if requested)';
}
