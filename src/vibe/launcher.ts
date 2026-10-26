// "See it": Gemma works out how to show the result of the user's changes (start a dev server and open a URL,
// open a file, or run a script), runs it after the user confirms, finds the URL, and retries with Gemma's fix
// if it fails. Commands come from a model, so nothing runs until the user presses Enter on the exact text.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { newId } from "../shared/events.js";
import type { ServerMessage } from "../shared/events.js";
import type { LaunchState } from "../shared/vibe.js";
import type { LaunchPlan, VibeGemma, WorkspaceSummary } from "./gemma.js";

const URL_RE = /(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?[^\s'"<>)\]]*)/i;
const MAX_ATTEMPTS = 3;

export interface LauncherDeps {
  root: () => string | null;
  gemma: () => VibeGemma;
  summary: (root: string) => WorkspaceSummary;
  /** What the latest change did (helps pick the right page, e.g. the new endpoint). */
  latestChange: () => string;
  broadcast: (m: ServerMessage) => void;
  env?: NodeJS.ProcessEnv;
}

export class Launcher {
  state: LaunchState | null = null;
  private child: ChildProcess | null = null;
  private log = "";
  private history: { command: string; error: string }[] = [];

  constructor(private deps: LauncherDeps) {}

  /** Ask Gemma how to show the result; waits for the user to confirm the command. */
  async plan(): Promise<void> {
    const root = this.deps.root();
    if (!root) throw new Error("choose a project folder first");
    this.stopProcess();
    this.history = [];
    this.set({ id: newId("launch"), phase: "planning", attempts: 0, log: "", why: "" });
    await this.replan();
  }

  private async replan(): Promise<void> {
    const root = this.deps.root()!;
    const plan = await this.deps.gemma().planLaunch({
      workspace: this.deps.summary(root),
      latestChange: this.deps.latestChange(),
      hasNodeModules: existsSync(join(root, "node_modules")),
      previousAttempts: this.history,
    });
    if (!this.state) return;
    if (!plan || plan.kind === "none") {
      return this.set({ ...this.state, phase: "failed", why: plan?.why ?? "Gemma couldn't work out how to open this project.", plan: plan ?? undefined });
    }
    if (plan.kind === "url" && plan.url && !plan.command) return this.set({ ...this.state, phase: "ready", plan, url: plan.url, why: plan.why });
    if (plan.kind === "file" && plan.file) return this.set({ ...this.state, phase: "ready", plan, file: join(root, plan.file), why: plan.why });
    this.set({ ...this.state, phase: "confirm", plan, why: plan.why });
  }

  /** User pressed Enter on the shown command. */
  confirm(): void {
    if (!this.state || this.state.phase !== "confirm" || !this.state.plan?.command) throw new Error("nothing to run");
    const root = this.deps.root()!;
    const plan = this.state.plan;
    this.log = "";
    this.set({ ...this.state, phase: "starting", attempts: this.state.attempts + 1, log: "" });
    const child = spawn(plan.command!, { cwd: root, shell: true, detached: process.platform !== "win32", env: { ...process.env, ...this.deps.env, BROWSER: "none", FORCE_COLOR: "0" } });
    this.child = child;
    const started = Date.now();
    const onData = (d: Buffer) => {
      this.log = (this.log + d.toString()).slice(-6000);
      const m = URL_RE.exec(this.log.replace(/\x1b\[[0-9;]*m/g, ""));
      if (this.state?.phase === "starting" && m) void this.found(m[1]!.replace("0.0.0.0", "localhost"));
      else if (this.state) this.set({ ...this.state, log: this.log.slice(-1500) });
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("close", (code) => {
      if (this.child !== child) return;
      this.child = null;
      if (!this.state) return;
      if (plan.kind === "command") {
        // One-shot (e.g. a script): its output is the result.
        return this.set({ ...this.state, phase: code === 0 ? "done" : "failed", log: this.log.slice(-3000), why: code === 0 ? plan.why : `Exited with code ${code}.` });
      }
      if (this.state.phase === "starting" || this.state.phase === "running") void this.failed(`exited with code ${code} after ${Math.round((Date.now() - started) / 1000)}s`);
    });
    // Servers that never print their URL: probe the planned one.
    if (plan.kind === "server" && plan.url) void this.probe(plan.url, child);
  }

  private async probe(url: string, child: ChildProcess): Promise<void> {
    const end = Date.now() + 60_000;
    while (Date.now() < end && this.child === child && this.state?.phase === "starting") {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
        if (r.status < 500) return this.found(url);
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (this.child === child && this.state?.phase === "starting") void this.failed("no address appeared within 60s");
  }

  private async found(url: string): Promise<void> {
    if (!this.state || this.state.phase !== "starting") return;
    // Prefer the planned page (e.g. the new endpoint) on the discovered host:port.
    let target = url;
    const planned = this.state.plan?.url;
    if (planned) {
      try {
        const p = new URL(planned);
        const f = new URL(url);
        if (p.pathname && p.pathname !== "/") target = `${f.origin}${p.pathname}${p.search}`;
      } catch {
        /* keep discovered */
      }
    }
    this.set({ ...this.state, phase: "running", url: target, log: this.log.slice(-1500) });
  }

  private async failed(reason: string): Promise<void> {
    if (!this.state) return;
    const cmd = this.state.plan?.command ?? "";
    this.history.push({ command: cmd, error: `${reason}\n${this.log.slice(-2000)}` });
    this.stopProcess();
    if (this.state.attempts >= MAX_ATTEMPTS) {
      return this.set({ ...this.state, phase: "failed", why: `It didn't start (${reason}). Gemma tried ${this.state.attempts} times.`, log: this.log.slice(-1500) });
    }
    // Agentic retry: Gemma reads the error and proposes a fixed command (still needs the user's Enter).
    this.set({ ...this.state, phase: "planning", why: `That didn't work (${reason}). Gemma is figuring out a fix…`, log: this.log.slice(-1500) });
    await this.replan();
  }

  stop(): void {
    this.stopProcess();
    if (this.state) this.set({ ...this.state, phase: "stopped" });
  }

  dispose(): void {
    this.stopProcess();
  }

  private stopProcess(): void {
    const c = this.child;
    this.child = null;
    if (!c || c.pid === undefined || c.exitCode !== null) return;
    try {
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(c.pid), "/T", "/F"]);
      else process.kill(-c.pid, "SIGTERM");
    } catch {
      c.kill("SIGTERM");
    }
  }

  private set(s: LaunchState): void {
    this.state = s;
    this.deps.broadcast({ type: "launch_updated", payload: s });
  }
}

export type { LaunchPlan };
