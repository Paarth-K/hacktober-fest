// OWNED BY P2 (feature/code-observer): bounded context extraction / retrieval and
// change-to-task attribution hints.
export { suggestTasks } from "./attribution.js";
export type { AttributionOptions, TaskHint } from "./attribution.js";
export { buildChangeContext, questionTerms, retrieveForQuestion } from "./packet.js";
export type { BatchWithSource, ContextOptions, QuestionTerms, RetrievalOptions } from "./packet.js";
