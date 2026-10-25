#!/usr/bin/env node
// One-command demo: creates a small real Node project (no npm deps) and launches the companion on it.
//   npm run demo              # create (if missing) + launch Tauri window on the demo workspace
//   npm run demo -- --reset   # recreate the demo workspace and wipe the demo app data
//   npm run demo -- --no-tauri  # engine + Vite only; open the printed URL in a browser
// Then, in another terminal, play the "coding agent":  npm run demo:agent -- login | break | fix
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEMO_DIR = process.env.LCC_DEMO_DIR ?? join(tmpdir(), "lcc-demo-todo-api");
export const DEMO_DATA = process.env.LCC_DEMO_DATA ?? join(tmpdir(), "lcc-demo-data");

const FILES = {
  "package.json": JSON.stringify({ name: "demo-todo-api", private: true, type: "module", scripts: { test: "node --test" } }, null, 2) + "\n",
  "README.md": "# demo-todo-api\n\nTiny HTTP API used to demo Local Code Companion. Run `npm test`.\n",
  ".env": "DEMO_API_KEY=not-a-real-key-demo-only\n",
  "src/server.js": `import { createServer } from "node:http";

// route(method, url, body) -> { status, body }. Kept pure so tests need no network.
export function route(method, url, _body) {
  if (method === "GET" && url === "/health") return { status: 200, body: { ok: true } };
  return { status: 404, body: { error: "not found" } };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  createServer((req, res) => {
    const { status, body } = route(req.method, req.url, {});
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  }).listen(3000);
}
`,
  "src/legacy/session.js": "// Old cookie-session helper, replaced by token login.\nexport const sessions = new Map();\n",
  "test/health.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { route } from "../src/server.js";

test("GET /health returns 200", () => {
  assert.equal(route("GET", "/health").status, 200);
});
`,
  "test/login.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { route } from "../src/server.js";

test("POST /login returns a token for valid credentials", () => {
  const res = route("POST", "/login", { user: "ada", password: "lovelace" });
  assert.equal(res.status, 200);
  assert.match(res.body.token, /^tok_/);
});

test("POST /login rejects a wrong password with 401", () => {
  assert.equal(route("POST", "/login", { user: "ada", password: "nope" }).status, 401);
});
`,
};

export function createDemoWorkspace(reset = false) {
  if (reset) {
    rmSync(DEMO_DIR, { recursive: true, force: true });
    rmSync(DEMO_DATA, { recursive: true, force: true });
  }
  if (existsSync(join(DEMO_DIR, "package.json"))) return false;
  for (const [rel, text] of Object.entries(FILES)) {
    const abs = join(DEMO_DIR, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const created = createDemoWorkspace(args.includes("--reset"));
  console.error(`[demo] workspace ${created ? "created" : "reused"}: ${DEMO_DIR}`);
  console.error(`[demo] app data: ${DEMO_DATA} (separate from your real data)`);
  console.error(`[demo] suggested goal:   Add token login to the demo API`);
  console.error(`[demo] suggested checks: "All tests" -> npm test   |   "Login tests" -> node --test test/login.test.js`);
  console.error(`[demo] simulate the coding agent in another terminal: npm run demo:agent -- login   (then: break, fix)`);
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const child = spawn(process.execPath, [join(root, "scripts", "dev.mjs"), ...args.filter((a) => a !== "--reset")], {
    stdio: "inherit",
    cwd: root,
    env: { ...process.env, LCC_WORKSPACE: DEMO_DIR, LCC_DATA_DIR: DEMO_DATA },
  });
  child.on("exit", (code) => process.exit(code ?? 0));
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
}
