/** Cheap tokenization shared by task attribution and question retrieval. */

const ENGLISH_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "nor", "but", "of", "to", "in", "on", "for", "with", "by", "from", "at", "as",
  "is", "are", "was", "were", "be", "been", "being", "it", "its", "this", "that", "these", "those", "into", "onto",
  "via", "per", "than", "then", "so", "if", "not", "no", "yes", "all", "any", "each", "every", "some", "such",
  "when", "where", "which", "who", "whom", "what", "why", "how", "can", "could", "should", "would", "will", "shall",
  "must", "may", "might", "do", "does", "did", "done", "has", "have", "had", "there", "their", "they", "them",
  "we", "our", "you", "your", "i", "me", "my", "he", "she", "his", "her", "about", "after", "before", "over", "under",
  "up", "down", "out", "off", "again", "also", "just", "only", "very", "more", "most", "other", "same", "own",
  // generic task verbs that say nothing about *where* the work happens
  "add", "adds", "added", "adding", "implement", "implements", "implemented", "implementing", "create", "creates",
  "created", "make", "makes", "made", "update", "updates", "updated", "fix", "fixes", "fixed", "support", "supports",
  "handle", "handles", "build", "builds", "write", "writes", "set", "setup", "allow", "allows", "ensure", "ensures",
  "enable", "enables", "new", "basic", "simple", "proper", "properly", "correct", "correctly", "work", "works",
  "working", "able", "use", "uses", "using", "used", "get", "gets", "task", "tasks", "feature", "code", "file", "files",
  "change", "changes", "changed", "thing", "things", "stuff", "way", "like", "need", "needs", "want", "wants",
  "explain", "explains", "mean", "means", "doing", "happen", "happens", "here", "now", "please", "tell", "return", "returns",
]);

/** Path segments and extensions too common to say anything about a task. */
const GENERIC_PATH_TOKENS = new Set([
  "src", "lib", "app", "apps", "index", "main", "mod", "pkg", "packages", "internal", "cmd", "source", "sources",
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go", "java", "kt", "cs", "rb", "php", "swift", "c", "h", "cc",
  "cpp", "hpp", "json", "yaml", "yml", "toml", "md", "txt", "html", "css", "scss", "vue", "svelte", "d",
]);

const CODE_KEYWORDS = new Set([
  "const", "let", "var", "function", "return", "import", "export", "from", "default", "class", "extends", "implements",
  "interface", "type", "enum", "new", "this", "self", "super", "null", "undefined", "true", "false", "none", "if",
  "else", "elif", "for", "while", "do", "switch", "case", "break", "continue", "try", "catch", "finally", "throw",
  "throws", "async", "await", "yield", "static", "public", "private", "protected", "readonly", "void", "string",
  "number", "boolean", "any", "unknown", "never", "object", "def", "pass", "lambda", "with", "as", "in", "of", "is",
  "not", "and", "or", "fn", "pub", "mut", "impl", "struct", "use", "crate", "func", "package", "go", "defer", "int",
  "require", "module", "exports", "console", "log", "typeof", "instanceof", "delete", "get", "set", "res", "req",
]);

/** Splits camelCase, PascalCase, snake_case, kebab-case and dotted names into lowercase words. */
export function splitIdentifier(id: string): string[] {
  return id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 0);
}

/** Very light stemming: enough for login/logins, test/tests, add/added. */
export function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length > 5 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
  else if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) w = w.slice(0, -1);
  return w;
}

/** Content words of free text (task titles, criteria, questions), stemmed and de-duplicated. */
export function keywords(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.split(/[^A-Za-z0-9_$.-]+/)) {
    for (const w of splitIdentifier(raw)) {
      if (w.length < 2 || ENGLISH_STOPWORDS.has(w) || /^\d+$/.test(w)) continue;
      out.add(stem(w));
    }
  }
  return [...out];
}

/** Meaningful tokens of a workspace path: directory names and the file stem. */
export function pathTokens(rel: string): { dirs: string[]; base: string[] } {
  const segs = rel.split("/");
  const file = segs.pop() ?? "";
  const stemPart = file.replace(/\.[^.]+$/, "");
  const clean = (words: string[]) =>
    words.filter((w) => w.length >= 2 && !GENERIC_PATH_TOKENS.has(w) && !ENGLISH_STOPWORDS.has(w)).map(stem);
  return { dirs: clean(segs.flatMap(splitIdentifier)), base: clean(splitIdentifier(stemPart)) };
}

const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/** Identifier words in code lines, minus language keywords. Returns word → count. */
export function codeTokens(lines: Iterable<string>, maxWords = 400): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    for (const m of line.matchAll(IDENT_RE)) {
      if (CODE_KEYWORDS.has(m[0])) continue;
      for (const w of splitIdentifier(m[0])) {
        if (w.length < 3 || CODE_KEYWORDS.has(w) || ENGLISH_STOPWORDS.has(w)) continue;
        const s = stem(w);
        counts.set(s, (counts.get(s) ?? 0) + 1);
        if (counts.size >= maxWords) return counts;
      }
    }
  }
  return counts;
}

/** 1 for equal stems, 0.7 when one is a ≥4-char prefix of the other (auth ~ authentication). */
export function tokenMatch(a: string, b: string): number {
  if (a === b) return 1;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= 4 && long.startsWith(short)) return 0.7;
  return 0;
}

export function isStopword(word: string): boolean {
  return ENGLISH_STOPWORDS.has(word.toLowerCase());
}
