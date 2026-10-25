/**
 * Deterministic observer fixtures. `LocalObserver.replayFiles` turns these into ChangeBatches
 * through the same diff/ignore/attribution pipeline as live edits.
 */
import type { TaskHint } from "../context/attribution.js";

export interface FixtureFile {
  path: string;
  /** Omitted or null = the file is created. */
  before?: string | null;
  /** Omitted or null = the file is deleted. Equal to `before` = unchanged, available as context only. */
  after?: string | null;
}

export interface ObserverFixture {
  name: string;
  sessionId: string;
  timestamp: string;
  files: FixtureFile[];
}

const SERVER_BEFORE = `import express from 'express';
import { health } from './routes/health';

const app = express();
app.use(express.json());

app.get('/health', health);

export function startServer(port: number) {
  return app.listen(port);
}
`;

const SERVER_AFTER = `import express from 'express';
import { health } from './routes/health';
import { login } from './auth/login';

const app = express();
app.use(express.json());

app.get('/health', health);

app.post('/login', async (req, res) => {
  const result = await login(req.body.email, req.body.password);
  res.status(result.ok ? 200 : 401).json(result);
});

export function startServer(port: number) {
  return app.listen(port);
}
`;

const LOGIN_AFTER = `import { verifyPassword } from './password';

export interface LoginResult {
  ok: boolean;
  userId?: string;
  error?: string;
}

const USERS = new Map([["ada@example.com", { id: "u1", passwordHash: "hash:secret1" }]]);

export async function login(email: string, password: string): Promise<LoginResult> {
  const user = USERS.get(email);
  if (!user) return { ok: false, error: "unknown email" };
  const valid = await verifyPassword(password, user.passwordHash);
  return valid ? { ok: true, userId: user.id } : { ok: false, error: "wrong password" };
}
`;

const PASSWORD_AFTER = `export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return hash === \`hash:\${password}\`;
}
`;

const SESSION_STORE_BEFORE = `const sessions = new Map<string, string>();

export function putSession(id: string, userId: string) {
  sessions.set(id, userId);
}

export function getSession(id: string) {
  return sessions.get(id);
}
`;

/** Create + modify + delete across three source files, plus a secret that must be omitted. */
export const MULTI_FILE_FIXTURE: ObserverFixture = {
  name: "multi-file-login",
  sessionId: "fixture-session",
  timestamp: "2026-10-25T12:00:00.000Z",
  files: [
    { path: "src/auth/login.ts", after: LOGIN_AFTER },
    { path: "src/auth/password.ts", after: PASSWORD_AFTER },
    { path: "src/server.ts", before: SERVER_BEFORE, after: SERVER_AFTER },
    { path: "src/legacy/session-store.ts", before: SESSION_STORE_BEFORE, after: null },
    { path: ".env", after: "API_KEY=sk-live-should-never-leave-the-machine\n" },
  ],
};

/** A small task list the demo and tests attribute changes against. */
export const DEMO_TASKS: TaskHint[] = [
  { id: "task-login", title: "Add login", acceptanceCriteria: ["POST /login returns 200 for valid credentials", "Wrong password returns 401"] },
  { id: "task-dark-mode", title: "Add dark mode toggle", acceptanceCriteria: ["Theme follows the OS setting", "Toggle persists across reloads"] },
  { id: "task-legacy", title: "Remove the legacy session store", acceptanceCriteria: ["src/legacy/session-store.ts is deleted"] },
  { id: "task-readme", title: "Write README install instructions", acceptanceCriteria: ["README lists npm install and npm run dev"] },
];
