// Terminal UI against the REAL engine (template Gemma, fake Claude that edits real files).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "ink-testing-library";
import { afterAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startEngine, type RunningEngine } from "../src/engine/main.js";
import { EngineClient } from "../src/shared/wsClient.js";
import { App } from "../src/tui/App.js";
import { VibeGemma } from "../src/vibe/gemma.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
let frame: () => string = () => "";
const wait = async (pred: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timeout. Screen:\n${frame()}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};
const LONG = "Add a function called feature in src/feature.js that returns the number 42 and export it for other modules";
let engine: RunningEngine;
afterAll(async () => engine && (await engine.stop()));

describe("terminal UI + real engine", () => {
  it("finish a change, then + New change starts a fresh one; list shows only this session", async () => {
    const ws = mkdtempSync(join(tmpdir(), "lcc-tui-ws-"));
    writeFileSync(join(ws, "README.md"), "# x\n");
    engine = await startEngine({
      dataDir: mkdtempSync(join(tmpdir(), "lcc-tui-data-")), quiet: true, modelProvider: "mock", workspace: ws,
      gemma: () => new VibeGemma({ provider: "mock" }),
      vibe: { env: { ...process.env, LCC_CLAUDE_BIN: process.execPath, LCC_CLAUDE_PREFIX_ARGS: JSON.stringify([FAKE]) }, settleQuietMs: 2500, settleMaxMs: 8000 },
    });
    const client = new EngineClient({ port: engine.bridge.port, token: engine.bridge.token }, { WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket });
    client.connect();
    const { lastFrame, stdin } = render(<App client={client} />);
    frame = () => lastFrame() ?? "";
    await wait(() => lastFrame()!.includes("● ready"));
    stdin.write(LONG);
    await wait(() => lastFrame()!.includes("Add a function"));
    stdin.write("\r");
    await wait(() => lastFrame()!.includes("What happened"), 30_000);

    stdin.write("\u001B[A"); // up -> "+ New change"
    await wait(() => lastFrame()!.includes("What would you like to change?"));
    stdin.write("Add a second function called other that returns seven and export it from src/other.js");
    await wait(() => lastFrame()!.includes("Add a second"));
    stdin.write("\r");
    await wait(() => engine.orchestrator.snapshot().vibeHistory.length === 2, 10_000);
    await wait(() => lastFrame()!.includes("What happened"), 30_000);
    client.close();
  }, 90_000);
});

describe("parallel changes (real engine)", () => {
  it("two agents at once: each change gets only its own files; the second is told about the first", async () => {
    const ws = mkdtempSync(join(tmpdir(), "lcc-par-ws-"));
    writeFileSync(join(ws, "README.md"), "# x\n");
    const prompts: string[] = [];
    const gemma = new VibeGemma({ provider: "mock" });
    const origRefine = gemma.refine.bind(gemma);
    gemma.refine = async (p, qa, w, level, onThinking, otherWork = []) => {
      const r = await origRefine(p, qa, w, level, onThinking, otherWork);
      prompts.push(JSON.stringify(otherWork));
      return r;
    };
    const eng = await startEngine({
      dataDir: mkdtempSync(join(tmpdir(), "lcc-par-data-")), quiet: true, modelProvider: "mock", workspace: ws,
      gemma: () => gemma,
      vibe: { env: { ...process.env, LCC_CLAUDE_BIN: process.execPath, LCC_CLAUDE_PREFIX_ARGS: JSON.stringify([FAKE]) }, settleQuietMs: 2500, settleMaxMs: 8000 },
    });
    try {
      const o = eng.orchestrator;
      const env = (type: string, payload: unknown) => ({ sessionId: "t", eventId: `e${Math.random()}`, timestamp: new Date().toISOString(), type, payload }) as never;
      const startChange = (p: string) => o.handle(env("vibe_start", { prompt: p, agent: "claude", review: false, allowCommands: true, level: "expert" }), () => {});
      await startChange("Please create the file FILE=src/alpha.js with a constant, WAIT a bit, and keep everything else untouched");
      await wait(() => o.state.workspaces[ws]!.vibeSessions[0]?.phase === "running", 10_000);
      await wait(() => [...(o.state.workspaces[ws]!.vibeSessions[0]?.events ?? [])].some((e) => e.kind === "tool"), 10_000);
      await startChange("Please create the file FILE=src/beta.js with a constant, WAIT a bit, and keep everything else untouched");
      await wait(() => o.state.workspaces[ws]!.vibeSessions.length === 2 && o.state.workspaces[ws]!.vibeSessions.every((s) => s.phase === "done"), 40_000);
      const [a, b] = o.state.workspaces[ws]!.vibeSessions;
      expect(a!.report!.changes.map((c) => c.path)).toEqual(["src/alpha.js"]);
      expect(b!.report!.changes.map((c) => c.path)).toEqual(["src/beta.js"]);
      expect(prompts[1]).toContain("src/alpha.js"); // Gemma was told what the other agent is touching
    } finally {
      await eng.stop();
    }
  }, 60_000);
});
