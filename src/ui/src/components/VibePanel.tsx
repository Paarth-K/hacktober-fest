import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeBatch, CheckCommand, ClientMessage, CodingAgentId, CodingAgentInfo, Task, VerificationRun, VibeHistoryItem, VibeSession } from "../../../shared/index.js";

interface Props {
  vibe: VibeSession | null;
  agents: CodingAgentInfo[];
  rootPath: string;
  changeBatches: ChangeBatch[];
  checks: CheckCommand[];
  verificationRuns: VerificationRun[];
  verifying: boolean;
  history: VibeHistoryItem[];
  tasks: Task[];
  onChangeFolder: () => void;
  onShowProgress: () => void;
  onSend: (message: ClientMessage) => void;
  onOpenFile: (path: string, line?: number) => void;
  onNotice: (text: string) => void;
}

const BUSY: Partial<Record<VibeSession["phase"], string>> = {
  clarifying: "Gemma is reading your prompt…",
  refining: "Gemma is writing the refined prompt…",
  reporting: "Gemma is writing the change report…",
};

export function VibePanel({ vibe, agents, rootPath, changeBatches, checks, verificationRuns, verifying, history, tasks, onChangeFolder, onShowProgress, onSend, onOpenFile, onNotice }: Props) {
  const firstAvailable = agents.find((a) => a.available)?.id ?? "claude";
  const [agent, setAgent] = useState<CodingAgentId>(firstAvailable);
  const [prompt, setPrompt] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [refined, setRefined] = useState("");
  const [allowCommands, setAllowCommands] = useState(false);
  const [review, setReview] = useState(false);
  useEffect(() => { if (vibe) setAllowCommands(vibe.allowCommands); }, [vibe?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const task = vibe?.taskId ? tasks.find((t) => t.id === vibe.taskId) : undefined;
  const folder = <div className="vibe-folder"><span className="muted small" title={rootPath}>📁 {rootPath.split(/[\\/]/).filter(Boolean).at(-1)}</span>{(!vibe || !["running", "reporting", "clarifying", "refining"].includes(vibe.phase)) && <button className="text-button small" onClick={onChangeFolder}>Change folder</button>}</div>;

  useEffect(() => { if (!agents.find((a) => a.id === agent)?.available) setAgent(firstAvailable); }, [agents]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setAnswers(vibe?.answers ?? {}); }, [vibe?.id, vibe?.phase === "awaiting_answers"]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (vibe?.refinedPrompt !== undefined) setRefined(vibe.refinedPrompt); }, [vibe?.id, vibe?.refinedPrompt]);

  const agentInfo = agents.find((a) => a.id === (vibe?.agent ?? agent));
  const phase = vibe?.phase;

  // ---------- new prompt ----------
  if (!vibe) {
    return (
      <section className="panel vibe">
        {folder}
        <div className="section-title"><div><span className="eyebrow">Build</span><h2>What do you want to change?</h2></div></div>
        <textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && prompt.trim()) onSend({ type: "vibe_start", payload: { prompt: prompt.trim(), agent, review, allowCommands, level: "beginner" } }); }} placeholder="e.g. “change the theme to dark mode”. Gemma asks only if something important is unclear, then prompts the agent." />
        <AgentPicker agents={agents} value={agent} onChange={setAgent} />
        <label className="toggle"><input type="checkbox" checked={review} onChange={(e) => setReview(e.target.checked)} /><span>Review Gemma's prompt before the agent runs</span></label>
        <label className="toggle"><input type="checkbox" checked={allowCommands} onChange={(e) => setAllowCommands(e.target.checked)} /><span>Let the agent run shell commands (tests, installs) without asking</span></label>
        {allowCommands && <p className="notice error static small">The agent will run commands in this folder on its own. Only enable this for code you trust.</p>}
        <button disabled={!prompt.trim() || !agents.some((a) => a.available)} onClick={() => onSend({ type: "vibe_start", payload: { prompt: prompt.trim(), agent, review, allowCommands, level: "beginner" } })}>Send to Gemma ⌘↵</button>
        <p className="muted small">{review ? "Gemma refines the prompt and waits for you to click Run." : `Gemma refines the prompt, then ${agents.find((a) => a.id === agent)?.name ?? agent} starts editing right away. You can stop it at any time.`}</p>
        <History items={history} busy={false} onOpen={(id) => onSend({ type: "vibe_open", payload: { vibeId: id } })} />
      </section>
    );
  }

  return (
    <section className="panel vibe">
      {folder}
      <div className="section-title">
        <div><span className="eyebrow">Build · {phaseLabel(vibe)}</span><h2 className="vibe-prompt-title">{vibe.originalPrompt}</h2></div>
        {!["running", "reporting"].includes(vibe.phase) && <button className="secondary" onClick={() => { setPrompt(""); onSend({ type: "vibe_reset", payload: {} }); }}>New</button>}
      </div>

      {vibe.gemma && <div className="model-line"><span className={`mode ${vibe.gemma.mode === "real" ? "real" : "mock"}`}>{vibe.gemma.mode === "real" ? "gemma" : "template"}</span><span>{vibe.gemma.mode === "real" ? vibe.gemma.model : `No model — ${vibe.gemma.detail ?? "fallback"}`}</span></div>}

      {task && <button className="vibe-task" onClick={onShowProgress} title="Open in Progress">Tracking: <strong>{task.title}</strong> · {statusText(task.status)} · {task.acceptanceCriteria.filter((c) => c.met).length}/{task.acceptanceCriteria.length} criteria</button>}
      {BUSY[vibe.phase] && <div className="vibe-busy"><span className="spinner" />{vibe.phase === "clarifying" && vibe.clarifyRounds > 0 ? "Gemma is checking your answers…" : BUSY[vibe.phase]}</div>}

      {phase === "awaiting_answers" && (
        <div className="vibe-questions">
          <p><strong>{vibe.clarifyRounds > 1 ? "One more thing." : "Gemma needs a bit more detail."}</strong> <span className="muted">{vibe.vaguenessReason}</span></p>
          {vibe.questions.filter((q) => !vibe.answers[q.id]?.trim()).map((q) => (
            <label key={q.id} className="vibe-question">
              <span>{q.question}</span>
              {q.why && <small className="muted">{q.why}</small>}
              {q.options && q.options.length > 0 && (
                <span className="chips">{q.options.map((o) => <button type="button" key={o} className={`chip ${answers[q.id] === o ? "active" : ""}`} onClick={() => setAnswers((a) => ({ ...a, [q.id]: o }))}>{o}</button>)}</span>
              )}
              <input value={answers[q.id] ?? ""} onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))} placeholder="Your answer" />
            </label>
          ))}
          {vibe.questions.some((q) => vibe.answers[q.id]?.trim()) && <details><summary>Already answered ({vibe.questions.filter((q) => vibe.answers[q.id]?.trim()).length})</summary><ul>{vibe.questions.filter((q) => vibe.answers[q.id]?.trim()).map((q) => <li key={q.id}>{q.question} <strong>{vibe.answers[q.id]}</strong></li>)}</ul></details>}
          <div className="row">
            <button onClick={() => onSend({ type: "vibe_answer", payload: { vibeId: vibe.id, answers } })} disabled={!Object.values(answers).some((v) => v.trim())}>Refine prompt</button>
            <button className="secondary" onClick={() => onSend({ type: "vibe_skip_questions", payload: { vibeId: vibe.id } })}>Skip — let Gemma assume</button>
          </div>
        </div>
      )}

      {(phase === "ready" || ((phase === "done" || phase === "failed" || phase === "cancelled" || phase === "running" || phase === "reporting") && vibe.refinedPrompt)) && (
        <div className="vibe-ready">
          {phase === "ready" && vibe.vague === false && <p className="muted small">Gemma found the prompt clear enough: {vibe.vaguenessReason}</p>}
          <span className="eyebrow">Refined prompt {phase === "ready" ? "(edit before running)" : "sent to the agent"}</span>
          {phase === "ready" ? <textarea rows={9} value={refined} onChange={(e) => setRefined(e.target.value)} /> : <details><summary>Prompt Gemma sent to {agentInfo?.name ?? vibe.agent}</summary><p className="small pre">{vibe.refinedPrompt}</p></details>}
          {vibe.assumptions.length > 0 && <details open={phase === "ready"}><summary>Assumptions ({vibe.assumptions.length})</summary><ul>{vibe.assumptions.map((a) => <li key={a}>{a}</li>)}</ul></details>}
          {phase === "ready" && (
            <>
              <AgentPicker agents={agents} value={agent} onChange={setAgent} />
              <label className="toggle">
                <input type="checkbox" checked={allowCommands} onChange={(e) => setAllowCommands(e.target.checked)} />
                <span>Let the agent run shell commands (tests, installs) without asking</span>
              </label>
              {allowCommands && <p className="notice error static small">The agent will run commands in {rootPath} on its own. Only enable this for code you trust.</p>}
              <p className="muted small">{agent === "claude" ? (allowCommands ? "Edits files and runs commands in the workspace. .env/key files are blocked." : "Edits files in the workspace. Shell commands are denied — use Run tests on the report instead. .env/key files are blocked.") : agents.find((a) => a.id === agent)?.detail} Runs in {rootPath}.</p>
              <div className="row">
                <button disabled={!refined.trim() || !agents.find((a) => a.id === agent)?.available} onClick={() => onSend({ type: "vibe_run", payload: { vibeId: vibe.id, prompt: refined.trim(), agent, allowCommands } })}>Run with {agents.find((a) => a.id === agent)?.name ?? agent}</button>
                <button className="secondary" onClick={() => onSend({ type: "vibe_cancel", payload: { vibeId: vibe.id } })}>Cancel</button>
              </div>
            </>
          )}
        </div>
      )}

      {(phase === "running" || phase === "reporting" || vibe.run) && <RunLog vibe={vibe} agentName={agentInfo?.name ?? vibe.agent} changeBatches={changeBatches} onCancel={() => onSend({ type: "vibe_cancel", payload: { vibeId: vibe.id } })} />}

      {vibe.report && <Verify vibe={vibe} checks={checks} runs={verificationRuns} verifying={verifying} onVerify={(command) => onSend({ type: "vibe_verify", payload: { vibeId: vibe.id, command } })} />}
      {vibe.report && <Report vibe={vibe} onOpenFile={onOpenFile} onNotice={onNotice} onRegenerate={() => onSend({ type: "vibe_regenerate_report", payload: { vibeId: vibe.id } })} onRerun={() => onSend({ type: "vibe_run", payload: { vibeId: vibe.id, prompt: refined.trim() || vibe.refinedPrompt || vibe.originalPrompt, agent: vibe.agent, allowCommands: vibe.run?.allowCommands ?? false } })} />}

      {vibe.error && <p className="notice error static">{vibe.error}</p>}
      {phase === "cancelled" && !vibe.run && <p className="muted">Cancelled. Click New to start another prompt.</p>}
    </section>
  );
}

