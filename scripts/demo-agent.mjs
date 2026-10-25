#!/usr/bin/env node
// Plays the "coding agent" for the demo by making real, uncommitted edits in the demo workspace.
//   npm run demo:agent -- login   # implement login: create src/auth/login.js, edit server.js, delete legacy file
//   npm run demo:agent -- break   # introduce a bug (wrong password accepted) -> Verify shows a regression
//   npm run demo:agent -- fix     # repair the bug
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEMO_DIR } from "./demo.mjs";

const loginJs = (check) => `// Token login for the demo API.
const USERS = { ada: "lovelace" };

export function login({ user, password } = {}) {
  if (${check}) return { status: 401, body: { error: "invalid credentials" } };
  return { status: 200, body: { token: \`tok_\${user}\` } };
}
`;
const GOOD = "USERS[user] === undefined || USERS[user] !== password";
const BUGGY = "USERS[user] === undefined";

const serverJs = `import { createServer } from "node:http";
import { login } from "./auth/login.js";

// route(method, url, body) -> { status, body }. Kept pure so tests need no network.
export function route(method, url, body) {
  if (method === "GET" && url === "/health") return { status: 200, body: { ok: true } };
  if (method === "POST" && url === "/login") return login(body);
  return { status: 404, body: { error: "not found" } };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  createServer((req, res) => {
    const { status, body } = route(req.method, req.url, {});
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  }).listen(3000);
}
`;

const write = (rel, text) => {
  const abs = join(DEMO_DIR, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  console.log(`  wrote   ${rel}`);
};

const step = process.argv[2];
if (!existsSync(join(DEMO_DIR, "package.json"))) {
  console.error(`demo workspace not found at ${DEMO_DIR}; run \`npm run demo\` first`);
  process.exit(1);
}
console.log(`[agent] ${step} in ${DEMO_DIR}`);
if (step === "login") {
  write("src/auth/login.js", loginJs(GOOD));
  write("src/server.js", serverJs);
  rmSync(join(DEMO_DIR, "src/legacy/session.js"), { force: true });
  console.log("  deleted src/legacy/session.js");
} else if (step === "break") {
  write("src/auth/login.js", loginJs(BUGGY));
} else if (step === "fix") {
  write("src/auth/login.js", loginJs(GOOD));
} else {
  console.error("usage: npm run demo:agent -- login | break | fix");
  process.exit(1);
}
