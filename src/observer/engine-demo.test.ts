// M4 demo, end to end through the real engine: goal → tasks → uncommitted 3-file edit seen by the
// live observer → change_batch with evidence + suggested links → progress unchanged → explanation
// grounded in the observer's context packet.
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startEngine, type RunningEngine } from "../engine/main.js";
import type { ServerEnvelope } from "../shared/events.js";
import { EngineClient } from "../shared/wsClient.js";

const workspace = mkdtempSync(join(tmpdir(), "lcc-demo-ws-"));
const dataDir = mkdtempSync(join(tmpdir(), "lcc-demo-data-"));
let engine: RunningEngine;
let client: EngineClient;

function next<T extends ServerEnvelope["type"]>(type: T, pred: (p: Extract<ServerEnvelope, { type: T }>["payload"]) => boolean = () => true, timeout = 15000) {
  return new Promise<Extract<ServerEnvelope, { type: T }>["payload"]>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeout);
    const off = client.on(type, (p) => {
      if (pred(p as never)) {
        clearTimeout(t);
        off();
        resolve(p as never);
      }
    });
  });
}

const file = (rel: string) => join(workspace, ...rel.split("/"));

beforeAll(async () => {
  mkdirSync(file("src/legacy"), { recursive: true });
  mkdirSync(file("src/auth"), { recursive: true });
  writeFileSync(file("src/server.ts"), "import express from 'express';\n\nconst app = express();\n\nexport function startServer(port: number) {\n  return app.listen(port);\n}\n");
  writeFileSync(file("src/legacy/session-store.ts"), "const sessions = new Map<string, string>();\n\nexport function getSession(id: string) {\n  return sessions.get(id);\n}\n");
  writeFileSync(file("README.md"), "# demo\n");
  writeFileSync(file(".env"), "API_KEY=sk-live-demo-secret\n");

  // Pinned to mock: a unit test must not depend on whether Ollama happens to be installed.
  engine = await startEngine({ dataDir, quiet: true, modelProvider: "mock" });
  client = new EngineClient({ port: engine.bridge.port, token: engine.bridge.token }, { WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket });
  const first = next("state_snapshot");
  client.connect();
  await first;
});

afterAll(async () => {
  client.close();
  await engine.stop();
  rmSync(workspace, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe("M4 demo: 3-file uncommitted edit through the engine", () => {
  it("goal → tasks → edit → evidence + hints → progress unchanged → grounded explanation", async () => {
    const snapP = next("state_snapshot", (s) => s.project?.rootPath === workspace && s.engine.observerRunning);
    client.send({ type: "set_project", payload: { rootPath: workspace, goal: "Ship login and drop legacy sessions" } });
    await snapP;

    const ids: Record<string, string> = {};
    for (const [key, title, criterion] of [
      ["login", "Add login", "POST /login returns 200 for valid credentials"],
      ["legacy", "Remove the legacy session store", "src/legacy/session-store.ts is deleted"],
      ["theme", "Add dark mode toggle", "Theme follows the OS setting"],
    ] as const) {
      const created = next("task_updated", (t) => t.title === title);
      client.send({ type: "create_task", payload: { title, acceptanceCriteria: [{ text: criterion }] } });
      ids[key] = (await created).id;
    }

    // The edit: no git, no hooks — just files changing on disk.
    const batchP = next("change_batch", (b) => b.source === "watcher");
    writeFileSync(file("src/auth/login.ts"), "export async function login(email: string, password: string) {\n  return email.length > 0 && password.length > 7;\n}\n");
    writeFileSync(
      file("src/server.ts"),
      "import express from 'express';\nimport { login } from './auth/login';\n\nconst app = express();\n\napp.post('/login', async (req, res) => {\n  res.status((await login(req.body.email, req.body.password)) ? 200 : 401).end();\n});\n\nexport function startServer(port: number) {\n  return app.listen(port);\n}\n",
    );
    unlinkSync(file("src/legacy/session-store.ts"));
    writeFileSync(file(".env"), "API_KEY=sk-live-demo-secret-rotated\n");
    const batch = await batchP;

    expect(batch.changes.map((c) => [c.path, c.kind])).toEqual([
      ["src/auth/login.ts", "create"],
      ["src/legacy/session-store.ts", "delete"],
      ["src/server.ts", "modify"],
    ]);
    expect(batch.changes.every((c) => !c.baselineMissing && c.hunks.length > 0)).toBe(true);
    expect(batch.evidence.length).toBeGreaterThanOrEqual(3);
    expect(batch.omissions).toContainEqual(expect.objectContaining({ path: ".env", reason: "secret" }));
    expect(JSON.stringify(batch)).not.toContain("sk-live");
    const linked = batch.suggestedTaskLinks.map((l) => l.taskId);
    expect(linked).toContain(ids.login);
    expect(linked).toContain(ids.legacy);
    expect(linked).not.toContain(ids.theme);

    // Activity alone never moves the percentage.
    const snap = await (async () => {
      const p = next("state_snapshot");
      client.send({ type: "request_snapshot", payload: {} });
      return p;
    })();
    expect(snap.progress?.percentComplete).toBe(0);

    // Explanation is built from the observer's context packet; citations must be real changed files.
    const res = next("explanation_result");
    client.send({ type: "request_explanation", payload: { changeBatchIds: [batch.id], level: "beginner", wantQuiz: true } });
    const explanation = await res;
    const changedPaths = new Set(batch.changes.map((c) => c.path).concat(["src/auth/login.ts"]));
    for (const c of explanation.evidence) expect(changedPaths.has(c.path)).toBe(true);
    expect(explanation.mode).toBe("mock");
  }, 60_000);
});
