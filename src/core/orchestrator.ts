// Engine orchestrator: owns state, routes UI messages, observer batches, AI
// requests and verification runs, and recomputes progress after every change.
import { mkdirSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { newId } from "../shared/events.js";
import type { ClientEnvelope, ServerMessage, StateSnapshot } from "../shared/events.js";
import type { ModelProvider, Observer } from "../shared/interfaces.js";
import {
  CheckCommandSchema,
  ExplanationResponseSchema,
  TaskBreakdownSuggestionSchema,
  isSafeRelPath,
} from "../shared/schemas.js";
import type {
  AcceptanceCriterion,
  ChangeBatch,
  ContextPacket,
  ExplanationResponse,
  ModelStatus,
  Preferences,
  ProgressSnapshot,
  Task,
  VerificationRun,
} from "../shared/schemas.js";
import type { JsonStore, PersistedState, WorkspaceState } from "../storage/jsonStore.js";
import { applyActivity, applyVerification, computeProgress, confirmByUser, deriveStatusFromCriteria, setCriterionByUser } from "./progress.js";
import { generateReport } from "./report.js";
import { runCheck } from "./verification.js";
import { VibeController } from "../vibe/controller.js";
import { VibeGemma } from "../vibe/gemma.js";
import { Launcher } from "../vibe/launcher.js";
import { workspaceSummary } from "../vibe/controller.js";

export const MAX_BATCHES = 200;
export const MAX_RUNS = 200;
export const REPORT_DIR = ".local-code-companion";

export interface OrchestratorDeps {
  store: JsonStore;
  observer: Observer;
  /** Called whenever preferences.modelProvider changes, and at startup. */
  createProvider: (prefs: Preferences) => ModelProvider;
  broadcast: (m: ServerMessage, replyTo?: string) => void;
  sessionId: string;
  version: string;
  mock: boolean;
  log?: (msg: string) => void;
  now?: () => Date;
  /** Builds the Gemma prompt-wrapper for the current preferences (defaults to local Ollama). */
  createGemma?: (prefs: Preferences) => VibeGemma;
  /** Overrides for the vibe controller (tests). */
  vibe?: { env?: NodeJS.ProcessEnv; settleQuietMs?: number; settleMaxMs?: number; agentTimeoutMs?: number };
}

type Reply = (m: ServerMessage) => void;

export class Orchestrator {
  state: PersistedState;
  provider: ModelProvider;
  modelStatus: ModelStatus = { provider: "unknown", state: "offline", detail: "not checked yet" };
  private inflightExplanations = new Map<string, Promise<ExplanationResponse>>();
  private runningChecks = new Set<string>();
  private lastProgressJson = "";
  private stallTimer: ReturnType<typeof setInterval> | null = null;
  private readonly log: (m: string) => void;
  private readonly now: () => Date;
  readonly vibe: VibeController;
  readonly launcher: Launcher;
  private gemma: VibeGemma;

  constructor(private deps: OrchestratorDeps) {
    this.log = deps.log ?? (() => {});
    this.now = deps.now ?? (() => new Date());
    const { state, warning } = deps.store.load();
    if (warning) this.log(warning);
    this.state = state;
    // A run cannot survive an engine restart: mark sessions stuck in a transient phase as failed.
    for (const w of Object.values(state.workspaces)) {
      w.vibeSessions = w.vibeSessions.map((v) =>
        ["clarifying", "refining", "running", "reporting"].includes(v.phase)
          ? { ...v, phase: "failed", error: `interrupted: the engine restarted during "${v.phase}"`, ...(v.run?.outcome === "running" ? { run: { ...v.run, outcome: "failed" as const } } : {}) }
          : v,
      );
    }
    this.provider = deps.createProvider(state.preferences);
    const think = process.env.LCC_GEMMA_THINK;
    const makeGemma =
      deps.createGemma ??
      ((p: Preferences) =>
        new VibeGemma({
          provider: p.modelProvider,
          baseUrl: process.env.OLLAMA_BASE_URL,
          model: process.env.OLLAMA_MODEL,
          think: think === "low" || think === "medium" || think === "high" ? think : false,
          gatewayKey: process.env.AI_GATEWAY_API_KEY,
          gatewayModel: process.env.SIDEKICK_GEMMA_MODEL,
        }));
    this.gemma = makeGemma(state.preferences);
    this.vibe = new VibeController({
      workspace: () => this.ws(),
      observer: deps.observer,
      gemma: () => this.gemma,
      broadcast: (m) => deps.broadcast(m),
      persist: () => this.persist(),
      log: this.log,
      now: this.now,
      verify: (command) => this.verifyCommand(command),
      changed: () => this.deps.broadcast({ type: "state_snapshot", payload: this.snapshot() }),
      createTask: (title, criteria, testCommand) => this.createVibeTask(title, criteria, testCommand),
      linkBatch: (batchId, taskId) => this.linkChange(batchId, taskId),
      runs: (ids) => (this.ws()?.verificationRuns ?? []).filter((r) => ids.includes(r.id)),
      ...deps.vibe,
    });
    this.launcher = new Launcher({
      root: () => this.ws()?.project.rootPath ?? null,
      gemma: () => this.gemma,
      summary: workspaceSummary,
      latestChange: () => {
        const v = this.vibe.current() ?? this.ws()?.vibeSessions.at(-1);
        return v ? `${v.originalPrompt}\n${v.report?.summary ?? ""}\nFiles: ${(v.report?.changes ?? []).map((c) => c.path).join(", ")}` : "";
      },
      broadcast: (m) => deps.broadcast(m),
    });
    this.rebuildGemma = () => (this.gemma = makeGemma(this.state.preferences));
  }
  private rebuildGemma: () => void;

  // ---------- lifecycle ----------

  async start(): Promise<void> {
    void this.refreshModelStatus();
    void this.vibe.init().catch((e) => this.log(`agent detection failed: ${e instanceof Error ? e.message : e}`));
    const ws = this.ws();
    if (ws) await this.startObserver(ws.project.rootPath);
    this.stallTimer = setInterval(() => this.pushProgressIfChanged(), 30_000);
    this.stallTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.stallTimer) clearInterval(this.stallTimer);
    this.vibe.stop();
    this.launcher.dispose();
    await this.deps.observer.stop().catch(() => {});
    this.deps.store.flush();
  }

  private ws(): WorkspaceState | null {
    const root = this.state.activeRootPath;
    return root ? (this.state.workspaces[root] ?? null) : null;
  }

  private requireWs(): WorkspaceState {
    const ws = this.ws();
    if (!ws) throw new Error("no project selected; pick a workspace folder first");
    return ws;
  }

  private persist(): void {
    this.deps.store.save(this.state);
  }

  /** A short Gemma-written progress line (for toasts). */
  narrate(event: string, request: string): Promise<string | null> {
    return this.gemma.narrate(event, request);
  }

  /** Load the local Gemma model into memory ahead of the first request. */
  warmUpGemma(): Promise<void> {
    return this.gemma.warmUp();
  }

  /** Save immediately (tests / shutdown). */
  persistNow(): void {
    this.deps.store.save(this.state);
    this.deps.store.flush();
  }

  private iso(): string {
    return this.now().toISOString();
  }

  private async startObserver(rootPath: string): Promise<void> {
    await this.deps.observer.stop().catch(() => {});
    if (!existsSync(rootPath)) {
      this.log(`workspace ${rootPath} does not exist; observer not started`);
      return;
    }
    try {
      await this.deps.observer.start({
        rootPath,
        sessionId: this.deps.sessionId,
        onBatch: (b) => this.ingestBatch(b),
        getTasks: () => this.ws()?.tasks ?? [],
        onError: (e) => this.log(`observer error: ${e.message}`),
      });
      const persisted = this.state.workspaces[rootPath]?.changeBatches ?? [];
      if (persisted.length) this.deps.observer.restoreBatches?.(persisted);
      this.log(`observer watching ${rootPath}`);
    } catch (e) {
      this.log(`observer failed to start: ${e instanceof Error ? e.message : e}`);
    }
  }

  async refreshModelStatus(): Promise<ModelStatus> {
    try {
      this.modelStatus = await this.provider.status();
    } catch (e) {
      this.modelStatus = { provider: this.provider.name, state: "offline", detail: e instanceof Error ? e.message : String(e) };
    }
    this.deps.broadcast({ type: "model_status", payload: this.modelStatus });
    return this.modelStatus;
  }

  // ---------- snapshots ----------

  progress(): ProgressSnapshot | null {
    const ws = this.ws();
    if (!ws) return null;
    const snap = computeProgress(ws.project.id, ws.tasks, { now: this.now(), stallMinutes: this.state.preferences.stallMinutes });
    // "Time since last activity" also counts observed-but-unlinked changes.
    const lastBatch = ws.changeBatches.at(-1)?.timestamp;
    if (lastBatch && (!snap.lastActivityAt || lastBatch > snap.lastActivityAt)) snap.lastActivityAt = lastBatch;
    return snap;
  }

  snapshot(): StateSnapshot {
    const ws = this.ws();
    return {
      project: ws?.project ?? null,
      milestones: ws?.milestones ?? [],
      tasks: ws ? [...ws.tasks].sort((a, b) => a.order - b.order) : [],
      progress: this.progress(),
      changeBatches: ws?.changeBatches.slice(-50) ?? [],
      verificationRuns: ws?.verificationRuns.slice(-50) ?? [],
      preferences: this.state.preferences,
      modelStatus: this.modelStatus,
      engine: {
        version: this.deps.version,
        sessionId: this.deps.sessionId,
        mock: this.deps.mock,
        dataDir: this.deps.store.dataDir,
        observerRunning: this.deps.observer.isRunning(),
      },
      selectedTaskId: this.state.selectedTaskId,
      vibe: this.vibe.current(),
      codingAgents: this.vibe.agents,
      vibeHistory: this.vibe.history(),
      launch: this.launcher.state,
    };
  }

  private pushProgress(): void {
    const p = this.progress();
    if (!p) return;
    this.lastProgressJson = JSON.stringify({ ...p, computedAt: "" });
    this.deps.broadcast({ type: "progress_updated", payload: p });
  }

  private pushProgressIfChanged(): void {
    const p = this.progress();
    if (!p) return;
    if (JSON.stringify({ ...p, computedAt: "" }) !== this.lastProgressJson) this.pushProgress();
  }

  private putTask(task: Task): void {
    const ws = this.requireWs();
    ws.tasks = ws.tasks.map((t) => (t.id === task.id ? task : t));
    this.deps.broadcast({ type: "task_updated", payload: task });
  }

  private findTask(id: string): Task {
    const t = this.requireWs().tasks.find((x) => x.id === id);
    if (!t) throw new Error(`task ${id} not found`);
    return t;
  }

  // ---------- observer ----------

  ingestBatch(batch: ChangeBatch): void {
    const ws = this.ws();
    if (!ws) return;
    if (ws.changeBatches.some((b) => b.id === batch.id)) return; // dedupe
    const taskIds = new Set(ws.tasks.map((t) => t.id));
    let links = batch.suggestedTaskLinks;
    if (links.length === 0) {
      try {
        links = this.deps.observer.suggestTasks(batch, ws.tasks);
      } catch (e) {
        this.log(`suggestTasks failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    const stored: ChangeBatch = {
      ...batch,
      // Suggestions are hints only; drop links to unknown tasks. linkedTaskId is set only by the user.
      suggestedTaskLinks: links.filter((l) => taskIds.has(l.taskId)).sort((a, b) => b.score - a.score),
      linkedTaskId: undefined,
    };
    ws.changeBatches = [...ws.changeBatches, stored].slice(-MAX_BATCHES);
    this.persist();
    this.deps.broadcast({ type: "change_batch", payload: stored });
    this.vibe.onBatch(stored);
    this.pushProgress();
  }

  // ---------- message routing ----------

  async handle(env: ClientEnvelope, reply: Reply): Promise<void> {
    const at = this.iso();
    switch (env.type) {
      case "request_snapshot":
        return reply({ type: "state_snapshot", payload: this.snapshot() });

      case "set_project": {
        if (this.vibe.isBusy()) throw new Error("a coding agent run is in progress; cancel it before switching workspace");
        const rootPath = resolve(env.payload.rootPath);
        if (!existsSync(rootPath)) throw new Error(`folder does not exist: ${rootPath}`);
        let ws = this.state.workspaces[rootPath];
        if (!ws) {
          ws = {
            project: { id: newId("proj"), name: env.payload.name ?? basename(rootPath), rootPath, goal: env.payload.goal ?? "", checkCommands: [], createdAt: at, updatedAt: at },
            milestones: [],
            tasks: [],
            changeBatches: [],
            verificationRuns: [],
            explanationCache: {},
            vibeSessions: [],
            currentVibeId: null,
          };
          this.state.workspaces[rootPath] = ws;
        } else {
          ws.project = { ...ws.project, name: env.payload.name ?? ws.project.name, goal: env.payload.goal ?? ws.project.goal, updatedAt: at };
        }
        const switched = this.state.activeRootPath !== rootPath;
        this.state.activeRootPath = rootPath;
        this.state.selectedTaskId = null;
        this.persist();
        if (switched || !this.deps.observer.isRunning()) await this.startObserver(rootPath);
        this.deps.broadcast({ type: "state_snapshot", payload: this.snapshot() });
        return;
      }

      case "update_project": {
        const ws = this.requireWs();
        const p = env.payload;
        ws.project = {
          ...ws.project,
          ...(p.name !== undefined ? { name: p.name } : {}),
          ...(p.goal !== undefined ? { goal: p.goal } : {}),
          ...(p.checkCommands !== undefined
            ? { checkCommands: p.checkCommands.map((c) => CheckCommandSchema.parse({ ...c, id: c.id ?? newId("chk") })) }
            : {}),
          updatedAt: at,
        };
        this.persist();
        this.deps.broadcast({ type: "state_snapshot", payload: this.snapshot() });
        return;
      }

      case "create_task": {
        const ws = this.requireWs();
        const task = this.newTask(ws, env.payload.title, env.payload.acceptanceCriteria, at, env.payload.milestoneId);
        ws.tasks.push(task);
        this.persist();
        this.deps.broadcast({ type: "task_updated", payload: task });
        this.pushProgress();
        return;
      }

      case "update_task": {
        const t = this.findTask(env.payload.taskId);
        let next: Task = { ...t, updatedAt: at };
        if (env.payload.title !== undefined) next.title = env.payload.title;
        if (env.payload.milestoneId !== undefined) next.milestoneId = env.payload.milestoneId ?? undefined;
        if (env.payload.acceptanceCriteria !== undefined) {
          next.acceptanceCriteria = env.payload.acceptanceCriteria.map((c) => {
            const prev = c.id ? t.acceptanceCriteria.find((x) => x.id === c.id) : undefined;
            // Keep met state only if the criterion and its check link are unchanged.
            const keep = prev && prev.text === c.text && prev.checkCommandId === c.checkCommandId;
            return {
              id: prev?.id ?? newId("ac"),
              text: c.text,
              checkCommandId: c.checkCommandId,
              met: keep ? prev.met : false,
              metBy: keep ? prev.metBy : "none",
            } satisfies AcceptanceCriterion;
          });
          next = deriveStatusFromCriteria(next, "Acceptance criteria edited", "user", at);
        }
        this.putTask(next);
        this.persist();
        this.pushProgress();
        return;
      }

      case "delete_task": {
        const ws = this.requireWs();
        this.findTask(env.payload.taskId);
        ws.tasks = ws.tasks.filter((t) => t.id !== env.payload.taskId);
        ws.tasks.sort((a, b) => a.order - b.order).forEach((t, i) => (t.order = i));
        for (const b of ws.changeBatches) if (b.linkedTaskId === env.payload.taskId) b.linkedTaskId = undefined;
        if (this.state.selectedTaskId === env.payload.taskId) this.state.selectedTaskId = null;
        this.persist();
        this.deps.broadcast({ type: "task_deleted", payload: { taskId: env.payload.taskId } });
        this.pushProgress();
        return;
      }

      case "reorder_tasks": {
        const ws = this.requireWs();
        const order = new Map(env.payload.taskIds.map((id, i) => [id, i]));
        const sorted = [...ws.tasks].sort((a, b) => (order.get(a.id) ?? 1e6 + a.order) - (order.get(b.id) ?? 1e6 + b.order));
        ws.tasks = sorted.map((t, i) => (t.order === i ? t : { ...t, order: i, updatedAt: at }));
        this.persist();
        this.deps.broadcast({ type: "state_snapshot", payload: this.snapshot() });
        return;
      }

      case "set_criterion_met": {
        const next = setCriterionByUser(this.findTask(env.payload.taskId), env.payload.criterionId, env.payload.met, at);
        this.putTask(next);
        this.persist();
        this.pushProgress();
        return;
      }

      case "confirm_task": {
        this.putTask(confirmByUser(this.findTask(env.payload.taskId), env.payload.reason, at));
        this.persist();
        this.pushProgress();
        return;
      }

      case "link_change_to_task":
        return this.linkChange(env.payload.changeBatchId, env.payload.taskId, at);

      case "request_breakdown": {
        const requestId = newId("bd");
        const suggestion = TaskBreakdownSuggestionSchema.parse(await this.provider.breakdown({ requestId, goal: env.payload.goal, promptText: env.payload.promptText }));
        return reply({ type: "breakdown_suggestion", payload: suggestion });
      }

      case "accept_breakdown": {
        const ws = this.requireWs();
        for (const s of env.payload.tasks) {
          ws.tasks.push(this.newTask(ws, s.title, s.acceptanceCriteria.map((text) => ({ text })), at));
        }
        this.persist();
        this.deps.broadcast({ type: "state_snapshot", payload: this.snapshot() });
        return;
      }

      case "run_verification":
        await this.runVerification(env.payload.checkCommandId, env.payload.taskIds, env.eventId);
        return;

      case "export_report": {
        const ws = this.requireWs();
        const snapshot = this.progress()!;
        let summary: { text: string; provider: string; mode: "real" | "mock"; source: "template" | "model" } | undefined;
        if (this.provider.summarizeProgress) {
          try {
            const s = await this.provider.summarizeProgress({ projectName: ws.project.name, goal: ws.project.goal, snapshot, tasks: ws.tasks, verificationRuns: ws.verificationRuns });
            if (s.text.trim()) summary = { text: s.text.trim(), provider: this.provider.name, mode: this.provider.mode, source: s.source };
          } catch (e) {
            this.log(`summarizeProgress failed: ${e instanceof Error ? e.message : e}`);
          }
        }
        const markdown = generateReport({ project: ws.project, tasks: ws.tasks, snapshot, verificationRuns: ws.verificationRuns, changeBatches: ws.changeBatches, summary, now: this.now() });
        let savedPath: string | undefined;
        if (env.payload.saveToWorkspace) {
          const dir = join(ws.project.rootPath, REPORT_DIR);
          mkdirSync(dir, { recursive: true });
          savedPath = join(dir, "progress-report.md");
          writeFileSync(savedPath, markdown);
        }
        return reply({ type: "report_ready", payload: { markdown, savedPath } });
      }

      case "request_explanation":
      case "ask_followup":
        return this.explain(env, reply);

      case "preferences_changed": {
        const before = this.state.preferences;
        this.state.preferences = { ...before, ...env.payload };
        this.persist();
        this.deps.broadcast({ type: "preferences_updated", payload: this.state.preferences });
        if (env.payload.modelProvider && env.payload.modelProvider !== before.modelProvider) {
          this.rebuildGemma();
          this.provider = this.deps.createProvider(this.state.preferences);
          void this.refreshModelStatus();
        }
        if (env.payload.stallMinutes !== undefined) this.pushProgress();
        return;
      }

      case "window_mode_changed": {
        this.state.preferences = {
          ...this.state.preferences,
          compact: env.payload.compact,
          ...(env.payload.alwaysOnTop !== undefined ? { alwaysOnTop: env.payload.alwaysOnTop } : {}),
        };
        this.persist();
        this.deps.broadcast({ type: "preferences_updated", payload: this.state.preferences });
        return;
      }

      case "select_task":
        this.state.selectedTaskId = env.payload.taskId;
        this.persist();
        return;

      case "open_file":
        return reply({ type: "open_file_result", payload: this.resolveOpenFile(env.payload.path, env.payload.line) });

      case "launch_plan":
        return this.launcher.plan();
      case "launch_confirm":
        return this.launcher.confirm();
      case "launch_stop":
        return this.launcher.stop();

      case "vibe_start":
      case "vibe_answer":
      case "vibe_skip_questions":
      case "vibe_run":
      case "vibe_cancel":
      case "vibe_regenerate_report":
      case "vibe_verify":
      case "vibe_ask":
      case "vibe_reset":
      case "vibe_open":
        await this.vibe.handle(env);
        if (env.type === "vibe_reset" || env.type === "vibe_start" || env.type === "vibe_open") this.deps.broadcast({ type: "state_snapshot", payload: this.snapshot() });
        return;
    }
  }

  /** Attach (or reassign / dismiss with null) a change batch to a task. Activity only; never completes a task. */
  linkChange(changeBatchId: string, taskId: string | null, at = this.iso()): void {
    const ws = this.requireWs();
    const batch = ws.changeBatches.find((b) => b.id === changeBatchId);
    if (!batch) throw new Error(`change batch ${changeBatchId} not found`);
    const prevTaskId = batch.linkedTaskId;
    if (prevTaskId && prevTaskId !== taskId) {
      const prev = ws.tasks.find((t) => t.id === prevTaskId);
      if (prev) {
        const evIds = new Set(batch.evidence.map((e) => e.id));
        this.putTask({
          ...prev,
          linkedChangeBatchIds: prev.linkedChangeBatchIds.filter((id) => id !== batch.id),
          evidenceIds: prev.evidenceIds.filter((id) => !evIds.has(id)),
          updatedAt: at,
        });
      }
    }
    batch.linkedTaskId = taskId;
    if (taskId) this.putTask(applyActivity(this.findTask(taskId), batch.id, batch.evidence.map((e) => e.id), batch.timestamp > at ? at : batch.timestamp));
    this.persist();
    this.deps.broadcast({ type: "change_batch", payload: { ...batch } });
    this.pushProgress();
  }

  /** Task for a Build prompt: Gemma's criteria (ticked by the user) + "tests pass" linked to the test check. */
  createVibeTask(title: string, criteria: string[], testCommand?: string): string {
    const ws = this.requireWs();
    const at = this.iso();
    let check = testCommand ? ws.project.checkCommands.find((c) => c.command === testCommand) : undefined;
    if (testCommand && !check) {
      check = CheckCommandSchema.parse({ id: newId("chk"), label: testCommand === "npm test" ? "Tests" : testCommand.slice(0, 60), command: testCommand });
      ws.project = { ...ws.project, checkCommands: [...ws.project.checkCommands, check], updatedAt: at };
    }
    const crit = [
      ...criteria.slice(0, check ? 4 : 5).map((text) => ({ text })),
      ...(check ? [{ text: `Tests pass (\`${check.command}\`)`, checkCommandId: check.id }] : []),
    ];
    const task = this.newTask(ws, title, crit, at);
    ws.tasks.push(task);
    this.persist();
    this.deps.broadcast({ type: "task_updated", payload: task });
    this.deps.broadcast({ type: "state_snapshot", payload: this.snapshot() });
    this.pushProgress();
    return task.id;
  }

  private newTask(ws: WorkspaceState, title: string, criteria: { id?: string; text: string; checkCommandId?: string }[], at: string, milestoneId?: string): Task {
    return {
      id: newId("task"),
      projectId: ws.project.id,
      ...(milestoneId ? { milestoneId } : {}),
      title,
      order: ws.tasks.length,
      status: "not_started",
      acceptanceCriteria: criteria.slice(0, 5).map((c) => ({ id: newId("ac"), text: c.text, met: false, metBy: "none", ...(c.checkCommandId ? { checkCommandId: c.checkCommandId } : {}) })),
      linkedChangeBatchIds: [],
      evidenceIds: [],
      verificationRunIds: [],
      statusHistory: [{ at, from: null, to: "not_started", reason: "Task created", actor: "user" }],
      createdAt: at,
      updatedAt: at,
    };
  }

  // ---------- verification ----------

  /** Run an exact command the user clicked (from a vibe report), saving it as a project check if new. */
  async verifyCommand(command: string): Promise<VerificationRun> {
    const ws = this.requireWs();
    let check = ws.project.checkCommands.find((c) => c.command === command);
    if (!check) {
      check = CheckCommandSchema.parse({ id: newId("chk"), label: command === "npm test" ? "Tests" : command.slice(0, 60), command });
      ws.project = { ...ws.project, checkCommands: [...ws.project.checkCommands, check], updatedAt: this.iso() };
      this.persist();
      this.deps.broadcast({ type: "state_snapshot", payload: this.snapshot() });
    }
    return this.runVerification(check.id, []);
  }

  async runVerification(checkCommandId: string, taskIds: string[], replyTo?: string): Promise<VerificationRun> {
    const ws = this.requireWs();
    const check = ws.project.checkCommands.find((c) => c.id === checkCommandId);
    if (!check) throw new Error(`check command ${checkCommandId} is not configured for this project`);
    if (this.runningChecks.has(check.id)) throw new Error(`"${check.label}" is already running`);
    // Tasks targeted: explicit ids + tasks with a criterion linked to this check.
    const linked = ws.tasks.filter((t) => t.acceptanceCriteria.some((c) => c.checkCommandId === check.id)).map((t) => t.id);
    const targets = [...new Set([...taskIds.filter((id) => ws.tasks.some((t) => t.id === id)), ...linked])];
    this.runningChecks.add(check.id);
    try {
      const run = await runCheck({
        projectId: ws.project.id,
        cwd: ws.project.rootPath,
        check,
        taskIds: targets,
        onStart: (r) => this.deps.broadcast({ type: "verification_started", payload: { runId: r.id, checkCommandId: check.id, command: check.command, taskIds: targets } }, replyTo),
      });
      ws.verificationRuns = [...ws.verificationRuns, run].slice(-MAX_RUNS);
      for (const t of ws.tasks) {
        const next = applyVerification(t, run, check);
        if (next !== t) this.putTask(next);
      }
      this.persist();
      this.deps.broadcast({ type: "verification_result", payload: run }, replyTo);
      this.pushProgress();
      return run;
    } finally {
      this.runningChecks.delete(check.id);
    }
  }

  // ---------- explanations ----------

  private async explain(env: Extract<ClientEnvelope, { type: "request_explanation" | "ask_followup" }>, reply: Reply): Promise<void> {
    const ws = this.requireWs();
    const p = env.payload;
    const question = "question" in p ? p.question : undefined;
    const task = p.taskId ? ws.tasks.find((t) => t.id === p.taskId) : undefined;
    const batchIds = p.changeBatchIds.length ? p.changeBatchIds : (task?.linkedChangeBatchIds ?? []);
    const key = JSON.stringify([batchIds, p.level, question ?? "", p.wantQuiz, this.provider.name]);
    const requestId = newId("req");

    const cached = ws.explanationCache[key];
    if (cached && cached.mode === "real") return reply({ type: "explanation_result", payload: { ...cached, requestId } });

    let job = this.inflightExplanations.get(key);
    if (!job) {
      job = (async () => {
        const context = question
          ? await this.deps.observer.retrieveForQuestion(question, batchIds)
          : await this.deps.observer.getContext(batchIds);
        const runs = task ? ws.verificationRuns.filter((r) => task.verificationRunIds.includes(r.id)) : [];
        const res = await this.provider.explain({
          sessionId: this.deps.sessionId,
          requestId,
          taskId: task?.id,
          changeBatchIds: batchIds,
          level: p.level,
          question,
          wantQuiz: p.wantQuiz,
          context,
          task: task ? { title: task.title, acceptanceCriteria: task.acceptanceCriteria.map((c) => c.text) } : undefined,
          verificationRuns: runs,
        });
        return enforceCitations(ExplanationResponseSchema.parse(res), context);
      })();
      this.inflightExplanations.set(key, job);
      job.finally(() => this.inflightExplanations.delete(key)).catch(() => {});
    }
    try {
      const res = await job;
      ws.explanationCache[key] = res;
      const keys = Object.keys(ws.explanationCache);
      if (keys.length > 100) delete ws.explanationCache[keys[0]!];
      this.persist();
      reply({ type: "explanation_result", payload: { ...res, requestId } });
    } catch (e) {
      const status = await this.refreshModelStatus();
      reply({ type: "explanation_error", payload: { requestId, error: e instanceof Error ? e.message : String(e), modelStatus: status } });
    }
  }

  // ---------- open file ----------

  resolveOpenFile(relPath: string, line?: number): { ok: boolean; path: string; absPath?: string; line?: number; error?: string } {
    const ws = this.ws();
    if (!ws) return { ok: false, path: relPath, error: "no project selected" };
    if (!isSafeRelPath(relPath)) return { ok: false, path: relPath, error: "unsafe path" };
    try {
      const root = realpathSync(ws.project.rootPath);
      const abs = realpathSync(join(root, ...relPath.split("/")));
      if (abs !== root && !abs.startsWith(root + sep)) return { ok: false, path: relPath, error: "path resolves outside the workspace" };
      return { ok: true, path: relPath, absPath: abs, ...(line ? { line } : {}) };
    } catch {
      return { ok: false, path: relPath, error: "file does not exist" };
    }
  }
}

/** Defense in depth: keep only citations that overlap evidence or excerpts in the context packet. */
export function enforceCitations(res: ExplanationResponse, ctx: ContextPacket): ExplanationResponse {
  const ranges = [
    ...ctx.evidence.map((e) => ({ path: e.path, s: e.startLine, e: e.endLine })),
    ...ctx.excerpts.map((x) => ({ path: x.path, s: x.startLine, e: x.endLine })),
  ];
  const ok = (c: { path: string; startLine: number; endLine: number }) =>
    c.startLine <= c.endLine && ranges.some((r) => r.path === c.path && c.startLine <= r.e && c.endLine >= r.s);
  const valid = res.evidence.filter(ok);
  const invalid = res.evidence.filter((c) => !ok(c)).map(({ path, startLine, endLine }) => ({ path, startLine, endLine }));
  return { ...res, evidence: valid, invalidCitations: [...res.invalidCitations, ...invalid] };
}
