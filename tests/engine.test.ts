// End-to-end engine test over the real loopback WebSocket with the typed client.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startEngine, type RunningEngine } from "../src/engine/main.js";
import { EngineClient } from "../src/shared/wsClient.js";
import type { ServerEnvelope, StateSnapshot } from "../src/shared/events.js";
import type { ChangeBatch } from "../src/shared/schemas.js";

let engine: RunningEngine;
let client: EngineClient;
const events: ServerEnvelope[] = [];
const workspace = mkdtempSync(join(tmpdir(), "lcc-ws-"));
const dataDir = mkdtempSync(join(tmpdir(), "lcc-data-"));
const node = JSON.stringify(process.execPath);

function next<T extends ServerEnvelope["type"]>(type: T, pred: (p: Extract<ServerEnvelope, { type: T }>["payload"]) => boolean = () => true, timeout = 8000) {
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

beforeAll(async () => {
  engine = await startEngine({ dataDir, quiet: true, modelProvider: "mock" });
  client = new EngineClient({ port: engine.bridge.port, token: engine.bridge.token }, { WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket });
  client.onAny((e) => events.push(e));
  const first = next("state_snapshot");
  client.connect();
  await first;
});
afterAll(async () => {
  client.close();
  await engine.stop();
});

describe("engine over websocket", () => {
  it("rejects connections without the token", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${engine.bridge.port}/?token=wrong`);
    const code = await new Promise((r) => ws.on("unexpected-response", (_req, res) => r(res.statusCode)).on("error", () => r("error")));
    expect(code).toBe(401);
  });

  it("goal -> tasks -> linked activity -> verify pass/fail -> report", async () => {
    let snap: StateSnapshot = await (async () => {
      const p = next("state_snapshot", (s) => s.project?.rootPath === workspace);
      client.send({ type: "set_project", payload: { rootPath: workspace, goal: "Build login" } });
      return p;
    })();
    expect(snap.project!.goal).toBe("Build login");

    const cfg = next("state_snapshot", (s) => (s.project?.checkCommands.length ?? 0) === 2);
    client.send({ type: "update_project", payload: { checkCommands: [
      { label: "passes", command: `${node} -e "process.exit(0)"` },
      { label: "fails", command: `${node} -e "process.exit(1)"` },
    ] } });
    snap = await cfg;
    const [pass, fail] = snap.project!.checkCommands;

    const created = next("task_updated", (t) => t.title === "Add login");
    client.send({ type: "create_task", payload: { title: "Add login", acceptanceCriteria: [{ text: "login test passes", checkCommandId: pass!.id }] } });
    const task = await created;
    expect(task.status).toBe("not_started");
    const failTaskP = next("task_updated", (t) => t.title === "Other");
    client.send({ type: "create_task", payload: { title: "Other", acceptanceCriteria: [{ text: "x", checkCommandId: fail!.id }] } });
    const other = await failTaskP;

    // Observed change arrives: activity is shown but percentage does not move.
    const batch: ChangeBatch = {
      id: "cb_test_1", sessionId: "s", timestamp: new Date().toISOString(), source: "fixture",
      changes: [{ path: "src/auth/login.ts", kind: "create", hunks: [], baselineMissing: false, truncated: false }],
      omissions: [], evidence: [{ id: "ev_t1", path: "src/auth/login.ts", startLine: 1, endLine: 3, changeBatchId: "cb_test_1" }],
      suggestedTaskLinks: [{ taskId: task.id, score: 0.9, reason: "path match" }, { taskId: "ghost", score: 0.9, reason: "x" }],
    };
    const cbEvt = next("change_batch", (b) => b.id === "cb_test_1");
    engine.orchestrator.ingestBatch(batch);
    engine.orchestrator.ingestBatch(batch); // duplicate is dropped
    const got = await cbEvt;
    expect(got.suggestedTaskLinks.map((l) => l.taskId)).toEqual([task.id]);
    expect(got.linkedTaskId).toBeUndefined();
    expect(engine.orchestrator.snapshot().changeBatches.filter((b) => b.id === "cb_test_1")).toHaveLength(1);

    const prog1 = next("progress_updated", (p) => p.byStatus.activity_detected === 1);
    client.send({ type: "link_change_to_task", payload: { changeBatchId: "cb_test_1", taskId: task.id } });
    const p1 = await prog1;
    expect(p1.percentComplete).toBe(0);
    expect(p1.unverifiedActivityTaskIds).toEqual([task.id]);

    // Failing check does not complete its task.
    const failRes = next("verification_result", (r) => r.checkCommandId === fail!.id);
    client.send({ type: "run_verification", payload: { checkCommandId: fail!.id, taskIds: [] } });
    expect((await failRes).result).toBe("fail");
    expect(engine.orchestrator.snapshot().tasks.find((t) => t.id === other.id)!.status).not.toMatch(/complete|confirmed/);

    // Passing check moves the linked task to verified_complete; bar updates.
    const prog2 = next("progress_updated", (p) => p.byStatus.verified_complete === 1);
    client.send({ type: "run_verification", payload: { checkCommandId: pass!.id, taskIds: [] } });
    expect((await prog2).percentComplete).toBe(50);

    const rep = next("report_ready");
    client.send({ type: "export_report", payload: { saveToWorkspace: false } });
    const md = (await rep).markdown;
    expect(md).toContain("**Complete:** 50%");
    expect(md).toContain("Add login");
    expect(md).toMatch(/Failing checks \(1\)/);
  });

  it("open_file stays inside the workspace", async () => {
    writeFileSync(join(workspace, "a.ts"), "x");
    const ok = next("open_file_result", (r) => r.path === "a.ts");
    client.send({ type: "open_file", payload: { path: "a.ts", line: 1 } });
    expect((await ok).ok).toBe(true);
    expect(() => client.send({ type: "open_file", payload: { path: "../etc/passwd" } })).toThrow();
  });

  it("explanation is labeled mock and citations are validated", async () => {
    const res = next("explanation_result");
    client.send({ type: "request_explanation", payload: { changeBatchIds: ["cb_test_1"], level: "beginner", wantQuiz: true } });
    const r = await res;
    expect(r.mode).toBe("mock");
    for (const c of r.evidence) expect(c.path).toBe("src/auth/login.ts");
  });

  it("invalid messages get an error, not a crash", async () => {
    const raw = new WebSocket(`ws://127.0.0.1:${engine.bridge.port}/?token=${engine.bridge.token}`);
    await new Promise((r) => raw.on("open", r));
    const err = new Promise<string>((r) => raw.on("message", (d) => { const m = JSON.parse(d.toString()); if (m.type === "error") r(m.payload.code); }));
    raw.send(JSON.stringify({ sessionId: "x", eventId: "e1", timestamp: "now", type: "update_task", payload: { taskId: 5 } }));
    expect(await err).toBe("invalid_message");
    raw.close();
  });

  it("persists state across engine restart", async () => {
    client.close();
    await engine.stop();
    engine = await startEngine({ dataDir, quiet: true, modelProvider: "mock" });
    const snap = engine.orchestrator.snapshot();
    expect(snap.project!.rootPath).toBe(workspace);
    expect(snap.tasks.find((t) => t.title === "Add login")!.status).toBe("verified_complete");
    expect(snap.progress!.percentComplete).toBe(50);
  });
});
