#!/usr/bin/env node
// `lcc [folder]` — Local Code Companion in your terminal, on a project folder (default: current directory).
//   lcc                 # terminal app on the folder you're in
//   lcc ~/code/my-app   # on another folder
//   lcc --window        # the floating desktop window (Tauri) instead
// Install once from the repo: `npm install && npm link`.
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);

if (args.includes("--window")) {
  const folder = resolve(args.find((a) => !a.startsWith("--")) ?? process.cwd());
  const child = spawn(process.execPath, [join(appRoot, "scripts", "dev.mjs"), ...args.filter((a) => a.startsWith("--") && a !== "--window")], {
    cwd: appRoot,
    stdio: "inherit",
    env: { ...process.env, LCC_WORKSPACE: folder },
  });
  child.on("exit", (code) => process.exit(code ?? 0));
} else {
  const { register } = await import(pathToFileURL(join(appRoot, "node_modules", "tsx", "dist", "esm", "api", "index.mjs")).href);
  register();
  await import(pathToFileURL(join(appRoot, "src", "tui", "index.tsx")).href);
}
