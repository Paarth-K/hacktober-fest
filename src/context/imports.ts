/** Direct, relative imports only — resolved against files the observer already knows. */

export interface ImportRef {
  specifier: string;
  /** Local names bound by the import (default, named, namespace). Empty when unknown. */
  names: string[];
}

const JS_FROM = /(?:import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"'\n]+)["']/g;
const JS_BARE = /(?:^|[^.\w$])(?:require|import)\s*\(\s*["']([^"'\n]+)["']\s*\)/g;
const PY_FROM = /^\s*from\s+(\.+[\w.]*|[\w.]+)\s+import\s+\(?([^)\n]+)\)?/gm;
const RS_MOD = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*;/gm;

export function extractImports(rel: string, text: string): ImportRef[] {
  const ext = rel.slice(rel.lastIndexOf(".") + 1).toLowerCase();
  const out: ImportRef[] = [];
  if (["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "vue", "svelte"].includes(ext)) {
    for (const m of text.matchAll(JS_FROM)) out.push({ specifier: m[3]!, names: parseJsBindings(m[2]!) });
    for (const m of text.matchAll(JS_BARE)) out.push({ specifier: m[1]!, names: [] });
  } else if (ext === "py" || ext === "pyi") {
    for (const m of text.matchAll(PY_FROM)) {
      const names = m[2]!
        .split(",")
        .map((s) => s.trim().split(/\s+as\s+/)[0]!.trim())
        .filter((s) => /^[A-Za-z_]\w*$/.test(s));
      out.push({ specifier: m[1]!, names });
    }
  } else if (ext === "rs") {
    for (const m of text.matchAll(RS_MOD)) out.push({ specifier: `mod:${m[1]!}`, names: [] });
  }
  return out;
}

function parseJsBindings(clause: string): string[] {
  const names: string[] = [];
  const braces = /\{([^}]*)\}/.exec(clause);
  if (braces) {
    for (const part of braces[1]!.split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.push(name);
    }
  }
  const outside = clause.replace(/\{[^}]*\}/, "").replace(/\*\s+as\s+[A-Za-z_$][\w$]*/, "");
  const def = /^\s*([A-Za-z_$][\w$]*)\s*,?/.exec(outside);
  if (def && def[1] !== "type") names.push(def[1]!);
  return names;
}

const JS_CANDIDATE_SUFFIXES = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", "/index.ts", "/index.tsx", "/index.js", "/index.jsx"];

/**
 * Resolves a relative import from `fromRel` to a known workspace path, or null.
 * Package imports (react, zod, …) are never resolved: they are outside the workspace view.
 */
export function resolveImport(fromRel: string, specifier: string, known: (rel: string) => string | null): string | null {
  const dir = fromRel.includes("/") ? fromRel.slice(0, fromRel.lastIndexOf("/")) : "";
  if (specifier.startsWith("mod:")) {
    const name = specifier.slice(4);
    const base = fromRel.endsWith("/mod.rs") || fromRel.endsWith("/lib.rs") || fromRel.endsWith("/main.rs") || !fromRel.includes("/")
      ? dir
      : fromRel.slice(0, -3);
    return firstKnown([`${joinRel(base, name)}.rs`, `${joinRel(base, name)}/mod.rs`], known);
  }
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const target = joinRel(dir, specifier);
    if (target === null) return null;
    const candidates = JS_CANDIDATE_SUFFIXES.map((s) => target + s);
    // TS ESM style: `./x.js` written for a `./x.ts` source.
    if (/\.(m|c)?js$/.test(target)) candidates.push(target.replace(/\.(m|c)?js$/, ".ts"), target.replace(/\.(m|c)?js$/, ".tsx"));
    return firstKnown(candidates, known);
  }
  if (/^\.+/.test(specifier)) {
    // Python relative import: one dot = this package, each extra dot = one level up.
    const dots = /^\.+/.exec(specifier)![0].length;
    let base: string | null = dir;
    for (let i = 1; i < dots && base !== null; i++) base = joinRel(base, "..");
    if (base === null) return null;
    const mod = specifier.slice(dots).replace(/\./g, "/");
    const target = mod ? joinRel(base, mod) : base;
    if (target === null) return null;
    return firstKnown([`${target}.py`, `${target}/__init__.py`], known);
  }
  if (/^[A-Za-z_][\w.]*$/.test(specifier) && !specifier.includes("/")) {
    // Python absolute import of a workspace package (`from app.auth import login`).
    const target = specifier.replace(/\./g, "/");
    return firstKnown([`${target}.py`, `${target}/__init__.py`, `src/${target}.py`], known);
  }
  return null;
}

function firstKnown(candidates: string[], known: (rel: string) => string | null): string | null {
  for (const c of candidates) {
    const hit = known(c);
    if (hit) return hit;
  }
  return null;
}

/** POSIX join that resolves `.`/`..`; null if it climbs above the workspace root. */
export function joinRel(base: string, rel: string): string | null {
  const parts = base ? base.split("/") : [];
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}
