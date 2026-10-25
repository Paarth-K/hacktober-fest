import { useState } from "react";
import type { TaskBreakdownSuggestion } from "../../../shared/index.js";

export function BreakdownPanel({ suggestion, onRequest, onAccept }: { suggestion: TaskBreakdownSuggestion | null; onRequest: (promptText: string) => void; onAccept: (suggestion: TaskBreakdownSuggestion) => void }) {
  const [prompt, setPrompt] = useState("");
  return <section className="panel"><div className="section-title"><div><span className="eyebrow">Plan</span><h2>Break down a coding prompt</h2></div></div><textarea rows={3} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Paste the prompt you gave your coding agent…" /><button onClick={() => onRequest(prompt)} disabled={!prompt.trim()}>Suggest tasks</button>{suggestion && <div className="suggestion-review"><div className="model-line"><span className={`mode ${suggestion.mode}`}>{suggestion.mode}</span><span>{suggestion.provider}</span></div><p className="muted">Review these suggestions. They do not count until accepted.</p>{suggestion.tasks.map((task, index) => <div className="suggested-task" key={`${task.title}-${index}`}><strong>{task.title}</strong>{task.acceptanceCriteria.map((criterion) => <small key={criterion}>□ {criterion}</small>)}</div>)}<button onClick={() => onAccept(suggestion)}>Accept reviewed tasks</button></div>}</section>;
}
