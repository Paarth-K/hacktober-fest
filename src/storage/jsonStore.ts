// JSON-file persistence in the OS app-data directory (atomic write, debounced).
// Chosen over better-sqlite3 for MVP reliability: no native module build.
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  ChangeBatchSchema,
  ExplanationResponseSchema,
  MilestoneSchema,
  PreferencesSchema,
  ProjectSchema,
  TaskSchema,
  VerificationRunSchema,
} from "../shared/schemas.js";
import { VibeSessionSchema } from "../shared/vibe.js";

export const APP_DIR_NAME = "local-code-companion";

export function defaultDataDir(): string {
  if (process.env.LCC_DATA_DIR) return process.env.LCC_DATA_DIR;
  const home = homedir();
  if (process.platform === "darwin") return join(home, "Library", "Application Support", APP_DIR_NAME);
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), APP_DIR_NAME);
  return join(process.env.XDG_DATA_HOME ?? join(home, ".local", "share"), APP_DIR_NAME);
}

export const WorkspaceStateSchema = z.object({
  project: ProjectSchema,
  milestones: z.array(MilestoneSchema).default([]),
  tasks: z.array(TaskSchema).default([]),
  changeBatches: z.array(ChangeBatchSchema).default([]),
  verificationRuns: z.array(VerificationRunSchema).default([]),
  /** key -> response; key = batch ids + level + question + quiz flag. */
  explanationCache: z.record(z.string(), ExplanationResponseSchema).default({}),
  vibeSessions: z.array(VibeSessionSchema).default([]),
  currentVibeId: z.string().nullable().default(null),
});
export type WorkspaceState = z.infer<typeof WorkspaceStateSchema>;

export const PersistedStateSchema = z.object({
  version: z.literal(1),
  preferences: PreferencesSchema.default(PreferencesSchema.parse({})),
  activeRootPath: z.string().nullable().default(null),
  /** Keyed by absolute workspace root path. */
  workspaces: z.record(z.string(), WorkspaceStateSchema).default({}),
  selectedTaskId: z.string().nullable().default(null),
});
export type PersistedState = z.infer<typeof PersistedStateSchema>;

export const EMPTY_STATE = (): PersistedState => PersistedStateSchema.parse({ version: 1 });

export class JsonStore {
  readonly file: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: PersistedState | null = null;

  constructor(readonly dataDir: string = defaultDataDir()) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, "state.json");
  }

  load(): { state: PersistedState; warning?: string } {
    if (!existsSync(this.file)) return { state: EMPTY_STATE() };
    try {
      const parsed = PersistedStateSchema.safeParse(JSON.parse(readFileSync(this.file, "utf8")));
      if (parsed.success) return { state: parsed.data };
      throw new Error(parsed.error.message.slice(0, 500));
    } catch (e) {
      // Keep the unreadable file for inspection instead of silently overwriting it.
      const backup = `${this.file}.corrupt-${Date.now()}`;
      copyFileSync(this.file, backup);
      return { state: EMPTY_STATE(), warning: `state.json unreadable (${e instanceof Error ? e.message : e}); backed up to ${backup}` };
    }
  }

  /** Debounced save. */
  save(state: PersistedState, delayMs = 250): void {
    this.pending = state;
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), delayMs);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.pending) return;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.pending, null, 1), { mode: 0o600 });
    renameSync(tmp, this.file);
    this.pending = null;
  }
}
