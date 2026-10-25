// Vibe flow: unit tests + full engine flow over WebSocket with a fake coding agent (real file edits),
// a fake Ollama, the real observer and the real verification runner.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startEngine, type RunningEngine } from "../src/engine/main.js";
import type { ContextPacket } from "../src/shared/schemas.js";
import type { VibeSession } from "../src/shared/vibe.js";
import { EngineClient } from "../src/shared/wsClient.js";
import { agentEnv, parseClaudeLine } from "../src/vibe/agents.js";
import { detectTestCommand } from "../src/vibe/controller.js";
import { changedFiles, templateClarify, VibeGemma } from "../src/vibe/gemma.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));

/** Fake Ollama: picks a canned answer by which system prompt it sees. */
function fakeOllama(over: { clarify?: unknown; refine?: unknown; report?: unknown } = {}): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    if (String(url).endsWith("/api/tags")) return new Response(JSON.stringify({ models: [{ name: "gemma4:31b" }] }));
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    const sys = body.messages[0]!.content;
    const content = sys.includes("read-only reviewer")
      ? sys.includes("already answered")
        ? { vague: false, reason: "Answers settle it", questions: [] }
        : over.clarify ?? { vague: true, reason: "No behavior specified", questions: [{ question: "What should feature() return?", options: ["42", "a string"] }] }
      : sys.includes("final prompt")
        ? over.refine ?? { title: "Add feature()", refinedPrompt: `${JSON.stringify(body).includes("SLOW") ? "SLOW " : ""}Add src/feature.js exporting feature() that returns 42. Keep changes minimal.`, assumptions: ["No tests requested"], acceptanceCriteria: ["feature() returns 42"] }
        : over.report ?? { summary: "Added feature() and updated the README.", files: [{ path: "src/feature.js", what: "New feature() returning 42" }, { path: "src/ghost.js", what: "invented" }], addressed: ["feature() exists"], notAddressed: [], risks: [], nextSteps: ["Run tests"], citations: [{ path: "src/feature.js", startLine: 1, endLine: 3 }, { path: "nope.js", startLine: 1, endLine: 1 }] };
    return new Response(JSON.stringify({ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }));
  }) as typeof fetch;
}

describe("vibe units", () => {
  it("parses Claude stream-json lines", () => {
    expect(parseClaudeLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }, { type: "tool_use", name: "Edit", input: { file_path: "/w/a.ts" } }] } })).events).toEqual([
      { kind: "text", text: "hi" },
      { kind: "tool", text: "Edit /w/a.ts" },
    ]);
    expect(parseClaudeLine(JSON.stringify({ type: "result", result: "done", is_error: true }))).toMatchObject({ final: "done", isError: true });
    expect(parseClaudeLine("not json").events[0]).toEqual({ kind: "text", text: "not json" });
  });

  it("strips the parent Claude Code session env from the agent", () => {
    const env = agentEnv({ PATH: "/bin", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "x", CLAUDE_PID: "1", HOME: "/h" });
    expect(env).toMatchObject({ PATH: "/bin", HOME: "/h" });
    expect(Object.keys(env).filter((k) => k.startsWith("CLAUDE"))).toEqual([]);
  });

  it("template clarify asks on short prompts only", () => {
    expect(templateClarify("add login").vague).toBe(true);
    expect(templateClarify("Add a POST /login route in src/server.js that checks the in-memory users map and returns a token").vague).toBe(false);
  });

  it("changedFiles merges batches (create then modify stays create)", () => {
    const ctx = { diffs: [
      { path: "a.js", kind: "create", hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ["+x", "+y"] }] },
      { path: "a.js", kind: "modify", hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-x", "+z"] }] },
    ] } as unknown as ContextPacket;
    expect(changedFiles(ctx)).toEqual([{ path: "a.js", kind: "create", added: 3, removed: 1, what: "" }]);
  });

  it("detects test commands", () => {
    const d = mkdtempSync(join(tmpdir(), "lcc-detect-"));
    expect(detectTestCommand(d)).toBeUndefined();
    writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    expect(detectTestCommand(d)).toBe("npm test");
  });

  it("Gemma: invalid model JSON falls back to a labeled template", async () => {
    const g = new VibeGemma({ provider: "auto", fetch: fakeOllama({ clarify: "not json at all" }) });
    const r = await g.clarify("add login", { name: "x", files: [], notes: "" });
    expect(r.source.mode).toBe("template");
    expect(r.vague).toBe(true);
  });

  it("Gemma: mock provider never calls the model", async () => {
    const g = new VibeGemma({ provider: "mock", fetch: (() => { throw new Error("should not fetch"); }) as unknown as typeof fetch });
    expect((await g.refine("x y", [], { name: "x", files: [], notes: "" })).source.mode).toBe("template");
  });
});

