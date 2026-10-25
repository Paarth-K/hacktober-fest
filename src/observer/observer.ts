/**
 * Local edit observer. Watches the workspace the user picked, debounces bursts of
 * file events, reconciles each touched path against a content baseline, and emits
 * ChangeBatch activity evidence. It never decides task status and never talks to the UI.
 */
import { lstatSync, type Stats } from "node:fs";
import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { suggestTasks, type AttributionOptions, type TaskHint } from "../context/attribution.js";
import { buildChangeContext, retrieveForQuestion, type BatchWithSource, type ContextOptions, type RetrievalOptions } from "../context/packet.js";
import {
  ChangeBatchSchema,
  type ChangeBatch,
  type ContextPacket,
  type EvidenceRef,
  type FileChange,
  type FileChangeKind,
  type Observer,
  type ObserverStartOptions,
  type Omission,
  type SuggestedTaskLink,
  type Task,
} from "../shared/index.js";
import { DEFAULT_DIFF_LIMITS, changedRanges, diffText, normalizeText, type DiffLimits } from "./diff.js";
import type { ObserverFixture } from "./fixtures.js";
import { classifyPath, isIgnoredDirName, looksBinary } from "./ignore.js";
import { defaultCaseInsensitive, fromWorkspaceRel, inspectEntry, isNotFound, isSafeRelPath, pathKey, toWorkspaceRel } from "./paths.js";
import { MapContentSource, SnapshotStore, sha1, type ContentSource, type Snapshot } from "./store.js";

type ChangeSource = ChangeBatch["source"];

export interface ObserverOptions {
  /** Quiet period after the last file event before a burst is flushed. */
  debounceMs?: number;
  /** Upper bound on how long a continuous burst can delay a flush. */
  maxWaitMs?: number;
  /** Files over this size are reported as changed but never diffed or put in context. */
  maxFileBytes?: number;
  /** Files read into the start-up baseline; beyond this, edits are reported with baselineMissing. */
  maxBaselineFiles?: number;
  /** Text kept in memory for diffs and context, in characters. */
  maxBaselineChars?: number;
  maxFilesPerBatch?: number;
  maxEvidencePerBatch?: number;
  /** Extra directory names to ignore anywhere in the tree. */
  extraIgnoredDirs?: string[];
  /** Attach full before/after text to small FileChanges. Off by default (no full code in events). */
  includeFileContent?: boolean;
  caseInsensitive?: boolean;
  diffLimits?: Partial<DiffLimits>;
  attribution?: AttributionOptions;
  /** false disables the filesystem watcher (tests drive flush()/rescan() directly). */
  watch?: boolean;
  now?: () => Date;
}

export interface ObserverStatus {
  running: boolean;
  rootPath: string | null;
  sessionId: string | null;
  baselineFiles: number;
  baselineComplete: boolean;
  retainedChars: number;
  pendingPaths: number;
  batchesEmitted: number;
  lastBatchAt: string | null;
}

interface Reconciled {
  change?: FileChange;
  omissions?: Omission[];
}

const INCLUDE_CONTENT_MAX_CHARS = 16 * 1024;
const MAX_RECENT_BATCHES = 500;

export class LocalObserver implements Observer {
  private readonly opts: Required<Omit<ObserverOptions, "attribution" | "diffLimits" | "extraIgnoredDirs">>;
  private readonly diffLimits: DiffLimits;
  private readonly extraDirs: ReadonlySet<string>;
  private readonly attribution?: AttributionOptions;

  private startOpts: ObserverStartOptions | null = null;
  private root: string | null = null;
  private rootReal: string | null = null;
  private running = false;
  private store: SnapshotStore;
  private baselineComplete = false;
  private watcher: FSWatcher | null = null;

  private readonly dirty = new Map<string, { rel: string; dir: boolean }>();
  private timer: NodeJS.Timeout | null = null;
  private firstDirtyAt = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private seq = 0;

  private readonly listeners = new Set<(batch: ChangeBatch) => void>();
  private readonly batches = new Map<string, BatchWithSource>();
  private readonly fixtureSource = new MapContentSource();
  private batchesEmitted = 0;
  private lastBatchAt: string | null = null;

