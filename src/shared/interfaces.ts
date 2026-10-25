// Module boundaries inside the Node engine. P4's core depends only on these
// interfaces; P2 implements Observer (src/observer + src/context) and P3
// implements ModelProvider (src/ai + src/skills).
import type {
  ChangeBatch,
  ContextPacket,
  ExplanationRequest,
  ExplanationResponse,
  ModelStatus,
  ProgressSnapshot,
  SuggestedTaskLink,
  Task,
  TaskBreakdownRequest,
  TaskBreakdownSuggestion,
  VerificationRun,
} from "./schemas.js";

// ---------- AI (P3) ----------

export interface ProgressReportInput {
  projectName: string;
  goal: string;
  snapshot: ProgressSnapshot;
  tasks: Task[];
  verificationRuns: VerificationRun[];
}

export interface ModelProvider {
  /** e.g. "mock", "ollama". */
  readonly name: string;
  readonly mode: "real" | "mock";
  /** Cheap reachability check; must not throw. */
  status(): Promise<ModelStatus>;
  /** Explanation, follow-up (request.question set) and quiz (request.wantQuiz). Must return a validated response with only citations present in request.context. */
  explain(request: ExplanationRequest): Promise<ExplanationResponse>;
  breakdown(request: TaskBreakdownRequest): Promise<TaskBreakdownSuggestion>;
  /** Optional plain-language summary that only restates the snapshot. source says whether a model or a template wrote it. */
  summarizeProgress?(input: ProgressReportInput): Promise<{ text: string; source: "template" | "model" }>;
}

// ---------- Observer + context (P2) ----------

export interface ObserverStartOptions {
  /** Absolute workspace root selected by the user. */
  rootPath: string;
  sessionId: string;
  /** Called once per debounced, deduplicated batch. */
  onBatch: (batch: ChangeBatch) => void;
  /** Current tasks, used for attribution hints. */
  getTasks: () => Task[];
  onError?: (error: Error) => void;
}

export interface Observer {
  start(options: ObserverStartOptions): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  /** Emit a pre-built batch through onBatch (tests / mock mode). */
  replayFixture(batch: ChangeBatch): void;
  /** Bounded context for explaining the given batches. */
  getContext(changeBatchIds: string[], options?: { maxChars?: number }): Promise<ContextPacket>;
  /** Bounded targeted retrieval for a follow-up question. Reports missing symbols in packet.missing. */
  retrieveForQuestion(question: string, changeBatchIds: string[], options?: { maxChars?: number }): Promise<ContextPacket>;
  /** Ranked hints; [] when confidence is low. Never links anything itself. */
  suggestTasks(batch: ChangeBatch, tasks: Task[]): SuggestedTaskLink[];
}
