// P4 adapter: canonical ModelProvider (src/shared) <-> P3's learning service (src/ai).
// P3's module keeps its own boundary schemas; this file is the only place that maps between them.
import { LearningService, MockProvider, OllamaProvider, summarizeProgress as templateSummary } from "../ai/index.js";
import type {
  ContextPacket as P3ContextPacket,
  ExplanationResponse as P3ExplanationResponse,
  ModelProvider as P3ModelProvider,
} from "../ai/index.js";
import type { ModelProvider, ProgressReportInput } from "../shared/interfaces.js";
import type {
  ContextPacket,
  ExplanationRequest,
  ExplanationResponse,
  ModelStatus,
  TaskBreakdownRequest,
  TaskBreakdownSuggestion,
} from "../shared/schemas.js";

export interface ModelProviderOptions {
  /** "auto" = use Ollama if reachable with an installed model, else labeled mock. */
  provider: "auto" | "mock" | "ollama";
  ollamaBaseUrl?: string;
  ollamaModel?: string;
  /** Injected in tests. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Pseudo batch id for context excerpts that do not belong to a change batch (e.g. follow-up search hits). */
const CONTEXT_BATCH = "context";

export function createModelProvider(options: ModelProviderOptions): ModelProvider {
  return new AdaptedProvider(options);
}

class AdaptedProvider implements ModelProvider {
  readonly name: string;
  readonly mode: "real" | "mock";
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private service: Promise<{ svc: P3ModelProvider; live: LearningService | null; model?: string; detail?: string }> | null = null;

  constructor(private readonly opts: ModelProviderOptions) {
    this.baseUrl = (opts.ollamaBaseUrl ?? "http://127.0.0.1:11434").replace(/\/$/, "");
    this.fetcher = opts.fetch ?? fetch;
    this.mode = opts.provider === "mock" ? "mock" : "real";
    this.name = opts.provider === "mock" ? "mock" : "ollama";
  }

  /** Lazily resolve the model tag (explicit OLLAMA_MODEL, else first installed gemma* tag) and build P3's service. */
  private resolve() {
    this.service ??= (async () => {
      const mock = new MockProvider();
      if (this.opts.provider === "mock") return { svc: mock, live: null, detail: "mock selected in preferences" };
      const tags = await this.listTags();
      const model = this.opts.ollamaModel || tags?.find((t) => /gemma/i.test(t));
      if (!model) {
        const detail = tags === null ? `Ollama not reachable at ${this.baseUrl}` : "no OLLAMA_MODEL set and no gemma* tag in `ollama list`";
        return { svc: mock, live: null, detail };
      }
      const live = new LearningService(new OllamaProvider({ baseUrl: this.baseUrl, model, timeoutMs: this.opts.timeoutMs, fetch: this.fetcher }), mock);
      return { svc: live, live, model };
    })();
    return this.service;
  }

