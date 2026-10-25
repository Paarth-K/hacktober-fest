// Live end-to-end smoke of the vibe flow on a fresh demo workspace:
//   rough prompt -> Gemma clarify -> answers -> Gemma refine -> REAL coding agent -> observed diffs -> Gemma report.
//   npx tsx scripts/vibe-smoke.ts [--agent=claude|codex] [--prompt="..."] [--provider=auto|mock]
// Uses a temp workspace + temp data dir. Prints each phase and the final report; exits non-zero on failure.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import WebSocket from "ws";
import { startEngine } from "../src/engine/main.js";
import type { VibeSession } from "../src/shared/vibe.js";
import { EngineClient } from "../src/shared/wsClient.js";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=") ?? d;
const agent = arg("agent", "claude") as "claude" | "codex";
const prompt = arg("prompt", "add login");
const provider = arg("provider", "auto") as "auto" | "mock";

const parent = mkdtempSync(join(tmpdir(), "lcc-vibe-smoke-"));
const ws = join(parent, "demo-todo-api");
execFileSync(process.execPath, ["-e", `process.env.LCC_DEMO_DIR=${JSON.stringify(ws)};import(${JSON.stringify(new URL("./demo.mjs", import.meta.url).href)}).then(m=>m.createDemoWorkspace(true))`]);

const engine = await startEngine({ dataDir: join(parent, "data"), quiet: true, modelProvider: provider, workspace: ws });
const client = new EngineClient({ port: engine.bridge.port, token: engine.bridge.token }, { WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket });
const t0 = Date.now();
const secs = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
let latest: VibeSession | null = null;
const waiters: { pred: (s: VibeSession) => boolean; resolve: (s: VibeSession) => void }[] = [];
client.on("vibe_updated", (s) => {
  if (latest?.phase !== s.phase) console.log(`[${secs()}] phase=${s.phase}`);
  latest = s;
  for (const w of [...waiters]) if (w.pred(s)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(s));
});
client.on("vibe_agent_event", ({ event }) => {
  if (event.kind !== "text") console.log(`[${secs()}]   agent ${event.kind}: ${event.text.slice(0, 160)}`);
});
client.on("error", (e) => console.log(`[${secs()}] ENGINE ERROR ${e.code}: ${e.message}`));
const until = (pred: (s: VibeSession) => boolean, ms: number) =>
  new Promise<VibeSession>((resolve, reject) => {
    if (latest && pred(latest)) return resolve(latest);
    waiters.push({ pred, resolve });
    setTimeout(() => reject(new Error(`timeout; phase=${latest?.phase} error=${latest?.error ?? ""}`)), ms);
  });

let ok = true;
try {
  const open = new Promise<void>((r) => client.onState((st) => st === "open" && r()));
  client.connect();
  await open;
  await new Promise((r) => setTimeout(r, 1500)); // agent detection runs at engine start
  console.log(`agents: ${JSON.stringify(engine.orchestrator.vibe.agents.map((a) => [a.id, a.available, a.version]))}`);
  console.log(`[${secs()}] vibe_start agent=${agent} prompt=${JSON.stringify(prompt)}`);
  client.send({ type: "vibe_start", payload: { prompt, agent } });
  let s = await until((x) => ["awaiting_answers", "ready", "failed"].includes(x.phase), 300_000);
  console.log(`  gemma: ${JSON.stringify(s.gemma)}\n  vague=${s.vague} reason=${s.vaguenessReason}`);
  if (s.phase === "awaiting_answers") {
    const answers: Record<string, string> = {};
    for (const q of s.questions) {
      answers[q.id] = q.options?.[0] ?? "Use the simplest option that fits the existing code; username 'ada' password 'lovelace'; make test/login.test.js pass.";
      console.log(`  Q ${q.id}: ${q.question}${q.options ? ` [${q.options.join(" | ")}]` : ""}\n    -> ${answers[q.id]}`);
    }
    client.send({ type: "vibe_answer", payload: { vibeId: s.id, answers } });
    s = await until((x) => ["ready", "failed"].includes(x.phase), 300_000);
  }
  console.log(`  refined prompt (${s.gemma?.mode}):\n${s.refinedPrompt?.split("\n").map((l) => "    | " + l).join("\n")}\n  assumptions: ${JSON.stringify(s.assumptions)}`);
  client.send({ type: "vibe_run", payload: { vibeId: s.id, prompt: s.refinedPrompt!, agent, allowCommands: process.argv.includes("--allow-commands") } });
  s = await until((x) => ["done", "failed", "cancelled"].includes(x.phase) && !!x.report, 25 * 60_000);
  console.log(`  run: ${JSON.stringify({ outcome: s.run?.outcome, exit: s.run?.exitCode, ms: s.run?.durationMs, batches: s.changeBatchIds.length })}`);
  console.log(`  agent final message: ${s.run?.finalMessage?.slice(0, 400)}`);
  console.log(`  report source: ${JSON.stringify(s.report?.source)}  invalidCitations=${s.report?.invalidCitations.length}`);
  console.log("\n" + s.report?.markdown.split("## Refined prompt")[0]);
  if (s.suggestedCheck) {
    console.log(`[${secs()}] user clicks "Run ${s.suggestedCheck}" (vibe_verify)`);
    client.send({ type: "vibe_verify", payload: { vibeId: s.id, command: s.suggestedCheck } });
    s = await until((x) => x.verificationRunIds.length > 0, 300_000);
    const v = engine.orchestrator.snapshot().verificationRuns.find((r) => r.id === s.verificationRunIds.at(-1));
    console.log(`  verify: ${v?.command} -> ${v?.result} (exit ${v?.exitCode}, ${v?.durationMs}ms)`);
    console.log("  report verification section: " + (s.report?.markdown.match(/## Verification[\s\S]*?\n\n(.*)\n/)?.[1] ?? "?"));
  }
  ok = s.phase === "done" && (s.report?.changes.length ?? 0) > 0;
} catch (e) {
  ok = false;
  console.log(`FAILED: ${e instanceof Error ? e.message : e}`);
} finally {
  client.close();
  await engine.stop();
  if (!process.argv.includes("--keep")) rmSync(parent, { recursive: true, force: true });
  else console.log(`kept ${parent}`);
  console.log(ok ? "VIBE SMOKE PASS" : "VIBE SMOKE FAIL");
  process.exit(ok ? 0 : 1);
}

