// Drives a vibe session: clarify -> (answers) -> refine -> run coding agent -> collect observed diffs -> report.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { newId } from "../shared/events.js";
import type { ClientEnvelope, ServerMessage } from "../shared/events.js";
import type { Observer } from "../shared/interfaces.js";
import type { ChangeBatch, VerificationRun } from "../shared/schemas.js";
import type { CodingAgentId, CodingAgentInfo, VibeAgentEvent, VibeHistoryItem, VibeSession } from "../shared/vibe.js";
import type { WorkspaceState } from "../storage/jsonStore.js";
import { AGENTS, detectAgents, runAgent, type AgentRunHandle } from "./agents.js";
import { reportMarkdown, type VibeGemma, type WorkspaceSummary } from "./gemma.js";

export const MAX_EVENTS = 300;
export const MAX_SESSIONS = 20;

export interface VibeDeps {
  workspace: () => WorkspaceState | null;
  observer: Observer;
  gemma: () => VibeGemma;
  broadcast: (m: ServerMessage) => void;
  persist: () => void;
  log: (m: string) => void;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  /** How long the observer must be quiet after the agent exits before reporting. */
  settleQuietMs?: number;
  settleMaxMs?: number;
  agentTimeoutMs?: number;
  /** Create the progress-tracking task for a prompt; returns its id. */
  createTask?: (title: string, criteria: string[], testCommand?: string) => string;
  /** Attach an observed change batch to a task as evidence (activity, never completion). */
  linkBatch?: (changeBatchId: string, taskId: string) => void;
  /** Called when the history list changes (session finished, opened, reset). */
  changed?: () => void;
  /** Runs an exact command as a project check (verification runner). */
  verify?: (command: string) => Promise<VerificationRun>;
  /** Looks up verification runs by id (for report markdown). */
  runs?: (ids: string[]) => VerificationRun[];
}

type VibeMessage = Extract<ClientEnvelope, { type: `vibe_${string}` }>;

export class VibeController {
  agents: CodingAgentInfo[] = [];
  private running: { vibeId: string; handle: AgentRunHandle } | null = null;
  /** vibeId collecting change batches (during the run and until the observer settles). */
  private collecting: string | null = null;
  private lastBatchAt = 0;

  constructor(private deps: VibeDeps) {
  }

  async init(): Promise<void> {
    this.agents = await detectAgents(this.deps.env);
    this.deps.broadcast({ type: "coding_agents", payload: this.agents });
    this.deps.log(`coding agents: ${this.agents.map((a) => `${a.id}=${a.available ? a.version : "missing"}`).join(", ")}`);
  }

  isBusy(): boolean {
    return this.running !== null || this.collecting !== null;
  }

  current(): VibeSession | null {
    const ws = this.deps.workspace();
    if (!ws?.currentVibeId) return null;
    return ws.vibeSessions.find((s) => s.id === ws.currentVibeId) ?? null;
  }

  history(): VibeHistoryItem[] {
    const ws = this.deps.workspace();
    if (!ws) return [];
    return [...ws.vibeSessions].reverse().map((s) => {
      const last = this.deps.runs?.(s.verificationRunIds.slice(-1))[0];
      return {
        id: s.id,
        createdAt: s.createdAt,
        originalPrompt: s.originalPrompt.slice(0, 300),
        agent: s.agent,
        phase: s.phase,
        filesChanged: s.report?.changes.length ?? 0,
        verified: !last ? "none" : last.result === "pass" ? "pass" : "fail",
      };
    });
  }

  stop(): void {
    this.running?.handle.cancel();
  }

  onBatch(batch: ChangeBatch): void {
    if (!this.collecting) return;
    const s = this.find(this.collecting);
    if (!s || s.changeBatchIds.includes(batch.id)) return;
    this.lastBatchAt = Date.now();
    this.update(s.id, { changeBatchIds: [...s.changeBatchIds, batch.id] });
    if (s.taskId) this.deps.linkBatch?.(batch.id, s.taskId);
  }

