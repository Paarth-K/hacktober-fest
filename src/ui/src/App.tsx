import { useEffect, useMemo, useRef, useState } from "react";
import { BreakdownPanel } from "./components/BreakdownPanel";
import { LearningPanel } from "./components/LearningPanel";
import { ProgressHeader } from "./components/ProgressHeader";
import { TaskList } from "./components/TaskList";
import { VerifyPanel } from "./components/VerifyPanel";
import { mockState } from "./fixtures/mock-project";
import type { BreakdownSuggestion, CompanionState, IncomingEnvelope, OutgoingType, Preferences } from "./lib/contracts";
import { preferencesSchema } from "./lib/contracts";
import { EngineClient, type ConnectionStatus } from "./lib/engine-client";
import { applyEngineEvent } from "./lib/state";
import { openWorkspaceFile, pickWorkspace, setCompact, setPinned } from "./lib/tauri";

const sessionId = crypto.randomUUID();
const engineUrl = new URLSearchParams(window.location.search).get("engineUrl") ?? import.meta.env.VITE_ENGINE_URL;
const engineToken = new URLSearchParams(window.location.search).get("token") ?? import.meta.env.VITE_ENGINE_TOKEN;

function loadPreferences(): Preferences {
  try {
    const stored = localStorage.getItem("local-code-companion-preferences");
    if (stored) {
      const parsed = preferencesSchema.safeParse(JSON.parse(stored));
      if (parsed.success) return parsed.data;
    }
  } catch { /* fall back to fixture preferences */ }
  return mockState.preferences;
}

const mockBreakdown: BreakdownSuggestion = {
  provider: "DeterministicMockProvider",
  mode: "mock",
  tasks: [
    { title: "Define the visible outcome", acceptanceCriteria: ["The expected behavior is observable", "The failure state is explicit"] },
    { title: "Implement the narrow vertical slice", acceptanceCriteria: ["The core flow works end-to-end"] },
    { title: "Verify and document", acceptanceCriteria: ["A user-triggered check passes", "Known gaps are recorded"] }
  ]
};

