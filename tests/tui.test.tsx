// Terminal UI behavior with a fake engine: real Ink rendering + real keystrokes.
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { ClientMessage, ServerEnvelope, VibeSession } from "../src/shared/index.js";
import { App, type EngineLike } from "../src/tui/App.js";
import { activityText, autoPane, friendlyError, steps } from "../src/tui/format.js";

class FakeEngine implements EngineLike {
  sent: ClientMessage[] = [];
  private handlers = new Set<(e: ServerEnvelope) => void>();
  send(m: ClientMessage) {
    this.sent.push(m);
    return "evt";
  }
  onAny(h: (e: ServerEnvelope) => void) {
    this.handlers.add(h);
    return () => void this.handlers.delete(h);
  }
  onState(h: (s: "open") => void) {
    h("open");
    return () => {};
  }
  emit(type: string, payload: unknown) {
    const e = { sessionId: "s", eventId: `e${Math.random()}`, timestamp: new Date().toISOString(), type, payload } as ServerEnvelope;
    this.handlers.forEach((h) => h(e));
  }
  last<T extends ClientMessage["type"]>(type: T) {
    return this.sent.filter((m) => m.type === type).at(-1) as Extract<ClientMessage, { type: T }> | undefined;
  }
}

const tick = () => new Promise((r) => setTimeout(r, 30));
const AT = new Date().toISOString();
const session = (over: Partial<VibeSession>): VibeSession => ({
  id: "v1", createdAt: AT, updatedAt: AT, originalPrompt: "change the theme to dark mode", agent: "claude", phase: "clarifying",
  level: "beginner", qa: [], criteria: [], review: false, allowCommands: true, questions: [], clarifyRounds: 0, answers: {}, assumptions: [],
  events: [], changeBatchIds: [], touched: [], parallel: false, verificationRunIds: [], ...over,
});
const report = {
  summary: "The app now uses dark colors everywhere.", changes: [{ path: "src/styles.css", kind: "modify" as const, added: 10, removed: 4, what: "Swapped the light colors for dark ones" }],
  addressed: ["Dark theme"], notAddressed: [], risks: ["Some images may look too bright"], tradeoffs: [], nextSteps: [], citations: [], invalidCitations: [], omissions: [],
  criteriaStatus: [],
  source: { provider: "ollama:gemma4:31b", mode: "real" as const, model: "gemma4:31b" }, markdown: "", generatedAt: AT,
};
const snapshot = (vibe: VibeSession | null, history: unknown[] = []) => ({
  project: { id: "p", name: "my-app", rootPath: "/Users/me/my-app", goal: "", checkCommands: [], createdAt: AT, updatedAt: AT },
  milestones: [], tasks: [], progress: null, changeBatches: [], verificationRuns: [],
  preferences: { level: "beginner", alwaysOnTop: true, compact: false, theme: "system", editorCommand: "", stallMinutes: 15, modelProvider: "auto" },
  modelStatus: { provider: "ollama", state: "real" }, engine: { version: "0", sessionId: "s", mock: false, dataDir: "", observerRunning: true },
  selectedTaskId: null, vibe, codingAgents: [{ id: "claude", name: "Claude Code", available: true }], vibeHistory: history,
});

function setup() {
  const engine = new FakeEngine();
  const r = render(<App client={engine} />);
  return { engine, ...r };
}

