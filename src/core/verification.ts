// Verification runner: runs ONE project-configured check command, only when the
// user clicks Verify. The command text is exactly what the user configured and
// saw; nothing from repository content or model output is interpolated into it.
import { spawn } from "node:child_process";
import { newId } from "../shared/events.js";
import type { CheckCommand, VerificationRun } from "../shared/schemas.js";

export const OUTPUT_TAIL_BYTES = 4096;
const BUFFER_CAP = 64 * 1024;

export interface RunCheckOptions {
  projectId: string;
  cwd: string;
  check: CheckCommand;
  taskIds: string[];
  runId?: string;
  onStart?: (run: VerificationRun) => void;
}

export function runCheck(opts: RunCheckOptions): Promise<VerificationRun> {
  const { check } = opts;
  const startedAt = new Date();
  const base: VerificationRun = {
    id: opts.runId ?? newId("run"),
    projectId: opts.projectId,
    taskIds: opts.taskIds,
    checkCommandId: check.id,
    command: check.command,
    startedAt: startedAt.toISOString(),
    exitCode: null,
    outputTail: "",
    result: "error",
  };
  opts.onStart?.(base);

  return new Promise((resolve) => {
    let buf = "";
    let timedOut = false;
    let settled = false;
    const append = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      if (buf.length > BUFFER_CAP) buf = buf.slice(-BUFFER_CAP);
    };
    const finish = (exitCode: number | null, result: VerificationRun["result"], extra = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const finishedAt = new Date();
      const out = (buf + extra).slice(-OUTPUT_TAIL_BYTES);
      resolve({ ...base, finishedAt: finishedAt.toISOString(), durationMs: finishedAt.getTime() - startedAt.getTime(), exitCode, outputTail: out, result });
    };

    let child: ReturnType<typeof spawn>;
    try {
      // shell: true so user-configured commands like "npm test -- auth" work on every OS (npm.cmd on Windows).
      child = spawn(check.command, { cwd: opts.cwd, shell: true, detached: process.platform !== "win32", env: { ...process.env, CI: "1", FORCE_COLOR: "0" } });
    } catch (e) {
      return finish(null, "error", `\n[companion] failed to start: ${e instanceof Error ? e.message : e}`);
    }
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, check.timeoutMs);
    child.on("error", (e) => finish(null, "error", `\n[companion] ${e.message}`));
    child.on("close", (code) => {
      if (timedOut) return finish(code, "timeout", `\n[companion] timed out after ${check.timeoutMs}ms`);
      finish(code, code === 0 ? "pass" : "fail");
    });
  });
}

function killTree(child: ReturnType<typeof spawn>): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}
