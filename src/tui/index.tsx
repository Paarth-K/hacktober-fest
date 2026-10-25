// `lcc` terminal app entry: runs the engine in-process for a project folder and renders the Ink UI.
//   lcc [folder] [--agent=claude|codex]
import { render } from "ink";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import WebSocket from "ws";
import { startEngine } from "../engine/main.js";
import { EngineClient } from "../shared/wsClient.js";
import { App } from "./App.js";

const args = process.argv.slice(2);
const folder = resolve(args.find((a) => !a.startsWith("--")) ?? process.cwd());
const agentArg = args.find((a) => a.startsWith("--agent="))?.split("=")[1];
const agent = agentArg === "codex" ? "codex" : "claude";

if (!existsSync(folder) || !statSync(folder).isDirectory()) {
  console.error(`lcc: not a folder: ${folder}`);
  process.exit(1);
}
if (!process.stdin.isTTY) {
  console.error("lcc needs an interactive terminal.");
  process.exit(1);
}

const engine = await startEngine({ workspace: folder, quiet: true });
const client = new EngineClient({ port: engine.bridge.port, token: engine.bridge.token }, { WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket });
client.connect();

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  client.close();
  await engine.stop();
};

const app = render(<App client={client} agent={agent} onQuit={() => void shutdown()} />, { exitOnCtrlC: false });
await app.waitUntilExit();
await shutdown();
process.exit(0);
