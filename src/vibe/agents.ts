// Runs a coding agent headless in the workspace and streams what it does.
//   Claude Code: `claude -p <prompt> --output-format stream-json --verbose --permission-mode acceptEdits ...` (CLI)
//     file edits in the workspace are auto-approved; shell commands are denied unless the user allowed commands.
//   Codex: official @openai/codex-sdk (bundles the codex binary): sandbox workspace-write, approvalPolicy never,
//     network off. Codex can run commands inside its sandbox; it cannot write outside the workspace.
// The prompt is passed as data (argv element / SDK input), never through a shell.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodingAgentId, CodingAgentInfo, VibeAgentEvent } from "../shared/vibe.js";

/** Claude Code permission rules denying reads/edits of secret-bearing files. Best effort: see README limitations. */
export const CLAUDE_DENY = ["Read(./.env*)", "Read(**/.env*)", "Edit(./.env*)", "Read(**/*.pem)", "Read(**/*.key)", "Bash(cat .env*)"];

export interface RunOptions {
  /** Let the agent run shell commands (tests, installs) without asking. Off by default. */
  allowCommands: boolean;
}

export interface AgentDescriptor {
  id: CodingAgentId;
  name: string;
  /** Exact command / SDK call shown to the user. */
  display: (o: RunOptions) => string;
  permissions: (o: RunOptions) => string;
}

export const AGENTS: Record<CodingAgentId, AgentDescriptor> = {
  claude: {
    id: "claude",
    name: "Claude Code",
    display: (o) =>
      `claude -p <refined prompt> --output-format stream-json --verbose --permission-mode acceptEdits${o.allowCommands ? " --allowedTools Bash" : ""} --disallowedTools ${CLAUDE_DENY.map((d) => `"${d}"`).join(" ")}`,
    permissions: (o) =>
      o.allowCommands
        ? "Edits files and runs shell commands in the workspace without asking. .env/key files are blocked."
        : "Edits files in the workspace (auto-accepted). Shell commands are denied. .env/key files are blocked.",
  },
  codex: {
    id: "codex",
    name: "Codex",
    display: () => `@openai/codex-sdk startThread({ sandboxMode: "workspace-write", approvalPolicy: "never", networkAccessEnabled: false }).runStreamed(<refined prompt>)`,
    permissions: () => "Sandboxed: writes and commands only inside the workspace, no network, no approval prompts.",
  },
};

/** LCC_*_PREFIX_ARGS: JSON array prepended to argv (lets tests run `node fake-agent.mjs ...`). */
function prefix(raw: string | undefined): string[] {
  if (!raw) return [];
  const v = JSON.parse(raw) as unknown;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new Error("PREFIX_ARGS must be a JSON string array");
  return v;
}

export function claudeCommand(prompt: string, o: RunOptions, env: NodeJS.ProcessEnv = process.env): { bin: string; args: string[] } {
  return {
    bin: env.LCC_CLAUDE_BIN || "claude",
    args: [
      ...prefix(env.LCC_CLAUDE_PREFIX_ARGS),
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
      ...(o.allowCommands ? ["--allowedTools", "Bash"] : []),
      "--disallowedTools",
      ...CLAUDE_DENY,
    ],
  };
}

/** The codex binary: LCC_CODEX_BIN (+ LCC_CODEX_PREFIX_ARGS), else the one bundled with @openai/codex-sdk (run via node). */
export function codexBinary(env: NodeJS.ProcessEnv = process.env): { bin: string; args: string[] } | null {
  if (env.LCC_CODEX_BIN) return { bin: env.LCC_CODEX_BIN, args: prefix(env.LCC_CODEX_PREFIX_ARGS) };
  try {
    const require = createRequire(import.meta.url);
    return { bin: process.execPath, args: [require.resolve("@openai/codex/bin/codex.js")] };
  } catch {
    return null;
  }
}

/** Child env without the parent Claude Code session's variables, so the agent runs as its own session. */
export function agentEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_") || k === "CLAUDE_PID" || k === "CLAUDE_EFFORT") continue;
    out[k] = v;
  }
  return { ...out, NO_COLOR: "1", FORCE_COLOR: "0" };
}

