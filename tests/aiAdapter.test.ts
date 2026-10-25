// Adapter between the canonical contract and P3's learning service, with a fake Ollama (no network).
import { describe, expect, it } from "vitest";
import { createModelProvider, toP3Context } from "../src/integrations/aiAdapter.js";
import { enforceCitations } from "../src/core/orchestrator.js";
import { loadDemoFixture } from "../src/shared/fixtures.js";
import { ExplanationResponseSchema, TaskBreakdownSuggestionSchema } from "../src/shared/schemas.js";
import type { ContextPacket, ExplanationRequest } from "../src/shared/schemas.js";

const f = loadDemoFixture();
const batch = f.changeBatches[0]!;
const ctx: ContextPacket = {
  changeBatchIds: [batch.id],
  excerpts: [],
  diffs: batch.changes.map((c) => ({ path: c.path, kind: c.kind, hunks: c.hunks })),
  evidence: batch.evidence,
  omissions: batch.omissions,
  missing: [],
  totalChars: 0,
  truncated: false,
};
const req = (over: Partial<ExplanationRequest> = {}): ExplanationRequest => ({
  sessionId: "s", requestId: "r1", changeBatchIds: [batch.id], level: "beginner", wantQuiz: true, context: ctx, verificationRuns: [], ...over,
});

/** Fake Ollama: /api/tags lists gemma; /api/chat returns the given model JSON. */
function fakeOllama(content: unknown, tags = ["gemma4:31b"]): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    if (u.endsWith("/api/tags")) return new Response(JSON.stringify({ models: tags.map((name) => ({ name })) }));
    if (u.endsWith("/api/chat")) return new Response(JSON.stringify({ message: { content: JSON.stringify(content) } }));
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
}
const offline = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;

const goodBody = {
  summary: "Adds a POST /login route that returns a token or 401.",
  behaviorChanges: ["POST /login now exists"],
  concepts: ["Express Router: groups routes"],
  concerns: ["Password check implementation is not shown"],
  evidence: [{ id: "ev_1", path: "src/auth/login.ts", startLine: 1, endLine: 10, changeBatchId: batch.id }],
  uncertainties: [],
  quiz: [{ question: "What does a wrong password return?", answer: "401" }],
};

describe("aiAdapter", () => {
  it("builds P3 excerpts from diff hunks when the observer gave none", () => {
    const { packet, batchIds } = toP3Context(ctx, [batch.id], []);
    expect(packet.excerpts.map((e) => e.evidence.id)).toEqual(["ev_1", "ev_2"]);
    expect(packet.excerpts[0]!.text).toContain("login.post");
    expect(batchIds).toEqual([batch.id]);
    expect(packet.omissions[0]).toMatch(/secret: .env/);
  });

  it("mock provider output is canonical and labeled mock", async () => {
    const p = createModelProvider({ provider: "mock" });
    expect(await p.status()).toMatchObject({ state: "mock" });
    const r = ExplanationResponseSchema.parse(await p.explain(req()));
    expect(r.mode).toBe("mock");
    expect(r.requestId).toBe("r1");
    expect(r.quiz?.length).toBeGreaterThan(0);
    const b = TaskBreakdownSuggestionSchema.parse(await p.breakdown({ requestId: "b1", goal: "Build a todo API" }));
    expect(b).toMatchObject({ mode: "mock", requestId: "b1" });
  });

  it("auto + reachable gemma -> real, grounded, citations mapped", async () => {
    const p = createModelProvider({ provider: "auto", fetch: fakeOllama(goodBody) });
    expect(await p.status()).toMatchObject({ state: "real", model: "gemma4:31b" });
    const r = ExplanationResponseSchema.parse(await p.explain(req()));
    expect(r).toMatchObject({ mode: "real", model: "gemma4:31b", provider: "ollama:gemma4:31b" });
    expect(r.evidence).toEqual([{ path: "src/auth/login.ts", startLine: 1, endLine: 10, evidenceId: "ev_1" }]);
    expect(r.concepts[0]).toEqual({ name: "Express Router", explanation: "groups routes" });
    expect(enforceCitations(r, ctx).invalidCitations).toEqual([]);
  });

  it("fictional citation from the model -> discarded, explicit mock fallback", async () => {
    const bad = { ...goodBody, evidence: [{ id: "ev_x", path: "src/made/up.ts", startLine: 1, endLine: 2, changeBatchId: batch.id }] };
    const p = createModelProvider({ provider: "auto", fetch: fakeOllama(bad) });
    const r = await p.explain(req());
    expect(r.mode).toBe("mock");
    expect(r.uncertainties.join(" ")).toMatch(/Live model invalid_output/);
    expect((await p.status()).state).toBe("offline");
  });

  it("Ollama offline -> status offline and labeled mock output", async () => {
    const p = createModelProvider({ provider: "auto", fetch: offline });
    expect(await p.status()).toMatchObject({ state: "offline" });
    expect((await p.explain(req())).mode).toBe("mock");
  });

  it("progress summary converts 0..100 to P3's fraction and is labeled template", async () => {
    const p = createModelProvider({ provider: "mock" });
    const snap = { projectId: "p", total: 5, byStatus: { not_started: 1, activity_detected: 1, needs_verification: 1, verified_complete: 1, user_confirmed: 1 }, percentComplete: 40, criteriaMet: 2, criteriaTotal: 6, unverifiedActivityTaskIds: [], stalledTaskIds: [], regressedTaskIds: [], computedAt: "x" };
    const s = await p.summarizeProgress!({ projectName: "x", goal: "", snapshot: snap, tasks: [], verificationRuns: [] });
    expect(s.source).toBe("template");
    expect(s.text).toMatch(/^40% complete/);
  });
});
