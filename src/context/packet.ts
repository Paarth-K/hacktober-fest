/**
 * Bounded, grounded context packets for P3's explanation and follow-up prompts.
 * Every excerpt is a real line range of a file the observer has seen; anything left
 * out is listed in `omissions`, and anything looked for but not found in `missing`.
 */
import type { ChangeBatch, ContextExcerpt, ContextPacket, EvidenceRef, FileChange, Omission } from "../shared/index.js";
import { changedRanges, hunkChars } from "../observer/diff.js";
import type { ContentSource } from "../observer/store.js";
import { enclosingBlock, findDefinitions, findUsages, langFamily, sliceLines, splitLines } from "./code.js";
import { extractImports, resolveImport } from "./imports.js";
import { isStopword } from "./tokens.js";

export interface ContextOptions {
  /** Character budget for excerpts + diffs. */
  maxChars?: number;
  /** Enclosing blocks longer than this are cut to a window around the change. */
  maxBlockLines?: number;
  /** Lines shown around a change when no enclosing block is found. */
  windowLines?: number;
  maxImportDefinitions?: number;
}

export interface RetrievalOptions extends ContextOptions {
  /** Upper bound on files scanned outside the changed/related set. */
  maxSearchFiles?: number;
  maxSymbols?: number;
}

export interface BatchWithSource {
  batch: ChangeBatch;
  /** Content as of this batch (live baseline or fixture files). */
  source: ContentSource;
}

const CONTEXT_DEFAULTS = { maxChars: 24_000, maxBlockLines: 80, windowLines: 8, maxImportDefinitions: 6 };
const RETRIEVAL_DEFAULTS = { maxChars: 16_000, maxSearchFiles: 4000, maxSymbols: 6 };

type ExcerptKind = ContextExcerpt["kind"];

class PacketBuilder {
  readonly excerpts: ContextExcerpt[] = [];
  readonly diffs: ContextPacket["diffs"] = [];
  readonly evidence: EvidenceRef[] = [];
  readonly omissions: Omission[] = [];
  readonly missing = new Set<string>();
  used = 0;
  truncated = false;

  constructor(
    readonly budget: number,
    readonly changeBatchIds: string[],
  ) {}

  addDiff(change: FileChange, batch: ChangeBatch): boolean {
    if (this.diffs.some((d) => d.path === change.path)) return true;
    if (!this.reserve(hunkChars(change.hunks), change.path, "diff")) return false;
    this.diffs.push({ path: change.path, kind: change.kind, hunks: change.hunks });
    for (const ev of batch.evidence) if (ev.path === change.path) this.evidence.push(ev);
    return true;
  }

  addExcerpt(path: string, startLine: number, endLine: number, kind: ExcerptKind, text: string, batch?: ChangeBatch): boolean {
    if (this.excerpts.some((x) => x.path === path && x.startLine <= startLine && x.endLine >= endLine)) return true;
    if (!this.reserve(text.length, path, `${kind} lines ${startLine}-${endLine}`)) return false;
    // Link to change evidence only when the excerpt really contains changed lines.
    const ev = batch?.evidence.find((e) => e.path === path && e.startLine <= endLine && e.endLine >= startLine);
    this.excerpts.push({ path, startLine, endLine, text, kind, ...(ev ? { evidenceId: ev.id } : {}) });
    return true;
  }

  omit(path: string, reason: Omission["reason"], detail: string): void {
    this.omissions.push({ path, reason, detail: detail.slice(0, 500) });
  }

  private reserve(chars: number, path: string, what: string): boolean {
    if (this.used + chars > this.budget) {
      this.truncated = true;
      this.omit(path, "budget", `${what} (${chars} chars) left out to stay within ${this.budget} chars`);
      return false;
    }
    this.used += chars;
    return true;
  }

  build(): ContextPacket {
    return {
      changeBatchIds: this.changeBatchIds,
      excerpts: this.excerpts,
      diffs: this.diffs,
      evidence: this.evidence,
      omissions: this.omissions,
      missing: [...this.missing],
      totalChars: this.used,
      truncated: this.truncated,
    };
  }
}

