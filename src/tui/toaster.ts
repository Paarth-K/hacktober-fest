// `skck --prog`: show progress as macOS toasts (top-right) via the MacToastKit helper in ./toasts.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
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
  // Rebuild when the helper's source is newer than the binary (e.g. after an update).
  const src = join(pkg, "Sources", "SidekickToasts", "main.swift");
  const fresh = (bin: string) => existsSync(bin) && statSync(bin).mtimeMs >= statSync(src).mtimeMs;
  const local = join(pkg, ".build", "release", "SidekickToasts");
  if (fresh(local)) return { bin: local };
  const scratch = join(defaultDataDir(), "toasts-build");
  const built = join(scratch, "release", "SidekickToasts");
  if (fresh(built)) return { bin: built };
  process.stderr.write("Building the toast helper (one time, ~30s)…\n");
  const r = spawnSync("swift", ["build", "-c", "release", "--package-path", pkg, "--scratch-path", scratch], { stdio: ["ignore", "ignore", "pipe"] });
  if (r.status !== 0 || !existsSync(built)) return { error: `Couldn't build the toast helper (needs Xcode command line tools): ${r.stderr?.toString().slice(-300) ?? ""}` };
  return { bin: built };
}

export class Toaster {
  private child: ChildProcess | null;
  /** Keeps toasts in order while Gemma writes each one. */
  private queue: Promise<void> = Promise.resolve();
  private request = new Map<string, string>();
  private phases = new Map<string, VibePhase>();
  private lastActivityToast = 0;

  /** narrate: Gemma writes the toast text from the event (falls back to the plain text). */
  constructor(bin: string, private narrate?: (event: string, request: string) => Promise<string | null>) {
    this.child = spawn(bin, [], { stdio: ["pipe", "ignore", "ignore"] });
    this.child.on("exit", () => (this.child = null));
  }

  show(message: string, icon: string, duration = 3): void {
    this.child?.stdin?.write(JSON.stringify({ message, icon, duration }) + "\n");
  }

  /** Ask Gemma for a specific line about this event; show the plain text if it takes over 2.5s. */
  private lastRequest = "";

  private say(fallback: string, icon: string, duration = 3, request = this.lastRequest): void {
    this.queue = this.queue.then(async () => {
      let text = fallback;
      if (this.narrate) {
        const g = await Promise.race([this.narrate(fallback, request).catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 2500))]);
        if (g) text = g;
      }
      this.show(text, icon, duration);
    });
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
      this.request.set(s.id, s.originalPrompt);
      this.lastRequest = s.originalPrompt;
      const others = [...this.phases.entries()].filter(([id, p]) => id !== s.id && (p === "running" || p === "refining")).length;
      switch (s.phase) {
        case "clarifying":
          if (!prev) this.say(`Gemma is reading “${what}”`, "brain");
          break;
        case "awaiting_answers":
          this.say("Gemma has a question for you", "questionmark.bubble.fill", 4);
          break;
        case "refining":
          this.say(others ? `Gemma is coordinating with ${others} other agent${others > 1 ? "s" : ""}` : "Gemma is writing instructions for Claude", others ? "arrow.triangle.branch" : "list.bullet.clipboard");
          break;
        case "running":
          this.say(`Claude Code started on “${what}”`, "hammer.fill");
          break;
        case "reporting":
          if (prev === "running") this.say("Gemma is explaining what changed", "text.magnifyingglass");
          break;
        case "done":
          this.say(`Done: ${s.report?.changes.length ?? 0} file${s.report?.changes.length === 1 ? "" : "s"} changed`, "checkmark.circle.fill", 4);
          break;
        case "failed":
          this.say(`Didn't finish: “${what}”`, "xmark.octagon.fill", 4);
          break;
        case "cancelled":
          this.say(`Stopped “${what}”`, "stop.circle.fill");
          break;
      }
    } else if (e.type === "vibe_agent_event") {
      this.lastRequest = this.request.get(e.payload.vibeId) ?? this.lastRequest;
      const t = activityText(e.payload.event);
      if (!t || t === "Looking through your code" || t === "Working") return;
      const now = Date.now();
      if (now - this.lastActivityToast < 4000) return; // don't spam
      this.lastActivityToast = now;
      this.say(`Claude: ${t}`, t.startsWith("Running") ? "terminal.fill" : "pencil", 2.5);
    } else if (e.type === "launch_updated" && e.payload.phase === "running" && e.payload.url) {
      this.show(`Your app is running: ${e.payload.url}`, "safari.fill", 5);
    }
  }
}
