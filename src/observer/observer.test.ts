import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChangeBatchSchema, isSafeRelPath, type ChangeBatch, type Task } from "../shared/index.js";
import { changedRanges, diffText } from "./diff.js";
import { classifyPath } from "./ignore.js";
import { createObserver, DEMO_TASKS, MULTI_FILE_FIXTURE, type LocalObserver } from "./index.js";
import { toWorkspaceRel } from "./paths.js";

describe("paths", () => {
  it("normalizes OS paths to safe POSIX workspace paths", () => {
    expect(toWorkspaceRel("/repo", "/repo/src/a.ts", path.posix)).toBe("src/a.ts");
    expect(toWorkspaceRel("C:\\repo", "C:\\repo\\src\\a.ts", path.win32)).toBe("src/a.ts");
    expect(toWorkspaceRel("C:\\Repo", "c:\\repo\\SRC\\a.ts", path.win32)).toBe("SRC/a.ts");
    expect(toWorkspaceRel("/repo", "/etc/passwd", path.posix)).toBeNull();
    expect(toWorkspaceRel("/repo", "/repo", path.posix)).toBeNull();
    expect(toWorkspaceRel("C:\\repo", "D:\\other\\x.ts", path.win32)).toBeNull();
  });

  it("rejects traversal and absolute paths", () => {
    for (const bad of ["../x", "a/../../x", "/etc/passwd", "C:/x", "a\\b", "", "a//b", "./a"]) expect(isSafeRelPath(bad)).toBe(false);
    expect(isSafeRelPath("src/..foo/a.ts")).toBe(true);
  });
});

describe("ignore rules", () => {
  it("ignores dirs, secrets, binaries, lockfiles and editor temp files", () => {
    expect(classifyPath(".git/config")).toBe("ignored_dir");
    expect(classifyPath("node_modules/zod/index.js")).toBe("ignored_dir");
    expect(classifyPath("packages/app/dist/main.js")).toBe("ignored_dir");
    expect(classifyPath("src-tauri/target/debug/app.exe")).toBe("ignored_dir");
    expect(classifyPath(".local-code-companion/progress-report.md")).toBe("ignored_dir");
    for (const s of [".env", ".env.local", "config/prod.env", "id_rsa", "keys/server.pem", "client_secret.json", "credentials.json", ".npmrc", ".ssh/config"]) {
      expect(classifyPath(s), s).toBe("secret");
    }
    expect(classifyPath("assets/logo.png")).toBe("binary");
    expect(classifyPath("package-lock.json")).toBe("lockfile");
    expect(classifyPath("src/.app.ts.swp")).toBe("editor_temp");
    expect(classifyPath("src/auth/login.ts")).toBeNull();
    expect(classifyPath("src/secretSanta.ts")).toBeNull();
    expect(classifyPath("README.md")).toBeNull();
  });
});

describe("diff", () => {
  it("produces real unified hunks with correct line numbers", () => {
    const before = "a\nb\nc\nd\ne\nf\ng\nh\n";
    const after = "a\nb\nC\nd\ne\nf\ng\nh\ni\n";
    const d = diffText(before, after);
    expect(d.addedLines).toBe(2);
    expect(d.removedLines).toBe(1);
    expect(d.hunks).toHaveLength(1);
    const h = d.hunks[0]!;
    expect(h).toMatchObject({ oldStart: 1, newStart: 1, oldLines: 8, newLines: 9 });
    expect(h.lines).toContain("-c");
    expect(h.lines).toContain("+C");
    expect(h.lines).toContain("+i");
    expect(changedRanges(d.hunks, false)).toEqual([
      { startLine: 3, endLine: 3 },
      { startLine: 9, endLine: 9 },
    ]);
  });

  it("splits distant edits into separate hunks", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
    const edited = [...lines];
    edited[2] = "changed 3";
    edited[35] = "changed 36";
    const d = diffText(`${lines.join("\n")}\n`, `${edited.join("\n")}\n`);
    expect(d.hunks).toHaveLength(2);
    expect(d.hunks[1]).toMatchObject({ oldStart: 33, newStart: 33 });
    expect(changedRanges(d.hunks, false)).toEqual([
      { startLine: 3, endLine: 3 },
      { startLine: 36, endLine: 36 },
    ]);
  });

  it("handles create, delete and caps", () => {
    const created = diffText("", "x\ny\n");
    expect(created.hunks[0]).toMatchObject({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ["+x", "+y"] });
    const deleted = diffText("x\ny\n", "");
    expect(deleted.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 2, newStart: 0, newLines: 0 });
    expect(changedRanges(deleted.hunks, true)).toEqual([{ startLine: 1, endLine: 2 }]);
    const big = Array.from({ length: 2000 }, (_, i) => `l${i}`).join("\n");
    const capped = diffText("", big);
    expect(capped.truncated).toBe(true);
    expect(capped.addedLines).toBe(2000);
    expect(capped.hunks.reduce((n, h) => n + h.lines.length, 0)).toBeLessThanOrEqual(400);
  });
});

