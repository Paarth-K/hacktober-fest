import { useState } from "react";
import type { ChangeBatch, ClientMessage, Project, Task, VerificationRun } from "../../../shared/index.js";

const statusLabels = {
  not_started: "Not started",
  activity_detected: "Activity detected",
  needs_verification: "Needs verification",
  verified_complete: "Verified complete",
  user_confirmed: "User confirmed",
};

function lineRange(batch: ChangeBatch, path: string) {
  const evidence = batch.evidence.find((item) => item.path === path);
  if (evidence) return { start: evidence.startLine, end: evidence.endLine };
  const hunk = batch.changes.find((change) => change.path === path)?.hunks[0];
  const start = Math.max(1, hunk?.newStart ?? hunk?.oldStart ?? 1);
  const count = hunk?.newLines || hunk?.oldLines || 1;
  return { start, end: start + count - 1 };
}

export function TaskList({ project, tasks, changes, verifications, attentionIds, onSend, onOpenFile }: {
  project: Project;
  tasks: Task[];
  changes: ChangeBatch[];
  verifications: VerificationRun[];
  attentionIds: Set<string>;
  onSend: (message: ClientMessage) => void;
  onOpenFile: (path: string, line: number) => void;
}) {
  const [expanded, setExpanded] = useState(tasks[0]?.id ?? "");
  const [newTitle, setNewTitle] = useState("");
  const [titleDrafts, setTitleDrafts] = useState<Record<string, string>>({});
  const [criterionDrafts, setCriterionDrafts] = useState<Record<string, string>>({});

  const orderedTasks = [...tasks].sort((a, b) => a.order - b.order);
  const createTask = () => {
    if (!newTitle.trim()) return;
    onSend({ type: "create_task", payload: { title: newTitle.trim(), acceptanceCriteria: [] } });
    setNewTitle("");
  };

  const moveTask = (taskId: string, direction: -1 | 1) => {
    const from = orderedTasks.findIndex((task) => task.id === taskId);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= orderedTasks.length) return;
    const taskIds = orderedTasks.map((task) => task.id);
    [taskIds[from], taskIds[to]] = [taskIds[to]!, taskIds[from]!];
    onSend({ type: "reorder_tasks", payload: { taskIds } });
  };

  return (
    <section className="panel" aria-labelledby="tasks-heading">
      <div className="section-title"><div><span className="eyebrow">Checklist</span><h2 id="tasks-heading">Tasks</h2></div><span className="count-pill">{tasks.length}</span></div>
      <div className="add-row"><input value={newTitle} onChange={(event) => setNewTitle(event.target.value)} onKeyDown={(event) => event.key === "Enter" && createTask()} placeholder="Add a task" aria-label="New task title" /><button onClick={createTask}>Add</button></div>
      <div className="task-list">
        {orderedTasks.map((task, index) => {
          const taskChanges = changes.filter((batch) => batch.linkedTaskId === task.id || task.linkedChangeBatchIds.includes(batch.id) || batch.suggestedTaskLinks.some((link) => link.taskId === task.id));
          const taskRuns = verifications.filter((run) => run.taskIds.includes(task.id));
          const isExpanded = expanded === task.id;
          const titleDraft = titleDrafts[task.id] ?? task.title;
          return (
            <article className={`task-card status-${task.status}`} key={task.id}>
              <button className="task-summary" onClick={() => { setExpanded(isExpanded ? "" : task.id); onSend({ type: "select_task", payload: { taskId: task.id } }); }} aria-expanded={isExpanded}>
                <span className="status-dot" /><span className="task-copy"><strong>{task.title}</strong><small>{statusLabels[task.status]} · {task.acceptanceCriteria.filter((item) => item.met).length}/{task.acceptanceCriteria.length} criteria</small></span>{attentionIds.has(task.id) && <span className="attention" title="Needs attention">!</span>}<span className="chevron">⌄</span>
              </button>
              {isExpanded && <div className="task-details">
                <div className="edit-row"><input value={titleDraft} onChange={(event) => setTitleDrafts((current) => ({ ...current, [task.id]: event.target.value }))} aria-label={`Edit ${task.title}`} /><button className="secondary" disabled={!titleDraft.trim() || titleDraft === task.title} onClick={() => onSend({ type: "update_task", payload: { taskId: task.id, title: titleDraft.trim() } })}>Save</button></div>
                <div className="criteria-list">
                  {task.acceptanceCriteria.length === 0 && <p className="muted">No acceptance criteria yet.</p>}
                  {task.acceptanceCriteria.map((criterion) => {
                    const draft = criterionDrafts[criterion.id] ?? criterion.text;
                    return <div key={criterion.id} className="criterion"><input type="checkbox" checked={criterion.met} onChange={(event) => onSend({ type: "set_criterion_met", payload: { taskId: task.id, criterionId: criterion.id, met: event.target.checked } })} /><span><input className="criterion-text" value={draft} onChange={(event) => setCriterionDrafts((current) => ({ ...current, [criterion.id]: event.target.value }))} onBlur={() => { if (draft.trim() && draft !== criterion.text) onSend({ type: "update_task", payload: { taskId: task.id, acceptanceCriteria: task.acceptanceCriteria.map((item) => ({ id: item.id, text: item.id === criterion.id ? draft.trim() : item.text, ...(item.checkCommandId ? { checkCommandId: item.checkCommandId } : {}) })) } }); }} /><small>{criterion.met ? `Met by ${criterion.metBy}` : "Not evidenced"}</small></span></div>;
                  })}
                </div>
                {taskChanges.map((batch) => {
                  const suggestion = batch.suggestedTaskLinks.find((link) => link.taskId === task.id);
                  const linked = batch.linkedTaskId === task.id || task.linkedChangeBatchIds.includes(batch.id);
                  return <div className="evidence-block" key={batch.id}><div className="evidence-heading"><span>Change evidence</span>{suggestion && !linked && batch.linkedTaskId === undefined && <span className="suggested">Suggested {Math.round(suggestion.score * 100)}%</span>}</div>{batch.changes.map((change) => { const range = lineRange(batch, change.path); return <button className="file-link" key={change.path} onClick={() => onOpenFile(change.path, range.start)}>{change.path}<span>{change.kind} · L{range.start}–{range.end}</span></button>; })}{suggestion && !linked && batch.linkedTaskId === undefined && <div className="suggestion-actions"><small>{suggestion.reason}</small><button onClick={() => onSend({ type: "link_change_to_task", payload: { changeBatchId: batch.id, taskId: task.id } })}>Accept link</button></div>}</div>;
                })}
                {taskRuns.map((run) => <div className={`run-row ${run.result}`} key={run.id}><strong>{run.result.toUpperCase()}</strong><code>{run.command}</code><small>{run.durationMs ?? "—"}ms · exit {run.exitCode ?? "—"}</small></div>)}
                <details className="history"><summary>Status history</summary>{task.statusHistory.length === 0 && <p>No status changes yet.</p>}{task.statusHistory.map((item) => <p key={`${item.at}-${item.to}`}><strong>{statusLabels[item.to]}</strong> — {item.reason}<small>{new Date(item.at).toLocaleString()}</small></p>)}</details>
                <div className="task-actions"><button className="secondary" disabled={index === 0} onClick={() => moveTask(task.id, -1)}>Move up</button><button className="secondary" disabled={index === orderedTasks.length - 1} onClick={() => moveTask(task.id, 1)}>Move down</button><button className="secondary" onClick={() => onSend({ type: "confirm_task", payload: { taskId: task.id } })}>Confirm manually</button><button className="danger-button" onClick={() => onSend({ type: "delete_task", payload: { taskId: task.id } })}>Delete</button></div>
              </div>}
            </article>
          );
        })}
      </div>
    </section>
  );
}