  constructor(options: ObserverOptions = {}) {
    this.opts = {
      debounceMs: options.debounceMs ?? 2500,
      maxWaitMs: options.maxWaitMs ?? 10_000,
      maxFileBytes: options.maxFileBytes ?? 256 * 1024,
      maxBaselineFiles: options.maxBaselineFiles ?? 20_000,
      maxBaselineChars: options.maxBaselineChars ?? 64 * 1024 * 1024,
      maxFilesPerBatch: options.maxFilesPerBatch ?? 50,
      maxEvidencePerBatch: options.maxEvidencePerBatch ?? 200,
      includeFileContent: options.includeFileContent ?? false,
      caseInsensitive: options.caseInsensitive ?? defaultCaseInsensitive(),
      watch: options.watch ?? true,
      now: options.now ?? (() => new Date()),
    };
    this.diffLimits = { ...DEFAULT_DIFF_LIMITS, ...options.diffLimits };
    this.extraDirs = new Set((options.extraIgnoredDirs ?? []).map((d) => d.toLowerCase()));
    this.attribution = options.attribution;
    this.store = new SnapshotStore(this.opts.caseInsensitive, this.opts.maxBaselineChars);
  }

  // ---- Observer interface --------------------------------------------------------

  /**
   * Baselines the workspace and starts watching. Restarting on the same root keeps the
   * old baseline and reports anything that changed while the observer was stopped.
   */
  async start(options: ObserverStartOptions): Promise<void> {
    const root = path.resolve(options.rootPath);
    const rootReal = await realpath(root);
    const sameRoot = this.root !== null && pathKey(this.root, this.opts.caseInsensitive) === pathKey(root, this.opts.caseInsensitive);
    if (this.running) await this.stop();
    this.startOpts = options;
    this.root = root;
    this.rootReal = rootReal;
    // Watch before scanning so edits made during the scan are queued, not lost.
    if (this.opts.watch) this.watcher = await this.startWatcher(root);
    if (sameRoot && this.store.size > 0) {
      await this.rescan();
    } else {
      this.store = new SnapshotStore(this.opts.caseInsensitive, this.opts.maxBaselineChars);
      await this.scanBaseline();
    }
    this.running = true;
  }