describe("vibe flow over the engine", () => {
  let engine: RunningEngine;
  let client: EngineClient;
  let latest: VibeSession | null = null;
  const ws = mkdtempSync(join(tmpdir(), "lcc-vibe-ws-"));
  const until = (pred: (s: VibeSession) => boolean, ms = 20_000) =>
    new Promise<VibeSession>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout; phase=${latest?.phase} error=${latest?.error}`)), ms);
      const check = (s: VibeSession) => pred(s) && (clearTimeout(t), off(), resolve(s));
      const off = client.on("vibe_updated", check);
      if (latest && pred(latest)) check(latest);
    });

  beforeAll(async () => {
    writeFileSync(join(ws, "package.json"), JSON.stringify({ name: "w", scripts: { test: "node -e \"process.exit(0)\"" } }));
    writeFileSync(join(ws, "README.md"), "# demo\n");
    engine = await startEngine({
      dataDir: mkdtempSync(join(tmpdir(), "lcc-vibe-data-")),
      quiet: true,
      modelProvider: "mock",
      workspace: ws,
      gemma: () => new VibeGemma({ provider: "auto", fetch: fakeOllama() }),
      vibe: {
        env: { ...process.env, LCC_CLAUDE_BIN: process.execPath, LCC_CLAUDE_PREFIX_ARGS: JSON.stringify([FAKE]), LCC_CODEX_BIN: "definitely-not-installed-codex" },
        settleQuietMs: 3000,
        settleMaxMs: 15_000,
      },
    });
    client = new EngineClient({ port: engine.bridge.port, token: engine.bridge.token }, { WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket });
    client.on("vibe_updated", (s) => (latest = s));
    const open = new Promise<void>((r) => client.onState((st) => st === "open" && r()));
    client.connect();
    await open;
    for (let i = 0; i < 40 && engine.orchestrator.vibe.agents.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
  }, 20_000);
  afterAll(async () => {
    client.close();
    await engine.stop();
  });

  it("detects the fake Claude and reports Codex as not installed", () => {
    const a = engine.orchestrator.vibe.agents;
    expect(a.find((x) => x.id === "claude")).toMatchObject({ available: true, version: "9.9.9 (Fake Claude)" });
    expect(a.find((x) => x.id === "codex")?.available).toBe(false);
  });

  it("vague prompt -> questions -> refined -> agent edits files -> grounded report -> user verify", async () => {
    client.send({ type: "vibe_start", payload: { prompt: "add a feature", agent: "claude", review: true, allowCommands: false, level: "beginner" } });
    let s = await until((x) => x.phase === "awaiting_answers");
    expect(s.questions[0]).toMatchObject({ id: "q1", question: "What should feature() return?" });
    expect(s.gemma).toMatchObject({ mode: "real", model: "gemma4:31b" });
    expect(s.suggestedCheck).toBe("npm test");
    expect(engine.orchestrator.snapshot().project?.goal).toBe("add a feature");

    client.send({ type: "vibe_answer", payload: { vibeId: s.id, answers: { q1: "42" } } });
    s = await until((x) => x.phase === "ready" && !!x.taskId);
    expect(s.refinedPrompt).toContain("returns 42");
    expect(s.answers).toEqual({ q1: "42" });
    // The prompt became a tracked task: Gemma's criterion + "tests pass" linked to the detected test command.
    const task = engine.orchestrator.snapshot().tasks.find((t) => t.id === s.taskId)!;
    expect(task.title).toBe("Add feature()");
    expect(task.acceptanceCriteria.map((c) => c.text)).toEqual(["feature() returns 42", "Tests pass (`npm test`)"]);
    expect(task.status).toBe("not_started");

    // Codex is not installed: refused, no state change.
    const err = new Promise<string>((r) => client.on("error", (e) => r(e.message)));
    client.send({ type: "vibe_run", payload: { vibeId: s.id, prompt: s.refinedPrompt!, agent: "codex", allowCommands: false } });
    expect(await err).toMatch(/not available/);

    client.send({ type: "vibe_run", payload: { vibeId: s.id, prompt: s.refinedPrompt! + " (edited)", agent: "claude", allowCommands: false } });
    s = await until((x) => x.phase === "done", 40_000);
    expect(s.run).toMatchObject({ outcome: "completed", exitCode: 0 });
    expect(s.run?.finalMessage).toMatch(/^Done\. Added feature\(\)/);
    expect(s.refinedPrompt).toMatch(/\(edited\)$/);
    expect(s.events.some((e) => e.kind === "tool" && e.text.startsWith("Write "))).toBe(true);
    expect(s.events.some((e) => e.kind === "stderr" && /requires approval/.test(e.text))).toBe(true);
    // Report is grounded in REAL observed changes; invented file + citation are discarded.
    const r = s.report!;
    expect(r.source.mode).toBe("real");
    expect(r.changes.map((c) => [c.path, c.kind])).toEqual([["README.md", "modify"], ["src/feature.js", "create"]]);
    expect(r.changes.find((c) => c.path === "src/feature.js")).toMatchObject({ added: 3, what: "New feature() returning 42" });
    expect(r.citations).toEqual([{ path: "src/feature.js", startLine: 1, endLine: 3 }]);
    expect(r.invalidCitations.map((c) => c.path).sort()).toEqual(["nope.js", "src/ghost.js"]);
    expect(r.markdown).toContain("_No tests were run. The changes above are unverified._");

    // User clicks "Run npm test": real process, recorded, saved as a project check, reflected in the report.
    client.send({ type: "vibe_verify", payload: { vibeId: s.id, command: "npm test" } });
    s = await until((x) => x.verificationRunIds.length === 1, 30_000);
    const run = engine.orchestrator.snapshot().verificationRuns.find((v) => v.id === s.verificationRunIds[0])!;
    expect(run).toMatchObject({ command: "npm test", result: "pass", exitCode: 0 });
    expect(engine.orchestrator.snapshot().project?.checkCommands.map((c) => c.command)).toEqual(["npm test"]);
    expect(s.report!.markdown).toMatch(/`npm test` → \*\*PASS\*\* \(exit 0\)/);
    // Progress: agent edits were attached as evidence (activity), the passing test met its linked criterion,
    // but the task is NOT complete until the user also confirms Gemma's criterion.
    const t2 = engine.orchestrator.snapshot().tasks.find((t) => t.id === s.taskId)!;
    expect(t2.linkedChangeBatchIds.length).toBeGreaterThan(0);
    expect(t2.acceptanceCriteria.map((c) => [c.met, c.metBy])).toEqual([[false, "none"], [true, "check"]]);
    expect(t2.status).not.toMatch(/complete|confirmed/);
  }, 90_000);

  it("cancel stops a running agent and still reports what changed", async () => {
    client.send({ type: "vibe_reset", payload: {} });
    // Auto-run (review off): answering the question goes straight through refine into the agent run.
    const toolEvent = new Promise<void>((r) => client.on("vibe_agent_event", ({ event }) => event.kind === "tool" && r()));
    client.send({ type: "vibe_start", payload: { prompt: "SLOW run please", agent: "claude", review: false, allowCommands: false, level: "beginner" } });
    let s = await until((x) => x.phase === "awaiting_answers");
    client.send({ type: "vibe_answer", payload: { vibeId: s.id, answers: { q1: "42" } } });
    s = await until((x) => x.phase === "running", 20_000);
    expect(s.refinedPrompt).toBeTruthy();
    await toolEvent; // the fake agent has written its files and is now sleeping
    client.send({ type: "vibe_cancel", payload: { vibeId: s.id } });
    s = await until((x) => x.phase === "cancelled" && !!x.report, 40_000);
    expect(s.run?.outcome).toBe("cancelled");
  }, 90_000);

  it("restart marks an interrupted session failed instead of stuck", async () => {
    const st = engine.orchestrator.state;
    const w = st.workspaces[ws]!;
    w.vibeSessions = w.vibeSessions.map((v, i) => (i === w.vibeSessions.length - 1 ? { ...v, phase: "running" } : v));
    engine.orchestrator.persistNow();
    const dataDir = engine.orchestrator.snapshot().engine.dataDir;
    client.close();
    await engine.stop();
    engine = await startEngine({ dataDir, quiet: true, modelProvider: "mock" });
    const last = engine.orchestrator.state.workspaces[ws]!.vibeSessions.at(-1)!;
    expect(last.phase).toBe("failed");
    expect(last.error).toMatch(/interrupted/);
  }, 30_000);
});