/** Context for explaining change batches: diffs → enclosing blocks → definitions the changed lines import. */
export async function buildChangeContext(batches: readonly BatchWithSource[], opts: ContextOptions = {}): Promise<ContextPacket> {
  const o = { ...CONTEXT_DEFAULTS, ...opts };
  const p = new PacketBuilder(o.maxChars, batches.map((b) => b.batch.id));
  carryOmissions(p, batches);

  // Newest first, so the latest diff of a file wins when batches overlap.
  const ordered = [...batches].reverse();
  for (const { batch } of ordered) for (const c of batch.changes) p.addDiff(c, batch);

  for (const { batch, source } of ordered) {
    for (const c of batch.changes) {
      if (c.kind === "delete" || c.hunks.length === 0) continue;
      const text = await source.read(c.path);
      if (text === null) {
        p.omit(c.path, "unreadable", "current content not available; only the diff is included");
        continue;
      }
      const lines = splitLines(text);
      const family = langFamily(c.path);
      for (const r of changedRanges(c.hunks, false)) {
        if (r.startLine > lines.length) continue;
        const block = enclosingBlock(lines, r.startLine, family);
        if (block && block.endLine >= r.endLine && block.endLine - block.startLine + 1 <= o.maxBlockLines) {
          p.addExcerpt(c.path, block.startLine, block.endLine, "enclosing", sliceLines(lines, block.startLine, block.endLine), batch);
          continue;
        }
        const lo = Math.max(block?.startLine ?? 1, r.startLine - o.windowLines, 1);
        const hi = Math.min(block?.endLine ?? lines.length, r.endLine + o.windowLines, lines.length);
        if (hi < lo) continue;
        if (block) p.omit(c.path, "budget", `\`${block.name}\` spans lines ${block.startLine}-${block.endLine}; only ${lo}-${hi} included`);
        p.addExcerpt(c.path, lo, hi, block ? "enclosing" : "changed", sliceLines(lines, lo, hi), batch);
      }
    }
  }

  let importDefs = 0;
  for (const { batch, source } of ordered) {
    const known = pathIndex(source);
    for (const c of batch.changes) {
      if (c.kind === "delete" || importDefs >= o.maxImportDefinitions) continue;
      const text = await source.read(c.path);
      if (text === null) continue;
      const added = c.hunks.flatMap((h) => h.lines.filter((l) => l[0] === "+").map((l) => l.slice(1))).join("\n");
      for (const imp of extractImports(c.path, text)) {
        const used = imp.names.filter((n) => wordIn(added, n));
        if (used.length === 0) continue;
        const target = resolveImport(c.path, imp.specifier, known);
        if (!target) continue;
        const targetText = await source.read(target);
        if (targetText === null) continue;
        const targetLines = splitLines(targetText);
        for (const name of used) {
          const def = findDefinitions(targetLines, name, langFamily(target))[0];
          if (!def || importDefs >= o.maxImportDefinitions) continue;
          const end = Math.min(def.endLine, def.startLine + o.maxBlockLines - 1);
          if (p.addExcerpt(target, def.startLine, end, "import", sliceLines(targetLines, def.startLine, end))) importDefs++;
        }
      }
    }
  }
  return p.build();
}

/**
 * Targeted evidence for a follow-up question: definitions and usages of the symbols it
 * names (changed files first, then their imports, then the rest of the known workspace),
 * files it names, and the relevant diffs. Symbols that cannot be found go in `missing`.
 */
export async function retrieveForQuestion(
  question: string,
  batches: readonly BatchWithSource[],
  workspace: ContentSource,
  opts: RetrievalOptions = {},
): Promise<ContextPacket> {
  const o = { ...CONTEXT_DEFAULTS, ...RETRIEVAL_DEFAULTS, ...opts };
  const p = new PacketBuilder(o.maxChars, batches.map((b) => b.batch.id));
  carryOmissions(p, batches);
  const terms = questionTerms(question);

  // Search order: changed files, files they import, everything else the observer knows.
  const owners = new Map<string, BatchWithSource>();
  for (const bw of batches) for (const c of bw.batch.changes) if (c.kind !== "delete") owners.set(c.path, bw);
  const changed = [...owners.keys()];
  const related: string[] = [];
  for (const path of changed) {
    const { source } = owners.get(path)!;
    const text = await source.read(path);
    if (text === null) continue;
    const known = pathIndex(source);
    for (const imp of extractImports(path, text)) {
      const target = resolveImport(path, imp.specifier, known);
      if (target && !owners.has(target) && !related.includes(target)) related.push(target);
    }
  }
  const near = [...changed, ...related];
  const others = workspace
    .paths()
    .filter((rel) => !owners.has(rel) && !related.includes(rel))
    .slice(0, o.maxSearchFiles);
  const ctx: SearchCtx = {
    p,
    read: (rel) => (owners.get(rel)?.source ?? workspace).read(rel),
    batchFor: (rel) => owners.get(rel)?.batch,
    maxBlockLines: o.maxBlockLines,
  };

  for (const sym of terms.symbols.slice(0, o.maxSymbols)) {
    let found = await addDefinition(ctx, sym, [...near, ...others]);
    found = (await addUsages(ctx, sym, near, 3, false)) || found;
    if (!found) found = await addUsages(ctx, sym, others, 2, false);
    if (!found) p.missing.add(`symbol \`${sym}\` was not found in the files the observer can see`);
  }

  for (const name of terms.files) {
    const lower = name.toLowerCase();
    const hit = [...near, ...others].find((rel) => rel.toLowerCase() === lower || rel.toLowerCase().endsWith(`/${lower}`));
    if (!hit) {
      p.missing.add(`file \`${name}\` is not in the observed workspace`);
      continue;
    }
    if (owners.has(hit)) continue; // its diff is added below
    const text = await ctx.read(hit);
    if (text === null) continue;
    const lines = splitLines(text);
    const end = Math.min(lines.length, 40);
    if (end > 0) p.addExcerpt(hit, 1, end, "search_hit", sliceLines(lines, 1, end));
  }

  for (const { batch } of [...batches].reverse()) for (const c of batch.changes) p.addDiff(c, batch);

  // Plain words: try them as definitions in nearby files, then as word hits in changed files.
  let wordHits = 0;
  for (const word of terms.words) {
    if (wordHits >= 4) break;
    if ((await addDefinition(ctx, word, near)) || (await addUsages(ctx, word, changed, 1, true))) wordHits++;
  }
  return p.build();
}

