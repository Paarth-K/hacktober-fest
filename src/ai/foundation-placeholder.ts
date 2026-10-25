// OWNED BY P3 (feature/gemma-learning). M0 placeholder from P4 so the engine compiles:
// replace freely, but keep exporting `createModelProvider(options): ModelProvider`.
import type { ModelProvider } from "../shared/index.js";

export interface ModelProviderOptions {
  /** "auto" = try Ollama, fall back to labeled mock. */
  provider: "auto" | "mock" | "ollama";
  ollamaBaseUrl?: string;
  ollamaModel?: string;
}

export function createModelProvider(_options: ModelProviderOptions): ModelProvider {
  return {
    name: "mock",
    mode: "mock",
    async status() {
      return { provider: "mock", state: "mock", detail: "M0 placeholder provider" };
    },
    async explain(req) {
      return {
        requestId: req.requestId,
        summary: `[MOCK] ${req.context.diffs.length} file(s) changed${req.question ? ` — question: ${req.question}` : ""}. This is placeholder output, not a model.`,
        behaviorChanges: req.context.diffs.map((d) => `${d.kind} ${d.path}`),
        concepts: [],
        concerns: [],
        evidence: req.context.evidence.slice(0, 3).map((e) => ({ path: e.path, startLine: e.startLine, endLine: e.endLine, evidenceId: e.id })),
        invalidCitations: [],
        uncertainties: ["Mock provider: no real analysis performed"],
        quiz: req.wantQuiz ? [{ question: "Which files changed?", answer: req.context.diffs.map((d) => d.path).join(", ") || "none", explanation: "" }] : undefined,
        provider: "mock",
        mode: "mock",
      };
    },
    async breakdown(req) {
      return {
        requestId: req.requestId,
        tasks: [{ title: `[MOCK] First step toward: ${req.goal.slice(0, 80)}`, acceptanceCriteria: ["A test command passes for this step"] }],
        provider: "mock",
        mode: "mock",
      };
    },
  };
}