describe("terminal UI flow", () => {
  it("send a prompt -> starts with auto permissions, no review", async () => {
    const { engine, lastFrame, stdin } = setup();
    engine.emit("state_snapshot", snapshot(null));
    await tick();
    expect(lastFrame()).toContain("What would you like to change?");
    expect(lastFrame()).toContain("my-app");
    stdin.write("change the theme to dark mode");
    await tick();
    stdin.write("\r");
    await tick();
    expect(engine.last("vibe_start")?.payload).toEqual({ prompt: "change the theme to dark mode", agent: "claude", review: false, allowCommands: true, level: "beginner" });
  });

  it("asks questions one at a time; a number picks an option", async () => {
    const { engine, lastFrame, stdin } = setup();
    engine.emit("state_snapshot", snapshot(session({ phase: "awaiting_answers", questions: [
      { id: "q1", question: "Should it follow your computer's setting?", options: ["Yes, follow the system", "Always dark"] },
      { id: "q2", question: "Any colors to keep?" },
    ] })));
    await tick();
    expect(lastFrame()).toContain("Quick question 1 of 2");
    stdin.write("2");
    await tick();
    expect(engine.last("vibe_answer")).toBeUndefined();
    expect(lastFrame()).toContain("Any colors to keep?");
    stdin.write("keep the brand pink");
    await tick();
    stdin.write("\r");
    await tick();
    expect(engine.last("vibe_answer")?.payload).toEqual({ vibeId: "v1", answers: { q1: "Always dark", q2: "keep the brand pink" } });
  });

  it("switches to Progress when Claude starts, then to Learn when it is done", async () => {
    const { engine, lastFrame, stdin } = setup();
    engine.emit("state_snapshot", snapshot(session({ phase: "refining" })));
    await tick();
    expect(lastFrame()).toContain("Writing clear instructions for Claude");
    engine.emit("vibe_updated", session({ phase: "running", run: { agent: "claude", command: "claude", allowCommands: true, startedAt: AT, outcome: "running" } }));
    engine.emit("vibe_agent_event", { vibeId: "v1", event: { at: AT, kind: "tool", text: "Edit /Users/me/my-app/src/styles.css" } });
    await tick();
    expect(lastFrame()).toContain("Claude is making the changes");
    expect(lastFrame()).toContain("Editing styles.css");
    // Esc stops Claude
    stdin.write("\u001B");
    await tick();
    expect(engine.last("vibe_cancel")?.payload).toEqual({ vibeId: "v1" });
    engine.emit("vibe_updated", session({ phase: "reporting", run: { agent: "claude", command: "claude", allowCommands: true, startedAt: AT, outcome: "completed" } }));
    engine.emit("vibe_updated", session({ phase: "done", report, run: { agent: "claude", command: "claude", allowCommands: true, startedAt: AT, outcome: "completed" } }));
    await tick();
    const f = lastFrame()!;
    expect(f).toContain("What happened");
    expect(f).toContain("The app now uses dark colors everywhere.");
    expect(f).toContain("styles.css — Swapped the light colors for dark ones");
    expect(f).not.toContain("Quick quiz");
  });

  it("Learn: number keys change the explanation level; typing asks a question", async () => {
    const { engine, stdin } = setup();
    engine.emit("state_snapshot", snapshot(session({ phase: "running", run: { agent: "claude", command: "c", allowCommands: true, startedAt: AT, outcome: "running" } })));
    await tick();
    engine.emit("vibe_updated", session({ phase: "done", report, run: { agent: "claude", command: "c", allowCommands: true, startedAt: AT, outcome: "completed" } }));
    await tick();
    stdin.write("3");
    await tick();
    expect(engine.last("vibe_regenerate_report")?.payload).toEqual({ vibeId: "v1", level: "expert" });
    expect(engine.last("preferences_changed")?.payload).toEqual({ level: "expert" });
    stdin.write("why 3 colors?");
    await tick();
    stdin.write("\r");
    await tick();
    expect(engine.last("vibe_ask")?.payload).toEqual({ vibeId: "v1", question: "why 3 colors?" });
  });

  it("a new request while Claude works starts in parallel; Esc stops only the viewed change", async () => {
    const { engine, stdin, lastFrame } = setup();
    const running = session({ phase: "running", run: { agent: "claude", command: "c", allowCommands: true, startedAt: AT, outcome: "running" } });
    engine.emit("state_snapshot", snapshot(running));
    await tick();
    stdin.write("\t"); // Progress -> Learn
    await tick();
    stdin.write("\t"); // Learn -> See it
    await tick();
    stdin.write("\t"); // See it -> Ask
    await tick();
    stdin.write("make buttons bigger");
    await tick();
    stdin.write("\r");
    await tick();
    expect(engine.last("vibe_start")?.payload.prompt).toBe("make buttons bigger");
    expect(lastFrame()).toContain("Starting alongside 1 running change");
    // second change arrives as current; the first keeps running in the list
    const second = session({ id: "v2", createdAt: new Date(Date.now() + 10).toISOString(), originalPrompt: "make buttons bigger", phase: "clarifying" });
    engine.emit("state_snapshot", snapshot(second));
    engine.emit("vibe_updated", running);
    await tick();
    expect(lastFrame()).toContain("● change the theme");
    stdin.write("\u001B");
    await tick();
    expect(engine.last("vibe_cancel")?.payload).toEqual({ vibeId: "v2" });
  });

  it("Progress 'Done when' shows Gemma's check of each criterion, and Gemma's thinking streams", async () => {
    const { engine, lastFrame, stdin } = setup();
    engine.emit("state_snapshot", snapshot(session({ phase: "refining" })));
    engine.emit("vibe_thinking", { vibeId: "v1", text: "The user wants dark colors.\nI'll keep the brand pink." });
    await tick();
    expect(lastFrame()).toContain("Gemma is thinking");
    expect(lastFrame()).toContain("I'll keep the brand pink.");
    const run = { agent: "claude" as const, command: "c", allowCommands: true, startedAt: AT, outcome: "completed" as const };
    engine.emit("vibe_updated", session({ phase: "running", criteria: ["Background is dark", "Text is readable"], run: { ...run, outcome: "running" } }));
    await tick();
    expect(lastFrame()).toContain("○ Background is dark");
    engine.emit("vibe_updated", session({ phase: "reporting", criteria: ["Background is dark", "Text is readable"], run }));
    engine.emit("vibe_updated", session({ phase: "done", criteria: ["Background is dark", "Text is readable"], run, report: { ...report, criteriaStatus: [{ text: "Background is dark", met: true, why: "body color set to #111" }, { text: "Text is readable", met: false, why: "" }] } }));
    await tick();
    expect(lastFrame()).toContain("What happened"); // switched to Learn
    stdin.write("\u001B[Z"); // Shift+Tab -> Progress
    await tick();
    expect(lastFrame()).toContain("✔ Background is dark");
    expect(lastFrame()).toContain("✖ Text is readable");
  });

  it("changes list: arrow keys open a past change", async () => {
    const { engine, lastFrame, stdin } = setup();
    const hist = [
      { id: "v2", createdAt: AT, originalPrompt: "add a contact page", agent: "claude", phase: "done", filesChanged: 2, verified: "pass" },
      { id: "v1", createdAt: AT, originalPrompt: "change the theme to dark mode", agent: "claude", phase: "done", filesChanged: 1, verified: "none" },
    ];
    engine.emit("state_snapshot", snapshot(null, hist));
    await tick();
    expect(lastFrame()).toContain("+ New change");
    expect(lastFrame()).toContain("✔ add a contact page");
    stdin.write("\u001B[B"); // down
    await tick();
    stdin.write("\u001B[B");
    await tick();
    expect(engine.last("vibe_open")?.payload).toEqual({ vibeId: "v1" });
  });
});