describe("fixture replay", () => {
  it("builds a contract-valid, deterministic multi-file batch with safe paths and no secrets", async () => {
    const obs = createObserver({ watch: false });
    const a = await obs.replayFiles(MULTI_FILE_FIXTURE, DEMO_TASKS);
    const b = await createObserver({ watch: false }).replayFiles(MULTI_FILE_FIXTURE, DEMO_TASKS);
    expect(a).not.toBeNull();
    const batch = ChangeBatchSchema.parse(a);
    expect(b!.id).toBe(batch.id);
    expect(batch.source).toBe("fixture");
    expect(batch.changes.map((c) => [c.path, c.kind])).toEqual([
      ["src/auth/login.ts", "create"],
      ["src/auth/password.ts", "create"],
      ["src/legacy/session-store.ts", "delete"],
      ["src/server.ts", "modify"],
    ]);
    for (const c of batch.changes) expect(isSafeRelPath(c.path)).toBe(true);
    expect(batch.omissions).toContainEqual({ path: ".env", reason: "secret" });
    expect(JSON.stringify(batch)).not.toContain("sk-live");
    expect(batch.evidence.length).toBeGreaterThan(0);
    for (const ev of batch.evidence) expect(ev.changeBatchId).toBe(batch.id);
    const server = batch.changes.find((c) => c.path === "src/server.ts")!;
    expect(server.hunks.flatMap((h) => h.lines)).toContain("+app.post('/login', async (req, res) => {");

    const ids = batch.suggestedTaskLinks.map((l) => l.taskId);
    expect(ids[0]).toBe("task-legacy"); // names the deleted file explicitly
    expect(ids).toContain("task-login");
    expect(ids).not.toContain("task-dark-mode");
    expect(ids).not.toContain("task-readme");
  });

  it("rejects unsafe fixture paths without echoing them", async () => {
    const obs = createObserver({ watch: false });
    const batch = await obs.replayFiles({ name: "bad", sessionId: "s", timestamp: "2026-10-25T00:00:00.000Z", files: [{ path: "../../etc/passwd", after: "root" }, { path: "ok.ts", after: "x" }] });
    expect(batch!.changes.map((c) => c.path)).toEqual(["ok.ts"]);
    expect(batch!.omissions[0]).toMatchObject({ reason: "outside_workspace", path: "(unsafe path)" });
  });

  it("replayFixture validates and emits a pre-built batch", async () => {
    const obs = createObserver({ watch: false });
    const seen: ChangeBatch[] = [];
    obs.onBatch((b) => seen.push(b));
    const batch = (await createObserver({ watch: false }).replayFiles(MULTI_FILE_FIXTURE))!;
    obs.replayFixture(batch);
    expect(seen.map((b) => b.id)).toEqual([batch.id]);
    expect(obs.getBatch(batch.id)).toBeDefined();
  });
});

// ---- live filesystem ---------------------------------------------------------------

const DEBOUNCE = 400;

function task(id: string, title: string, criteria: string[] = [], linkedChangeBatchIds: string[] = []): Task {
  const at = "2026-10-25T00:00:00.000Z";
  return {
    id,
    projectId: "p1",
    title,
    order: 0,
    status: "not_started",
    acceptanceCriteria: criteria.map((text, i) => ({ id: `${id}-c${i}`, text, met: false, metBy: "none" })),
    linkedChangeBatchIds,
    evidenceIds: [],
    verificationRunIds: [],
    statusHistory: [],
    createdAt: at,
    updatedAt: at,
  };
}

