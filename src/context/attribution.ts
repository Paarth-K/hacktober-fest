/**
 * Change-to-task attribution hints. Cheap signals only; the result is a suggestion
 * the user accepts or reassigns, never a link or a status change.
 */
import type { ChangeBatch, FileChange, SuggestedTaskLink } from "../shared/index.js";
import { codeTokens, keywords, pathTokens, tokenMatch } from "./tokens.js";

/** The slice of a Task the heuristics need. Canonical `Task` objects fit this shape. */
export interface TaskHint {
  id: string;
  title: string;
  acceptanceCriteria?: ReadonlyArray<string | { text: string }>;
  /** Workspace-relative paths already linked to this task through accepted change batches. */
  linkedPaths?: readonly string[];
}

export interface AttributionOptions {
  /** Suggestions under this score are dropped: low confidence means no suggestion. */
  minScore?: number;
  maxSuggestions?: number;
}

const DEFAULT_MIN_SCORE = 0.4;
const DEFAULT_MAX_SUGGESTIONS = 3;
const MAX_REASON_CHARS = 300;

interface TaskProfile {
  task: TaskHint;
  /** stemmed keyword → weight (title 1, criteria 0.5) */
  words: Map<string, number>;
  totalWeight: number;
  textLower: string;
  linked: Set<string>;
}

interface FileSignal {
  score: number;
  reasons: string[];
}

export function suggestTasks(
  batch: Pick<ChangeBatch, "changes">,
  tasks: readonly TaskHint[],
  opts: AttributionOptions = {},
): SuggestedTaskLink[] {
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;
  const maxSuggestions = opts.maxSuggestions ?? DEFAULT_MAX_SUGGESTIONS;
  const files = batch.changes.map((c) => ({ path: c.path, ...fileFeatures(c) }));

  const out: SuggestedTaskLink[] = [];
  for (const p of tasks.map(profileTask)) {
    let best: (FileSignal & { path: string }) | null = null;
    for (const f of files) {
      const sig = scoreFile(p, f.path, f.dirs, f.base, f.code);
      if (!best || sig.score > best.score) best = { ...sig, path: f.path };
    }
    if (!best || best.score < minScore) continue;
    const reason = `${best.path}: ${best.reasons.join("; ")}`;
    out.push({ taskId: p.task.id, score: round2(best.score), reason: reason.slice(0, MAX_REASON_CHARS) });
  }
  out.sort((a, b) => b.score - a.score || a.taskId.localeCompare(b.taskId));
  return out.slice(0, maxSuggestions);
}

function profileTask(task: TaskHint): TaskProfile {
  const words = new Map<string, number>();
  for (const w of keywords(task.title)) words.set(w, 1);
  const criteria = (task.acceptanceCriteria ?? []).map((c) => (typeof c === "string" ? c : c.text));
  for (const w of keywords(criteria.join(" "))) if (!words.has(w)) words.set(w, 0.5);
  let totalWeight = 0;
  for (const v of words.values()) totalWeight += v;
  return {
    task,
    words,
    totalWeight,
    textLower: `${task.title}\n${criteria.join("\n")}`.toLowerCase(),
    linked: new Set((task.linkedPaths ?? []).map((p) => p.toLowerCase())),
  };
}

function fileFeatures(change: FileChange) {
  const { dirs, base } = pathTokens(change.path);
  const changedLines: string[] = [];
  for (const h of change.hunks) for (const l of h.lines) if (l[0] === "+" || l[0] === "-") changedLines.push(l.slice(1));
  return { dirs, base, code: codeTokens(changedLines) };
}

function scoreFile(p: TaskProfile, path: string, dirs: string[], base: string[], code: Map<string, number>): FileSignal {
  const reasons: string[] = [];
  const signals: number[] = [];
  const pathLower = path.toLowerCase();
  const fileName = pathLower.slice(pathLower.lastIndexOf("/") + 1);

  // 1. The task text names this file.
  if (p.textLower.includes(pathLower) || (fileName.length >= 4 && fileName.includes(".") && p.textLower.includes(fileName))) {
    signals.push(0.9);
    reasons.push(`task mentions ${fileName}`);
  }

  // 2. The file was already linked to this task through an accepted change batch.
  if (p.linked.has(pathLower)) {
    signals.push(0.7);
    reasons.push("file already linked to this task");
  }

  // 3. Path words overlap task keywords. The file stem counts more than directories.
  if (p.totalWeight > 0) {
    const pathWords = [...base.map((w) => [w, 1] as const), ...dirs.map((w) => [w, 0.8] as const)];
    const { best, coverage, matched } = overlap(p, pathWords);
    if (best > 0) {
      signals.push(Math.min(0.75, 0.55 * best + 0.4 * coverage));
      reasons.push(`path matches ${quoteList(matched)}`);
    }
  }

  // 4. Identifiers in the changed lines overlap task keywords (weaker).
  if (p.totalWeight > 0 && code.size > 0) {
    const codeWords = [...code.keys()].map((w) => [w, 1] as const);
    const { best, coverage, matched } = overlap(p, codeWords);
    if (best > 0) {
      signals.push(Math.min(0.45, 0.3 * best + 0.2 * coverage));
      reasons.push(`changed code mentions ${quoteList(matched)}`);
    }
  }

  const score = 1 - signals.reduce((acc, s) => acc * (1 - s), 1);
  return { score, reasons };
}

/** Best single keyword match and weighted coverage of the task's keywords by `candidates`. */
function overlap(p: TaskProfile, candidates: ReadonlyArray<readonly [string, number]>) {
  let best = 0;
  let covered = 0;
  const matched: string[] = [];
  for (const [kw, weight] of p.words) {
    let m = 0;
    for (const [cand, candWeight] of candidates) m = Math.max(m, tokenMatch(kw, cand) * candWeight);
    if (m > 0) {
      matched.push(kw);
      covered += weight * m;
      best = Math.max(best, m * weight);
    }
  }
  return { best, coverage: covered / p.totalWeight, matched };
}

function quoteList(words: string[]): string {
  return words
    .slice(0, 3)
    .map((w) => `'${w}'`)
    .join(", ");
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
