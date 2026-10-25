#!/usr/bin/env node
// Starts the engine, waits for its READY line, then launches `tauri dev` with
// LCC_ENGINE_PORT / LCC_ENGINE_TOKEN in the environment (read by the Rust shell
// command `engine_connection`). Pass --mock to run the engine in mock mode,
// --no-tauri to run engine + Vite only (open http://localhost:1420/?port=..&token=..).
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const mock = args.includes("--mock");
const noTauri = args.includes("--no-tauri");
const isWin = process.platform === "win32";
const children = [];

const engine = spawn(process.execPath, ["--import", "tsx", "src/engine/main.ts", ...(mock ? ["--mock"] : [])], {
  stdio: ["ignore", "pipe", "inherit"],
  env: process.env,
});
children.push(engine);

let started = false;
let buf = "";
engine.stdout.on("data", (d) => {
  buf += d.toString();
  process.stdout.write(d);
  const m = buf.match(/LCC_ENGINE_READY (\{.*\})/);
  if (m && !started) {
    started = true;
    const { port, token } = JSON.parse(m[1]);
    const env = { ...process.env, LCC_ENGINE_PORT: String(port), LCC_ENGINE_TOKEN: token, VITE_LCC_ENGINE_PORT: String(port), VITE_LCC_ENGINE_TOKEN: token };
    const cmd = noTauri ? ["vite"] : ["tauri", "dev"];
    console.error(`[dev] engine on ${port}; starting ${cmd.join(" ")}`);
    if (noTauri) console.error(`[dev] open http://localhost:1420/?port=${port}&token=${token}`);
    const ui = spawn(isWin ? "npx.cmd" : "npx", cmd, { stdio: "inherit", env, shell: isWin });
    children.push(ui);
    ui.on("exit", (code) => shutdown(code ?? 0));
  }
});
engine.on("exit", (code) => {
  console.error(`[dev] engine exited (${code})`);
  shutdown(code ?? 1);
});

function shutdown(code) {
  for (const c of children) if (c.exitCode === null) c.kill("SIGTERM");
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
