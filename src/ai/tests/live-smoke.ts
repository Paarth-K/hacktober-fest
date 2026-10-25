import { writeFile } from 'node:fs/promises';
import { OllamaProvider } from '../ollama.js';
import { request } from './fixtures.js';

const provider = new OllamaProvider();
const results: unknown[] = [];
async function run(name: string, action: () => Promise<unknown>) {
  const started = Date.now();
  try { const output = await action(); const result = { name, result: 'PASS', latencyMs: Date.now() - started, output }; results.push(result); console.log(JSON.stringify(result, null, 2)); }
  catch (error) { const result = { name, result: 'FAIL', latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) }; results.push(result); console.log(JSON.stringify(result)); process.exitCode = 1; }
}
await run('beginner explanation and quiz', () => provider.explain(request));
await run('expert explanation of second diff', () => provider.explain({ ...request, level: 'expert', includeQuiz: false, context: { excerpts: [{ evidence: { id: 'e2', path: 'src/normalize.ts', startLine: 1, endLine: 4, changeBatchId: 'batch-2' }, text: 'export function normalize(value: string): string {\n  return value.trim().toLowerCase();\n}\n// Edit: added trim() before toLowerCase().' }], omissions: ['No callers supplied.'], verificationRuns: [] }, changeBatchIds: ['batch-2'] }));
await run('follow-up with fresh targeted evidence', () => provider.explain({ ...request, question: 'Why is the zero initial value needed for an empty prices array?', context: { ...request.context, omissions: ['Fresh targeted context: reducer only; no tests supplied.'] } }));
await run('project task breakdown', () => provider.breakdown({ goal: 'Build a local shopping cart TypeScript library with adding/removing items, computing totals, and unit tests.' }));
if (process.env.AI_SMOKE_OUTPUT) await writeFile(process.env.AI_SMOKE_OUTPUT, JSON.stringify({ model: process.env.OLLAMA_MODEL, results }, null, 2) + '\n');
