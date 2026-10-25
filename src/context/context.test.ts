import { describe, expect, it } from "vitest";
import { ContextPacketSchema } from "../shared/index.js";
import { createObserver, DEMO_TASKS, MULTI_FILE_FIXTURE } from "../observer/index.js";
import { diffText } from "../observer/diff.js";
import { suggestTasks } from "./attribution.js";
import { enclosingBlock, splitLines } from "./code.js";
import { questionTerms } from "./packet.js";

function change(path: string, before: string, after: string) {
  return { path, kind: "modify" as const, hunks: diffText(before, after).hunks, baselineMissing: false, truncated: false };
}

describe("attribution hints", () => {
  it("suggests 'Add login' for a change to src/auth/login.ts", () => {
    const c = { ...change("src/auth/login.ts", "", "export function login() {}\n"), kind: "create" as const };
    const links = suggestTasks({ changes: [c] }, DEMO_TASKS);
    expect(links[0]).toMatchObject({ taskId: "task-login" });
    expect(links[0]!.score).toBeGreaterThanOrEqual(0.4);
    expect(links[0]!.reason).toContain("login");
  });

  it("suggests nothing for an unrelated change", () => {
    const c = change("src/utils/format.ts", "export const a = 1;\n", "export function formatDate(d: Date) {\n  return d.toISOString();\n}\n");
    expect(suggestTasks({ changes: [c] }, DEMO_TASKS)).toEqual([]);
  });

  it("suggests nothing when there are no tasks", () => {
    expect(suggestTasks({ changes: [change("src/auth/login.ts", "", "x\n")] }, [])).toEqual([]);
  });
});

describe("enclosing blocks", () => {
  it("finds the innermost function around a line", () => {
    const lines = splitLines("class A {\n  run(x: number) {\n    if (x) {\n      return 1;\n    }\n    return 2;\n  }\n}\n");
    expect(enclosingBlock(lines, 4, "brace")).toMatchObject({ startLine: 2, endLine: 7, name: "run" });
    const py = splitLines("def outer():\n    x = 1\n    return x\n\ndef other():\n    pass\n");
    expect(enclosingBlock(py, 2, "indent")).toMatchObject({ startLine: 1, endLine: 3, name: "outer" });
  });
});

describe("context packets", () => {
  it("getContext returns diffs, enclosing blocks and imported definitions, all real", async () => {
    const obs = createObserver({ watch: false });
    const batch = (await obs.replayFiles(MULTI_FILE_FIXTURE, DEMO_TASKS))!;
    const ctx = ContextPacketSchema.parse(await obs.getContext([batch.id]));
    expect(ctx.diffs.map((d) => d.path).sort()).toEqual(["src/auth/login.ts", "src/auth/password.ts", "src/legacy/session-store.ts", "src/server.ts"]);
    const login = ctx.excerpts.find((x) => x.path === "src/auth/login.ts" && x.text.includes("export async function login"));
    // A created file is changed end to end, so the excerpt is the whole new file.
    expect(login).toMatchObject({ kind: "changed", startLine: 1, endLine: 16 });
    expect(login!.evidenceId && batch.evidence.some((e) => e.id === login!.evidenceId)).toBe(true);
    for (const x of ctx.excerpts) {
      const lines = x.text.split("\n").length;
      expect(lines).toBe(x.endLine - x.startLine + 1);
    }
    expect(ctx.totalChars).toBeLessThanOrEqual(24_000);
    expect(JSON.stringify(ctx)).not.toContain("sk-live");
  });

  it("includes the definition an edited line imports from an unchanged file", async () => {
    const obs = createObserver({ watch: false });
    const password = "export function verifyPassword(p: string, h: string) {\n  return h === `hash:${p}`;\n}\n";
    const before = "import { verifyPassword } from './password';\n\nexport function login(p: string) {\n  return false;\n}\n";
    const after = "import { verifyPassword } from './password';\n\nexport function login(p: string) {\n  return verifyPassword(p, 'hash:x');\n}\n";
    const batch = (await obs.replayFiles({
      name: "import",
      sessionId: "s",
      timestamp: "2026-10-25T00:00:00.000Z",
      files: [
        { path: "src/auth/password.ts", before: password, after: password },
        { path: "src/auth/login.ts", before, after },
      ],
    }))!;
    expect(batch.changes.map((c) => c.path)).toEqual(["src/auth/login.ts"]);
    const ctx = await obs.getContext([batch.id]);
    expect(ctx.excerpts.find((x) => x.kind === "import")).toMatchObject({ path: "src/auth/password.ts", startLine: 1, endLine: 3 });
    expect(ctx.excerpts.find((x) => x.kind === "enclosing")).toMatchObject({ path: "src/auth/login.ts", startLine: 3, endLine: 5 });
  });

  it("respects maxChars and reports what was left out", async () => {
    const obs = createObserver({ watch: false });
    const batch = (await obs.replayFiles(MULTI_FILE_FIXTURE))!;
    const ctx = await obs.getContext([batch.id], { maxChars: 300 });
    expect(ctx.totalChars).toBeLessThanOrEqual(300);
    expect(ctx.truncated).toBe(true);
    expect(ctx.omissions.some((o) => o.reason === "budget")).toBe(true);
  });

  it("retrieveForQuestion finds a named symbol with exact references", async () => {
    const obs = createObserver({ watch: false });
    const batch = (await obs.replayFiles(MULTI_FILE_FIXTURE))!;
    const ctx = ContextPacketSchema.parse(await obs.retrieveForQuestion("What does `verifyPassword` check?", [batch.id]));
    const hit = ctx.excerpts.find((x) => x.path === "src/auth/password.ts" && x.text.includes("function verifyPassword"));
    expect(hit).toMatchObject({ startLine: 1, endLine: 3 });
    expect(ctx.missing).toEqual([]);
  });

  it("retrieveForQuestion reports a nonexistent symbol as missing instead of guessing", async () => {
    const obs = createObserver({ watch: false });
    const batch = (await obs.replayFiles(MULTI_FILE_FIXTURE))!;
    const ctx = await obs.retrieveForQuestion("Why does refreshTokenRotation() run before login?", [batch.id]);
    expect(ctx.missing.some((m) => m.includes("refreshTokenRotation"))).toBe(true);
    expect(ctx.excerpts.some((x) => x.text.includes("refreshTokenRotation"))).toBe(false);
  });

  it("reports unknown change batch ids", async () => {
    const ctx = await createObserver({ watch: false }).getContext(["cb_nope"]);
    expect(ctx.missing[0]).toContain("cb_nope");
    expect(ctx.diffs).toEqual([]);
  });

  it("splits questions into symbols, files and words", () => {
    expect(questionTerms("Why does `handleLogin` call auth.verify() in server.ts for sessions?")).toEqual({
      symbols: ["handleLogin", "verify"],
      files: ["server.ts"],
      words: ["call", "sessions"],
    });
  });
});