interface SearchCtx {
  p: PacketBuilder;
  read: (rel: string) => Promise<string | null>;
  batchFor: (rel: string) => ChangeBatch | undefined;
  maxBlockLines: number;
}

async function addDefinition(ctx: SearchCtx, symbol: string, paths: readonly string[]): Promise<boolean> {
  for (const rel of paths) {
    const text = await ctx.read(rel);
    if (text === null || !text.includes(symbol)) continue;
    const lines = splitLines(text);
    const def = findDefinitions(lines, symbol, langFamily(rel))[0];
    if (!def) continue;
    const end = Math.min(def.endLine, def.startLine + ctx.maxBlockLines - 1);
    ctx.p.addExcerpt(rel, def.startLine, end, "search_hit", sliceLines(lines, def.startLine, end), ctx.batchFor(rel));
    return true;
  }
  return false;
}

async function addUsages(ctx: SearchCtx, symbol: string, paths: readonly string[], maxFiles: number, caseInsensitive: boolean): Promise<boolean> {
  let files = 0;
  for (const rel of paths) {
    if (files >= maxFiles) break;
    const text = await ctx.read(rel);
    if (text === null) continue;
    if (!(caseInsensitive ? text.toLowerCase().includes(symbol.toLowerCase()) : text.includes(symbol))) continue;
    const lines = splitLines(text);
    const hits = caseInsensitive ? findWordCI(lines, symbol) : findUsages(lines, symbol, 3);
    if (hits.length === 0) continue;
    files++;
    for (const line of hits.slice(0, 2)) {
      const lo = Math.max(1, line - 3);
      const hi = Math.min(lines.length, line + 3);
      ctx.p.addExcerpt(rel, lo, hi, "search_hit", sliceLines(lines, lo, hi), ctx.batchFor(rel));
    }
  }
  return files > 0;
}

function findWordCI(lines: readonly string[], word: string): number[] {
  const re = new RegExp(`\\b${word.replace(/[^A-Za-z0-9_]/g, "")}\\b`, "i");
  const out: number[] = [];
  for (let i = 0; i < lines.length && out.length < 3; i++) if (re.test(lines[i]!)) out.push(i + 1);
  return out;
}

export interface QuestionTerms {
  symbols: string[];
  files: string[];
  words: string[];
}

const FILE_RE = /^[\w.-]+\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py|rs|go|java|kt|cs|rb|php|swift|c|h|cpp|hpp|json|md|css|scss|html|vue|svelte|ya?ml|toml|sql|sh)$/i;

/** Splits a question into code-like symbols, file names and plain content words. */
export function questionTerms(question: string): QuestionTerms {
  const symbols = new Set<string>();
  const files = new Set<string>();
  const words = new Set<string>();
  const classify = (tok: string, quoted: boolean) => {
    const t = tok.replace(/[?.,:;!]+$/, "").replace(/\(\)$/, "");
    if (!t) return;
    const lastSeg = t.split("/").pop() ?? "";
    if (FILE_RE.test(lastSeg)) {
      files.add(lastSeg);
      return;
    }
    const parts = t.split(".").filter(Boolean);
    const name = parts[parts.length - 1];
    if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) return;
    const codeLike = quoted || /\(\)[?.,:;!]*$/.test(tok) || parts.length > 1 || /_/.test(name) || /[a-z][A-Z]/.test(name) || /^[A-Z][a-z0-9]+[A-Z]/.test(name);
    if (codeLike) symbols.add(name);
    else if (name.length >= 4 && !isStopword(name)) words.add(name.toLowerCase());
  };
  const rest = question.replace(/`([^`]+)`/g, (_, inner: string) => {
    for (const tok of inner.split(/[\s,()]+/)) classify(tok, true);
    return " ";
  });
  for (const tok of rest.split(/\s+/)) classify(tok.replace(/^[^\w$./]+/, ""), false);
  return { symbols: [...symbols], files: [...files], words: [...words] };
}

function carryOmissions(p: PacketBuilder, batches: readonly BatchWithSource[]): void {
  for (const { batch } of batches) {
    p.omissions.push(...batch.omissions);
    for (const c of batch.changes) {
      if (c.baselineMissing) p.omit(c.path, "unreadable", "no earlier version was recorded, so the diff cannot show what changed");
    }
  }
}

function wordIn(text: string, word: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_$])${word.replace(/\$/g, "\\$")}($|[^A-Za-z0-9_$])`).test(text);
}

/** Case-insensitive lookup of the paths a source knows. */
function pathIndex(source: ContentSource): (rel: string) => string | null {
  const map = new Map(source.paths().map((rel) => [rel.toLowerCase(), rel]));
  return (rel) => map.get(rel.toLowerCase()) ?? null;
}