  async handle(env: VibeMessage): Promise<void> {
    switch (env.type) {
      case "vibe_start":
        return this.start(env.payload.prompt, env.payload.agent, env.payload.review, env.payload.allowCommands);
      case "vibe_answer":
        return this.answer(env.payload.vibeId, env.payload.answers);
      case "vibe_skip_questions":
        return this.refine(env.payload.vibeId, {});
      case "vibe_run":
        return this.run(env.payload.vibeId, env.payload.prompt, env.payload.agent, env.payload.allowCommands);
      case "vibe_cancel":
        return this.cancel(env.payload.vibeId);
      case "vibe_regenerate_report":
        return this.report(env.payload.vibeId);
      case "vibe_verify":
        return this.verify(env.payload.vibeId, env.payload.command);
      case "vibe_reset": {
        if (this.isBusy()) throw new Error("a coding agent run is in progress; cancel it first");
        const ws = this.requireWs();
        ws.currentVibeId = null;
        this.deps.persist();
        return;
      }
      case "vibe_open": {
        if (this.isBusy()) throw new Error("a coding agent run is in progress; cancel it first");
        const ws = this.requireWs();
        if (!ws.vibeSessions.some((s) => s.id === env.payload.vibeId)) throw new Error("session not found");
        ws.currentVibeId = env.payload.vibeId;
        this.deps.persist();
        return;
      }
    }
  }

  // ---------- phases ----------

  private async start(prompt: string, agent: CodingAgentId, review: boolean, allowCommands: boolean): Promise<void> {
    if (this.isBusy()) throw new Error("a coding agent run is in progress; cancel it first");
    const ws = this.requireWs();
    const at = this.iso();
    const s: VibeSession = {
      id: newId("vibe"),
      createdAt: at,
      updatedAt: at,
      originalPrompt: prompt.trim(),
      agent,
      phase: "clarifying",
      review,
      allowCommands,
      questions: [],
      clarifyRounds: 0,
      answers: {},
      assumptions: [],
      events: [],
      changeBatchIds: [],
      verificationRunIds: [],
      ...(detectTestCommand(ws.project.rootPath) ? { suggestedCheck: detectTestCommand(ws.project.rootPath) } : {}),
    };
    ws.vibeSessions = [...ws.vibeSessions, s].slice(-MAX_SESSIONS);
    ws.currentVibeId = s.id;
    if (!ws.project.goal.trim()) ws.project = { ...ws.project, goal: s.originalPrompt.slice(0, 2000), updatedAt: at };
    this.emit(s);

    const summary = workspaceSummary(ws.project.rootPath);
    const c = await this.deps.gemma().clarify(s.originalPrompt, summary);
    if (!this.isPhase(s.id, "clarifying")) return; // cancelled / replaced meanwhile
    if (c.vague) {
      this.update(s.id, { phase: "awaiting_answers", vague: true, vaguenessReason: c.reason, questions: c.questions, clarifyRounds: 1, gemma: c.source });
      return;
    }
    this.update(s.id, { vague: false, vaguenessReason: c.reason, gemma: c.source });
    await this.refine(s.id, {}, "clarifying");
  }

  /** Answers in; Gemma re-checks once for a remaining consequential gap (max 2 rounds), then refines. */
  private async answer(vibeId: string, answers: Record<string, string>): Promise<void> {
    const s = this.find(vibeId);
    if (!s) throw new Error(`vibe session ${vibeId} not found`);
    if (s.phase !== "awaiting_answers") throw new Error(`cannot answer in phase ${s.phase}`);
    const merged = { ...s.answers, ...answers };
    if (s.clarifyRounds >= 2) return this.refine(vibeId, merged);
    this.update(vibeId, { phase: "clarifying", answers: merged });
    const prior = s.questions.map((q) => ({ question: q.question, answer: merged[q.id] ?? "" })).filter((x) => x.answer.trim());
    const c = await this.deps.gemma().clarify(s.originalPrompt, workspaceSummary(this.requireWs().project.rootPath), prior);
    if (!this.isPhase(vibeId, "clarifying")) return;
    if (c.vague && c.questions.length) {
      this.update(vibeId, { phase: "awaiting_answers", vaguenessReason: c.reason, questions: [...s.questions, ...c.questions], clarifyRounds: s.clarifyRounds + 1, gemma: c.source });
      return;
    }
    await this.refine(vibeId, merged, "clarifying");
  }

