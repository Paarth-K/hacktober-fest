/**
 * Text/regex code structure: language family, definition headers, enclosing blocks.
 * Deliberately shallow — no parser — and every result is a real line range of the file.
 */

export type LangFamily = "brace" | "indent" | "plain";

const BRACE_EXTS = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "java", "kt", "kts", "scala", "cs", "c", "h", "cpp", "cc",
  "cxx", "hpp", "hh", "go", "rs", "swift", "php", "dart", "groovy", "vue", "svelte", "css", "scss", "less",
]);
const INDENT_EXTS = new Set(["py", "pyi", "pyw"]);

export function langFamily(rel: string): LangFamily {
  const ext = rel.slice(rel.lastIndexOf(".") + 1).toLowerCase();
  if (BRACE_EXTS.has(ext)) return "brace";
  if (INDENT_EXTS.has(ext)) return "indent";
  return "plain";
}

const CONTROL_WORDS = new Set(["if", "for", "while", "switch", "catch", "with", "return", "function", "else", "do", "try", "new", "await", "typeof", "sizeof"]);

/** Ordered definition-header patterns; group 1 is the defined name. */
const DEF_PATTERNS: RegExp[] = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[<(]/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]*)?=>|[A-Za-z_$][\w$]*\s*=>|\(\s*$|\([^)]*$)/,
  /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:declare\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)/,
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|union)\s+([A-Za-z_]\w*)/,
  /^\s*impl(?:<[^>]*>)?\s+(?:[\w:<>]+\s+for\s+)?([A-Za-z_]\w*)/,
  /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/,
  /^\s*class\s+([A-Za-z_]\w*)/,
  // methods / C-family functions: `name(args) {` or `Type name(args) {`, `async name() {`
  /^\s*(?:(?:public|private|protected|internal|static|final|abstract|override|async|virtual|readonly|get|set|export)\s+)*(?:[\w<>[\],.?*&:]+\s+)?([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*(?::\s*[^{;=]+)?(?:throws\s+[\w., ]+)?\s*\{\s*$/,
];

export interface Definition {
  name: string;
  line: number; // 1-based header line
}

export function matchDefinition(line: string): string | null {
  for (const re of DEF_PATTERNS) {
    const m = re.exec(line);
    const name = m?.[1];
    if (name && !CONTROL_WORDS.has(name)) return name;
  }
  return null;
}

export interface Block {
  startLine: number;
  endLine: number;
  name?: string;
}

/** End line of the block whose header is at `headerLine` (1-based), or null if it is not a block. */
export function blockEnd(lines: readonly string[], headerLine: number, family: LangFamily): number | null {
  const start = headerLine - 1;
  if (family === "indent") {
    const indent = indentOf(lines[start] ?? "");
    let end = start;
    for (let i = start + 1; i < lines.length; i++) {
      if ((lines[i] ?? "").trim() === "") continue;
      if (indentOf(lines[i] ?? "") <= indent) break;
      end = i;
    }
    return end + 1;
  }
  if (family === "plain") return null;
  let depth = 0;
  let opened = false;
  let inBlockComment = false;
  for (let i = start; i < lines.length && i < start + 2000; i++) {
    const line = lines[i] ?? "";
    let quote: string | null = null;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      const next = line[j + 1];
      if (inBlockComment) {
        if (ch === "*" && next === "/") {
          inBlockComment = false;
          j++;
        }
        continue;
      }
      if (quote) {
        if (ch === "\\") j++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === "/" && next === "/") break;
      if (ch === "/" && next === "*") {
        inBlockComment = true;
        j++;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "{") {
        depth++;
        opened = true;
      } else if (ch === "}") {
        depth--;
        if (opened && depth <= 0) return i + 1;
      }
    }
    // A header that never opens a brace within a few lines is a one-liner (e.g. `const f = x => x`).
    if (!opened && i - start >= 4) return null;
    if (!opened && /;\s*$/.test(line)) return i + 1;
  }
  return opened ? Math.min(lines.length, start + 2000) : null;
}

/** Innermost definition block containing `line` (1-based), scanning at most `maxScan` lines up. */
export function enclosingBlock(lines: readonly string[], line: number, family: LangFamily, maxScan = 400): Block | null {
  if (family === "plain") return null;
  const lowest = Math.max(1, line - maxScan);
  for (let i = Math.min(line, lines.length); i >= lowest; i--) {
    const name = matchDefinition(lines[i - 1] ?? "");
    if (!name) continue;
    const end = blockEnd(lines, i, family);
    if (end !== null && end >= line) return { startLine: i, endLine: end, name };
  }
  return null;
}

/** All definition blocks named `symbol` in a file. */
export function findDefinitions(lines: readonly string[], symbol: string, family: LangFamily): Block[] {
  const out: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.includes(symbol)) continue;
    if (matchDefinition(lines[i]!) !== symbol) continue;
    const end = family === "plain" ? i + 1 : (blockEnd(lines, i + 1, family) ?? i + 1);
    out.push({ startLine: i + 1, endLine: end, name: symbol });
  }
  return out;
}

/** Lines (1-based) where `symbol` appears as a whole word. */
export function findUsages(lines: readonly string[], symbol: string, max = 20): number[] {
  const re = new RegExp(`(^|[^A-Za-z0-9_$])${escapeRegExp(symbol)}($|[^A-Za-z0-9_$])`);
  const out: number[] = [];
  for (let i = 0; i < lines.length && out.length < max; i++) if (re.test(lines[i]!)) out.push(i + 1);
  return out;
}

export function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function sliceLines(lines: readonly string[], startLine: number, endLine: number): string {
  return lines.slice(startLine - 1, endLine).join("\n");
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function indentOf(line: string): number {
  const m = /^[ \t]*/.exec(line);
  return m ? m[0].replace(/\t/g, "    ").length : 0;
}
