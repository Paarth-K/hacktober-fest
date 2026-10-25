#!/usr/bin/env node
// `lcc [folder]` — open the Local Code Companion window on a project folder (default: current directory).
//   lcc                 # open on the folder you're in
//   lcc ~/code/my-app   # open on another folder
//   lcc --no-tauri      # engine + UI in the browser instead of the desktop window
// Install once from the repo: `npm install && npm link`.
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith("--"));
const folder = resolve(args.find((a) => !a.startsWith("--")) ?? process.cwd());
if (!existsSync(folder) || !statSync(folder).isDirectory()) {
  console.error(`lcc: not a folder: ${folder}`);
  process.exit(1);
}
const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
console.error(`[lcc] opening ${folder}`);
const child = spawn(process.execPath, [join(appRoot, "scripts", "dev.mjs"), ...flags], {
  cwd: appRoot,
  stdio: "inherit",
  env: { ...process.env, LCC_WORKSPACE: folder },
});
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
