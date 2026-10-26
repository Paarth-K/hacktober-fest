// Terminal UI. One input router for the whole app; panes follow the work (Ask -> Progress -> Learn).
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ClientMessage, CodingAgentId, Level, ServerEnvelope, VibePhase } from "../shared/index.js";
import type { ConnectionState } from "../shared/wsClient.js";
import { applyEngineEvent, initialUiState } from "../ui/src/lib/state.js";
import { BUSY_PHASES, LEVELS, LEVEL_LABEL, PANES, PANE_LABEL, autoPane, basename, friendlyError, paneForPhase, type Pane } from "./format.js";
import { AskPane, ChangesList, LearnPane, ProgressPane } from "./panes.js";
import { ScrollArea, ScrollHint } from "./ScrollArea.js";
import { TextBox } from "./TextBox.js";

/** The bits of EngineClient the UI uses (a fake implements this in tests). */
export interface EngineLike {
  send(message: ClientMessage): string;
  onAny(handler: (e: ServerEnvelope) => void): () => void;
  onState(handler: (s: ConnectionState) => void): () => void;
}

export interface Settings {
  agent: CodingAgentId;
  autoPermissions: boolean;
}

export function App({ client, agent = "claude", autoPermissions = true, onQuit }: { client: EngineLike; agent?: CodingAgentId; autoPermissions?: boolean; onQuit?: () => void }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [ui, setUi] = useState(initialUiState);
  const [conn, setConn] = useState<ConnectionState>("connecting");
  const [pane, setPane] = useState<Pane>("ask");
  const [drafts, setDrafts] = useState<Record<"ask" | "learn", string>>({ ask: "", learn: "" });
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState(0);
  const [toast, setToast] = useState("");
  const [now, setNow] = useState(Date.now());
  const [scroll, setScroll] = useState(0);
  const [contentH, setContentH] = useState(0);
  const prevPhase = useRef<{ id?: string; phase?: VibePhase }>({});
  // Each launch is a fresh session: the Changes list only shows changes made since the app opened.
  const [sessionStart] = useState(() => new Date(Date.now() - 1000).toISOString());
  const resetSent = useRef(false);

  useEffect(() => {
    const offs = [
      client.onState((s) => {
        setConn(s);
        if (s === "open" && !resetSent.current) {
          resetSent.current = true;
          try {
            client.send({ type: "vibe_reset", payload: {} });
          } catch {
            /* engine will send a snapshot anyway */
          }
        }
      }),
      client.onAny((e) => {
        if (e.type === "error") setToast(friendlyError(e.payload.message));
        setUi((s) => applyEngineEvent(s, e));
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [client]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const vibe = ui.vibe;
  const busy = !!vibe && BUSY_PHASES.includes(vibe.phase);
  const level: Level = vibe?.level ?? ui.preferences.level;
  const task = vibe?.taskId ? ui.tasks.find((t) => t.id === vibe.taskId) : undefined;
  // This launch's changes, newest first, with live phases (several can run at once).
  const history = useMemo(() => {
    const byId = new Map(ui.vibeHistory.filter((h) => h.createdAt >= sessionStart).map((h) => [h.id, h]));
    for (const x of Object.values(ui.sessions)) {
      if (x.createdAt < sessionStart) continue;
      const prev = byId.get(x.id);
      byId.set(x.id, { id: x.id, createdAt: x.createdAt, originalPrompt: x.originalPrompt, agent: x.agent, phase: x.phase, filesChanged: x.report?.changes.length ?? prev?.filesChanged ?? 0, verified: prev?.verified ?? "none" });
    }
    return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [ui.sessions, ui.vibeHistory, sessionStart]);
  const runningCount = history.filter((h) => h.phase === "running").length;
  const thinking = vibe ? ui.thinking[vibe.id] ?? "" : "";

  // Follow the work: switch panes on meaningful phase transitions of the current change.
  useEffect(() => {
    if (!vibe) return void (prevPhase.current = {});
    const prev = prevPhase.current.id === vibe.id ? prevPhase.current.phase : undefined;
    if (prevPhase.current.id !== vibe.id) {
      setAnswers({});
      setSelected(Math.max(0, history.findIndex((h) => h.id === vibe.id) + 1));
      if (prev === undefined && prevPhase.current.id !== undefined) setPane(paneForPhase(vibe.phase));
    }
    setScroll(0);
    const next = autoPane(prev, vibe.phase);
    if (next) setPane(next);
    prevPhase.current = { id: vibe.id, phase: vibe.phase };
  }, [vibe?.id, vibe?.phase]); // eslint-disable-line react-hooks/exhaustive-deps


  const send = (m: ClientMessage) => {
    try {
      client.send(m);
    } catch (e) {
      setToast(e instanceof Error && /not connected/.test(e.message) ? "Lost connection to the helper. Reconnecting…" : String(e));
    }
  };
  const start = (prompt: string) => {
    send({ type: "vibe_start", payload: { prompt, agent, review: false, allowCommands: autoPermissions, level: ui.preferences.level } });
  };

  // Unanswered clarifying questions, one at a time.
  const pendingQs = vibe?.phase === "awaiting_answers" ? vibe.questions.filter((q) => !vibe.answers[q.id]?.trim()) : [];
  const qIndex = pendingQs.findIndex((q) => !answers[q.id]);
  const question = qIndex >= 0 ? pendingQs[qIndex]! : null;
  const answer = (text: string) => {
    if (!vibe || !question) return;
    const next = { ...answers, [question.id]: text };
    setAnswers(next);
    if (pendingQs.every((q) => next[q.id])) send({ type: "vibe_answer", payload: { vibeId: vibe.id, answers: next } });
  };

  const setLevel = (l: Level) => {
    if (l === level) return;
    send({ type: "preferences_changed", payload: { level: l } });
    if (vibe?.report && !busy) send({ type: "vibe_regenerate_report", payload: { vibeId: vibe.id, level: l } });
    setToast(`Explanations will be written for: ${LEVEL_LABEL[l]}`);
  };

  const openChange = (index: number) => {
    setSelected(index);
    if (index === 0) {
      send({ type: "vibe_reset", payload: {} });
      setPane("ask");
      return;
    }
    const item = history[index - 1];
    if (item && item.id !== vibe?.id) {
      send({ type: "vibe_open", payload: { vibeId: item.id } });
      setPane(paneForPhase(item.phase));
    }
  };

  // Layout: everything fits the terminal; the pane content scrolls, the text box stays at the bottom.
  const term = (stdout as unknown as NodeJS.WriteStream | undefined) ?? process.stdout;
  const cols = term.columns ?? 100;
  const rows = term.rows ?? 30;
  const wide = cols >= 90;
  const showBox = pane === "ask" || (pane === "learn" && !!vibe?.report);
  const mainH = Math.max(10, rows - 1 /* header */ - 1 /* footer */ - (toast ? 1 : 0));
  const areaH = Math.max(3, mainH - 2 /* border */ - 2 /* tabs */ - 1 /* scroll hint */ - (showBox ? 3 : 0));

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onQuit?.();
      return exit();
    }
    if (key.ctrl && input === "n") return openChange(0);
    if (key.tab) {
      const i = PANES.indexOf(pane);
      setScroll(0);
      return setPane(PANES[(i + (key.shift ? PANES.length - 1 : 1)) % PANES.length]!);
    }
    if (key.pageDown || key.pageUp) {
      const step = Math.max(3, Math.floor(areaH / 2));
      return setScroll((v) => Math.max(0, Math.min(Math.max(0, contentH - areaH), v + (key.pageDown ? step : -step))));
    }
    if (key.upArrow || key.downArrow) return openChange(Math.max(0, Math.min(history.length, selected + (key.upArrow ? -1 : 1))));
    if (key.escape) {
      if (vibe && (vibe.phase === "running" || vibe.phase === "clarifying" || vibe.phase === "refining" || vibe.phase === "awaiting_answers")) {
        send({ type: "vibe_cancel", payload: { vibeId: vibe.id } });
        return setToast(vibe.phase === "running" ? "Stopping this change… I'll still explain whatever it changed." : "Cancelled this change.");
      }
      return setDrafts((d) => ({ ...d, [pane === "learn" ? "learn" : "ask"]: "" }));
    }

    const box: "ask" | "learn" | null = pane === "ask" ? "ask" : pane === "learn" ? "learn" : null;
    if (!box) {
      // Progress pane: single-key actions.
      if ((input === "t" || input === "T") && vibe?.phase === "done" && vibe.suggestedCheck) {
        send({ type: "vibe_verify", payload: { vibeId: vibe.id, command: vibe.suggestedCheck } });
        setToast(`Checking: running ${vibe.suggestedCheck}…`);
      }
      return;
    }
    const draft = drafts[box];

    // Shortcuts only when the box is empty.
    if (!draft && /^[1-9]$/.test(input)) {
      const n = Number(input);
      if (box === "ask" && question?.options?.[n - 1]) return answer(question.options[n - 1]!);
      if (box === "learn" && LEVELS[n - 1]) return setLevel(LEVELS[n - 1]!);
    }
    if (key.return) {
      const text = draft.trim();
      if (!text) return;
      setDrafts((d) => ({ ...d, [box]: "" }));
      if (box === "ask") {
        if (question) return answer(text);
        // Starts in parallel with anything already running; Gemma keeps the agents out of each other's way.
        setToast("");
        if (runningCount > 0) setToast(`Starting alongside ${runningCount} running change${runningCount > 1 ? "s" : ""}. ↑↓ to switch between them.`);
        return start(text);
      }
      if (!vibe?.run) return setToast("Ask questions here after Claude has made a change.");
      return send({ type: "vibe_ask", payload: { vibeId: vibe.id, question: text } });
    }
    if (key.backspace || key.delete) return setDrafts((d) => ({ ...d, [box]: d[box].slice(0, -1) }));
    if (key.ctrl || key.meta || key.leftArrow || key.rightArrow) return;
    if (input) setDrafts((d) => ({ ...d, [box]: d[box] + input.replace(/[\r\n]+/g, " ") }));
  });


  const listWidth = Math.min(34, Math.max(26, Math.floor(cols * 0.28)));
  const claude = ui.codingAgents.find((a) => a.id === agent);
  const folder = ui.project ? basename(ui.project.rootPath) : "…";

  return (
    <Box flexDirection="column" width={cols}>
      <Box justifyContent="space-between" paddingX={1}>
        <Text>
          <Text color="cyan" bold>◆ Companion</Text>
          <Text dimColor>{"  ·  "}</Text>
          <Text bold>{folder}</Text>
        </Text>
        <Text>
          {conn !== "open" ? <Text color="yellow">connecting…</Text> : claude && !claude.available ? <Text color="red">Claude Code not set up</Text> : <Text color="green">● ready</Text>}
        </Text>
      </Box>
      <Box height={mainH}>
        {wide && <ChangesList items={history} currentId={vibe?.id ?? null} selected={selected} width={listWidth} height={mainH} />}
        <Box flexDirection="column" flexGrow={1} height={mainH} borderStyle="round" borderColor="cyan" paddingX={1}>
          <Box gap={2} marginBottom={1}>
            {PANES.map((p) => (
              <Text key={p} color={p === pane ? "cyan" : "gray"} bold={p === pane} underline={p === pane}>{PANE_LABEL[p]}</Text>
            ))}
            {!wide && history.length > 0 && <Text dimColor>{`· change ${Math.max(1, selected)} of ${history.length}`}</Text>}
          </Box>
          <ScrollArea height={areaH} scroll={scroll} onContentHeight={setContentH}>
            {pane === "ask" && <AskPane vibe={vibe} question={question} questionNumber={qIndex + 1} questionCount={pendingQs.length} thinking={thinking} />}
            {pane === "progress" && <ProgressPane vibe={vibe} task={task} changeBatches={ui.changeBatches} runs={ui.verificationRuns} now={now} />}
            {pane === "learn" && <LearnPane vibe={vibe} level={level} thinking={thinking} />}
          </ScrollArea>
          <ScrollHint above={scroll > 0} below={contentH - scroll > areaH} />
          {showBox && (
            <TextBox
              active
              value={pane === "ask" ? drafts.ask : drafts.learn}
              placeholder={pane === "learn" ? "Ask anything about this change" : question ? (question.options?.length ? "Press a number, or type your own answer" : "Type your answer") : vibe ? "e.g. make the buttons bigger" : "e.g. change the theme to dark mode"}
            />
          )}
        </Box>
      </Box>
      {toast && <Box paddingX={1}><Text color="yellow" wrap="wrap">{toast}</Text></Box>}
      <Box paddingX={1}>
        <Text dimColor wrap="truncate-end">{hints(pane, vibe?.phase, busy)}</Text>
      </Box>
    </Box>
  );
}

function hints(pane: Pane, phase: VibePhase | undefined, busy: boolean): string {
  const nav = "Ctrl+N new change · Tab switch view · ↑↓ changes · Ctrl+C quit";
  if (phase === "running") return `Esc stop this change · ${nav}`;
  if (pane === "ask") return phase === "awaiting_answers" ? `Enter answer · Esc cancel · ${nav}` : busy ? `Enter start another change · Esc cancel this one · ${nav}` : `Enter send · ${nav}`;
  if (pane === "learn") return `1-3 explanation level · Enter ask a question · ${nav}`;
  if (pane === "progress" && phase === "done") return `T check it works · ${nav}`;
  return busy ? `Esc stop · ${nav}` : nav;
}
