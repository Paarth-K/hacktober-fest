// `skck --prog`: show progress as macOS toasts (top-right) via the MacToastKit helper in ./toasts.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerEnvelope, VibePhase } from "../shared/index.js";
import { defaultDataDir } from "../storage/jsonStore.js";
import { activityText, truncate } from "./format.js";

/** Find (or build once) the SidekickToasts helper. Returns null with a reason when unavailable. */
export function ensureToastHelper(): { bin: string } | { error: string } {
  if (process.platform !== "darwin") return { error: "Toasts are only available on macOS." };
  // Walk up from this file to the package root (works for src/tui/*.ts and the dist-cli bundle).
  let root = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(root, "toasts", "Package.swift")) && dirname(root) !== root) root = dirname(root);
  const pkg = join(root, "toasts");
  if (!existsSync(join(pkg, "Package.swift"))) return { error: "Toast helper sources are missing." };
  const local = join(pkg, ".build", "release", "SidekickToasts");
  if (existsSync(local)) return { bin: local };
  const scratch = join(defaultDataDir(), "toasts-build");
  const built = join(scratch, "release", "SidekickToasts");
  if (existsSync(built)) return { bin: built };
  process.stderr.write("Building the toast helper (one time, ~30s)…\n");
  const r = spawnSync("swift", ["build", "-c", "release", "--package-path", pkg, "--scratch-path", scratch], { stdio: ["ignore", "ignore", "pipe"] });
  if (r.status !== 0 || !existsSync(built)) return { error: `Couldn't build the toast helper (needs Xcode command line tools): ${r.stderr?.toString().slice(-300) ?? ""}` };
  return { bin: built };
}

export class Toaster {
  private child: ChildProcess | null;
  private phases = new Map<string, VibePhase>();
  private lastActivityToast = 0;

  constructor(bin: string) {
    this.child = spawn(bin, [], { stdio: ["pipe", "ignore", "ignore"] });
    this.child.on("exit", () => (this.child = null));
  }

  show(message: string, icon: string, duration = 3): void {
    this.child?.stdin?.write(JSON.stringify({ message, icon, duration }) + "\n");
  }

  close(): void {
    this.child?.stdin?.end();
    this.child = null;
  }

  /** Turn engine events into short progress toasts. */
  onEvent(e: ServerEnvelope): void {
    if (e.type === "vibe_updated") {
      const s = e.payload;
      const prev = this.phases.get(s.id);
      if (prev === s.phase) return;
      this.phases.set(s.id, s.phase);
      const what = truncate(s.originalPrompt, 40);
      const others = [...this.phases.entries()].filter(([id, p]) => id !== s.id && (p === "running" || p === "refining")).length;
      switch (s.phase) {
        case "clarifying":
          if (!prev) this.show(`Gemma is reading “${what}”`, "brain");
          break;
        case "awaiting_answers":
          this.show("Gemma has a question for you", "questionmark.bubble.fill", 4);
          break;
        case "refining":
          this.show(others ? `Gemma is coordinating with ${others} other agent${others > 1 ? "s" : ""}` : "Gemma is writing instructions for Claude", others ? "arrow.triangle.branch" : "list.bullet.clipboard");
          break;
        case "running":
          this.show(`Claude Code started on “${what}”`, "hammer.fill");
          break;
        case "reporting":
          if (prev === "running") this.show("Gemma is explaining what changed", "text.magnifyingglass");
          break;
        case "done":
          this.show(`Done: ${s.report?.changes.length ?? 0} file${s.report?.changes.length === 1 ? "" : "s"} changed`, "checkmark.circle.fill", 4);
          break;
        case "failed":
          this.show(`Didn't finish: “${what}”`, "xmark.octagon.fill", 4);
          break;
        case "cancelled":
          this.show(`Stopped “${what}”`, "stop.circle.fill");
          break;
      }
    } else if (e.type === "vibe_agent_event") {
      const t = activityText(e.payload.event);
      if (!t || t === "Looking through your code" || t === "Working") return;
      const now = Date.now();
      if (now - this.lastActivityToast < 4000) return; // don't spam
      this.lastActivityToast = now;
      this.show(`Claude: ${t}`, t.startsWith("Running") ? "terminal.fill" : "pencil", 2.5);
    } else if (e.type === "launch_updated" && e.payload.phase === "running" && e.payload.url) {
      this.show(`Your app is running: ${e.payload.url}`, "safari.fill", 5);
    }
  }
}
