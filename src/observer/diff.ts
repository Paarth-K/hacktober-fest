/**
 * Bounded line diff (Myers) producing unified-diff hunks. No dependency, and the
 * work is capped: past `maxEditDistance` the changed middle is reported as a
 * whole-block replace, which is still an accurate (if coarse) diff.
 */
import type { DiffHunk } from "../shared/index.js";

export interface DiffLimits {
  contextLines: number;
  maxHunksPerFile: number;
  maxDiffLinesPerFile: number;
  maxLineChars: number;
  maxEditDistance: number;
}

export const DEFAULT_DIFF_LIMITS: DiffLimits = {
  contextLines: 3,
  maxHunksPerFile: 40,
  maxDiffLinesPerFile: 400,
  maxLineChars: 400,
  maxEditDistance: 1000,
};

export interface FileDiff {
  hunks: DiffHunk[];
  addedLines: number;
  removedLines: number;
  /** True when hunks were cut at the per-file caps. Counts stay exact. */
  truncated: boolean;
}

type Tag = " " | "-" | "+";
interface Op {
  tag: Tag;
  line: string;
}

/** Normalizes line endings so CRLF/LF churn alone never shows up as a change. */
export function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function splitTextLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Line diff of two normalized texts. */
export function diffText(before: string, after: string, limits: DiffLimits = DEFAULT_DIFF_LIMITS): FileDiff {
  const ops = diffLines(splitTextLines(before), splitTextLines(after), limits.maxEditDistance);
  let addedLines = 0;
  let removedLines = 0;
  for (const op of ops) {
    if (op.tag === "+") addedLines++;
    else if (op.tag === "-") removedLines++;
  }
  const all = toHunks(ops, limits.contextLines);
  const hunks: DiffHunk[] = [];
  let budget = limits.maxDiffLinesPerFile;
  let truncated = false;
  for (const h of all) {
    if (hunks.length >= limits.maxHunksPerFile || budget <= 0) {
      truncated = true;
      break;
    }
    const lines = h.lines.map((l) => (l.length > limits.maxLineChars ? `${l.slice(0, limits.maxLineChars)}…` : l));
    if (lines.length > budget) {
      truncated = true;
      hunks.push(trimHunk({ ...h, lines }, budget));
      break;
    }
    budget -= lines.length;
    hunks.push({ ...h, lines });
  }
  return { hunks, addedLines, removedLines, truncated };
}

/** Edit script from `a` to `b`. Common prefix/suffix are trimmed before the O(ND) search. */
export function diffLines(a: readonly string[], b: readonly string[], maxEditDistance = DEFAULT_DIFF_LIMITS.maxEditDistance): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const midA = a.slice(pre, a.length - suf);
  const midB = b.slice(pre, b.length - suf);
  const middle = myers(midA, midB, maxEditDistance) ?? [
    ...midA.map((line): Op => ({ tag: "-", line })),
    ...midB.map((line): Op => ({ tag: "+", line })),
  ];
  return [
    ...a.slice(0, pre).map((line): Op => ({ tag: " ", line })),
    ...middle,
    ...a.slice(a.length - suf).map((line): Op => ({ tag: " ", line })),
  ];
}

/** Myers' greedy shortest edit script; null when the edit distance exceeds `maxD`. */
function myers(a: readonly string[], b: readonly string[], maxD: number): Op[] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((line) => ({ tag: "+", line }));
  if (m === 0) return a.map((line) => ({ tag: "-", line }));
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] = v[-d..d] as it stood before step d.
  const trace: Int32Array[] = [];
  const limit = Math.min(max, maxD);
  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice(off - d, off + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, d);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], a: readonly string[], b: readonly string[], dEnd: number): Op[] {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = dEnd; d > 0; d--) {
    const vd = trace[d]!;
    const at = (k: number) => vd[k + d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ tag: " ", line: a[--x]! });
      y--;
    }
    if (x === prevX) ops.push({ tag: "+", line: b[--y]! });
    else ops.push({ tag: "-", line: a[--x]! });
  }
  while (x > 0 && y > 0) {
    ops.push({ tag: " ", line: a[--x]! });
    y--;
  }
  return ops.reverse();
}

/** Groups an edit script into unified-diff hunks with `context` lines around changes. */
function toHunks(ops: readonly Op[], context: number): DiffHunk[] {
  const oldBefore = new Int32Array(ops.length + 1);
  const newBefore = new Int32Array(ops.length + 1);
  for (let i = 0; i < ops.length; i++) {
    const tag = ops[i]!.tag;
    oldBefore[i + 1] = oldBefore[i]! + (tag === "+" ? 0 : 1);
    newBefore[i + 1] = newBefore[i]! + (tag === "-" ? 0 : 1);
  }
  const groups: Array<[number, number]> = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]!.tag === " ") continue;
    const last = groups[groups.length - 1];
    if (last && i - last[1] - 1 <= 2 * context) last[1] = i;
    else groups.push([i, i]);
  }
  return groups.map(([first, lastChange]) => {
    const start = Math.max(0, first - context);
    const end = Math.min(ops.length - 1, lastChange + context);
    const slice = ops.slice(start, end + 1);
    const oldLines = slice.filter((o) => o.tag !== "+").length;
    const newLines = slice.filter((o) => o.tag !== "-").length;
    return {
      // Unified-diff convention: an empty side's start is the line before it.
      oldStart: oldBefore[start]! + (oldLines > 0 ? 1 : 0),
      oldLines,
      newStart: newBefore[start]! + (newLines > 0 ? 1 : 0),
      newLines,
      lines: slice.map((o) => `${o.tag}${o.line}`),
    };
  });
}

/** Cuts a hunk to `keep` lines and recomputes its line counts so it stays a valid hunk. */
function trimHunk(h: DiffHunk, keep: number): DiffHunk {
  const lines = h.lines.slice(0, keep);
  let oldLines = 0;
  let newLines = 0;
  for (const l of lines) {
    if (!l.startsWith("+")) oldLines++;
    if (!l.startsWith("-")) newLines++;
  }
  return { oldStart: h.oldStart, oldLines, newStart: h.newStart, newLines, lines };
}

export interface LineRange {
  startLine: number;
  endLine: number;
}

/**
 * Changed line ranges of a file. Added lines map to the current file; a pure
 * deletion maps to the nearest current line so the UI can still point at the spot.
 * For a deleted file the ranges are lines of the removed content.
 */
export function changedRanges(hunks: readonly DiffHunk[], fileDeleted: boolean): LineRange[] {
  const lines = new Set<number>();
  for (const h of hunks) {
    let oldLine = h.oldStart;
    let newLine = h.newStart;
    const lastNewLine = Math.max(1, h.newStart + h.newLines - 1);
    for (const line of h.lines) {
      const tag = line[0];
      if (tag === "+") {
        lines.add(newLine++);
      } else if (tag === "-") {
        lines.add(fileDeleted ? oldLine : Math.max(1, Math.min(newLine, lastNewLine)));
        oldLine++;
      } else {
        oldLine++;
        newLine++;
      }
    }
  }
  const ranges: LineRange[] = [];
  for (const n of [...lines].sort((p, q) => p - q)) {
    const last = ranges[ranges.length - 1];
    if (last && n <= last.endLine + 1) last.endLine = n;
    else ranges.push({ startLine: n, endLine: n });
  }
  return ranges;
}

/** Characters a set of hunks costs in a context budget. */
export function hunkChars(hunks: readonly DiffHunk[]): number {
  let n = 0;
  for (const h of hunks) for (const l of h.lines) n += l.length + 1;
  return n;
}
