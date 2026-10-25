// OWNED BY P2 (feature/code-observer). M0 placeholder from P4 so the engine compiles:
// replace freely, but keep exporting `createObserver(): Observer` (see src/shared/interfaces.ts).
import type { ChangeBatch, ContextPacket, Observer, ObserverStartOptions, SuggestedTaskLink, Task } from "../shared/index.js";

export function createObserver(): Observer {
  let opts: ObserverStartOptions | null = null;
  const batches = new Map<string, ChangeBatch>();
  const packet = (ids: string[]): ContextPacket => {
    const bs = ids.map((id) => batches.get(id)).filter((b): b is ChangeBatch => !!b);
    return {
      changeBatchIds: ids,
      excerpts: [],
      diffs: bs.flatMap((b) => b.changes.map((c) => ({ path: c.path, kind: c.kind, hunks: c.hunks }))),
      evidence: bs.flatMap((b) => b.evidence),
      omissions: bs.flatMap((b) => b.omissions),
      missing: ["placeholder observer: no file context retrieval"],
      totalChars: 0,
      truncated: false,
    };
  };
  return {
    async start(o) {
      opts = o;
    },
    async stop() {
      opts = null;
    },
    isRunning: () => opts !== null,
    replayFixture(batch) {
      batches.set(batch.id, batch);
      opts?.onBatch(batch);
    },
    async getContext(ids) {
      return packet(ids);
    },
    async retrieveForQuestion(_q, ids) {
      return packet(ids);
    },
    suggestTasks(_batch: ChangeBatch, _tasks: Task[]): SuggestedTaskLink[] {
      return [];
    },
  };
}