function AgentPicker({ agents, value, onChange }: { agents: CodingAgentInfo[]; value: CodingAgentId; onChange: (a: CodingAgentId) => void }) {
  if (agents.length === 0) return <p className="muted small">Detecting coding agents…</p>;
  return (
    <div className="agent-picker" role="radiogroup" aria-label="Coding agent">
      {agents.map((a) => (
        <button key={a.id} type="button" role="radio" aria-checked={value === a.id} disabled={!a.available} className={`chip ${value === a.id ? "active" : ""}`} title={a.available ? `${a.name} ${a.version ?? ""}` : a.detail} onClick={() => onChange(a.id)}>
          {a.name}{a.available ? "" : " (not installed)"}
        </button>
      ))}
    </div>
  );
}

function RunLog({ vibe, agentName, changeBatches, onCancel }: { vibe: VibeSession; agentName: string; changeBatches: ChangeBatch[]; onCancel: () => void }) {
  const [now, setNow] = useState(Date.now());
  const logRef = useRef<HTMLDivElement>(null);
  const running = vibe.phase === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  useEffect(() => { logRef.current?.scrollTo(0, logRef.current.scrollHeight); }, [vibe.events.length]);
  const files = useMemo(() => {
    const ids = new Set(vibe.changeBatchIds);
    const m = new Map<string, string>();
    for (const b of changeBatches) if (ids.has(b.id)) for (const c of b.changes) m.set(c.path, c.kind);
    return [...m];
  }, [vibe.changeBatchIds, changeBatches]);
  const started = vibe.run ? Date.parse(vibe.run.startedAt) : now;
  const secs = Math.round(((vibe.run?.durationMs ?? (running ? now - started : 0)) / 1000));
  const events = vibe.events.filter((e) => e.kind !== "text" || running).slice(-40);
  return (
    <div className="vibe-run">
      <div className="row space">
        <span><strong>{agentName}</strong> · {running ? "working" : vibe.run?.outcome} · {secs}s</span>
        {running && <button className="danger-button" onClick={onCancel}>Stop</button>}
      </div>
      {files.length > 0 && <div className="vibe-live-files">{files.map(([p, k]) => <span key={p} className={`file-pill ${k}`}>{k === "create" ? "+" : k === "delete" ? "−" : "~"} {p}</span>)}</div>}
      {(running || events.length > 0) && <details open={running}><summary>Agent activity ({vibe.events.length})</summary><div className="vibe-log" ref={logRef}>{events.map((e, i) => <div key={i} className={`log-line ${e.kind}`}>{e.kind === "tool" ? "▸ " : e.kind === "stderr" ? "! " : ""}{e.text}</div>)}</div></details>}
    </div>
  );
}

