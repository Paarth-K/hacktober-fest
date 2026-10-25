import { createHash } from "node:crypto";
import { pathKey } from "./paths.js";

export type SnapshotKind = "text" | "binary" | "large";

/** Last known state of one workspace file. Content is kept only for text under the memory cap. */
export interface Snapshot {
  path: string;
  kind: SnapshotKind;
  /** sha1 of normalized text (text) or raw bytes (binary); null when the file was not read. */
  hash: string | null;
  content: string | null;
  /** size:mtime signature, used for files too large to hash on every change. */
  sig?: string;
}

/** Read access to file text for context building. Paths are safe workspace-relative paths. */
export interface ContentSource {
  read(rel: string): Promise<string | null>;
  paths(): string[];
}

export class SnapshotStore implements ContentSource {
  private readonly map = new Map<string, Snapshot>();
  private contentChars = 0;

  constructor(
    private readonly caseInsensitive: boolean,
    private readonly maxContentChars: number,
  ) {}

  get size(): number {
    return this.map.size;
  }

  get retainedChars(): number {
    return this.contentChars;
  }

  get(rel: string): Snapshot | undefined {
    return this.map.get(pathKey(rel, this.caseInsensitive));
  }

  set(snap: Snapshot): void {
    this.delete(snap.path);
    let content = snap.content;
    if (content !== null) {
      if (this.contentChars + content.length > this.maxContentChars) content = null;
      else this.contentChars += content.length;
    }
    this.map.set(pathKey(snap.path, this.caseInsensitive), { ...snap, content });
  }

  delete(rel: string): void {
    const key = pathKey(rel, this.caseInsensitive);
    const prev = this.map.get(key);
    if (prev?.content) this.contentChars -= prev.content.length;
    this.map.delete(key);
  }

  /** Snapshots strictly inside a directory, for directory deletes. */
  entriesUnder(dirRel: string): Snapshot[] {
    const prefix = pathKey(`${dirRel}/`, this.caseInsensitive);
    const out: Snapshot[] = [];
    for (const [key, snap] of this.map) if (key.startsWith(prefix)) out.push(snap);
    return out;
  }

  paths(): string[] {
    return [...this.map.values()].map((s) => s.path);
  }

  async read(rel: string): Promise<string | null> {
    return this.get(rel)?.content ?? null;
  }
}

/** In-memory content for fixture batches, so context works without touching disk. */
export class MapContentSource implements ContentSource {
  private readonly files = new Map<string, string>();

  set(rel: string, text: string | null): void {
    if (text === null) this.files.delete(rel);
    else this.files.set(rel, text);
  }

  async read(rel: string): Promise<string | null> {
    return this.files.get(rel) ?? null;
  }

  paths(): string[] {
    return [...this.files.keys()];
  }
}

export function sha1(data: string | Uint8Array): string {
  return createHash("sha1").update(data).digest("hex");
}