describe("layout", () => {
  it("fits the terminal: long explanations scroll, the question box stays visible", async () => {
    const { engine, lastFrame, stdin } = setup();
    const long = { ...report, summary: "A long explanation. ".repeat(60), changes: Array.from({ length: 6 }, (_, i) => ({ path: `src/f${i}.ts`, kind: "modify" as const, added: 1, removed: 1, what: "Changed something important in this file" })) };
    engine.emit("state_snapshot", snapshot(session({ phase: "running", run: { agent: "claude", command: "c", allowCommands: true, startedAt: AT, outcome: "running" } })));
    await tick();
    engine.emit("vibe_updated", session({ phase: "done", report: long, run: { agent: "claude", command: "c", allowCommands: true, startedAt: AT, outcome: "completed" } }));
    await tick();
    await tick();
    const f = lastFrame()!;
    expect(f.split("\n").length).toBeLessThanOrEqual(30);
    expect(f).toContain("◆ Sidekick");
    expect(f).toContain("Ask anything about this change");
    expect(f).toContain("▼ more below");
    stdin.write("\u001B[6~"); // PgDn
    await tick();
    expect(lastFrame()).toContain("▲ PgUp");
  });
});

describe("plain-language helpers", () => {
  it("describes agent activity without jargon", () => {
    expect(activityText({ at: AT, kind: "tool", text: "Write /a/b/Hero.tsx" })).toBe("Writing Hero.tsx");
    expect(activityText({ at: AT, kind: "tool", text: "Grep useState" })).toBe("Looking through your code");
    expect(activityText({ at: AT, kind: "tool", text: "Bash npm test" })).toBe("Running a command");
  });
  it("auto-switches only on meaningful transitions", () => {
    expect(autoPane(undefined, "clarifying")).toBe("ask");
    expect(autoPane("refining", "running")).toBe("progress");
    expect(autoPane("reporting", "done")).toBe("learn");
    expect(autoPane("done", "reporting")).toBeNull(); // rewriting an explanation stays in Learn
  });
  it("rewrites errors for non-technical users", () => {
    expect(friendlyError("Ollama not reachable at http://127.0.0.1:11434")).toMatch(/Open the Ollama app/);
    expect(friendlyError("Claude Code is not available: `claude` CLI not found on PATH")).toMatch(/isn't installed/);
  });
  it("progress steps reflect the phase", () => {
    expect(steps(session({ phase: "running", run: { agent: "claude", command: "c", allowCommands: true, startedAt: AT, outcome: "running" } })).map((s) => s.state)).toEqual(["done", "done", "active", "todo"]);
  });
});
