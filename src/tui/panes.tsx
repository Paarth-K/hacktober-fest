import { Box, Text } from "ink";
import type { ChangeBatch, ClarifyQuestion, Level, Task, VerificationRun, VibeHistoryItem, VibeSession } from "../shared/index.js";
import {
  BUSY_PHASES,
  LEVEL_LABEL,
  LEVELS,
  basename,
  changeTitle,
  currentActivity,
  elapsed,
  phaseIcon,
  phaseWords,
  steps,
  timeAgo,
  truncate,
} from "./format.js";
import { Spinner } from "./Spinner.js";

// ---------- Changes list ----------

export function ChangesList({ items, currentId, selected, width, height }: { items: VibeHistoryItem[]; currentId: string | null; selected: number; width: number; height: number }) {
  const room = Math.max(1, height - 4);
  const first = Math.max(0, Math.min(selected - 1 - Math.floor(room / 2), items.length - room));
  return (
    <Box flexDirection="column" width={width} height={height} flexShrink={0} borderStyle="round" borderColor="gray" paddingX={1} overflow="hidden">
      <Text bold>Changes</Text>
      <Text color={selected === 0 ? "cyan" : undefined} inverse={selected === 0}> + New change </Text>
      {items.length === 0 && <Text dimColor>Nothing yet</Text>}
      {items.slice(first, first + room).map((h, j) => {
        const i = first + j;
        const sel = selected === i + 1;
        const cur = h.id === currentId;
        return (
          <Box key={h.id} flexDirection="column">
            <Text color={sel ? "cyan" : cur ? "white" : "gray"} inverse={sel} wrap="truncate-end">
              {` ${phaseIcon(h.phase, h.verified)} ${truncate(h.originalPrompt, width - 7)} `}
            </Text>
            {sel && <Text dimColor wrap="truncate-end">{`   ${phaseWords(h.phase)} · ${timeAgo(h.createdAt)}`}</Text>}
          </Box>
        );
      })}
    </Box>
  );
}

// ---------- Ask ----------

export function AskPane(props: {
  vibe: VibeSession | null;
  question: ClarifyQuestion | null;
  questionNumber: number;
  questionCount: number;
  thinking?: string;
}) {
  const { vibe, question } = props;
  if (vibe && (vibe.phase === "clarifying" || vibe.phase === "refining")) {
    return (
      <Box flexDirection="column" gap={1}>
        <Request vibe={vibe} />
        <Box gap={1}>
          <Spinner />
          <Text>{vibe.phase === "clarifying" ? (vibe.clarifyRounds > 0 ? "Checking your answers…" : "Gemma is reading your request…") : "Writing clear instructions for Claude…"}</Text>
        </Box>
        <ThinkingView text={props.thinking} />
      </Box>
    );
  }
  if (vibe?.phase === "awaiting_answers" && question) {
    return (
      <Box flexDirection="column" gap={1}>
        <Request vibe={vibe} />
        <Box flexDirection="column">
          <Text color="yellow" bold>{props.questionCount > 1 ? `Quick question ${props.questionNumber} of ${props.questionCount}` : "Quick question"}</Text>
          <Text bold wrap="wrap">{question.question}</Text>
          {question.why && <Text dimColor wrap="wrap">{question.why}</Text>}
        </Box>
        {question.options && question.options.length > 0 && (
          <Box flexDirection="column">
            {question.options.map((o, i) => (
              <Text key={o} wrap="wrap"><Text color="cyan" bold>{` ${i + 1} `}</Text> {o}</Text>
            ))}
          </Box>
        )}
      </Box>
    );
  }
  const busy = !!vibe && BUSY_PHASES.includes(vibe.phase);
  return (
    <Box flexDirection="column" gap={1}>
      {vibe?.error && vibe.phase !== "running" && <Text color="red" wrap="wrap">{vibe.error}</Text>}
      {!vibe ? (
        <Box flexDirection="column">
          <Text bold>What would you like to change?</Text>
          <Text dimColor>Describe it in your own words. Gemma will ask if anything is unclear, then Claude makes the change.</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Request vibe={vibe} />
          <Text dimColor>{busy ? "This change is still going. Type another request to run it at the same time." : "Want something else? Describe the next change."}</Text>
        </Box>
      )}
    </Box>
  );
}

