// Node engine entry point. Prints one line `LCC_ENGINE_READY {"port":N,"token":"..."}`
// on stdout once the loopback WebSocket is listening.
//   npm run engine         -> real engine (persists to OS app-data dir)
//   npm run engine:mock    -> seeded with fixtures/demo-state.json, temp data dir, replays a fake change
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelProvider } from "../ai/index.js";
import { Orchestrator } from "../core/orchestrator.js";
import { createObserver } from "../observer/index.js";
import { newId } from "../shared/events.js";
import { loadDemoFixture } from "../shared/fixtures.js";
import type { ChangeBatch } from "../shared/schemas.js";
import { startBridge, type Bridge } from "../integrations/wsServer.js";
import { JsonStore, defaultDataDir } from "../storage/jsonStore.js";

export const ENGINE_VERSION = "0.1.0";

export interface EngineOptions {
  mock?: boolean;
  dataDir?: string;
  port?: number;
  token?: string;
  quiet?: boolean;
}

export interface RunningEngine {
  bridge: Bridge;
  orchestrator: Orchestrator;
  stop(): Promise<void>;
}

export async function startEngine(opts: EngineOptions = {}): Promise<RunningEngine> {
  const mock = !!opts.mock;
  const log = (m: string) => {
    if (!opts.quiet) console.error(`[engine] ${m}`);
  };
  const sessionId = newId("sess");
  const dataDir = opts.dataDir ?? (mock ? join(tmpdir(), `lcc-mock-${process.pid}`) : defaultDataDir());
  const store = new JsonStore(dataDir);
  const observer = createObserver();
  let bridge: Bridge | null = null;
  const broadcast: ConstructorParameters<typeof Orchestrator>[0]["broadcast"] = (m, replyTo) => bridge?.broadcast(m, replyTo);

  const orchestrator = new Orchestrator({
    store,
    observer,
    createProvider: (prefs) =>
      createModelProvider({
        provider: mock ? "mock" : prefs.modelProvider,
        ollamaBaseUrl: process.env.OLLAMA_BASE_URL,
        ollamaModel: process.env.OLLAMA_MODEL,
      }),
    broadcast,
    sessionId,
    version: ENGINE_VERSION,
    mock,
    log,
  });

  if (mock && !orchestrator.state.activeRootPath) seedFromFixture(orchestrator);

  bridge = await startBridge({
    sessionId,
    port: opts.port,
    token: opts.token,
    log,
    onConnect: (send) => send({ type: "state_snapshot", payload: orchestrator.snapshot() }),
    onMessage: (env, reply) => orchestrator.handle(env, reply),
  });
  await orchestrator.start();

  let replayTimer: ReturnType<typeof setTimeout> | null = null;
  if (mock) replayTimer = setTimeout(() => observer.replayFixture(syntheticBatch(sessionId)), 3000);

  // Connection file so a separately launched UI (browser dev) can find the engine. User-only perms.
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "engine.json"), JSON.stringify({ port: bridge.port, token: bridge.token, pid: process.pid, mock }), { mode: 0o600 });
  log(`listening on ws://127.0.0.1:${bridge.port} (mock=${mock}, data=${dataDir})`);

  return {
    bridge,
    orchestrator,
    async stop() {
      if (replayTimer) clearTimeout(replayTimer);
      await orchestrator.stop();
      await bridge!.close();
    },
  };
}

function seedFromFixture(o: Orchestrator): void {
  const f = loadDemoFixture();
  mkdirSync(f.project.rootPath, { recursive: true });
  o.state.activeRootPath = f.project.rootPath;
  o.state.workspaces[f.project.rootPath] = {
    project: f.project,
    milestones: f.milestones,
    tasks: f.tasks,
    changeBatches: f.changeBatches,
    verificationRuns: f.verificationRuns,
    explanationCache: {},
  };
}

/** A fresh fake change each mock launch so the UI sees a live change_batch event. */
function syntheticBatch(sessionId: string): ChangeBatch {
  const id = newId("cb_mock");
  return {
    id,
    sessionId,
    timestamp: new Date().toISOString(),
    source: "fixture",
    changes: [
      {
        path: "src/todos/routes.ts",
        kind: "modify",
        baselineMissing: false,
        truncated: false,
        hunks: [{ oldStart: 10, oldLines: 1, newStart: 10, newLines: 3, lines: [" router.get(\"/todos\", list);", "+router.post(\"/todos\", create);", "+router.delete(\"/todos/:id\", remove);"] }],
      },
    ],
    omissions: [],
    evidence: [{ id: newId("ev"), path: "src/todos/routes.ts", startLine: 10, endLine: 12, changeBatchId: id }],
    suggestedTaskLinks: [{ taskId: "task_crud", score: 0.7, reason: "keyword \"todos\" matches task \"Todo CRUD endpoints\"" }],
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("main.ts");
if (isMain) {
  const mock = process.argv.includes("--mock") || process.env.LCC_MOCK === "1";
  const engine = await startEngine({
    mock,
    port: process.env.LCC_PORT ? Number(process.env.LCC_PORT) : undefined,
    token: process.env.LCC_TOKEN || undefined,
  });
  process.stdout.write(`LCC_ENGINE_READY ${JSON.stringify({ port: engine.bridge.port, token: engine.bridge.token })}\n`);
  const shutdown = async () => {
    await engine.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
