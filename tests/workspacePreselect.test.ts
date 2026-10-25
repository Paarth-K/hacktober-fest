import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startEngine } from "../src/engine/main.js";

describe("LCC_WORKSPACE / EngineOptions.workspace", () => {
  it("preselects the workspace and starts the observer, keeping the goal empty for the user to type", async () => {
    const ws = mkdtempSync(join(tmpdir(), "lcc-pre-ws-"));
    writeFileSync(join(ws, "a.js"), "export const a = 1;\n");
    const engine = await startEngine({ dataDir: mkdtempSync(join(tmpdir(), "lcc-pre-data-")), quiet: true, modelProvider: "mock", workspace: ws });
    try {
      const s = engine.orchestrator.snapshot();
      expect(s.project?.rootPath).toBe(ws);
      expect(s.project?.goal).toBe("");
      expect(s.engine.observerRunning).toBe(true);
    } finally {
      await engine.stop();
    }
  });
});