function Request({ vibe }: { vibe: VibeSession }) {
  return (
    <Box flexDirection="column">
      <Text dimColor>You asked</Text>
      <Text wrap="wrap">“{truncate(vibe.originalPrompt, 400)}”</Text>
    </Box>
  );
}

// ---------- Progress ----------

export function ProgressPane({ vibe, task, changeBatches, runs, now }: { vibe: VibeSession | null; task?: Task; changeBatches: ChangeBatch[]; runs: VerificationRun[]; now: number }) {
  if (!vibe) return <Empty text="Nothing is happening yet. Describe a change in Ask." />;
  const files = filesFor(vibe, changeBatches);
  void task;
  const lastRun = runs.filter((r) => vibe.verificationRunIds.includes(r.id)).at(-1);
  return (
    <Box flexDirection="column" gap={1}>
      <Request vibe={vibe} />
      <Box flexDirection="column">
        {steps(vibe).map((s) => (
          <Box key={s.label} flexDirection="column">
            <Box gap={1}>
              {s.state === "active" ? <Spinner /> : <Text color={s.state === "done" ? "green" : s.state === "failed" ? "red" : "gray"}>{s.state === "done" ? "✔" : s.state === "failed" ? "✖" : "○"}</Text>}
              <Text color={s.state === "todo" ? "gray" : undefined} bold={s.state === "active"}>{s.label}</Text>
              {s.state === "active" && vibe.phase === "running" && vibe.run && <Text dimColor>{elapsed(vibe.run.startedAt, now)}</Text>}
            </Box>
            {s.state === "active" && vibe.phase === "running" && <Text color="cyan">{`    ${currentActivity(vibe)}…`}</Text>}
          </Box>
        ))}
      </Box>
      {files.length > 0 && (
        <Box flexDirection="column">
          <Text bold>{`Files changed (${files.length})`}</Text>
          {files.slice(0, 8).map(([p, k]) => (
            <Text key={p} wrap="truncate-end">
              <Text color={k === "create" ? "green" : k === "delete" ? "red" : "yellow"}>{`  ${k === "create" ? "+" : k === "delete" ? "−" : "~"} `}</Text>
              {basename(p)}
              <Text dimColor>{`  ${k === "create" ? "new" : k === "delete" ? "removed" : "edited"}`}</Text>
            </Text>
          ))}
          {files.length > 8 && <Text dimColor>{`  and ${files.length - 8} more`}</Text>}
        </Box>
      )}
      {vibe.criteria.length > 0 && (
        <Box flexDirection="column">
          <Text bold>Done when</Text>
          {vibe.criteria.map((c, i) => {
            const st = vibe.report?.criteriaStatus[i];
            const state = st ? (st.met ? "met" : "not") : vibe.phase === "running" || vibe.phase === "reporting" ? "pending" : "unknown";
            return (
              <Text key={c} wrap="wrap" color={state === "met" ? "green" : state === "not" ? "yellow" : "gray"}>
                {`  ${state === "met" ? "✔" : state === "not" ? "✖" : "○"} ${c}`}
                {st?.why ? <Text dimColor>{` — ${st.why}`}</Text> : null}
              </Text>
            );
          })}
          {vibe.suggestedCheck && (
            <Text color={!lastRun ? "gray" : lastRun.result === "pass" ? "green" : "red"}>{`  ${!lastRun ? "○" : lastRun.result === "pass" ? "✔" : "✖"} Tests pass (${vibe.suggestedCheck})`}</Text>
          )}
          {vibe.report && <Text dimColor>✔/✖ checked by Gemma against the actual changes.</Text>}
        </Box>
      )}
      {vibe.phase === "done" && vibe.suggestedCheck && <Text dimColor>{`Press T to check that everything still works (runs ${vibe.suggestedCheck}).`}</Text>}
      {vibe.phase === "failed" && vibe.error && <Text color="red" wrap="wrap">{vibe.error}</Text>}
    </Box>
  );
}

export function filesFor(vibe: VibeSession, batches: ChangeBatch[]): [string, string][] {
  if (vibe.report && vibe.phase !== "running") return vibe.report.changes.map((c) => [c.path, c.kind]);
  const ids = new Set(vibe.changeBatchIds);
  const m = new Map<string, string>();
  for (const b of batches) if (ids.has(b.id)) for (const c of b.changes) m.set(c.path, m.get(c.path) === "create" && c.kind !== "delete" ? "create" : c.kind);
  return [...m];
}