export function App() {
  const [state, setState] = useState<CompanionState>(() => ({ ...mockState, preferences: loadPreferences() }));
  const [connection, setConnection] = useState<ConnectionStatus>(engineUrl ? "connecting" : "mock");
  const [notice, setNotice] = useState<string>(engineUrl ? "Connecting to local engine…" : "Deterministic mock data — no command or model has run.");
  const [invalidMessage, setInvalidMessage] = useState("");
  const [activeTab, setActiveTab] = useState<"progress" | "learn">("progress");
  const [report, setReport] = useState("");
  const clientRef = useRef<EngineClient | null>(null);

  useEffect(() => {
    const client = new EngineClient({
      url: engineUrl,
      token: engineToken,
      sessionId,
      onStatus: setConnection,
      onInvalidMessage: setInvalidMessage,
      onEvent: (event) => {
        if (event.type === "report_exported") setReport(event.payload.markdown);
        else if (event.type === "engine_error") setNotice(event.payload.message);
        else setState((current) => applyEngineEvent(current, event));
      }
    });
    clientRef.current = client;
    client.connect();
    return () => client.close();
  }, []);

  useEffect(() => {
    localStorage.setItem("local-code-companion-preferences", JSON.stringify(state.preferences));
    document.documentElement.dataset.theme = state.preferences.theme;
  }, [state.preferences]);

  const send = (type: OutgoingType, payload: unknown) => {
    clientRef.current?.send(type, payload);
    if (connection === "mock") setNotice(`Mock mode: ${type.replaceAll("_", " ")} request recorded; no external action ran.`);
  };

  const updatePreferences = (next: Partial<Preferences>) => {
    const preferences = { ...state.preferences, ...next };
    setState((current) => ({ ...current, preferences }));
    send("preferences_changed", preferences);
  };

  const togglePin = async () => {
    const pinned = !state.preferences.pinned;
    try { await setPinned(pinned); updatePreferences({ pinned }); }
    catch (error) { setNotice(`Could not update window pin: ${String(error)}`); }
  };

  const toggleCompact = async (value = !state.preferences.compact) => {
    try { await setCompact(value); updatePreferences({ compact: value }); send("window_mode_changed", { compact: value }); }
    catch (error) { setNotice(`Could not change window mode: ${String(error)}`); }
  };

  const openFile = async (path: string, line: number) => {
    if (!state.project) return;
    try {
      await openWorkspaceFile(state.project.rootPath, path, line, state.preferences.editorCommand);
      send("open_file", { path, line });
    } catch (error) { setNotice(`Could not open ${path}: ${String(error)}`); }
  };

  const chooseWorkspace = async () => {
    const selected = await pickWorkspace();
    if (!selected) {
      setNotice("Workspace selection is available in the Tauri app.");
      return;
    }
    send("preferences_changed", { selectedWorkspace: selected });
    setNotice(`Workspace selected: ${selected}. Waiting for engine snapshot.`);
  };

  const requestBreakdown = (promptText: string) => {
    send("request_breakdown", { goal: state.project?.goal ?? "", promptText });
    if (connection === "mock") {
      const synthetic: IncomingEnvelope = { sessionId, eventId: crypto.randomUUID(), timestamp: new Date().toISOString(), type: "breakdown_suggestion", payload: mockBreakdown };
      setState((current) => applyEngineEvent(current, synthetic));
    }
  };

  const exportReport = (destination: "copy" | "workspace") => {
    send("export_report", { projectId: state.project?.id, destination });
    if (connection === "mock") {
      setReport(`# ${state.project?.name ?? "Project"} progress\n\n**Verified:** 1 task\n\n**Unverified activity:** 2 tasks\n\n> Mock report preview. No engine evidence export ran.`);
    }
  };

  const copyReport = async () => {
    await navigator.clipboard.writeText(report);
    setNotice("Report copied to clipboard.");
  };

  const attentionIds = useMemo(() => new Set([
    ...(state.progress?.stalledTaskIds ?? []),
    ...(state.progress?.regressedTaskIds ?? []),
    ...state.tasks.filter((task) => task.status === "activity_detected").map((task) => task.id)
  ]), [state.progress, state.tasks]);

  if (state.preferences.compact) {
    return <main className="app compact-app"><ProgressHeader project={state.project} progress={state.progress} tasks={state.tasks} compact onExpand={() => toggleCompact(false)} /></main>;
  }

  return (
    <main className="app">
      <header className="topbar">
        <div className="brand"><span className="brand-dot" /><span>Companion</span></div>
        <div className="window-actions">
          <button className={`icon-button ${state.preferences.pinned ? "active" : ""}`} onClick={togglePin} aria-pressed={state.preferences.pinned} title="Keep window on top">⌖</button>
          <button className="icon-button" onClick={() => toggleCompact(true)} title="Compact mode">—</button>
          <button className="icon-button" onClick={() => document.querySelector<HTMLDialogElement>("#preferences")?.showModal()} title="Preferences">⚙</button>
        </div>
      </header>

      <div className={`connection-banner ${connection}`} role="status">
        <span />{connection === "connected" ? "Local engine connected" : connection === "mock" ? "Mock mode" : connection === "reconnecting" ? "Engine disconnected — reconnecting" : connection === "connecting" ? "Connecting to local engine" : "Engine disconnected"}
      </div>
      {notice && <button className="notice" onClick={() => setNotice("")}>{notice}<span>×</span></button>}
      {invalidMessage && <button className="notice error" onClick={() => setInvalidMessage("")}>Invalid engine message ignored: {invalidMessage}<span>×</span></button>}

      <ProgressHeader project={state.project} progress={state.progress} tasks={state.tasks} compact={false} onExpand={() => undefined} />

      <nav className="tabs" aria-label="Companion sections">
        <button className={activeTab === "progress" ? "active" : ""} onClick={() => setActiveTab("progress")}>Progress</button>
        <button className={activeTab === "learn" ? "active" : ""} onClick={() => setActiveTab("learn")}>Learn</button>
      </nav>

      <div className="content">
        {!state.project ? <section className="panel empty-state"><div className="empty-icon">⌂</div><h2>Choose your workspace</h2><p>Pick a local project and set a goal to begin tracking evidence.</p><button onClick={chooseWorkspace}>Choose folder</button></section> : activeTab === "progress" ? <>
          <section className="goal-card">
            <div><span className="eyebrow">Project goal</span><p>{state.project.goal}</p><small>{state.project.rootPath}</small></div>
            <button className="secondary" onClick={chooseWorkspace}>Change</button>
          </section>
          {(attentionIds.size > 0) && <section className="attention-strip"><strong>{attentionIds.size} task{attentionIds.size === 1 ? "" : "s"} need attention</strong><span>Activity, stall, or regression needs verification.</span></section>}
          <TaskList project={state.project} tasks={state.tasks} changes={state.changes} verifications={state.verifications} attentionIds={attentionIds} onSend={send} onOpenFile={openFile} />
          <VerifyPanel project={state.project} runs={state.verifications} onRun={(commandId) => send("run_verification", { projectId: state.project?.id, commandId })} />
          <BreakdownPanel suggestion={state.breakdown} onRequest={requestBreakdown} onAccept={(suggestion) => send("accept_breakdown", { projectId: state.project?.id, tasks: suggestion.tasks })} />
          <section className="panel report-panel"><div><span className="eyebrow">Honest handoff</span><h2>Progress report</h2><p className="muted">Done, active, unverified, untouched, and failing checks stay separate.</p></div><div className="report-actions"><button onClick={() => exportReport("copy")}>Preview report</button><button className="secondary" onClick={() => exportReport("workspace")}>Save to workspace</button></div>{report && <div className="report-preview"><pre>{report}</pre><button onClick={copyReport}>Copy Markdown</button></div>}</section>
        </> : <LearningPanel explanation={state.explanation} level={state.preferences.level} onLevel={(level) => updatePreferences({ level })} onRequest={(quiz) => send("request_explanation", { projectId: state.project?.id, level: state.preferences.level, quiz })} onQuestion={(question) => send("ask_followup", { projectId: state.project?.id, question, level: state.preferences.level })} onOpenFile={openFile} />}
      </div>

      <dialog id="preferences" className="preferences-dialog">
        <form method="dialog"><div className="section-title"><h2>Preferences</h2><button className="icon-button" value="cancel">×</button></div><label>Theme<select value={state.preferences.theme} onChange={(event) => updatePreferences({ theme: event.target.value as Preferences["theme"] })}><option value="system">Follow system</option><option value="light">Light</option><option value="dark">Dark</option></select></label><label>Editor command<input value={state.preferences.editorCommand} onChange={(event) => updatePreferences({ editorCommand: event.target.value })} placeholder="code -g" /></label><p className="muted">The Rust shell validates every opened path stays inside the selected workspace.</p><button value="default">Done</button></form>
      </dialog>
    </main>
  );
}
