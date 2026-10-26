import {
  DEFAULT_PREFERENCES,
  type ExplanationResponse,
  type ModelStatus,
  type ServerEnvelope,
  type StateSnapshot,
  type TaskBreakdownSuggestion,
} from "../../../shared/index.js";

export interface UiState extends StateSnapshot {
  /** Every session seen this run, by id (several can run at once). */
  sessions: Record<string, import("../../../shared/index.js").VibeSession>;
  /** Gemma's live reasoning per session. */
  thinking: Record<string, string>;
  explanation: ExplanationResponse | null;
  breakdown: TaskBreakdownSuggestion | null;
  runningVerificationChecks: Record<string, string>;
}

export const initialUiState: UiState = {
  project: null,
  milestones: [],
  tasks: [],
  progress: null,
  changeBatches: [],
  verificationRuns: [],
  preferences: DEFAULT_PREFERENCES,
  modelStatus: { provider: "none", state: "offline", detail: "Waiting for engine connection" },
  engine: { version: "unknown", sessionId: "pending", mock: false, dataDir: "", observerRunning: false },
  selectedTaskId: null,
  explanation: null,
  breakdown: null,
  runningVerificationChecks: {},
  vibe: null,
  codingAgents: [],
  vibeHistory: [],
  launch: null,
  sessions: {},
  thinking: {},
};

export function applyEngineEvent(state: UiState, event: ServerEnvelope): UiState {
  switch (event.type) {
    case "state_snapshot":
      return { ...state, ...event.payload, sessions: event.payload.vibe ? { ...state.sessions, [event.payload.vibe.id]: event.payload.vibe } : state.sessions };
    case "progress_updated":
      return { ...state, progress: event.payload };
    case "change_batch":
      return state.changeBatches.some((batch) => batch.id === event.payload.id)
        ? state
        : { ...state, changeBatches: [...state.changeBatches, event.payload] };
    case "task_updated":
      return {
        ...state,
        tasks: state.tasks.some((task) => task.id === event.payload.id)
          ? state.tasks.map((task) => task.id === event.payload.id ? event.payload : task)
          : [...state.tasks, event.payload],
      };
    case "task_deleted":
      return { ...state, tasks: state.tasks.filter((task) => task.id !== event.payload.taskId) };
    case "verification_started":
      return { ...state, runningVerificationChecks: { ...state.runningVerificationChecks, [event.payload.runId]: event.payload.checkCommandId } };
    case "verification_result": {
      const runningVerificationChecks = { ...state.runningVerificationChecks };
      delete runningVerificationChecks[event.payload.id];
      return {
        ...state,
        runningVerificationChecks,
        verificationRuns: state.verificationRuns.some((run) => run.id === event.payload.id)
          ? state.verificationRuns.map((run) => run.id === event.payload.id ? event.payload : run)
          : [...state.verificationRuns, event.payload],
      };
    }
    case "breakdown_suggestion":
      return { ...state, breakdown: event.payload };
    case "explanation_result":
      return { ...state, explanation: event.payload };
    case "explanation_error":
      return { ...state, modelStatus: event.payload.modelStatus };
    case "model_status":
      return { ...state, modelStatus: event.payload };
    case "preferences_updated":
      return { ...state, preferences: event.payload };
    case "vibe_updated": {
      // Several sessions can run at once: track all, but only the one being viewed is `vibe`.
      const s = event.payload;
      const viewing = !state.vibe || state.vibe.id === s.id;
      const thinking = ["clarifying", "refining", "reporting"].includes(s.phase) || s.qa.some((x) => x.pending) ? state.thinking : { ...state.thinking, [s.id]: "" };
      return { ...state, sessions: { ...state.sessions, [s.id]: s }, thinking, ...(viewing ? { vibe: s } : {}) };
    }
    case "vibe_agent_event": {
      const cur = state.sessions[event.payload.vibeId];
      const next = cur ? { ...cur, events: [...cur.events, event.payload.event].slice(-300) } : undefined;
      return {
        ...state,
        ...(next ? { sessions: { ...state.sessions, [next.id]: next } } : {}),
        ...(state.vibe?.id === event.payload.vibeId && next ? { vibe: next } : {}),
      };
    }
    case "launch_updated":
      return { ...state, launch: event.payload };
    case "vibe_thinking":
      return { ...state, thinking: { ...state.thinking, [event.payload.vibeId]: event.payload.text } };
    case "coding_agents":
      return { ...state, codingAgents: event.payload };
    case "open_file_result":
    case "report_ready":
    case "error":
      return state;
  }
}

export function modelStatusLabel(status: ModelStatus): string {
  if (status.state === "offline") return status.detail ? `Model offline — ${status.detail}` : "Model offline";
  return `${status.provider}${status.model ? ` · ${status.model}` : ""}`;
}