export async function detectAgents(env: NodeJS.ProcessEnv = process.env): Promise<CodingAgentInfo[]> {
  const cenv = agentEnv(env);
  const claudeInfo = (async (): Promise<CodingAgentInfo> => {
    const r = await runQuick(env.LCC_CLAUDE_BIN || "claude", [...prefix(env.LCC_CLAUDE_PREFIX_ARGS), "--version"], 8000, cenv);
    return r.ok
      ? { id: "claude", name: "Claude Code", available: true, version: firstLine(r.out), detail: AGENTS.claude.permissions({ allowCommands: false }) }
      : { id: "claude", name: "Claude Code", available: false, detail: "`claude` CLI not found on PATH. Install Claude Code and run `claude` once to log in." };
  })();
  const codexInfo = (async (): Promise<CodingAgentInfo> => {
    const bin = codexBinary(env);
    if (!bin) return { id: "codex", name: "Codex", available: false, detail: "@openai/codex-sdk is not installed (npm install)." };
    const v = await runQuick(bin.bin, [...bin.args, "--version"], 8000, cenv);
    if (!v.ok) return { id: "codex", name: "Codex", available: false, detail: "The codex binary failed to start on this machine." };
    const hasKey = !!(env.OPENAI_API_KEY || env.CODEX_API_KEY);
    const s = hasKey ? { ok: true, out: "api key" } : await runQuick(bin.bin, [...bin.args, "login", "status"], 8000, cenv);
    const loggedIn = hasKey || (s.ok && !/not logged in/i.test(s.out));
    return loggedIn
      ? { id: "codex", name: "Codex", available: true, version: firstLine(v.out), detail: AGENTS.codex.permissions({ allowCommands: true }) }
      : { id: "codex", name: "Codex", available: false, version: firstLine(v.out), detail: "Codex is installed but not logged in. Run `npx codex login` (or set OPENAI_API_KEY), then restart the app." };
  })();
  return Promise.all([claudeInfo, codexInfo]);
}

const firstLine = (s: string) => s.trim().split("\n")[0]?.slice(0, 100);

function runQuick(bin: string, args: string[], timeoutMs: number, env: NodeJS.ProcessEnv): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    let out = "";
    let child: ChildProcess;
    try {
      child = spawn(bin, args, { env, shell: useShell(bin) });
    } catch {
      return resolve({ ok: false, out: "" });
    }
    const t = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (out += d));
    child.on("error", () => {
      clearTimeout(t);
      resolve({ ok: false, out });
    });
    child.on("close", (code) => {
      clearTimeout(t);
      resolve({ ok: code === 0, out });
    });
  });
}

export interface AgentRunResult {
  outcome: "completed" | "failed" | "timeout" | "cancelled";
  exitCode: number | null;
  durationMs: number;
  finalMessage?: string;
}

export interface AgentRunHandle {
  done: Promise<AgentRunResult>;
  cancel(): void;
}

export interface RunAgentOptions extends RunOptions {
  agent: CodingAgentId;
  prompt: string;
  cwd: string;
  timeoutMs?: number;
  onEvent: (e: VibeAgentEvent) => void;
  env?: NodeJS.ProcessEnv;
}

export function runAgent(opts: RunAgentOptions): AgentRunHandle {
  return opts.agent === "codex" ? runCodex(opts) : runClaude(opts);
}

const emitter = (onEvent: RunAgentOptions["onEvent"]) => (kind: VibeAgentEvent["kind"], text: string) =>
  onEvent({ at: new Date().toISOString(), kind, text: text.slice(0, 2000) });

function runClaude(opts: RunAgentOptions): AgentRunHandle {
  const started = Date.now();
  const ev = emitter(opts.onEvent);
  let cancelled = false;
  let timedOut = false;
  let finalMessage: string | undefined;
  let isError = false;
  const { bin, args } = claudeCommand(opts.prompt, opts, opts.env);

  const child = spawn(bin, args, {
    cwd: opts.cwd,
    env: agentEnv(opts.env),
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    shell: useShell(bin),
  });
  ev("status", `Started Claude Code in the workspace${opts.allowCommands ? " (shell commands allowed)" : ""}`);

  let buf = "";
  child.stdout?.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const r = parseClaudeLine(line);
      for (const e of r.events) ev(e.kind, e.text);
      if (r.final !== undefined) {
        finalMessage = r.final;
        isError = r.isError;
      }
    }
  });
  child.stderr?.on("data", (d: Buffer) => {
    const text = d.toString("utf8").trim();
    if (text) ev("stderr", text);
  });

  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child);
  }, opts.timeoutMs ?? 20 * 60_000);

  const done = new Promise<AgentRunResult>((resolve) => {
    child.on("error", (e) => {
      clearTimeout(timer);
      ev("stderr", `Could not start ${bin}: ${e.message}`);
      resolve({ outcome: "failed", exitCode: null, durationMs: Date.now() - started });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const outcome = cancelled ? "cancelled" : timedOut ? "timeout" : code === 0 && !isError ? "completed" : "failed";
      ev("status", `Claude Code ${outcome} (exit ${code ?? "none"})`);
      resolve({ outcome, exitCode: code, durationMs: Date.now() - started, ...(finalMessage ? { finalMessage: finalMessage.slice(0, 8000) } : {}) });
    });
  });

  return {
    done,
    cancel() {
      cancelled = true;
      killTree(child);
    },
  };
}

