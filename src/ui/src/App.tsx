import { useEffect, useMemo, useRef, useState } from "react";
import { EngineClient, type ConnectionState } from "../../shared/wsClient.js";
import type { ClientMessage, Preferences, ServerEnvelope } from "../../shared/index.js";
import { resolveEngineConnection } from "../lib/engineConnection.js";
import { BreakdownPanel } from "./components/BreakdownPanel.js";
import { LearningPanel } from "./components/LearningPanel.js";
import { ProgressHeader } from "./components/ProgressHeader.js";
import { TaskList } from "./components/TaskList.js";
import { VerifyPanel } from "./components/VerifyPanel.js";
import { applyEngineEvent, initialUiState } from "./lib/state.js";
import { openWorkspaceFile, pickWorkspace, setCompact, setPinned } from "./lib/tauri.js";

type UiConnection = ConnectionState | "no-engine";

export function App() {
  const [state, setState] = useState(initialUiState);
  const [connection, setConnection] = useState<UiConnection>("connecting");
  const [notice, setNotice] = useState("Connecting to the local engine…");
  const [invalidMessage, setInvalidMessage] = useState("");
  const [activeTab, setActiveTab] = useState<"progress" | "learn">("progress");
  const [report, setReport] = useState("");
  const clientRef = useRef<EngineClient | null>(null);
  const stateRef = useRef(state);

  useEffect(() => { stateRef.current = state; }, [state]);

  useEffect(() => {
    let disposed = false;
    let client: EngineClient | null = null;

    void resolveEngineConnection().then((engineConnection) => {
      if (disposed) return;
      if (!engineConnection) {
        setConnection("no-engine");
        setNotice("Engine unavailable. Start with npm run dev:mock or npm run dev.");
        return;
      }
      client = new EngineClient(engineConnection, {
        onInvalidMessage: (_raw, error) => setInvalidMessage(error instanceof Error ? error.message : "Engine event failed schema validation"),
      });
      clientRef.current = client;
      client.onState((next) => {
        setConnection(next);
        if (next === "open") {
          setNotice("");
          try { client?.send({ type: "request_snapshot", payload: {} }); } catch { /* initial snapshot is already sent */ }
        }
      });
      client.onAny((event) => handleServerEvent(event));
      client.connect();
    });

    const handleServerEvent = (event: ServerEnvelope) => {
      if (event.type === "report_ready") {
        setReport(event.payload.markdown);
        setNotice(event.payload.savedPath ? `Report saved to ${event.payload.savedPath}` : "Report ready to copy.");
      } else if (event.type === "explanation_error") {
        setNotice(`Explanation unavailable: ${event.payload.error}`);
      } else if (event.type === "error") {
        setNotice(`${event.payload.code}: ${event.payload.message}`);
      } else if (event.type === "open_file_result") {
        if (!event.payload.ok) {
          setNotice(event.payload.error ?? `Could not open ${event.payload.path}`);
        } else {
          const current = stateRef.current;
          if (current.project) {
            void openWorkspaceFile(current.project.rootPath, event.payload.path, event.payload.line ?? 1, current.preferences.editorCommand)
              .catch((error) => setNotice(`Could not launch editor: ${String(error)}`));
          }
        }
      }
      setState((current) => applyEngineEvent(current, event));
    };

    return () => {
      disposed = true;
      client?.close();
      clientRef.current = null;
    };
  }, []);

  useEffect(() => { document.documentElement.dataset.theme = state.preferences.theme; }, [state.preferences.theme]);

  const send = (message: ClientMessage) => {
    if (message.type === "select_task") setState((current) => ({ ...current, selectedTaskId: message.payload.taskId }));
    try {
      clientRef.current?.send(message);
      if (!clientRef.current || connection !== "open") setNotice("Engine is disconnected; request was not sent.");
    } catch (error) {
      setNotice(`Request could not be sent: ${String(error)}`);
    }
  };

  const updatePreferences = (next: Partial<Preferences>) => {
    setState((current) => ({ ...current, preferences: { ...current.preferences, ...next } }));
    send({ type: "preferences_changed", payload: next });
  };

  const togglePin = async () => {
    const alwaysOnTop = !state.preferences.alwaysOnTop;
    try {
      await setPinned(alwaysOnTop);
      updatePreferences({ alwaysOnTop });
      send({ type: "window_mode_changed", payload: { compact: state.preferences.compact, alwaysOnTop } });
    } catch (error) { setNotice(`Could not update window pin: ${String(error)}`); }
  };

  const toggleCompact = async (compact = !state.preferences.compact) => {
    try {
      await setCompact(compact);
      updatePreferences({ compact });
      send({ type: "window_mode_changed", payload: { compact, alwaysOnTop: state.preferences.alwaysOnTop } });
    } catch (error) { setNotice(`Could not change window mode: ${String(error)}`); }
  };

  const chooseWorkspace = async () => {
    const rootPath = await pickWorkspace();
    if (!rootPath) {
      if (!("__TAURI_INTERNALS__" in window)) setNotice("Workspace selection is available in the Tauri app.");
      return;
    }
    send({ type: "set_project", payload: { rootPath, ...(state.project?.goal ? { goal: state.project.goal } : {}) } });
    setNotice(`Workspace selected: ${rootPath}. Waiting for engine snapshot.`);
  };

  const requestBreakdown = (promptText: string) => {
    const goal = state.project?.goal.trim();
    if (!goal) return setNotice("Set a project goal before requesting a breakdown.");
    send({ type: "request_breakdown", payload: { goal, ...(promptText.trim() ? { promptText: promptText.trim() } : {}) } });
  };

  const selectedTask = state.tasks.find((task) => task.id === state.selectedTaskId)
    ?? state.tasks.find((task) => task.status === "activity_detected" || task.status === "needs_verification");
  const selectedBatchIds = selectedTask?.linkedChangeBatchIds.length
    ? selectedTask.linkedChangeBatchIds
    : state.changeBatches.at(-1)?.id ? [state.changeBatches.at(-1)!.id] : [];

  const requestExplanation = (wantQuiz: boolean) => {
    if (selectedBatchIds.length === 0) return setNotice("No observed change evidence is available to explain.");
    send({ type: "request_explanation", payload: { ...(selectedTask ? { taskId: selectedTask.id } : {}), changeBatchIds: selectedBatchIds, level: state.preferences.level, wantQuiz } });
  };

  const askFollowup = (question: string) => {
    send({ type: "ask_followup", payload: { question, ...(selectedTask ? { taskId: selectedTask.id } : {}), changeBatchIds: selectedBatchIds, level: state.preferences.level, wantQuiz: false } });
  };

  const attentionIds = useMemo(() => new Set([
    ...(state.progress?.unverifiedActivityTaskIds ?? []),
    ...(state.progress?.stalledTaskIds ?? []),
    ...(state.progress?.regressedTaskIds ?? []),
  ]), [state.progress]);
  const runningCheckIds = useMemo(() => new Set(Object.values(state.runningVerificationChecks)), [state.runningVerificationChecks]);
  const connectionClass = connection === "open" ? "connected" : connection;

  if (state.preferences.compact) {
    return <main className="app compact-app"><ProgressHeader project={state.project} progress={state.progress} tasks={state.tasks} compact onExpand={() => void toggleCompact(false)} /></main>;
  }

  return (
    <main className="app">
      <header className="topbar">
        <div className="brand"><span className="brand-dot" /><span>Companion</span></div>
        <div className="window-actions">
          <button className={`icon-button ${state.preferences.alwaysOnTop ? "active" : ""}`} onClick={() => void togglePin()} aria-pressed={state.preferences.alwaysOnTop} title="Keep window on top">⌖</button>
          <button className="icon-button" onClick={() => void toggleCompact(true)} title="Compact mode">—</button>
          <button className="icon-button" onClick={() => document.querySelector<HTMLDialogElement>("#preferences")?.showModal()} title="Preferences">⚙</button>
        </div>
      </header>

      <div className={`connection-banner ${connectionClass}`} role="status"><span />{connection === "open" ? `Local engine connected${state.engine.mock ? " · mock" : ""}` : connection === "reconnecting" ? "Engine disconnected — reconnecting" : connection === "connecting" ? "Connecting to local engine" : "Engine disconnected"}</div>
      {notice && <button className="notice" onClick={() => setNotice("")}>{notice}<span>×</span></button>}
      {invalidMessage && <button className="notice error" onClick={() => setInvalidMessage("")}>Invalid engine message ignored: {invalidMessage}<span>×</span></button>}

      <ProgressHeader project={state.project} progress={state.progress} tasks={state.tasks} compact={false} onExpand={() => undefined} />
      <nav className="tabs" aria-label="Companion sections"><button className={activeTab === "progress" ? "active" : ""} onClick={() => setActiveTab("progress")}>Progress</button><button className={activeTab === "learn" ? "active" : ""} onClick={() => setActiveTab("learn")}>Learn</button></nav>

      <div className="content">
        {!state.project ? <section className="panel empty-state"><div className="empty-icon">⌂</div><h2>Choose your workspace</h2><p>Pick a local project and set a goal to begin tracking evidence.</p><button onClick={() => void chooseWorkspace()}>Choose folder</button></section> : activeTab === "progress" ? <>
          <section className="goal-card"><div><span className="eyebrow">Project goal</span><p>{state.project.goal}</p><small>{state.project.rootPath}</small></div><button className="secondary" onClick={() => void chooseWorkspace()}>Change</button></section>
          {attentionIds.size > 0 && <section className="attention-strip"><strong>{attentionIds.size} task{attentionIds.size === 1 ? "" : "s"} need attention</strong><span>Activity, stall, or regression needs verification.</span></section>}
          <TaskList project={state.project} tasks={state.tasks} changes={state.changeBatches} verifications={state.verificationRuns} attentionIds={attentionIds} onSend={send} onOpenFile={(path, line) => send({ type: "open_file", payload: { path, line } })} />
          <VerifyPanel project={state.project} runs={state.verificationRuns} runningCheckIds={runningCheckIds} onRun={(checkCommandId) => send({ type: "run_verification", payload: { checkCommandId, taskIds: state.selectedTaskId ? [state.selectedTaskId] : [] } })} />
          <BreakdownPanel suggestion={state.breakdown} onRequest={requestBreakdown} onAccept={(suggestion) => send({ type: "accept_breakdown", payload: { requestId: suggestion.requestId, tasks: suggestion.tasks } })} />
          <section className="panel report-panel"><div><span className="eyebrow">Honest handoff</span><h2>Progress report</h2><p className="muted">Done, active, unverified, untouched, and failing checks stay separate.</p></div><div className="report-actions"><button onClick={() => send({ type: "export_report", payload: { saveToWorkspace: false } })}>Preview report</button><button className="secondary" onClick={() => send({ type: "export_report", payload: { saveToWorkspace: true } })}>Save to workspace</button></div>{report && <div className="report-preview"><pre>{report}</pre><button onClick={() => void navigator.clipboard.writeText(report).then(() => setNotice("Report copied to clipboard."))}>Copy Markdown</button></div>}</section>
        </> : <LearningPanel explanation={state.explanation} modelStatus={state.modelStatus} level={state.preferences.level} onLevel={(level) => updatePreferences({ level })} onRequest={requestExplanation} onQuestion={askFollowup} onOpenFile={(path, line) => send({ type: "open_file", payload: { path, line } })} />}
      </div>

      <dialog id="preferences" className="preferences-dialog"><form method="dialog"><div className="section-title"><h2>Preferences</h2><button className="icon-button" value="cancel">×</button></div><label>Theme<select value={state.preferences.theme} onChange={(event) => updatePreferences({ theme: event.target.value as Preferences["theme"] })}><option value="system">Follow system</option><option value="light">Light</option><option value="dark">Dark</option></select></label><label>Editor command<input value={state.preferences.editorCommand} onChange={(event) => updatePreferences({ editorCommand: event.target.value })} placeholder="code -g {file}:{line}" /></label><p className="muted">The engine and Rust shell both validate opened paths stay inside the selected workspace.</p><button value="default">Done</button></form></dialog>
    </main>
  );
}
