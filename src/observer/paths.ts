import path from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { isSafeRelPath } from "../shared/index.js";

export { isSafeRelPath };

export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Converts an absolute path under `root` to a safe, NFC-normalized, POSIX-style
 * workspace-relative path. Returns null for the root itself or anything outside it.
 */
export function toWorkspaceRel(root: string, abs: string, pathImpl: typeof path = path): string | null {
  const rel = pathImpl.relative(root, abs);
  if (!rel || pathImpl.isAbsolute(rel)) return null;
  const posix = toPosix(rel).normalize("NFC");
  return isSafeRelPath(posix) ? posix : null;
}

/** Default case rule: Windows and macOS volumes are case-insensitive unless told otherwise. */
export function defaultCaseInsensitive(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" || platform === "darwin";
}

/** Map key for a workspace-relative path, folding case on case-insensitive filesystems. */
export function pathKey(rel: string, caseInsensitive: boolean): string {
  return caseInsensitive ? rel.toLowerCase() : rel;
}

/** Absolute OS path for a safe relative path. Throws on anything unsafe. */
export function fromWorkspaceRel(root: string, rel: string): string {
  if (!isSafeRelPath(rel)) throw new Error(`unsafe workspace path: ${JSON.stringify(rel)}`);
  const abs = path.resolve(root, ...rel.split("/"));
  if (toWorkspaceRel(root, abs) === null) throw new Error(`path escapes workspace: ${JSON.stringify(rel)}`);
  return abs;
}

export type ResolvedEntry =
  | { kind: "missing" }
  | { kind: "file"; abs: string; size: number; mtimeMs: number }
  | { kind: "dir"; abs: string }
  | { kind: "symlink"; abs: string; insideWorkspace: boolean }
  | { kind: "other"; abs: string };

/**
 * lstat a workspace path without following symlinks. Symlinks are reported, never
 * followed; `insideWorkspace` says whether the link target stays under `rootReal`.
 */
export async function inspectEntry(root: string, rootReal: string, rel: string): Promise<ResolvedEntry> {
  const abs = fromWorkspaceRel(root, rel);
  let st;
  try {
    st = await lstat(abs);
  } catch (err) {
    if (isNotFound(err)) return { kind: "missing" };
    throw err;
  }
  if (st.isSymbolicLink()) {
    let insideWorkspace = false;
    try {
      insideWorkspace = toWorkspaceRel(rootReal, await realpath(abs)) !== null;
    } catch {
      insideWorkspace = false;
    }
    return { kind: "symlink", abs, insideWorkspace };
  }
  if (st.isDirectory()) return { kind: "dir", abs };
  if (st.isFile()) return { kind: "file", abs, size: st.size, mtimeMs: st.mtimeMs };
  return { kind: "other", abs };
}

export function isNotFound(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