function runCodex(opts: RunAgentOptions): AgentRunHandle {
  const started = Date.now();
  const ev = emitter(opts.onEvent);
  const abort = new AbortController();
  let cancelled = false;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, opts.timeoutMs ?? 20 * 60_000);

  const done = (async (): Promise<AgentRunResult> => {
    let finalMessage: string | undefined;
    let failed: string | undefined;
    try {
      const bin = codexBinary(opts.env);
      if (!bin) throw new Error("@openai/codex-sdk is not installed");
      const { Codex } = await import("@openai/codex-sdk");
      // The SDK spawns codexPathOverride directly; the bundled launcher is a JS file, so go through a tiny shim.
      const codexPathOverride = bin.args.length ? nodeShim(bin.bin, bin.args) : bin.bin;
      const env = Object.fromEntries(Object.entries(agentEnv(opts.env)).filter((e): e is [string, string] => typeof e[1] === "string"));
      const codex = new Codex({ codexPathOverride, env });
      const thread = codex.startThread({ workingDirectory: opts.cwd, sandboxMode: "workspace-write", approvalPolicy: "never", skipGitRepoCheck: true, networkAccessEnabled: false });
      ev("status", "Started Codex in the workspace (sandbox: workspace-write, no network)");
      const { events } = await thread.runStreamed(opts.prompt, { signal: abort.signal });
      for await (const e of events) {
        if (e.type === "item.completed") {
          const item = e.item as { type: string; [k: string]: unknown };
          if (item.type === "agent_message") {
            finalMessage = String(item.text ?? "");
            ev("text", finalMessage);
          } else if (item.type === "command_execution") ev("tool", `$ ${String(item.command)}${item.exit_code !== undefined ? ` (exit ${String(item.exit_code)})` : ""}`);
          else if (item.type === "file_change") for (const c of (item.changes as { path: string; kind: string }[] | undefined) ?? []) ev("tool", `${c.kind === "add" ? "Write" : c.kind === "delete" ? "Delete" : "Edit"} ${c.path}`);
          else if (item.type === "error") ev("stderr", String(item.message ?? "error"));
        } else if (e.type === "turn.failed") {
          failed = e.error.message;
          ev("stderr", `Codex turn failed: ${failed}`);
        } else if (e.type === "error") {
          failed = e.message;
          ev("stderr", `Codex error: ${failed}`);
        }
      }
    } catch (e) {
      if (!abort.signal.aborted) {
        failed = e instanceof Error ? e.message : String(e);
        ev("stderr", `Codex: ${failed}`);
      }
    } finally {
      clearTimeout(timer);
    }
    const outcome = cancelled ? "cancelled" : timedOut ? "timeout" : failed ? "failed" : "completed";
    ev("status", `Codex ${outcome}`);
    return { outcome, exitCode: outcome === "completed" ? 0 : null, durationMs: Date.now() - started, ...(finalMessage ? { finalMessage: finalMessage.slice(0, 8000) } : {}) };
  })();

  return {
    done,
    cancel() {
      cancelled = true;
      abort.abort();
    },
  };
}

/** A small executable that runs `node <script> <args> "$@"`, for SDKs that spawn a single binary path. */
function nodeShim(nodeBin: string, args: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "lcc-codex-"));
  if (process.platform === "win32") {
    const p = join(dir, "codex.cmd");
    writeFileSync(p, `@"${nodeBin}" ${args.map((a) => `"${a}"`).join(" ")} %*\r\n`);
    return p;
  }
  const p = join(dir, "codex");
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  writeFileSync(p, `#!/bin/sh\nexec ${q(nodeBin)} ${args.map(q).join(" ")} "$@"\n`);
  chmodSync(p, 0o755);
  return p;
}

/** On Windows, npm-installed CLIs are .cmd shims that need a shell; real .exe paths do not. */
function useShell(bin: string): boolean {
  return process.platform === "win32" && !/\.exe$/i.test(bin);
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

/** One line of `claude -p --output-format stream-json --verbose`. Unknown shapes are ignored. */
export function parseClaudeLine(line: string): { events: { kind: VibeAgentEvent["kind"]; text: string }[]; final?: string; isError: boolean } {
  let m: any;
  try {
    m = JSON.parse(line);
  } catch {
    return { events: [{ kind: "text", text: line }], isError: false };
  }
  const events: { kind: VibeAgentEvent["kind"]; text: string }[] = [];
  if (m?.type === "assistant" && Array.isArray(m.message?.content)) {
    for (const c of m.message.content) {
      if (c?.type === "text" && typeof c.text === "string" && c.text.trim()) events.push({ kind: "text", text: c.text.trim() });
      if (c?.type === "tool_use") events.push({ kind: "tool", text: describeTool(c.name, c.input) });
    }
  } else if (m?.type === "user" && Array.isArray(m.message?.content)) {
    for (const c of m.message.content) {
      if (c?.type === "tool_result" && c.is_error) events.push({ kind: "stderr", text: `Tool error: ${stringify(c.content).slice(0, 300)}` });
    }
  } else if (m?.type === "result") {
    return { events, final: typeof m.result === "string" ? m.result : "", isError: !!m.is_error };
  }
  return { events, isError: false };
}

function describeTool(name: string, input: any): string {
  const target = input?.file_path ?? input?.path ?? input?.notebook_path ?? input?.pattern ?? input?.command ?? input?.url ?? "";
  return `${name}${target ? ` ${String(target).slice(0, 300)}` : ""}`;
}

function stringify(x: unknown): string {
  if (typeof x === "string") return x;
  if (Array.isArray(x)) return x.map((y) => (typeof y?.text === "string" ? y.text : "")).join(" ");
  return JSON.stringify(x ?? "");
}
