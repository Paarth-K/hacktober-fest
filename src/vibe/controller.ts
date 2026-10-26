// Drives a vibe session: clarify -> (answers) -> refine -> run coding agent -> collect observed diffs -> report.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
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
  /** Several changes can run at once (one agent each). */
  private running = new Map<string, AgentRunHandle>();
  /** Sessions collecting observed change batches (while running and until the observer settles). */
  private collecting = new Map<string, { lastBatchAt: number; touched: Set<string>; lastEventAt: number }>();

  constructor(private deps: VibeDeps) {
  }

  /** Resolves once coding agents have been detected (runs wait for it). */
  private detected: Promise<void> | null = null;

  init(): Promise<void> {
    this.detected ??= this.detect();
    return this.detected;
  }

  private async detect(): Promise<void> {
    this.agents = await detectAgents(this.deps.env);
    this.deps.broadcast({ type: "coding_agents", payload: this.agents });
    this.deps.log(`coding agents: ${this.agents.map((a) => `${a.id}=${a.available ? a.version : "missing"}`).join(", ")}`);
  }

  /** True while any agent is running (blocks switching workspace, not starting more changes). */
  isBusy(): boolean {
    return this.running.size > 0 || this.collecting.size > 0;
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
    for (const h of this.running.values()) h.cancel();
  }

  /**
   * Attribute an observed batch to the run that made it. With several agents at once, the batch goes to the
   * session whose agent touched the most of its files; otherwise to the most recently active running session.
   */
  onBatch(batch: ChangeBatch): void {
    if (this.collecting.size === 0) return;
    const paths = batch.changes.map((c) => c.path);
    // A debounced batch can mix several agents' edits: give it to every change that touched one of its files.
    let targets = [...this.collecting].filter(([, c]) => paths.some((p) => c.touched.has(p))).map(([id]) => id);
    if (targets.length === 0) {
      const latest = [...this.collecting].sort((a, b) => b[1].lastEventAt - a[1].lastEventAt)[0];
      targets = latest ? [latest[0]] : [];
    }
    for (const id of targets) {
      const s = this.find(id);
      if (!s || s.changeBatchIds.includes(batch.id)) continue;
      this.collecting.get(id)!.lastBatchAt = Date.now();
      this.update(id, { changeBatchIds: [...s.changeBatchIds, batch.id] });
      if (s.taskId && targets.length === 1) this.deps.linkBatch?.(batch.id, s.taskId);
      this.scheduleCriteriaCheck(id);
    }
  }

  async handle(env: VibeMessage): Promise<void> {
    switch (env.type) {
      case "vibe_start":
        return this.start(env.payload.prompt, env.payload.agent, env.payload.review, env.payload.allowCommands, env.payload.level);
      case "vibe_answer":
        return this.answer(env.payload.vibeId, env.payload.answers);
      case "vibe_skip_questions":
        return this.refine(env.payload.vibeId, {});
      case "vibe_run":
        return this.run(env.payload.vibeId, env.payload.prompt, env.payload.agent, env.payload.allowCommands);
      case "vibe_cancel":
        return this.cancel(env.payload.vibeId);
      case "vibe_regenerate_report":
        if (env.payload.level) this.update(env.payload.vibeId, { level: env.payload.level });
        return this.report(env.payload.vibeId);
      case "vibe_ask":
        return this.ask(env.payload.vibeId, env.payload.question);
      case "vibe_verify":
        return this.verify(env.payload.vibeId, env.payload.command);
      case "vibe_reset": {
        const ws = this.requireWs();
        ws.currentVibeId = null;
        this.deps.persist();
        return;
      }
      case "vibe_open": {
        const ws = this.requireWs();
        if (!ws.vibeSessions.some((s) => s.id === env.payload.vibeId)) throw new Error("session not found");
        ws.currentVibeId = env.payload.vibeId;
        this.deps.persist();
        return;
      }
    }
  }

  // ---------- phases ----------

  private async start(prompt: string, agent: CodingAgentId, review: boolean, allowCommands: boolean, level: VibeSession["level"]): Promise<void> {
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
      level,
      criteria: [],
      criteriaLive: [],
      qa: [],
      questions: [],
      clarifyRounds: 0,
      answers: {},
      assumptions: [],
      events: [],
      changeBatchIds: [],
      touched: [],
      parallel: false,
      verificationRunIds: [],
      ...(detectTestCommand(ws.project.rootPath) ? { suggestedCheck: detectTestCommand(ws.project.rootPath) } : {}),
    };
    ws.vibeSessions = [...ws.vibeSessions, s].slice(-MAX_SESSIONS);
    ws.currentVibeId = s.id;
    if (!ws.project.goal.trim()) ws.project = { ...ws.project, goal: s.originalPrompt.slice(0, 2000), updatedAt: at };
    this.emit(s);

    const summary = workspaceSummary(ws.project.rootPath);
    const c = await this.deps.gemma().clarify(s.originalPrompt, summary, [], s.level, this.thinker(s.id));
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
    // Beginners get one round of plain questions; others may get one follow-up round.
    if (s.clarifyRounds >= (s.level === "beginner" ? 1 : 2)) return this.refine(vibeId, merged);
    this.update(vibeId, { phase: "clarifying", answers: merged });
    const prior = s.questions.map((q) => ({ question: q.question, answer: merged[q.id] ?? "" })).filter((x) => x.answer.trim());
    const c = await this.deps.gemma().clarify(s.originalPrompt, workspaceSummary(this.requireWs().project.rootPath), prior, s.level, this.thinker(vibeId));
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
    // Parallel agents: tell Gemma what the others are doing so it keeps this agent out of their way.
    const otherWork = [...this.collecting.entries()]
      .filter(([id]) => id !== vibeId)
      .map(([id, c]) => ({ request: this.find(id)?.originalPrompt.slice(0, 300) ?? "", files: [...c.touched].slice(0, 40) }));
    const r = await this.deps.gemma().refine(s.originalPrompt, qa, workspaceSummary(this.requireWs().project.rootPath), s.level, this.thinker(vibeId), otherWork);
    if (!this.isPhase(vibeId, "refining")) return;
    this.update(vibeId, { phase: "ready", refinedPrompt: r.refinedPrompt, assumptions: r.assumptions, criteria: r.acceptanceCriteria, gemma: r.source });
    this.ensureTask(vibeId, r.title, r.acceptanceCriteria);
    const cur = this.find(vibeId)!;
    // Like code-guide: once Gemma has no more questions, hand the refined prompt straight to the agent.
    if (!cur.review) {
      await this.init(); // agent detection may still be running right after startup
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
    const s = this.find(vibeId);
    if (this.running.has(vibeId)) throw new Error("this change is already running");
    if (!s) throw new Error(`vibe session ${vibeId} not found`);
    if (!["ready", "done", "failed", "cancelled"].includes(s.phase)) throw new Error(`cannot run in phase ${s.phase}`);
    await this.init();
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
      touched: [],
      parallel: false,
      criteriaLive: [],
      report: undefined,
      error: undefined,
      run: { agent, command: desc.display({ allowCommands }), allowCommands, startedAt, outcome: "running" },
    });
    const parallel = this.collecting.size > 0;
    for (const id of this.collecting.keys()) this.update(id, { parallel: true });
    this.collecting.set(vibeId, { lastBatchAt: Date.now(), touched: new Set(), lastEventAt: Date.now() });
    if (parallel) this.update(vibeId, { parallel: true });
    const handle = runAgent({
      agent,
      allowCommands,
      prompt,
      cwd: ws.project.rootPath,
      timeoutMs: this.deps.agentTimeoutMs,
      env: this.deps.env,
      onEvent: (e) => this.pushEvent(vibeId, e),
    });
    this.running.set(vibeId, handle);
    // Finish asynchronously so the WS handler returns immediately.
    void handle.done.then(async (res) => {
      this.running.delete(vibeId);
      const cur = this.find(vibeId);
      if (cur?.run) {
        this.update(vibeId, {
          run: { ...cur.run, finishedAt: this.iso(), exitCode: res.exitCode, durationMs: res.durationMs, outcome: res.outcome, ...(res.finalMessage ? { finalMessage: res.finalMessage } : {}) },
          phase: "reporting",
        });
      }
      await this.settle(vibeId);
      this.collecting.delete(vibeId);
      await this.report(vibeId);
    });
  }

  private async cancel(vibeId: string): Promise<void> {
    const s = this.find(vibeId);
    if (!s) return;
    const h = this.running.get(vibeId);
    if (h) {
      h.cancel(); // run() continues to settle + report on what changed so far
      return;
    }
    if (["clarifying", "awaiting_answers", "refining", "ready"].includes(s.phase)) this.update(vibeId, { phase: "cancelled" });
  }

  private async report(vibeId: string): Promise<void> {
    const s = this.find(vibeId);
    if (!s?.run) throw new Error("nothing to report yet; run the agent first");
    if (this.running.has(vibeId)) throw new Error("the agent is still running");
    this.update(vibeId, { phase: "reporting" });
    try {
      let context = await this.deps.observer.getContext(s.changeBatchIds, { maxChars: 40_000 });
      // Ran alongside another change: only report the files this change's agent edited.
      if (s.parallel && s.touched.length) {
        const mine = new Set(s.touched);
        context = {
          ...context,
          diffs: context.diffs.filter((d) => mine.has(d.path)),
          evidence: context.evidence.filter((e) => mine.has(e.path)),
          excerpts: context.excerpts.filter((x) => mine.has(x.path)),
        };
      }
      const agentName = AGENTS[s.run.agent].name;
      const cur = this.find(vibeId)!;
      const input = {
        level: cur.level,
        criteria: cur.criteria,
        onThinking: this.thinker(vibeId),
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

  /** Learn pane follow-up: Gemma answers from this change's diffs at the session level. */
  private async ask(vibeId: string, question: string): Promise<void> {
    const s = this.find(vibeId);
    if (!s?.run) throw new Error("ask after the agent has run");
    const at = this.iso();
    const previous = s.qa.filter((x) => !x.pending).map(({ question: q, answer: a }) => ({ question: q, answer: a }));
    this.update(vibeId, { qa: [...s.qa, { question, answer: "", at, pending: true }] });
    let answer: string;
    try {
      const context = await this.deps.observer.retrieveForQuestion(question, s.changeBatchIds, { maxChars: 30_000 });
      answer = (await this.deps.gemma().answer(question, s.level, { originalPrompt: s.originalPrompt, reportSummary: s.report?.summary, context, previous }, this.thinker(vibeId))).answer;
    } catch (e) {
      answer = `Couldn't answer that: ${e instanceof Error ? e.message : String(e)}`;
    }
    const cur = this.find(vibeId);
    if (!cur) return;
    this.update(vibeId, { qa: cur.qa.map((x) => (x.at === at && x.question === question ? { ...x, answer, pending: false } : x)) });
  }

  private async verify(vibeId: string, command: string): Promise<void> {
    const s = this.find(vibeId);
    if (!s?.report) throw new Error("run the agent and get a report before verifying");
    if (this.running.has(vibeId)) throw new Error("the agent is still running");
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

  private criteriaTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private criteriaBusy = new Set<string>();

  /** Re-check the "done when" list against the edits so far, a moment after edits land (one check at a time). */
  private scheduleCriteriaCheck(vibeId: string): void {
    const s = this.find(vibeId);
    if (!s?.criteria.length) return;
    clearTimeout(this.criteriaTimers.get(vibeId));
    this.criteriaTimers.set(
      vibeId,
      setTimeout(() => void this.checkCriteriaNow(vibeId), 1500),
    );
  }

  private async checkCriteriaNow(vibeId: string): Promise<void> {
    if (this.criteriaBusy.has(vibeId)) return this.scheduleCriteriaCheck(vibeId);
    const s = this.find(vibeId);
    if (!s || s.report || !s.criteria.length) return;
    this.criteriaBusy.add(vibeId);
    try {
      let context = await this.deps.observer.getContext(s.changeBatchIds, { maxChars: 20_000 });
      if (s.parallel && s.touched.length) {
        const mine = new Set(s.touched);
        context = { ...context, diffs: context.diffs.filter((d) => mine.has(d.path)), evidence: context.evidence.filter((e) => mine.has(e.path)) };
      }
      const live = await this.deps.gemma().checkCriteria(s.criteria, s.originalPrompt, context);
      const cur = this.find(vibeId);
      // Items only move forward while running (no flicker back to unchecked); the final report decides.
      if (live && cur && !cur.report) this.update(vibeId, { criteriaLive: live.map((c, i) => (cur.criteriaLive[i]?.met ? cur.criteriaLive[i]! : c)) });
    } catch (e) {
      this.deps.log(`criteria check failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      this.criteriaBusy.delete(vibeId);
    }
  }

  /** Wait until the observer has been quiet for settleQuietMs (it debounces bursts), bounded by settleMaxMs. */
  private async settle(vibeId: string): Promise<void> {
    const quiet = this.deps.settleQuietMs ?? 4000;
    const max = this.deps.settleMaxMs ?? 20_000;
    const start = Date.now();
    const c = this.collecting.get(vibeId);
    if (!c) return;
    c.lastBatchAt = Math.max(c.lastBatchAt, Date.now());
    while (Date.now() - start < max && Date.now() - c.lastBatchAt < quiet) await new Promise((r) => setTimeout(r, 250));
  }

  // ---------- state helpers ----------

  /** Streams Gemma's reasoning for a session to the UI (throttled). */
  private thinker(vibeId: string): (text: string) => void {
    let last = 0;
    return (text) => {
      const now = Date.now();
      if (now - last < 250) return;
      last = now;
      this.deps.broadcast({ type: "vibe_thinking", payload: { vibeId, text: text.slice(-4000) } });
    };
  }

  private pushEvent(vibeId: string, e: VibeAgentEvent): void {
    const s = this.find(vibeId);
    if (!s) return;
    s.events = [...s.events, e].slice(-MAX_EVENTS);
    // Remember which files this agent touched (for attributing batches when several agents run).
    const c = this.collecting.get(vibeId);
    if (c) {
      c.lastEventAt = Date.now();
      const root = this.deps.workspace()?.project.rootPath;
      const m = /^(?:Edit|MultiEdit|Write|NotebookEdit|Delete) (.+)$/.exec(e.text);
      if (e.kind === "tool" && m && root) {
        const abs = m[1]!.trim();
        // Agents report resolved paths (e.g. /private/var/... on macOS for /var/...): match either form.
        let real = root;
        try {
          real = realpathSync(root);
        } catch {
          /* keep root */
        }
        const base = [root, real].find((r) => abs === r || abs.startsWith(r + "/") || abs.startsWith(r + "\\"));
        const rel = base ? abs.slice(base.length).replace(/^[\\/]+/, "").split(/[\\/]/).join("/") : abs;
        if (!c.touched.has(rel)) {
          c.touched.add(rel);
          s.touched = [...s.touched, rel];
        }
      }
    }
    this.deps.broadcast({ type: "vibe_agent_event", payload: { vibeId, event: e } });
    this.deps.persist();
  }

  private find(id: string): VibeSession | undefined {
    return this.deps.workspace()?.vibeSessions.find((s) => s.id === id);
  }

  private isPhase(id: string, phase: VibeSession["phase"]): boolean {
    return this.find(id)?.phase === phase;
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
