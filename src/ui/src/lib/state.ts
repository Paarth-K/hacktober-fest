import type { CompanionState, IncomingEnvelope } from "./contracts";

export function applyEngineEvent(state: CompanionState, event: IncomingEnvelope): CompanionState {
  switch (event.type) {
    case "state_snapshot": return event.payload;
    case "progress_updated": return { ...state, progress: event.payload };
    case "change_batch": return state.changes.some((batch) => batch.id === event.payload.id)
      ? state
      : { ...state, changes: [event.payload, ...state.changes] };
    case "task_updated": return {
      ...state,
      tasks: state.tasks.some((task) => task.id === event.payload.id)
        ? state.tasks.map((task) => task.id === event.payload.id ? event.payload : task)
        : [...state.tasks, event.payload]
    };
    case "verification_result": return {
      ...state,
      verifications: state.verifications.some((run) => run.id === event.payload.id)
        ? state.verifications
        : [event.payload, ...state.verifications]
    };
    case "explanation": return { ...state, explanation: event.payload };
    case "breakdown_suggestion": return { ...state, breakdown: event.payload };
    default: return state;
  }
}
