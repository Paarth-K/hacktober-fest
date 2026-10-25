// P4 integration gate: drives the REAL engine (real observer, real checks, configured model) over the
// loopback WebSocket against a fresh temp workspace with real, uncommitted file edits.
//   npx tsx scripts/e2e-gate.ts                 # model per LCC_MODEL_PROVIDER (default auto)
//   LCC_MODEL_PROVIDER=mock npx tsx scripts/e2e-gate.ts
// Prints one PASS/FAIL line per step and exits non-zero on any FAIL.
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startEngine, type RunningEngine } from "../src/engine/main.js";
import type { ServerMessage } from "../src/shared/events.js";
import type { ChangeBatch } from "../src/shared/schemas.js";
import { EngineClient } from "../src/shared/wsClient.js";

type Payload<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>["payload"];
const results: { step: string; ok: boolean; detail: string }[] = [];
const record = (step: string, ok: boolean, detail = "") => {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? `  — ${detail}` : ""}`);
};

const root = mkdtempSync(join(tmpdir(), "lcc-gate-ws-"));
const dataDir = mkdtempSync(join(tmpdir(), "lcc-gate-data-"));
const node = JSON.stringify(process.execPath);
const provider = (process.env.LCC_MODEL_PROVIDER as "auto" | "mock" | "ollama" | undefined) ?? "auto";

let engine: RunningEngine;
let client: EngineClient;

function next<T extends ServerMessage["type"]>(type: T, pred: (p: Payload<T>) => boolean = () => true, timeoutMs = 15_000): Promise<Payload<T>> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      off();
      reject(new Error(`timeout after ${timeoutMs}ms waiting for ${type}`));
    }, timeoutMs);
    const off = client.on(type, (p) => {
      if (pred(p as Payload<T>)) {
        clearTimeout(t);
        off();
        resolve(p as Payload<T>);
      }
    });
  });
}

async function connect() {
  engine = await startEngine({ dataDir, quiet: true, modelProvider: provider });
  client = new EngineClient({ port: engine.bridge.port, token: engine.bridge.token }, { WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket });
  const snap = next("state_snapshot");
  client.connect();
  return snap;
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    record(name, false, e instanceof Error ? e.message : String(e));
    return undefined;
  }
}

async function main() {
  // Seed workspace with a baseline before the observer starts.
  mkdirSync(join(root, "src", "auth"), { recursive: true });
  mkdirSync(join(root, "src", "legacy"), { recursive: true });
  writeFileSync(join(root, "src", "server.ts"), 'import express from "express";\nconst app = express();\napp.get("/health", (_req, res) => res.sendStatus(200));\nexport default app;\n');
  writeFileSync(join(root, "src", "legacy", "session.ts"), "// old cookie session helper\nexport const session = {};\n");
  writeFileSync(join(root, ".env"), "API_KEY=sk-live-supersecretvalue123456\n");

  await connect();
  record("engine starts and sends state_snapshot", true, `port ${engine.bridge.port}, provider=${provider}`);

  const snap = await step("set_project starts observer", async () => {
    const p = next("state_snapshot", (s) => s.project?.rootPath === root);
    client.send({ type: "set_project", payload: { rootPath: root, goal: "Add login to a small Express API" } });
    const s = await p;
    record("set_project starts observer", s.engine.observerRunning, `observerRunning=${s.engine.observerRunning}`);
    return s;
  });
  if (!snap) return;

  const cfgP = next("state_snapshot", (s) => (s.project?.checkCommands.length ?? 0) === 2);
  client.send({ type: "update_project", payload: { checkCommands: [
    { label: "login check", command: `${node} -e "require('fs').accessSync('src/auth/login.ts')"` },
    { label: "always fails", command: `${node} -e "process.exit(2)"` },
  ] } });
  const cfg = await cfgP;
  const [passCheck, failCheck] = cfg.project!.checkCommands;

  const loginP = next("task_updated", (t) => t.title === "Add login endpoint");
  client.send({ type: "create_task", payload: { title: "Add login endpoint", acceptanceCriteria: [{ text: "src/auth/login.ts exists and loads", checkCommandId: passCheck!.id }] } });
  const login = await loginP;
  const otherP = next("task_updated", (t) => t.title === "Write deployment docs");
  client.send({ type: "create_task", payload: { title: "Write deployment docs", acceptanceCriteria: [{ text: "docs check passes", checkCommandId: failCheck!.id }] } });
  const other = await otherP;
  record("goal + tasks with acceptance criteria created", true, `${login.id}, ${other.id}`);

  // Let the observer finish baselining, then make a real 3-file uncommitted create/edit/delete burst.
  await new Promise((r) => setTimeout(r, 1500));
  const before = engine.orchestrator.progress()!.percentComplete;
  const batchP = step("observer emits ChangeBatch for 3-file edit", () =>
    next("change_batch", (b) => b.changes.some((c) => c.path === "src/auth/login.ts"), 20_000),
  );
  writeFileSync(join(root, "src", "auth", "login.ts"), 'import { Router } from "express";\nexport const login = Router();\nlogin.post("/login", (req, res) => {\n  if (req.body.password !== "pw") return res.status(401).json({ error: "invalid" });\n  res.json({ token: "t" });\n});\n');
  writeFileSync(join(root, "src", "server.ts"), 'import express from "express";\nimport { login } from "./auth/login";\nconst app = express();\napp.use(express.json());\napp.use(login);\napp.get("/health", (_req, res) => res.sendStatus(200));\nexport default app;\n');
  unlinkSync(join(root, "src", "legacy", "session.ts"));
  writeFileSync(join(root, ".env"), "API_KEY=sk-live-changedsecretvalue98765\n");
  const batch = (await batchP) as ChangeBatch | undefined;
  if (batch) {
    // Bursts may be split across batches; gather everything observed in the last few seconds.
    await new Promise((r) => setTimeout(r, 6000));
    const all = engine.orchestrator.snapshot().changeBatches;
    const changes = all.flatMap((b) => b.changes);
    const kinds = Object.fromEntries(changes.map((c) => [c.path, c.kind]));
    record("observer emits ChangeBatch for 3-file edit", true, JSON.stringify(kinds));
    record("create/modify/delete kinds correct",
      kinds["src/auth/login.ts"] === "create" && kinds["src/server.ts"] === "modify" && kinds["src/legacy/session.ts"] === "delete", JSON.stringify(kinds));
    record("secret .env never in changes", !changes.some((c) => c.path.endsWith(".env")), `omissions=${JSON.stringify(all.flatMap((b) => b.omissions).map((o) => `${o.reason}:${o.path}`))}`);
    const srv = changes.find((c) => c.path === "src/server.ts");
    record("real diff hunks (not synthetic)", !!srv && srv.hunks.some((h) => h.lines.some((l) => l.includes("app.use(express.json())") && l.startsWith("+"))));
    const sugg = all.flatMap((b) => b.suggestedTaskLinks);
    record("suggested task link to 'Add login endpoint'", sugg.some((s) => s.taskId === login.id), JSON.stringify(sugg));
    record("activity does not change percentComplete", engine.orchestrator.progress()!.percentComplete === before, `before=${before} after=${engine.orchestrator.progress()!.percentComplete}`);
    record("no task auto-linked", engine.orchestrator.snapshot().tasks.every((t) => t.status === "not_started"));

    const linked = next("progress_updated", (p) => p.byStatus.activity_detected === 1);
    for (const b of all.filter((b) => b.changes.some((c) => c.path.startsWith("src/")))) {
      client.send({ type: "link_change_to_task", payload: { changeBatchId: b.id, taskId: login.id } });
    }
    const p1 = await step("link -> activity_detected, 0%", () => linked);
    if (p1) record("link -> activity_detected, 0%", p1.percentComplete === before, `percent=${p1.percentComplete}`);
  }

  // Verify: failing check does not complete; passing check verifies its task.
  const failRun = await step("failing check recorded, task not complete", async () => {
    const p = next("verification_result", (r) => r.checkCommandId === failCheck!.id);
    client.send({ type: "run_verification", payload: { checkCommandId: failCheck!.id, taskIds: [] } });
    return p;
  });
  if (failRun) {
    const t = engine.orchestrator.snapshot().tasks.find((x) => x.id === other.id)!;
    record("failing check recorded, task not complete", failRun.result === "fail" && failRun.exitCode === 2 && !/complete|confirmed/.test(t.status), `exit=${failRun.exitCode} status=${t.status}`);
  }
  const passRun = await step("passing check -> verified_complete", async () => {
    const p = next("verification_result", (r) => r.checkCommandId === passCheck!.id);
    client.send({ type: "run_verification", payload: { checkCommandId: passCheck!.id, taskIds: [] } });
    return p;
  });
  if (passRun) {
    const t = engine.orchestrator.snapshot().tasks.find((x) => x.id === login.id)!;
    const pct = engine.orchestrator.progress()!.percentComplete;
    record("passing check -> verified_complete", passRun.result === "pass" && t.status === "verified_complete" && pct === 50, `exit=${passRun.exitCode} status=${t.status} percent=${pct}`);
  }

  // Explanation + follow-up quiz with the configured provider.
  const batchIds = engine.orchestrator.snapshot().changeBatches.map((b) => b.id);
  const expl = await step("explanation", async () => {
    const p = Promise.race([next("explanation_result", () => true, 240_000), next("explanation_error", () => true, 240_000).then((e) => { throw new Error(`explanation_error: ${e.error}`); })]);
    client.send({ type: "request_explanation", payload: { taskId: login.id, changeBatchIds: batchIds, level: "beginner", wantQuiz: true } });
    return p;
  });
  if (expl) {
    const realPaths = new Set(engine.orchestrator.snapshot().changeBatches.flatMap((b) => b.changes.map((c) => c.path)));
    record("explanation", true, `mode=${expl.mode} provider=${expl.provider} model=${expl.model ?? "-"} ${expl.latencyMs ?? "?"}ms`);
    record("explanation citations reference observed files only", expl.evidence.every((c) => realPaths.has(c.path)), JSON.stringify(expl.evidence));
    record("quiz returned", (expl.quiz?.length ?? 0) > 0, `${expl.quiz?.length ?? 0} question(s)`);
    console.log(`      summary: ${expl.summary.slice(0, 300)}`);
    if (expl.mode !== "real") console.log("      NOTE: explanation was MOCK — this is NOT a live Gemma verification.");
  }
  const fu = await step("follow-up question", async () => {
    const p = Promise.race([next("explanation_result", () => true, 240_000), next("explanation_error", () => true, 240_000).then((e) => { throw new Error(`explanation_error: ${e.error}`); })]);
    client.send({ type: "ask_followup", payload: { question: "What status code is returned for a wrong password?", taskId: login.id, changeBatchIds: batchIds, level: "expert", wantQuiz: false } });
    return p;
  });
  if (fu) record("follow-up question", true, `mode=${fu.mode} ${fu.latencyMs ?? "?"}ms — ${fu.summary.slice(0, 160)}`);

  const rep = await step("progress report", async () => {
    const p = next("report_ready");
    client.send({ type: "export_report", payload: { saveToWorkspace: true } });
    return p;
  });
  if (rep) record("progress report", rep.markdown.includes("**Complete:** 50%") && /Failing checks \(1\)/.test(rep.markdown) && !!rep.savedPath, rep.savedPath ?? "");

  // Relaunch persistence.
  client.close();
  await engine.stop();
  const s2 = await connect();
  const t2 = s2.tasks.find((t) => t.title === "Add login endpoint");
  record("relaunch keeps project, tasks, statuses", s2.project?.rootPath === root && t2?.status === "verified_complete" && s2.progress?.percentComplete === 50, `status=${t2?.status} percent=${s2.progress?.percentComplete}`);
  client.close();
  await engine.stop();
}

main()
  .catch((e) => record("gate script crashed", false, e instanceof Error ? e.stack ?? e.message : String(e)))
  .finally(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} PASS${failed.length ? ` — FAILED: ${failed.map((f) => f.step).join("; ")}` : ""}`);
    process.exit(failed.length ? 1 : 0);
  });

