import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { OllamaProvider } from '../ollama.js';
import type { ContextPacket } from '../contracts.js';

// Test harness only: actual disk edits, not a watcher or production diff extractor.
const root = await mkdtemp(join(tmpdir(), 'p3-observed-'));
const provider = new OllamaProvider();
const edits = [
  { path: 'src/cart.ts', before: 'export function total(prices: number[]): number {\n  return prices.reduce((sum, price) => sum + price);\n}', after: 'export function total(prices: number[]): number {\n  return prices.reduce((sum, price) => sum + price, 0);\n}' },
  { path: 'src/normalize.ts', before: 'export function normalize(value: string): string {\n  return value.toLowerCase();\n}', after: 'export function normalize(value: string): string {\n  return value.trim().toLowerCase();\n}' },
  { path: 'src/page.ts', before: 'export function pageSize(value: number): number {\n  return value;\n}', after: 'export function pageSize(value: number): number {\n  return Math.min(100, Math.max(1, value));\n}' },
];
const results: unknown[] = [];
try {
  await mkdir(join(root, 'src'));
  for (const [index, edit] of edits.entries()) {
    const file = join(root, edit.path);
    await writeFile(file, edit.before);
    const before = await readFile(file, 'utf8');
    await writeFile(file, edit.after);
    const after = await readFile(file, 'utf8');
    const batch = `disk-batch-${index}`;
    const context: ContextPacket = { excerpts: [{ evidence: { id: `disk-ref-${index}`, path: edit.path, startLine: 1, endLine: 3, changeBatchId: batch }, text: `Observed previous file:\n${before}\nObserved current file (cited lines 1–3):\n${after}` }], omissions: ['Only the observed before/after function is provided. No tests or callers are included.'], verificationRuns: [] };
    const started = Date.now();
    try {
      const output = await provider.explain({ sessionId: 'observed-smoke', changeBatchIds: [batch], level: index === 0 ? 'beginner' : 'expert', includeQuiz: index === 0, question: index === 2 ? 'What does the new clamp do? Is behavior for NaN known from this expression?' : undefined, context });
      const result = { name: edit.path, result: 'PASS', latencyMs: Date.now() - started, observedBefore: before, observedAfter: after, output };
      results.push(result); console.log(JSON.stringify(result, null, 2));
    } catch (error) { results.push({ name: edit.path, result: 'FAIL', error: String(error) }); console.error(error); process.exitCode = 1; }
  }
} finally { await rm(root, { recursive: true, force: true }); }
if (process.env.AI_SMOKE_OUTPUT) await writeFile(resolve(process.env.INIT_CWD ?? process.cwd(), process.env.AI_SMOKE_OUTPUT), JSON.stringify({ model: process.env.OLLAMA_MODEL, harness: 'real temporary disk edits; no P2 observer integration', results }, null, 2) + '\n');
