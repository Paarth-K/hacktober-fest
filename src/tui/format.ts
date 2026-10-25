// Plain-language helpers for the terminal UI. Pure functions (unit-tested).
import type { Level, Task, VibeAgentEvent, VibeHistoryItem, VibePhase, VibeSession } from "../shared/index.js";

export type Pane = "ask" | "progress" | "learn";
export const PANES: Pane[] = ["ask", "progress", "learn"];
export const PANE_LABEL: Record<Pane, string> = { ask: "Ask", progress: "Progress", learn: "Learn" };

export const LEVELS: Level[] = ["beginner", "intermediate", "expert"];
export const LEVEL_LABEL: Record<Level, string> = { beginner: "New to coding", intermediate: "Learning", expert: "Experienced" };

/** Phases where Claude/Gemma are busy and the user should not switch changes. */
export const BUSY_PHASES: VibePhase[] = ["clarifying", "refining", "running", "reporting"];

export const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).at(-1) ?? p;

export function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, Math.max(0, n - 1))}…` : one;
}

/** What Claude is doing, in words a non-programmer understands. */
export function activityText(e: VibeAgentEvent): string | null {
  if (e.kind === "tool") {
    const [tool = "", ...rest] = e.text.split(" ");
    const target = rest.join(" ");
    if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(tool)) return `${tool === "Write" ? "Writing" : "Editing"} ${basename(target)}`;
    if (tool === "Delete") return `Removing ${basename(target)}`;
    if (/^(Read|Glob|Grep|LS)$/.test(tool)) return "Looking through your code";
    if (tool === "Bash" || tool.startsWith("$")) return "Running a command";
    if (tool === "TodoWrite") return "Planning the steps";
    if (/^Web/.test(tool)) return "Looking something up";
    return "Working";
  }
  if (e.kind === "text") return null; // Claude's chatter is shown separately, not as an activity
  return null;
}

/** Latest plain-language activity line for a running change. */
export function currentActivity(v: VibeSession): string {
  for (let i = v.events.length - 1; i >= 0; i--) {
    const t = activityText(v.events[i]!);
    if (t) return t;
  }
  return "Getting started";
}

/** Short title for a change: the task title Gemma wrote, else the request. */
export function changeTitle(prompt: string, taskTitle?: string): string {
  return truncate(taskTitle || prompt, 60);
}

export function phaseIcon(phase: VibePhase, verified: VibeHistoryItem["verified"] = "none"): string {
  switch (phase) {
    case "clarifying":
    case "refining":
    case "reporting":
      return "…";
    case "awaiting_answers":
    case "ready":
      return "?";
    case "running":
      return "●";
    case "done":
      return verified === "pass" ? "✔" : verified === "fail" ? "✖" : "✓";
    case "failed":
      return "✖";
    case "cancelled":
      return "■";
  }
}

export function phaseWords(phase: VibePhase): string {
  switch (phase) {
    case "clarifying": return "reading your request";
    case "awaiting_answers": return "has a question";
    case "refining": return "writing instructions";
    case "ready": return "ready to start";
    case "running": return "Claude is working";
    case "reporting": return "explaining";
    case "done": return "done";
    case "failed": return "didn't finish";
    case "cancelled": return "stopped";
  }
}

/**
 * Which pane to jump to when a change moves into `next`. Only transitions the user would expect trigger a switch:
 * Gemma asking -> Ask, Claude starting -> Progress, finished -> Learn. Re-writing an explanation never jumps.
 */
export function autoPane(prev: VibePhase | undefined, next: VibePhase): Pane | null {
  if (prev === next) return null;
  if (next === "awaiting_answers" || (next === "clarifying" && prev === undefined)) return "ask";
  if (next === "running") return "progress";
  if ((next === "done" || next === "failed" || next === "cancelled") && (prev === "running" || prev === "reporting")) return "learn";
  return null;
}

/** Pane to show when the user opens an existing change. */
export function paneForPhase(phase: VibePhase): Pane {
  if (phase === "running" || phase === "reporting") return "progress";
  if (phase === "done" || phase === "failed" || phase === "cancelled") return "learn";
  return "ask";
}

export function elapsed(fromIso: string, toMs = Date.now()): string {
  const s = Math.max(0, Math.round((toMs - Date.parse(fromIso)) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function timeAgo(iso: string, now = Date.now()): string {
  const m = Math.round((now - Date.parse(iso)) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

/** Engine/agent errors rewritten for a non-technical reader. */
export function friendlyError(raw: string): string {
  if (/ollama|gemma|model/i.test(raw) && /unreachable|not reachable|offline|ECONNREFUSED|timed out|no local/i.test(raw))
    return "Your local helper (Ollama) isn't running. Open the Ollama app, then try again.";
  if (/claude/i.test(raw) && /not (found|available|installed)/i.test(raw)) return "Claude Code isn't installed or logged in. Run `claude` once in a terminal to set it up.";
  if (/in progress|still running/i.test(raw)) return "Claude is still working on the current change. Press Esc to stop it first.";
  return raw.replace(/^[a-z_]+: /, "");
}

/** Progress: which of the 4 steps are done / active for a change. */
export function steps(v: VibeSession): { label: string; state: "done" | "active" | "todo" | "failed" }[] {
  const order: VibePhase[] = ["clarifying", "awaiting_answers", "refining", "ready", "running", "reporting", "done"];
  const idx = order.indexOf(v.phase === "failed" || v.phase === "cancelled" ? (v.report ? "done" : "running") : v.phase);
  const st = (activeFrom: number, doneAt: number): "done" | "active" | "todo" => (idx >= doneAt ? "done" : idx >= activeFrom ? "active" : "todo");
  const ran = v.run?.outcome;
  return [
    { label: "Understood your request", state: st(0, 2) },
    { label: "Wrote instructions for Claude", state: st(2, 4) },
    { label: ran === "failed" || ran === "timeout" ? "Claude ran into a problem" : ran === "cancelled" ? "You stopped Claude" : "Claude is making the changes", state: ran && ran !== "running" && ran !== "completed" ? "failed" : st(4, 5) },
    { label: "Explaining what changed", state: st(5, 6) },
  ];
}

export function taskProgress(task: Task | undefined): { met: number; total: number } | null {
  if (!task) return null;
  return { met: task.acceptanceCriteria.filter((c) => c.met).length, total: task.acceptanceCriteria.length };
}

export function bar(done: number, total: number, width = 16): string {
  if (total <= 0) return "░".repeat(width);
  const n = Math.round((done / total) * width);
  return "▓".repeat(n) + "░".repeat(width - n);
}
