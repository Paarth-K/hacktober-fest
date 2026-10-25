import type { ExplanationRequest } from '../contracts.js';
export const request: ExplanationRequest = {
  sessionId: 'live-smoke-session', changeBatchIds: ['batch-1'], level: 'beginner', includeQuiz: true,
  context: { excerpts: [{ evidence: { id: 'e1', path: 'src/cart.ts', startLine: 1, endLine: 5, changeBatchId: 'batch-1' }, text: 'export function total(prices: number[]): number {\n  return prices.reduce((sum, price) => sum + price, 0);\n}\n// Prior implementation used reduce without the initial zero.\n// This edit adds zero so an empty array returns zero.' }], omissions: ['Only the changed function is provided; callers are not included.'], verificationRuns: [] },
};
export const responseBody = {
  summary: 'The reducer starts with zero.', behaviorChanges: ['Empty input returns zero.'], concepts: ['A reducer combines array elements into one value.'], concerns: ['Callers are not provided.'],
  evidence: [{ id: 'e1', path: 'src/cart.ts', startLine: 1, endLine: 3, changeBatchId: 'batch-1' }], uncertainties: ['Runtime behavior has not been checked.'], quiz: [{ question: 'What is the initial sum?', answer: 'Zero.' }],
};