function Report({ vibe, onOpenFile, onNotice, onRegenerate, onRerun }: { vibe: VibeSession; onOpenFile: (p: string, l?: number) => void; onNotice: (t: string) => void; onRegenerate: () => void; onRerun: () => void }) {
  const r = vibe.report!;
  const firstLine = (path: string) => r.citations.find((c) => c.path === path)?.startLine;
  return (
    <div className="vibe-report">
      <div className="row space">
        <span className="eyebrow">What changed</span>
        <span className={`mode ${r.source.mode === "real" ? "real" : "mock"}`} title={r.source.detail}>{r.source.mode === "real" ? `gemma · ${r.source.model ?? ""}` : "template"}</span>
      </div>
      <p className="vibe-summary">{r.summary}</p>
      <ul className="vibe-files">
        {r.changes.map((c) => (
          <li key={c.path}>
            <button className="file-link" disabled={c.kind === "delete"} onClick={() => onOpenFile(c.path, firstLine(c.path))}>{c.path}</button>
            <span className={`kind ${c.kind}`}>{c.kind}</span><span className="muted small"> +{c.added}/−{c.removed}</span>
            {c.what && <div className="small">{c.what}</div>}
          </li>
        ))}
      </ul>
      <List title="Addressed" items={r.addressed} cls="ok" />
      <List title="Not visible in the diffs" items={r.notAddressed} cls="warn" />
      <List title="Risks" items={r.risks} cls="warn" />
      <List title="Tradeoffs" items={r.tradeoffs} />
      <List title="Next steps" items={r.nextSteps} />
      {r.invalidCitations.length > 0 && <p className="muted small">{r.invalidCitations.length} unsupported reference(s) from the model were discarded.</p>}
      {vibe.run?.finalMessage && <details><summary>Agent's own summary (a claim, not evidence)</summary><p className="small pre">{vibe.run.finalMessage}</p></details>}
      <p className="muted small">Based only on file changes observed during the run. A report is not verification — run your tests.</p>
      <div className="row">
        <button onClick={() => void navigator.clipboard.writeText(r.markdown).then(() => onNotice("Report copied to clipboard."))}>Copy report</button>
        <button className="secondary" onClick={onRegenerate}>Regenerate</button>
        <button className="secondary" onClick={onRerun}>Run again</button>
      </div>
    </div>
  );
}

function Verify({ vibe, checks, runs, verifying, onVerify }: { vibe: VibeSession; checks: CheckCommand[]; runs: VerificationRun[]; verifying: boolean; onVerify: (command: string) => void }) {
  const commands = [...new Set([...(vibe.suggestedCheck ? [vibe.suggestedCheck] : []), ...checks.map((c) => c.command)])];
  const [custom, setCustom] = useState("");
  const mine = runs.filter((r) => vibe.verificationRunIds.includes(r.id));
  return (
    <div className="vibe-verify">
      <span className="eyebrow">Verify (runs only when you click)</span>
      <div className="row">
        {commands.map((c) => <button key={c} className={mine.length ? "secondary" : ""} disabled={verifying} onClick={() => onVerify(c)}>Run <code>{c}</code></button>)}
      </div>
      <div className="row">
        <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder={commands.length ? "or another command…" : "Test command, e.g. npm test"} />
        <button className="secondary" disabled={!custom.trim() || verifying} onClick={() => onVerify(custom.trim())}>Run</button>
      </div>
      {verifying && <div className="vibe-busy"><span className="spinner" />Running…</div>}
      {mine.map((r) => (
        <details key={r.id} className={`run-result ${r.result}`} open={r === mine.at(-1)}>
          <summary><strong>{r.result.toUpperCase()}</strong> <code>{r.command}</code> · exit {r.exitCode ?? "—"} · {Math.round((r.durationMs ?? 0) / 100) / 10}s</summary>
          <pre>{r.outputTail.slice(-1500)}</pre>
        </details>
      ))}
      {!mine.length && !verifying && <p className="muted small">Not verified yet. The agent's changes have not been tested by you.</p>}
    </div>
  );
}

function History({ items, busy, onOpen }: { items: VibeHistoryItem[]; busy: boolean; onOpen: (id: string) => void }) {
  if (!items.length) return null;
  return (
    <details className="vibe-history">
      <summary>History ({items.length})</summary>
      <ul>
        {items.map((h) => (
          <li key={h.id}>
            <button className="text-button" disabled={busy} onClick={() => onOpen(h.id)}>{h.originalPrompt}</button>
            <span className="muted small"> · {new Date(h.createdAt).toLocaleString()} · {h.agent} · {h.phase}{h.filesChanged ? ` · ${h.filesChanged} files` : ""}{h.verified !== "none" ? ` · tests ${h.verified}` : ""}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function List({ title, items, cls }: { title: string; items: string[]; cls?: string }) {
  if (!items.length) return null;
  return <div className={`vibe-list ${cls ?? ""}`}><strong>{title}</strong><ul>{items.map((x) => <li key={x}>{x}</li>)}</ul></div>;
}

function statusText(s: Task["status"]): string {
  return { not_started: "not started", activity_detected: "changes made, not verified", needs_verification: "needs verification", verified_complete: "verified", user_confirmed: "confirmed by you" }[s];
}

function phaseLabel(v: VibeSession): string {
  switch (v.phase) {
    case "clarifying": return "reading prompt";
    case "awaiting_answers": return "questions";
    case "refining": return "refining";
    case "ready": return "review";
    case "running": return "agent running";
    case "reporting": return "writing report";
    case "done": return "done";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
  }
}