  /** Flushes pending edits, then stops watching. The baseline is kept for a restart on the same root. */
  async stop(): Promise<void> {
    if (!this.running && !this.watcher) return;
    try {
      await this.flush();
    } catch (err) {
      this.emitError(err);
    }
    const w = this.watcher;
    this.watcher = null;
    if (w) await w.close();
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Emits a pre-built batch through the same path as live batches (validated first). */
  replayFixture(batch: ChangeBatch): void {
    const parsed = ChangeBatchSchema.safeParse(batch);
    if (!parsed.success) {
      this.emitError(new Error(`replayFixture: invalid ChangeBatch: ${parsed.error.message}`));
      return;
    }
    this.publish(parsed.data, this.workspaceSource());
  }

  async getContext(changeBatchIds: string[], options: ContextOptions = {}): Promise<ContextPacket> {
    const { known, unknown } = this.lookup(changeBatchIds);
    const packet = await buildChangeContext(known, options);
    return withUnknown({ ...packet, changeBatchIds }, unknown);
  }

  /** Targeted evidence for a follow-up question. No IDs = the three most recent batches. */
  async retrieveForQuestion(question: string, changeBatchIds: string[], options: RetrievalOptions = {}): Promise<ContextPacket> {
    const ids = changeBatchIds.length > 0 ? changeBatchIds : [...this.batches.keys()].slice(-3);
    const { known, unknown } = this.lookup(ids);
    const packet = await retrieveForQuestion(question, known, this.workspaceSource(), options);
    return withUnknown({ ...packet, changeBatchIds: ids }, unknown);
  }

  /** Attribution hints for a batch. Hints only; nothing is linked. */
  suggestTasks(batch: ChangeBatch, tasks: readonly (Task | TaskHint)[]): SuggestedTaskLink[] {
    return suggestTasks(batch, tasks.map((t) => this.toHint(t)), this.attribution);
  }

  // ---- extras (engine/tests) -----------------------------------------------------

  /** Subscribe to batches in addition to start({onBatch}). */
  onBatch(listener: (batch: ChangeBatch) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  status(): ObserverStatus {
    return {
      running: this.running,
      rootPath: this.root,
      sessionId: this.startOpts?.sessionId ?? null,
      baselineFiles: this.store.size,
      baselineComplete: this.baselineComplete,
      retainedChars: this.store.retainedChars,
      pendingPaths: this.dirty.size,
      batchesEmitted: this.batchesEmitted,
      lastBatchAt: this.lastBatchAt,
    };
  }

  /**
   * Makes batches from an earlier engine run (persisted state) known again, without
   * emitting them. Their stored diffs and evidence are used as-is; no excerpts are read
   * for them, because the files may have changed since those line numbers were recorded.
   */
  restoreBatches(batches: readonly ChangeBatch[]): number {
    const none: ContentSource = { read: async () => null, paths: () => [] };
    let restored = 0;
    for (const b of batches) {
      if (this.batches.has(b.id)) continue;
      const parsed = ChangeBatchSchema.safeParse(b);
      if (!parsed.success) continue;
      this.batches.set(b.id, { batch: parsed.data, source: none });
      restored++;
    }
    while (this.batches.size > MAX_RECENT_BATCHES) this.batches.delete(this.batches.keys().next().value!);
    return restored;
  }

  getBatch(id: string): ChangeBatch | undefined {
    return this.batches.get(id)?.batch;
  }

  /** Marks a path as touched (absolute OS path or workspace-relative POSIX path). */
  notifyPath(p: string, isDirectory = false): void {
    if (!this.root) return;
    const rel = path.isAbsolute(p) ? toWorkspaceRel(this.root, p) : isSafeRelPath(p) ? p : null;
    if (rel) this.markDirty(rel, isDirectory);
  }

  /** Processes pending edits now instead of waiting for the debounce ("Analyze now"). */
  flush(): Promise<ChangeBatch | null> {
    return this.serial(async () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      const pending = [...this.dirty.values()];
      this.dirty.clear();
      this.firstDirtyAt = 0;
      if (pending.length === 0 || !this.root) return null;
      const rels = new Map<string, string>();
      const add = (rel: string) => rels.set(pathKey(rel, this.opts.caseInsensitive), rel);
      for (const d of pending) {
        if (!d.dir) {
          add(d.rel);
          continue;
        }
        // A removed directory takes its known files with it; an added one may hold
        // files written faster than the watcher attached to it.
        for (const s of this.store.entriesUnder(d.rel)) add(s.path);
        for (const rel of (await this.walk(d.rel, 2000)).files) add(rel);
      }
      return this.reconcileAll([...rels.values()], "watcher");
    });
  }

  /** Full reconcile of the workspace against the baseline; reports anything that differs. */
  rescan(): Promise<ChangeBatch | null> {
    return this.serial(async () => {
      if (!this.root) return null;
      const { files, complete } = await this.walk("", this.opts.maxBaselineFiles);
      const rels = new Map<string, string>();
      for (const rel of files) rels.set(pathKey(rel, this.opts.caseInsensitive), rel);
      if (complete) for (const rel of this.store.paths()) rels.set(pathKey(rel, this.opts.caseInsensitive), rel);
      const batch = await this.reconcileAll([...rels.values()], "manual");
      if (complete) this.baselineComplete = true;
      return batch;
    });
  }

  /**
   * Builds and emits a deterministic batch from in-memory before/after content, through
   * the same ignore/diff/evidence/attribution pipeline as live edits. Nothing touches disk.
   */
  async replayFiles(fixture: ObserverFixture, tasks?: readonly (Task | TaskHint)[]): Promise<ChangeBatch | null> {
    const changes: FileChange[] = [];
    const omissions: Omission[] = [];
    for (const f of [...fixture.files].sort((a, b) => a.path.localeCompare(b.path))) {
      if (!isSafeRelPath(f.path)) {
        omissions.push({ path: "(unsafe path)", reason: "outside_workspace", detail: "fixture path rejected: not a safe workspace-relative path" });
        continue;
      }
      const reason = classifyPath(f.path, this.extraDirs);
      if (reason === "secret") {
        omissions.push({ path: f.path, reason: "secret" });
        continue;
      }
      if (reason) continue;
      const kind: FileChangeKind = f.before == null ? "create" : f.after == null ? "delete" : "modify";
      const before = kind === "create" ? "" : normalizeText(f.before ?? "");
      const after = kind === "delete" ? "" : normalizeText(f.after ?? "");
      // Unchanged files are context only (e.g. a module the changed code imports).
      if (kind === "modify" && before === after) {
        this.fixtureSource.set(f.path, after);
        continue;
      }
      const d = diffText(before, after, this.diffLimits);
      changes.push({ path: f.path, kind, hunks: d.hunks, baselineMissing: false, truncated: d.truncated });
      if (d.truncated) omissions.push(truncatedOmission(f.path, d.addedLines, d.removedLines));
      this.fixtureSource.set(f.path, kind === "delete" ? null : after);
    }
    if (changes.length === 0) return null;
    const id = `cb_fx_${sha1(JSON.stringify([fixture.sessionId, fixture.timestamp, fixture.files])).slice(0, 16)}`;
    return this.emitBatch(changes, omissions, "fixture", this.fixtureSource, {
      id,
      timestamp: fixture.timestamp,
      sessionId: fixture.sessionId,
      tasks,
    });
  }

  // ---- internals -----------------------------------------------------------------

  private lookup(ids: readonly string[]): { known: BatchWithSource[]; unknown: string[] } {
    const known: BatchWithSource[] = [];
    const unknown: string[] = [];
    for (const id of ids) {
      const hit = this.batches.get(id);
      if (hit) known.push(hit);
      else unknown.push(id);
    }
    return { known, unknown };
  }

  /** Task → TaskHint, with linked paths taken from the batches the user accepted for it. */
  private toHint(t: Task | TaskHint): TaskHint {
    if (!("linkedChangeBatchIds" in t)) return t;
    const linkedPaths = new Set<string>();
    for (const id of t.linkedChangeBatchIds) for (const c of this.getBatch(id)?.changes ?? []) linkedPaths.add(c.path);
    return { id: t.id, title: t.title, acceptanceCriteria: t.acceptanceCriteria, linkedPaths: [...linkedPaths] };
  }

  private startWatcher(root: string): Promise<FSWatcher> {
    return new Promise((resolve) => {
      const w = watch(root, {
        ignoreInitial: true,
        followSymlinks: false,
        persistent: true,
        ignored: (p: string, stats?: Stats) => this.ignoredByWatcher(root, p, stats),
      });
      w.on("all", (event, p) => {
        const rel = toWorkspaceRel(root, p);
        if (!rel) return;
        if (event === "addDir" || event === "unlinkDir") this.markDirty(rel, true);
        else if (event === "add" || event === "change" || event === "unlink") this.markDirty(rel, false);
      });
      w.on("error", (err) => this.emitError(err));
      w.once("ready", () => resolve(w));
    });
  }

  private ignoredByWatcher(root: string, abs: string, stats?: Stats): boolean {
    if (path.relative(root, abs) === "") return false;
    const rel = toWorkspaceRel(root, abs);
    if (rel === null) return true;
    const base = rel.slice(rel.lastIndexOf("/") + 1);
    if (isIgnoredDirName(base) || this.extraDirs.has(base.toLowerCase())) {
      // chokidar sometimes asks without stats. Only a directory named build/dist/… is
      // ignored; a file such as scripts/build is ordinary source.
      const st = stats ?? lstatSync(abs, { throwIfNoEntry: false });
      if (!st || st.isDirectory()) return true;
    } else if (stats?.isDirectory()) {
      return classifyPath(`${rel}/x`, this.extraDirs) !== null;
    }
    const reason = classifyPath(rel, this.extraDirs);
    // Secret files stay visible to the watcher so their change is reported as an
    // omission; their content is never read.
    return reason !== null && reason !== "secret";
  }

  private markDirty(rel: string, dir: boolean): void {
    this.dirty.set(`${pathKey(rel, this.opts.caseInsensitive)}${dir ? "/" : ""}`, { rel, dir });
    const now = Date.now();
    if (!this.firstDirtyAt) this.firstDirtyAt = now;
    if (this.timer) clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(this.opts.debounceMs, this.firstDirtyAt + this.opts.maxWaitMs - now));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch((err) => this.emitError(err));
    }, wait);
  }

  private scanBaseline(): Promise<void> {
    return this.serial(async () => {
      const { files, complete } = await this.walk("", this.opts.maxBaselineFiles);
      this.baselineComplete = complete;
      await pool(files, 16, async (rel) => {
        const snap = await this.readSnapshot(rel);
        if (snap) this.store.set(snap);
      });
    });
  }

  /** Lists eligible files under `startRel`, skipping ignored dirs, ignored file kinds and symlinks. */
  private async walk(startRel: string, limit: number): Promise<{ files: string[]; complete: boolean }> {
    const root = this.root!;
    const files: string[] = [];
    const stack = [startRel];
    while (stack.length > 0) {
      const dirRel = stack.pop()!;
      let entries;
      try {
        entries = await readdir(dirRel ? fromWorkspaceRel(root, dirRel) : root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const name = e.name.normalize("NFC");
        const rel = dirRel ? `${dirRel}/${name}` : name;
        if (!isSafeRelPath(rel) || e.isSymbolicLink()) continue;
        if (e.isDirectory()) {
          if (!isIgnoredDirName(name) && !this.extraDirs.has(name.toLowerCase())) stack.push(rel);
          continue;
        }
        if (!e.isFile() || classifyPath(rel, this.extraDirs) !== null) continue;
        files.push(rel);
        if (files.length >= limit) return { files, complete: false };
      }
    }
    return { files, complete: true };
  }

  private async readSnapshot(rel: string): Promise<Snapshot | null> {
    try {
      const entry = await inspectEntry(this.root!, this.rootReal!, rel);
      if (entry.kind !== "file") return null;
      if (entry.size > this.opts.maxFileBytes) return { path: rel, kind: "large", hash: null, content: null, sig: sigOf(entry) };
      const buf = await readFile(entry.abs);
      if (looksBinary(buf)) return { path: rel, kind: "binary", hash: sha1(buf), content: null };
      const text = normalizeText(buf.toString("utf8"));
      return { path: rel, kind: "text", hash: sha1(text), content: text };
    } catch {
      return null;
    }
  }

  private async reconcileAll(rels: string[], source: ChangeSource): Promise<ChangeBatch | null> {
    const changes: FileChange[] = [];
    const omissions: Omission[] = [];
    for (const rel of rels.sort()) {
      try {
        const r = await this.reconcile(rel);
        if (r.change) changes.push(r.change);
        if (r.omissions) omissions.push(...r.omissions);
      } catch (err) {
        omissions.push({ path: rel, reason: "unreadable", detail: (err as Error).message.slice(0, 500) });
      }
    }
    if (changes.length === 0) return null;
    const kept = changes.slice(0, this.opts.maxFilesPerBatch);
    for (const c of changes.slice(this.opts.maxFilesPerBatch)) {
      omissions.push({ path: c.path, reason: "budget", detail: `${c.kind} not included: over the ${this.opts.maxFilesPerBatch}-file batch limit` });
    }
    return this.emitBatch(kept, omissions, source, this.liveSource());
  }

  /** Compares one path's current state with its baseline and updates the baseline. */
  private async reconcile(rel: string): Promise<Reconciled> {
    const reason = classifyPath(rel, this.extraDirs);
    if (reason === "secret") return { omissions: [{ path: rel, reason: "secret", detail: "matches a secret/credential pattern; content never read" }] };
    if (reason) return {};
    const prev = this.store.get(rel);
    const entry = await inspectEntry(this.root!, this.rootReal!, rel);
    if (entry.kind === "symlink") {
      return { omissions: [{ path: rel, reason: entry.insideWorkspace ? "symlink" : "outside_workspace", detail: "symlinks are not followed" }] };
    }
    if (entry.kind !== "file") return prev ? this.deleted(prev) : {};

    if (entry.size > this.opts.maxFileBytes) {
      const sig = sigOf(entry);
      if (prev?.kind === "large" && prev.sig === sig) return {};
      this.store.set({ path: rel, kind: "large", hash: null, content: null, sig });
      return {
        change: bare(rel, prev ? "modify" : this.unseenKind(), true),
        omissions: [{ path: rel, reason: "too_large", detail: `${entry.size} bytes exceeds the ${this.opts.maxFileBytes}-byte cap` }],
      };
    }

    let buf: Buffer;
    try {
      buf = await readFile(entry.abs);
    } catch (err) {
      if (isNotFound(err)) return prev ? this.deleted(prev) : {};
      throw err;
    }
    if (looksBinary(buf)) {
      const hash = sha1(buf);
      if (prev?.hash === hash) return {};
      this.store.set({ path: rel, kind: "binary", hash, content: null });
      return { change: bare(rel, prev ? "modify" : this.unseenKind(), true), omissions: [{ path: rel, reason: "binary" }] };
    }

    const text = normalizeText(buf.toString("utf8"));
    const hash = sha1(text);
    if (prev?.hash === hash) return {};
    this.store.set({ path: rel, kind: "text", hash, content: text });

    // Without a recorded earlier version we say so instead of inventing a diff.
    const before = prev ? prev.content : this.baselineComplete ? "" : null;
    if (before === null) return { change: bare(rel, "modify", true) };
    const kind: FileChangeKind = prev ? "modify" : "create";
    const d = diffText(before, text, this.diffLimits);
    const change: FileChange = { path: rel, kind, hunks: d.hunks, baselineMissing: false, truncated: d.truncated };
    if (this.opts.includeFileContent && before.length <= INCLUDE_CONTENT_MAX_CHARS && text.length <= INCLUDE_CONTENT_MAX_CHARS) {
      if (kind === "modify") change.before = before;
      change.after = text;
    }
    return { change, omissions: d.truncated ? [truncatedOmission(rel, d.addedLines, d.removedLines)] : [] };
  }

  private deleted(prev: Snapshot): Reconciled {
    this.store.delete(prev.path);
    if (prev.kind === "text" && prev.content !== null) {
      const d = diffText(prev.content, "", this.diffLimits);
      return {
        change: { path: prev.path, kind: "delete", hunks: d.hunks, baselineMissing: false, truncated: d.truncated },
        omissions: d.truncated ? [truncatedOmission(prev.path, 0, d.removedLines)] : [],
      };
    }
    const omissions: Omission[] = prev.kind === "large" ? [{ path: prev.path, reason: "too_large" }] : prev.kind === "binary" ? [{ path: prev.path, reason: "binary" }] : [];
    return { change: bare(prev.path, "delete", prev.kind === "text"), omissions };
  }

  /** Kind for a file absent from the baseline: a create only if the baseline was complete. */
  private unseenKind(): FileChangeKind {
    return this.baselineComplete ? "create" : "modify";
  }

  private async emitBatch(
    changes: FileChange[],
    omissions: Omission[],
    source: ChangeSource,
    content: ContentSource,
    fixed?: { id: string; timestamp: string; sessionId: string; tasks?: readonly (Task | TaskHint)[] },
  ): Promise<ChangeBatch | null> {
    const timestamp = fixed?.timestamp ?? this.opts.now().toISOString();
    const sessionId = fixed?.sessionId ?? this.startOpts?.sessionId ?? "observer";
    const id =
      fixed?.id ?? `cb_${sha1(`${sessionId}|${source}|${++this.seq}|${timestamp}|${changes.map((c) => `${c.kind}:${c.path}`).join(",")}`).slice(0, 20)}`;
    const draft: ChangeBatch = {
      id,
      sessionId,
      timestamp,
      source,
      changes,
      omissions: dedupeOmissions(omissions),
      evidence: this.evidenceFor(id, changes),
      suggestedTaskLinks: [],
    };
    let tasks: readonly (Task | TaskHint)[] = fixed?.tasks ?? [];
    if (!fixed?.tasks && this.startOpts) {
      try {
        tasks = this.startOpts.getTasks();
      } catch (err) {
        this.emitError(err);
      }
    }
    draft.suggestedTaskLinks = this.suggestTasks(draft, tasks);

    const parsed = ChangeBatchSchema.safeParse(draft);
    if (!parsed.success) {
      this.emitError(new Error(`observer built an invalid ChangeBatch: ${parsed.error.message}`));
      return null;
    }
    this.publish(parsed.data, content);
    return parsed.data;
  }

  private publish(batch: ChangeBatch, content: ContentSource): void {
    this.batches.set(batch.id, { batch, source: content });
    if (this.batches.size > MAX_RECENT_BATCHES) this.batches.delete(this.batches.keys().next().value!);
    this.batchesEmitted++;
    this.lastBatchAt = batch.timestamp;
    const sinks = [...(this.startOpts ? [this.startOpts.onBatch] : []), ...this.listeners];
    for (const sink of sinks) {
      try {
        sink(batch);
      } catch (err) {
        this.emitError(err);
      }
    }
  }

  private evidenceFor(changeBatchId: string, changes: readonly FileChange[]): EvidenceRef[] {
    const out: EvidenceRef[] = [];
    for (const c of changes) {
      for (const r of changedRanges(c.hunks, c.kind === "delete")) {
        if (out.length >= this.opts.maxEvidencePerBatch) return out;
        out.push({
          id: `ev_${sha1(`${changeBatchId}:${c.path}:${r.startLine}-${r.endLine}`).slice(0, 16)}`,
          path: c.path,
          startLine: r.startLine,
          endLine: r.endLine,
          changeBatchId,
        });
      }
    }
    return out;
  }

  /** Baseline text, falling back to a guarded disk read when the memory cap dropped it. */
  private liveSource(): ContentSource {
    const store = this.store;
    return {
      read: async (rel) => (await store.read(rel)) ?? (await this.readDiskText(rel)),
      paths: () => store.paths(),
    };
  }

  /** Live workspace plus fixture content, for retrieval and replayed batches. */
  private workspaceSource(): ContentSource {
    const live = this.liveSource();
    const fixtures = this.fixtureSource;
    return {
      read: async (rel) => (await live.read(rel)) ?? (await fixtures.read(rel)),
      paths: () => [...new Set([...live.paths(), ...fixtures.paths()])],
    };
  }

  private async readDiskText(rel: string): Promise<string | null> {
    if (!this.root || !this.rootReal || !isSafeRelPath(rel) || classifyPath(rel, this.extraDirs) !== null) return null;
    try {
      const entry = await inspectEntry(this.root, this.rootReal, rel);
      if (entry.kind !== "file" || entry.size > this.opts.maxFileBytes) return null;
      const buf = await readFile(entry.abs);
      return looksBinary(buf) ? null : normalizeText(buf.toString("utf8"));
    } catch {
      return null;
    }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private emitError(err: unknown): void {
    const e = err instanceof Error ? err : new Error(String(err));
    if (this.startOpts?.onError) this.startOpts.onError(e);
    else console.error("[observer]", e);
  }
}

function bare(rel: string, kind: FileChangeKind, baselineMissing: boolean): FileChange {
  return { path: rel, kind, hunks: [], baselineMissing, truncated: false };
}

function truncatedOmission(rel: string, added: number, removed: number): Omission {
  return { path: rel, reason: "budget", detail: `diff cut at the per-file limit (+${added}/-${removed} lines in total)` };
}

function sigOf(entry: { size: number; mtimeMs: number }): string {
  return `${entry.size}:${Math.round(entry.mtimeMs)}`;
}

function dedupeOmissions(omissions: Omission[]): Omission[] {
  const seen = new Set<string>();
  return omissions.filter((o) => {
    const key = `${o.path}|${o.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function withUnknown(packet: ContextPacket, unknownIds: readonly string[]): ContextPacket {
  if (unknownIds.length === 0) return packet;
  const notes = unknownIds.map((id) => `change batch ${id} is not known to the observer (expired, or from an earlier engine run)`);
  return { ...packet, missing: [...notes, ...packet.missing] };
}

async function pool<T>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  });
  await Promise.all(workers);
}
