import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCheck } from "../src/core/verification.js";

const cwd = mkdtempSync(join(tmpdir(), "lcc-verify-"));
const node = JSON.stringify(process.execPath);

describe("verification runner (real processes)", () => {
  it("records a passing command", async () => {
    const r = await runCheck({ projectId: "p", cwd, taskIds: [], check: { id: "c", label: "ok", command: `${node} -e "console.log('all good')"`, timeoutMs: 10000 } });
    expect(r).toMatchObject({ result: "pass", exitCode: 0 });
    expect(r.outputTail).toContain("all good");
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("records a failing command", async () => {
    const r = await runCheck({ projectId: "p", cwd, taskIds: [], check: { id: "c", label: "bad", command: `${node} -e "console.error('boom'); process.exit(3)"`, timeoutMs: 10000 } });
    expect(r).toMatchObject({ result: "fail", exitCode: 3 });
    expect(r.outputTail).toContain("boom");
  });

  it("times out", async () => {
    const r = await runCheck({ projectId: "p", cwd, taskIds: [], check: { id: "c", label: "slow", command: `${node} -e "setTimeout(()=>{}, 60000)"`, timeoutMs: 500 } });
    expect(r.result).toBe("timeout");
  });

  it("caps output", async () => {
    const r = await runCheck({ projectId: "p", cwd, taskIds: [], check: { id: "c", label: "loud", command: `${node} -e "process.stdout.write('x'.repeat(200000))"`, timeoutMs: 10000 } });
    expect(r.outputTail.length).toBeLessThanOrEqual(4096);
  });
});