  private async refine(vibeId: string, answers: Record<string, string>, from: VibeSession["phase"] = "awaiting_answers"): Promise<void> {
    const s = this.find(vibeId);
    if (!s) throw new Error(`vibe session ${vibeId} not found`);
    if (s.phase !== from && !(from === "awaiting_answers" && s.phase === "ready")) throw new Error(`cannot refine in phase ${s.phase}`);
    this.update(vibeId, { phase: "refining", answers });
    const qa = s.questions.map((q) => ({ question: q.question, answer: answers[q.id] ?? "" }));
    const r = await this.deps.gemma().refine(s.originalPrompt, qa, workspaceSummary(this.requireWs().project.rootPath));
    if (!this.isPhase(vibeId, "refining")) return;
    this.update(vibeId, { phase: "ready", refinedPrompt: r.refinedPrompt, assumptions: r.assumptions, gemma: r.source });
    this.ensureTask(vibeId, r.title, r.acceptanceCriteria);
    const cur = this.find(vibeId)!;
    // Like code-guide: once Gemma has no more questions, hand the refined prompt straight to the agent.
    if (!cur.review) {
      const info = this.agents.find((a) => a.id === cur.agent);
      if (info?.available) await this.run(vibeId, r.refinedPrompt, cur.agent, cur.allowCommands);
      else this.update(vibeId, { error: `${info?.name ?? cur.agent} is not available: ${info?.detail ?? "not detected"}. Review the prompt and pick another agent.` });
    }
  }

  /** One progress-tracking task per prompt: Gemma's criteria + "tests pass" linked to the project's test check. */
  private ensureTask(vibeId: string, title: string, criteria: string[]): void {
    const s = this.find(vibeId);
    if (!s || s.taskId || !this.deps.createTask) return;
    try {
      const taskId = this.deps.createTask(title, criteria, s.suggestedCheck);
      this.update(vibeId, { taskId });
    } catch (e) {
      this.deps.log(`could not create task: ${e instanceof Error ? e.message : e}`);
    }
  }

  private async run(vibeId: string, prompt: string, agent: CodingAgentId, allowCommands: boolean): Promise<void> {
    if (this.isBusy()) throw new Error("a coding agent run is already in progress");
    const s = this.find(vibeId);
    if (!s) throw new Error(`vibe session ${vibeId} not found`);
    if (!["ready", "done", "failed", "cancelled"].includes(s.phase)) throw new Error(`cannot run in phase ${s.phase}`);
    const info = this.agents.find((a) => a.id === agent);
    if (!info?.available) throw new Error(`${info?.name ?? agent} is not available: ${info?.detail ?? "not detected"}`);
    const ws = this.requireWs();
    const desc = AGENTS[agent];
    if (!s.taskId) this.ensureTask(vibeId, s.originalPrompt.split("\n")[0]!.slice(0, 80), ["The requested change is visible in the code"]);
    const startedAt = this.iso();
    this.update(vibeId, {
      phase: "running",
      agent,
      refinedPrompt: prompt,
      events: [],
      changeBatchIds: [],
      verificationRunIds: [],
      report: undefined,
      error: undefined,
      run: { agent, command: desc.display({ allowCommands }), allowCommands, startedAt, outcome: "running" },
    });
    this.collecting = vibeId;
    this.lastBatchAt = Date.now();
    const handle = runAgent({
      agent,
      allowCommands,
      prompt,
      cwd: ws.project.rootPath,
      timeoutMs: this.deps.agentTimeoutMs,
      env: this.deps.env,
      onEvent: (e) => this.pushEvent(vibeId, e),
    });
    this.running = { vibeId, handle };
    // Finish asynchronously so the WS handler returns immediately.
    void handle.done.then(async (res) => {
      this.running = null;
      const cur = this.find(vibeId);
      if (cur?.run) {
        this.update(vibeId, {
          run: { ...cur.run, finishedAt: this.iso(), exitCode: res.exitCode, durationMs: res.durationMs, outcome: res.outcome, ...(res.finalMessage ? { finalMessage: res.finalMessage } : {}) },
          phase: "reporting",
        });
      }
      await this.settle();
      this.collecting = null;
      await this.report(vibeId);
    });
  }

