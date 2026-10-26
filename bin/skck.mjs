#!/usr/bin/env node
// `skck [folder]` — Sidekick in your terminal, on a project folder (default: current directory).
//   skck                 # terminal app on the folder you're in
//   skck ~/code/my-app   # on another folder
//   skck --setup         # choose skill level, models, permissions
//   skck --window        # the floating desktop window (Tauri; source checkout only)
// Installed package: runs the prebuilt bundle (dist-cli/skck.mjs, made by `npm run build:cli` / on pack).
// Source checkout (`npm link`): always runs the live TypeScript through tsx (LCC_FROM_BUNDLE=1 to test the bundle).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);

// Secrets (e.g. AI_GATEWAY_API_KEY) come from .env files, never from the repo: the app folder's .env
// (source checkout) and Sidekick's data folder .env (works for the installed copy). Existing env wins.
const dataDir =
  process.env.LCC_DATA_DIR ??
  (process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "local-code-companion")
    : process.platform === "win32"
      ? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "local-code-companion")
      : join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "local-code-companion"));
for (const f of [join(appRoot, ".env"), join(dataDir, ".env")]) {
  if (existsSync(f)) {
    try {
      process.loadEnvFile(f);
    } catch {
      /* ignore malformed .env */
    }
  }
}
const bundle = join(appRoot, "dist-cli", "skck.mjs");
const source = join(appRoot, "src", "tui", "index.tsx");

if (args.includes("--window")) {
  if (!existsSync(join(appRoot, "src-tauri"))) {
    console.error("skck --window needs a source checkout of the repo (Tauri + Rust). Use `skck` for the terminal app.");
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