  private async listTags(): Promise<string[] | null> {
    try {
      const res = await this.fetcher(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return null;
      const body = (await res.json()) as { models?: { name?: string; model?: string }[] };
      return (body.models ?? []).map((m) => m.name ?? m.model ?? "").filter(Boolean);
    } catch {
      return null;
    }
  }

  async status(): Promise<ModelStatus> {
    if (this.opts.provider === "mock") return { provider: "mock", state: "mock", detail: "Deterministic mock (no model inference)" };
    const { live, model, detail } = await this.resolve();
    if (!live) return { provider: "ollama", state: "offline", detail: `${detail}; using labeled mock fallback` };
    const tags = await this.listTags();
    if (tags === null) return { provider: "ollama", state: "offline", model, detail: `Ollama not reachable at ${this.baseUrl}; using labeled mock fallback` };
    if (!tags.includes(model!)) return { provider: "ollama", state: "offline", model, detail: `model ${model} is not installed (ollama list)` };
    if (live.lastFailure) return { provider: "ollama", state: "offline", model, detail: `last request failed: ${live.lastFailure.code} ${live.lastFailure.message}` };
    return { provider: "ollama", state: "real", model };
  }

  async explain(req: ExplanationRequest): Promise<ExplanationResponse> {
    const started = Date.now();
    const { svc, model } = await this.resolve();
    const { packet, batchIds } = toP3Context(req.context, req.changeBatchIds, req.verificationRuns);
    const out = await svc.explain({
      sessionId: req.sessionId,
      taskId: req.taskId,
      task: req.task ? `${req.task.title}\nAcceptance criteria:\n- ${req.task.acceptanceCriteria.join("\n- ")}` : undefined,
      changeBatchIds: batchIds,
      level: req.level,
      question: req.question,
      includeQuiz: req.wantQuiz,
      context: packet,
    });
    return fromP3Explanation(out, req, model, Date.now() - started);
  }

  async breakdown(req: TaskBreakdownRequest): Promise<TaskBreakdownSuggestion> {
    const { svc, model } = await this.resolve();
    const out = await svc.breakdown({ goal: req.goal, promptText: req.promptText });
    const mode = out.mode === "live" ? "real" : "mock";
    return { requestId: req.requestId, tasks: out.tasks, provider: out.provider, mode, ...(mode === "real" && model ? { model } : {}) };
  }

  async summarizeProgress(input: ProgressReportInput): Promise<{ text: string; source: "template" | "model" }> {
    // P3's formatter expects a fraction in [0,1]; the canonical snapshot is 0..100.
    const s = input.snapshot;
    const text = templateSummary({ total: s.total, byStatus: s.byStatus, percentComplete: s.percentComplete / 100, criteriaMet: s.criteriaMet, criteriaTotal: s.criteriaTotal });
    return { text, source: "template" };
  }
}

/** Canonical ContextPacket -> P3 packet. Builds excerpts from diff hunks when the observer supplied none. */
export function toP3Context(ctx: ContextPacket, changeBatchIds: string[], runs: ExplanationRequest["verificationRuns"]): { packet: P3ContextPacket; batchIds: string[] } {
  const evidenceById = new Map(ctx.evidence.map((e) => [e.id, e]));
  const excerpts: P3ContextPacket["excerpts"] = [];
  let synthetic = 0;
  let needsContextBatch = false;

  for (const x of ctx.excerpts) {
    if (x.endLine < x.startLine) continue;
    const ev = x.evidenceId ? evidenceById.get(x.evidenceId) : ctx.evidence.find((e) => e.path === x.path && e.startLine <= x.endLine && e.endLine >= x.startLine);
    const batch = ev?.changeBatchId ?? CONTEXT_BATCH;
    if (batch === CONTEXT_BATCH) needsContextBatch = true;
    // The excerpt's own range is what the text covers, so cite that range.
    excerpts.push({ evidence: { id: ev && ev.startLine === x.startLine && ev.endLine === x.endLine ? ev.id : `ctx_${++synthetic}`, path: x.path, startLine: x.startLine, endLine: x.endLine, changeBatchId: batch }, text: x.text });
  }

  if (excerpts.length === 0) {
    // Fallback: hunk text for each piece of evidence (new-side lines, or old-side for deletes).
    for (const ev of ctx.evidence) {
      const diff = ctx.diffs.find((d) => d.path === ev.path);
      const lines = diff?.hunks.flatMap((h) => h.lines).filter((l) => !l.startsWith(diff.kind === "delete" ? "+" : "-")) ?? [];
      if (lines.length === 0) continue;
      excerpts.push({ evidence: { id: ev.id, path: ev.path, startLine: ev.startLine, endLine: ev.endLine, changeBatchId: ev.changeBatchId }, text: lines.join("\n").slice(0, 8000) });
    }
  }

  const batchIds = [...new Set([...changeBatchIds, ...excerpts.map((e) => e.evidence.changeBatchId), ...(needsContextBatch ? [CONTEXT_BATCH] : [])])];
  const omissions = [
    ...ctx.omissions.map((o) => `${o.reason}: ${o.path}${o.detail ? ` (${o.detail})` : ""}`),
    ...ctx.missing.map((m) => `Not found in workspace context: ${m}`),
    ...(ctx.truncated ? ["Context was truncated to fit the budget."] : []),
  ];
  return {
    packet: {
      excerpts,
      omissions,
      verificationRuns: runs.map((r) => ({ id: r.id, command: r.command, result: r.result, exitCode: r.exitCode })),
    },
    batchIds,
  };
}

export function fromP3Explanation(out: P3ExplanationResponse, req: ExplanationRequest, model: string | undefined, latencyMs: number): ExplanationResponse {
  const mode = out.mode === "live" ? "real" : "mock";
  const realIds = new Set(req.context.evidence.map((e) => e.id));
  return {
    requestId: req.requestId,
    summary: out.summary,
    behaviorChanges: out.behaviorChanges,
    concepts: out.concepts.map((c) => {
      const m = /^([^:.]{2,60}):\s+([\s\S]+)$/.exec(c);
      return m ? { name: m[1]!.trim(), explanation: m[2]!.trim() } : { name: c.split(/[.:]/)[0]!.slice(0, 60).trim() || "Concept", explanation: c };
    }),
    concerns: out.concerns,
    evidence: out.evidence.map((e) => ({ path: e.path, startLine: e.startLine, endLine: e.endLine, ...(realIds.has(e.id) ? { evidenceId: e.id } : {}) })),
    invalidCitations: [],
    uncertainties: out.uncertainties,
    ...(out.quiz?.length ? { quiz: out.quiz.slice(0, 3).map((q) => ({ question: q.question, answer: q.answer, explanation: "" })) } : {}),
    provider: out.provider,
    mode,
    ...(mode === "real" && model ? { model } : {}),
    latencyMs,
  };
}