  private async cancel(vibeId: string): Promise<void> {
    const s = this.find(vibeId);
    if (!s) return;
    if (this.running?.vibeId === vibeId) {
      this.running.handle.cancel(); // run() continues to settle + report on what changed so far
      return;
    }
    if (["clarifying", "awaiting_answers", "refining", "ready"].includes(s.phase)) this.update(vibeId, { phase: "cancelled" });
  }

  private async report(vibeId: string): Promise<void> {
    const s = this.find(vibeId);
    if (!s?.run) throw new Error("nothing to report yet; run the agent first");
    if (this.running?.vibeId === vibeId) throw new Error("the agent is still running");
    this.update(vibeId, { phase: "reporting" });
    try {
      const context = await this.deps.observer.getContext(s.changeBatchIds, { maxChars: 40_000 });
      const agentName = AGENTS[s.run.agent].name;
      const input = {
        originalPrompt: s.originalPrompt,
        refinedPrompt: s.refinedPrompt ?? s.originalPrompt,
        agentName,
        agentOutcome: s.run.outcome,
        agentFinalMessage: s.run.finalMessage,
        context,
      };
      const body = await this.deps.gemma().report(input);
      const generatedAt = this.iso();
      const report = { ...body, markdown: reportMarkdown(body, input, generatedAt, this.deps.runs?.(s.verificationRunIds) ?? []), generatedAt };
      const phase = s.run.outcome === "cancelled" ? "cancelled" : s.run.outcome === "completed" ? "done" : "failed";
      this.update(vibeId, { phase, report, ...(phase === "failed" ? { error: `${agentName} ${s.run.outcome} (exit ${s.run.exitCode ?? "none"})` } : {}) });
      this.deps.changed?.();
    } catch (e) {
      this.update(vibeId, { phase: "failed", error: `report failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  private async verify(vibeId: string, command: string): Promise<void> {
    const s = this.find(vibeId);
    if (!s?.report) throw new Error("run the agent and get a report before verifying");
    if (this.isBusy()) throw new Error("the agent is still running");
    if (!this.deps.verify) throw new Error("verification is not available");
    const run = await this.deps.verify(command.trim());
    const cur = this.find(vibeId)!;
    const ids = [...cur.verificationRunIds, run.id];
    const report = cur.report && cur.run
      ? {
          ...cur.report,
          markdown: reportMarkdown(
            cur.report,
            { originalPrompt: cur.originalPrompt, refinedPrompt: cur.refinedPrompt ?? cur.originalPrompt, agentName: AGENTS[cur.run.agent].name, agentOutcome: cur.run.outcome, agentFinalMessage: cur.run.finalMessage },
            cur.report.generatedAt,
            this.deps.runs?.(ids) ?? [run],
          ),
        }
      : cur.report;
    this.update(vibeId, { verificationRunIds: ids, ...(report ? { report } : {}) });
    this.deps.changed?.();
  }

  /** Wait until the observer has been quiet for settleQuietMs (it debounces bursts), bounded by settleMaxMs. */
  private async settle(): Promise<void> {
    const quiet = this.deps.settleQuietMs ?? 4000;
    const max = this.deps.settleMaxMs ?? 20_000;
    const start = Date.now();
    this.lastBatchAt = Math.max(this.lastBatchAt, Date.now());
    while (Date.now() - start < max && Date.now() - this.lastBatchAt < quiet) await new Promise((r) => setTimeout(r, 250));
  }

  // ---------- state helpers ----------

  private pushEvent(vibeId: string, e: VibeAgentEvent): void {
    const s = this.find(vibeId);
    if (!s) return;
    s.events = [...s.events, e].slice(-MAX_EVENTS);
    this.deps.broadcast({ type: "vibe_agent_event", payload: { vibeId, event: e } });
    this.deps.persist();
  }

  private find(id: string): VibeSession | undefined {
    return this.deps.workspace()?.vibeSessions.find((s) => s.id === id);
  }

  private isPhase(id: string, phase: VibeSession["phase"]): boolean {
    return this.find(id)?.phase === phase && this.deps.workspace()?.currentVibeId === id;
  }

  private update(id: string, patch: Partial<VibeSession>): void {
    const ws = this.requireWs();
    let updated: VibeSession | undefined;
    ws.vibeSessions = ws.vibeSessions.map((s) => (s.id === id ? (updated = { ...s, ...patch, updatedAt: this.iso() }) : s));
    if (updated) this.emit(updated);
  }

  private emit(s: VibeSession): void {
    this.deps.persist();
    this.deps.broadcast({ type: "vibe_updated", payload: s });
  }

  private requireWs(): WorkspaceState {
    const ws = this.deps.workspace();
    if (!ws) throw new Error("choose a workspace folder first");
    return ws;
  }

  private iso(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }
}

/** Best-guess test command for the workspace; only ever run when the user clicks it. */
export function detectTestCommand(root: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    const t = pkg.scripts?.test;
    if (t && !/no test specified/.test(t)) return "npm test";
  } catch {
    /* not node */
  }
  if (existsSync(join(root, "Cargo.toml"))) return "cargo test";
  if (existsSync(join(root, "go.mod"))) return "go test ./...";
  if (existsSync(join(root, "pyproject.toml")) || existsSync(join(root, "pytest.ini"))) return "pytest";
  return undefined;
}

const SKIP = new Set([".git", "node_modules", "dist", "build", "target", ".local-code-companion", ".next", "out", "coverage", "__pycache__", ".venv", "venv"]);
const SECRETISH = /^\.env|\.(pem|key|p12|pfx)$|^id_(rsa|ed25519)|credentials|secret/i;

/** Bounded, secret-free sketch of the workspace for Gemma (file names + package.json scripts + README head). */
export function workspaceSummary(root: string, maxFiles = 120): WorkspaceSummary {
  const files: string[] = [];
  const walk = (rel: string, depth: number) => {
    if (files.length >= maxFiles || depth > 3) return;
    let entries: string[];
    try {
      entries = readdirSync(join(root, rel)).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (files.length >= maxFiles) return;
      if (SKIP.has(name) || SECRETISH.test(name)) continue;
      const r = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = statSync(join(root, r));
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(r, depth + 1);
      else files.push(r);
    }
  };
  walk("", 0);
  const notes: string[] = [];
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: string; scripts?: Record<string, string>; dependencies?: object; devDependencies?: object };
    notes.push(`package.json name=${pkg.name ?? "?"} scripts=${JSON.stringify(pkg.scripts ?? {})} deps=${Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).slice(0, 30).join(",")}`);
  } catch {
    /* not a node project */
  }
  for (const readme of ["README.md", "readme.md", "README"]) {
    try {
      notes.push(`README: ${readFileSync(join(root, readme), "utf8").slice(0, 800)}`);
      break;
    } catch {
      /* none */
    }
  }
  return { name: basename(root), files, notes: notes.join("\n").slice(0, 2000) };
}
