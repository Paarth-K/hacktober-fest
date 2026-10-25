// P4 machine-B smoke: canonical ExplanationRequest -> aiAdapter -> P3 OllamaProvider -> real local model.
// Usage: OLLAMA_MODEL=<tag from `ollama list`> npx tsx scripts/live-gemma-smoke.ts [out.json]
import { writeFileSync } from "node:fs";
import { createModelProvider } from "../src/integrations/aiAdapter.js";
import { enforceCitations } from "../src/core/orchestrator.js";
import { loadDemoFixture } from "../src/shared/fixtures.js";
import { ExplanationResponseSchema, TaskBreakdownSuggestionSchema } from "../src/shared/schemas.js";
import type { ContextPacket } from "../src/shared/schemas.js";

const f = loadDemoFixture();
const b = f.changeBatches[0]!;
const ctx: ContextPacket = {
  changeBatchIds: [b.id], excerpts: [], evidence: b.evidence, omissions: b.omissions, missing: [], totalChars: 0, truncated: false,
  diffs: b.changes.map((c) => ({ path: c.path, kind: c.kind, hunks: c.hunks })),
};
const p = createModelProvider({ provider: "ollama", ollamaModel: process.env.OLLAMA_MODEL });
const out: Record<string, unknown> = { status: await p.status() };
console.log("status", out.status);

for (const [name, level, question] of [["beginner_quiz", "beginner", undefined], ["expert_followup", "expert", "What happens when the password is wrong?"]] as const) {
  const t = Date.now();
  const r = enforceCitations(ExplanationResponseSchema.parse(await p.explain({ sessionId: "smoke", requestId: name, changeBatchIds: [b.id], level, question, wantQuiz: level === "beginner", context: ctx, verificationRuns: [] })), ctx);
  out[name] = { ms: Date.now() - t, ...r };
  console.log(name, { mode: r.mode, model: r.model, ms: Date.now() - t, citations: r.evidence, invalid: r.invalidCitations, quiz: r.quiz?.length ?? 0 });
  console.log("  summary:", r.summary);
}
const t = Date.now();
const bd = TaskBreakdownSuggestionSchema.parse(await p.breakdown({ requestId: "bd", goal: f.project.goal }));
out.breakdown = { ms: Date.now() - t, ...bd };
console.log("breakdown", { mode: bd.mode, ms: Date.now() - t, tasks: bd.tasks.map((x) => `${x.title} [${x.acceptanceCriteria.length}]`) });
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(out, null, 2));
