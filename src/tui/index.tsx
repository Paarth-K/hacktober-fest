// `skck` terminal app entry: runs the engine in-process for a project folder and renders the Ink UI.
//   skck [folder] [--agent=claude|codex]
import { render } from "ink";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import WebSocket from "ws";
import { startEngine } from "../engine/main.js";
import { EngineClient } from "../shared/wsClient.js";
import { App } from "./App.js";
import { applyConfigEnv, loadConfig } from "./config.js";
import { Setup } from "./Setup.js";
import { Toaster, ensureToastHelper } from "./toaster.js";

const args = process.argv.slice(2);
const folder = resolve(args.find((a) => !a.startsWith("--")) ?? process.cwd());
const config = loadConfig();
const agentArg = args.find((a) => a.startsWith("--agent="))?.split("=")[1];
const agent = agentArg === "codex" ? "codex" : agentArg === "claude" ? "claude" : config.agent;

if (!existsSync(folder) || !statSync(folder).isDirectory()) {
  console.error(`skck: not a folder: ${folder}`);
  process.exit(1);
}
if (!process.stdin.isTTY) {
  console.error("skck needs an interactive terminal.");
  process.exit(1);
}

if (args.includes("--setup")) {
  let installed: string[] = [];
  try {
    const r = await fetch(`${process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434"}/api/tags`, { signal: AbortSignal.timeout(2000) });
    installed = ((await r.json()) as { models?: { name: string }[] }).models?.map((m) => m.name).filter((n) => /gemma/i.test(n)) ?? [];
  } catch {
    /* Ollama not running: only the downloadable option is shown */
  }
  const gateway = process.env.AI_GATEWAY_API_KEY ? process.env.SIDEKICK_GEMMA_MODEL || "google/gemma-4-26b-a4b-it" : undefined;
  const app = render(<Setup initial={config} installedGemma={installed} gateway={gateway} />);
  await app.waitUntilExit();
  process.exit(0);
}

applyConfigEnv(config);
const engine = await startEngine({ workspace: folder, quiet: true });
engine.orchestrator.state.preferences = { ...engine.orchestrator.state.preferences, level: config.level };
void engine.orchestrator.warmUpGemma(); // local Ollama: load the model now so the first question is quick
const client = new EngineClient({ port: engine.bridge.port, token: engine.bridge.token }, { WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket });
client.connect();

// `skck --prog`: also show progress as macOS toasts in the top-right corner.
let toaster: Toaster | null = null;
if (args.includes("--prog")) {
  const helper = ensureToastHelper();
  if ("bin" in helper) {
    toaster = new Toaster(helper.bin, (event, request) => engine.orchestrator.narrate(event, request));
    client.onAny((e) => toaster?.onEvent(e));
  } else process.stderr.write(`${helper.error}\n`);
}

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  toaster?.close();
  client.close();
  await engine.stop();
};

const app = render(<App client={client} agent={agent} autoPermissions={config.autoPermissions} onQuit={() => void shutdown()} />, { exitOnCtrlC: false });
await app.waitUntilExit();
await shutdown();
process.exit(0);
