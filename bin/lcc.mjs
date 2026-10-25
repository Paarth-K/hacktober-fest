#!/usr/bin/env node
// `lcc [folder]` — Local Code Companion in your terminal, on a project folder (default: current directory).
//   lcc                 # terminal app on the folder you're in
//   lcc ~/code/my-app   # on another folder
//   lcc --window        # the floating desktop window (Tauri; source checkout only)
// Installed package: runs the prebuilt bundle (dist-cli/lcc.mjs, made by `npm run build:cli` / on pack).
// Source checkout (`npm link`): always runs the live TypeScript through tsx (LCC_FROM_BUNDLE=1 to test the bundle).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const bundle = join(appRoot, "dist-cli", "lcc.mjs");
const source = join(appRoot, "src", "tui", "index.tsx");

if (args.includes("--window")) {
  if (!existsSync(join(appRoot, "src-tauri"))) {
    console.error("lcc --window needs a source checkout of the repo (Tauri + Rust). Use `lcc` for the terminal app.");
    process.exit(1);
  }
  const folder = resolve(args.find((a) => !a.startsWith("--")) ?? process.cwd());
  const child = spawn(process.execPath, [join(appRoot, "scripts", "dev.mjs"), ...args.filter((a) => a.startsWith("--") && a !== "--window")], {
    cwd: appRoot,
    stdio: "inherit",
    env: { ...process.env, LCC_WORKSPACE: folder },
  });
  child.on("exit", (code) => process.exit(code ?? 0));
} else if (existsSync(source) && process.env.LCC_FROM_BUNDLE !== "1") {
  // Dev: compile on the fly so edits take effect without rebuilding.
  const require = createRequire(import.meta.url);
  const { register } = await import(pathToFileURL(require.resolve("tsx/esm/api")).href);
  register();
  await import(pathToFileURL(source).href);
} else {
  await import(pathToFileURL(bundle).href);
}