describe("live observer", () => {
  let root: string;
  let obs: LocalObserver;
  let batches: ChangeBatch[];
  let errors: Error[];
  let tasks: Task[];

  const write = (rel: string, text: string) => writeFile(path.join(root, ...rel.split("/")), text);
  const nextBatch = (timeoutMs = 8000) =>
    new Promise<ChangeBatch>((resolve, reject) => {
      const start = batches.length;
      const t = setTimeout(() => reject(new Error(`no batch within ${timeoutMs}ms`)), timeoutMs);
      const off = obs.onBatch(() => {
        if (batches.length > start) {
          clearTimeout(t);
          off();
          resolve(batches[batches.length - 1]!);
        }
      });
    });
  const startObserver = () =>
    obs.start({ rootPath: root, sessionId: "test-session", onBatch: (b) => batches.push(b), getTasks: () => tasks, onError: (e) => errors.push(e) });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "lcc-observer-"));
    await mkdir(path.join(root, "src", "auth"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "dep"), { recursive: true });
    await write("src/server.ts", "export const port = 3000;\n\nexport function start() {\n  return port;\n}\n");
    await write("src/old.ts", "export const legacy = true;\n");
    await write("README.md", "# demo\n");
    batches = [];
    errors = [];
    tasks = [task("t-login", "Add login", ["POST /login works"]), task("t-theme", "Add dark mode toggle")];
    obs = createObserver({ debounceMs: DEBOUNCE, maxWaitMs: 4000, maxFileBytes: 4096 });
    await startObserver();
  });

  afterEach(async () => {
    await obs.stop();
    await rm(root, { recursive: true, force: true });
  });

  it("reports an uncommitted 3-file create/edit/delete with real hunks and an attribution hint", async () => {
    const pending = nextBatch();
    await write("src/auth/login.ts", "export function login(user: string) {\n  return user.length > 0;\n}\n");
    await write("src/server.ts", "export const port = 3000;\n\nexport function start() {\n  console.log('up');\n  return port;\n}\n");
    await unlink(path.join(root, "src", "old.ts"));
    const batch = ChangeBatchSchema.parse(await pending);

    expect(batch.source).toBe("watcher");
    expect(batch.sessionId).toBe("test-session");
    expect(batch.changes.map((c) => [c.path, c.kind])).toEqual([
      ["src/auth/login.ts", "create"],
      ["src/old.ts", "delete"],
      ["src/server.ts", "modify"],
    ]);
    const server = batch.changes.find((c) => c.path === "src/server.ts")!;
    expect(server.baselineMissing).toBe(false);
    expect(server.hunks[0]!.lines).toContain("+  console.log('up');");
    expect(batch.evidence).toContainEqual(expect.objectContaining({ path: "src/server.ts", startLine: 4, endLine: 4 }));
    expect(batch.suggestedTaskLinks.map((l) => l.taskId)).toEqual(["t-login"]);
    expect(errors).toEqual([]);
  });

  it("collapses three rapid writes into one batch with the final content", async () => {
    const pending = nextBatch();
    for (let i = 1; i <= 3; i++) {
      await write("src/server.ts", `export const port = ${3000 + i};\n\nexport function start() {\n  return port;\n}\n`);
      await new Promise((r) => setTimeout(r, 60));
    }
    const batch = await pending;
    await new Promise((r) => setTimeout(r, DEBOUNCE * 3));
    expect(batches).toHaveLength(1);
    expect(batch.changes).toHaveLength(1);
    const lines = batch.changes[0]!.hunks.flatMap((h) => h.lines);
    expect(lines).toContain("-export const port = 3000;");
    expect(lines).toContain("+export const port = 3003;");
  });

  it("never reads secrets or ignored dirs, and reports large files without content", async () => {
    const pending = nextBatch();
    await write(".env", "API_KEY=sk-live-do-not-leak\n");
    await write("node_modules/dep/index.js", "module.exports = 1;\n");
    await write("src/big.ts", `// ${"x".repeat(8000)}\n`);
    await write("README.md", "# demo\n\nMore docs.\n");
    const batch = await pending;
    const json = JSON.stringify(batch);
    expect(json).not.toContain("sk-live");
    expect(json).not.toContain("node_modules");
    expect(batch.omissions).toContainEqual(expect.objectContaining({ path: ".env", reason: "secret" }));
    expect(batch.omissions).toContainEqual(expect.objectContaining({ path: "src/big.ts", reason: "too_large" }));
    const big = batch.changes.find((c) => c.path === "src/big.ts")!;
    expect(big.hunks).toEqual([]);
    expect(json).not.toContain("xxxxxxxxxx");
    expect(batch.changes.map((c) => c.path)).toContain("README.md");

    const ctx = await obs.getContext([batch.id]);
    expect(JSON.stringify(ctx)).not.toContain("sk-live");
  });

  it("watches extensionless files named like ignored dirs (scripts/build, bin/out)", async () => {
    await mkdir(path.join(root, "scripts"), { recursive: true });
    const created = nextBatch();
    await write("scripts/build", "#!/bin/sh\nnpm run ui:build\n");
    expect((await created).changes.map((c) => [c.path, c.kind])).toEqual([["scripts/build", "create"]]);
    const edited = nextBatch();
    await write("scripts/build", "#!/bin/sh\nnpm run ui:build\nnpm test\n");
    expect((await edited).changes[0]!.hunks.flatMap((h) => h.lines)).toContain("+npm test");
  });

  it("emits nothing when a save does not change content", async () => {
    await write("README.md", "# demo\n");
    await new Promise((r) => setTimeout(r, DEBOUNCE * 4));
    expect(batches).toHaveLength(0);
  });

  it("reports edits made while stopped after a restart on the same root", async () => {
    await obs.stop();
    expect(obs.isRunning()).toBe(false);
    await write("src/server.ts", "export const port = 8080;\n\nexport function start() {\n  return port;\n}\n");
    await startObserver();
    expect(obs.isRunning()).toBe(true);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.source).toBe("manual");
    expect(batches[0]!.changes[0]!.hunks[0]!.lines).toContain("+export const port = 8080;");

    // and it keeps watching afterwards
    const pending = nextBatch();
    await write("src/auth/login.ts", "export const login = () => true;\n");
    expect((await pending).changes[0]).toMatchObject({ path: "src/auth/login.ts", kind: "create" });
  });

  it("reports every file of a removed directory and of a freshly written one", async () => {
    await mkdir(path.join(root, "src", "feature"), { recursive: true });
    await write("src/feature/a.ts", "export const a = 1;\n");
    await write("src/feature/b.ts", "export const b = 2;\n");
    await nextBatch();

    const removed = nextBatch();
    await rm(path.join(root, "src", "feature"), { recursive: true, force: true });
    expect((await removed).changes.map((c) => [c.path, c.kind])).toEqual([
      ["src/feature/a.ts", "delete"],
      ["src/feature/b.ts", "delete"],
    ]);

    const added = nextBatch();
    await mkdir(path.join(root, "src", "fresh", "deep"), { recursive: true });
    await write("src/fresh/deep/x.ts", "export const x = 1;\n");
    await write("src/fresh/y.ts", "export const y = 2;\n");
    expect((await added).changes.map((c) => [c.path, c.kind])).toEqual([
      ["src/fresh/deep/x.ts", "create"],
      ["src/fresh/y.ts", "create"],
    ]);
  });

  it("treats a rename as delete + create", async () => {
    const pending = nextBatch();
    await (await import("node:fs/promises")).rename(path.join(root, "src", "old.ts"), path.join(root, "src", "renamed.ts"));
    expect((await pending).changes.map((c) => [c.path, c.kind])).toEqual([
      ["src/old.ts", "delete"],
      ["src/renamed.ts", "create"],
    ]);
  });

  it("uses linked change batches as an attribution signal", async () => {
    const pending = nextBatch();
    await write("src/server.ts", "export const port = 1;\n\nexport function start() {\n  return port;\n}\n");
    const first = await pending;
    tasks = [task("t-ops", "Harden deployment", [], [first.id])];
    const second = nextBatch();
    await write("src/server.ts", "export const port = 2;\n\nexport function start() {\n  return port;\n}\n");
    const batch = await second;
    expect(batch.suggestedTaskLinks[0]).toMatchObject({ taskId: "t-ops" });
    expect(batch.suggestedTaskLinks[0]!.reason).toContain("already linked");
  });

  it("does not follow symlinks out of the workspace", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "lcc-outside-"));
    await writeFile(path.join(outside, "secret.ts"), "export const leaked = 'outside';\n");
    try {
      await symlink(path.join(outside, "secret.ts"), path.join(root, "src", "link.ts"), "file");
    } catch {
      await rm(outside, { recursive: true, force: true });
      return; // creating symlinks needs extra rights on Windows; nothing to test then
    }
    obs.notifyPath("src/link.ts");
    await write("README.md", "# demo\n\nlinked\n");
    const batch = await nextBatch();
    expect(JSON.stringify(batch)).not.toContain("leaked");
    expect(batch.changes.map((c) => c.path)).not.toContain("src/link.ts");
    await rm(outside, { recursive: true, force: true });
  });
});