// ---------- Learn ----------

export function LearnPane({ vibe, level, thinking }: { vibe: VibeSession | null; level: Level; thinking?: string }) {
  if (!vibe) return <Empty text="After Claude makes a change, you'll see a simple explanation of it here." />;
  const levelBar = (
    <Box gap={1}>
      <Text dimColor>Explain it for:</Text>
      {LEVELS.map((l, i) => (
        <Text key={l} color={l === level ? "cyan" : "gray"} inverse={l === level}>{` ${i + 1} ${LEVEL_LABEL[l]} `}</Text>
      ))}
    </Box>
  );
  if (!vibe.report) {
    return (
      <Box flexDirection="column" gap={1}>
        {levelBar}
        {vibe.phase === "reporting" ? (
          <Box flexDirection="column">
            <Box gap={1}><Spinner /><Text>Writing an explanation of the changes…</Text></Box>
            <ThinkingView text={thinking} />
          </Box>
        ) : (
          <Text dimColor>The explanation appears here once Claude has finished.</Text>
        )}
      </Box>
    );
  }
  const r = vibe.report;
  const rewriting = vibe.phase === "reporting";
  // Beginners see plain cautions only; "not done" items appear for everyone, phrased in their own request's terms.
  const notes = [...r.notAddressed.map((n) => `Not done yet: ${n}`), ...r.risks].slice(0, level === "beginner" ? 2 : 3);
  return (
    <Box flexDirection="column" gap={1}>
      {levelBar}
      {rewriting && <Box gap={1}><Spinner /><Text>{`Rewriting for “${LEVEL_LABEL[level]}”…`}</Text></Box>}
      {(rewriting || vibe.qa.some((x) => x.pending)) && <ThinkingView text={thinking} />}
      {r.source.mode !== "real" && <Text color="yellow">Gemma wasn't available, so this is a basic summary. Start Ollama for a real explanation.</Text>}
      <Box flexDirection="column">
        <Text bold color="cyan">What happened</Text>
        <Text wrap="wrap">{r.summary}</Text>
      </Box>
      {r.changes.length > 0 && (
        <Box flexDirection="column">
          <Text bold color="cyan">File by file</Text>
          {r.changes.slice(0, 6).map((c) => (
            <Text key={c.path} wrap="wrap">
              <Text bold>{`• ${basename(c.path)}`}</Text>
              <Text>{c.what ? ` — ${c.what}` : ` (${c.kind === "create" ? "new" : c.kind === "delete" ? "removed" : "edited"})`}</Text>
            </Text>
          ))}
          {r.changes.length > 6 && <Text dimColor>{`  and ${r.changes.length - 6} more files`}</Text>}
        </Box>
      )}
      {notes.length > 0 && (
        <Box flexDirection="column">
          <Text bold color="yellow">Good to know</Text>
          {notes.map((n) => <Text key={n} wrap="wrap">{`• ${n}`}</Text>)}
        </Box>
      )}
      {vibe.qa.slice(-3).map((x) => (
        <Box key={x.at + x.question} flexDirection="column">
          <Text color="cyan" wrap="wrap">{`You: ${x.question}`}</Text>
          {x.pending ? <Box gap={1}><Spinner /><Text dimColor>Gemma is looking at the changes…</Text></Box> : <Text wrap="wrap">{x.answer}</Text>}
        </Box>
      ))}
    </Box>
  );
}

/** Gemma's live reasoning (last few lines), shown while it works. */
export function ThinkingView({ text }: { text?: string }) {
  if (!text?.trim()) return null;
  const lines = text.trim().split(/\n+/).slice(-4).map((l) => truncate(l, 200));
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" borderTop={false} borderRight={false} borderBottom={false} paddingLeft={1}>
      <Text dimColor italic>Gemma is thinking…</Text>
      {lines.map((l, i) => <Text key={i} dimColor wrap="wrap">{l}</Text>)}
    </Box>
  );
}

function Empty({ text }: { text: string }) {
  return <Text dimColor wrap="wrap">{text}</Text>;
}

export { changeTitle };
