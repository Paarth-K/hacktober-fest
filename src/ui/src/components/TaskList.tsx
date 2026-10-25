import { useState } from "react";
import type { ChangeBatch, Project, Task, VerificationRun } from "../lib/contracts";

const statusLabels = {
  not_started: "Not started",
  activity_detected: "Activity detected",
  needs_verification: "Needs verification",
  verified_complete: "Verified complete",
  user_confirmed: "User confirmed"
};

export function TaskList({ project, tasks, changes, verifications, attentionIds, onSend, onOpenFile }: {
  project: Project;
  tasks: Task[];
  changes: ChangeBatch[];
  verifications: VerificationRun[];
  attentionIds: Set<string>;
  onSend: (type: "select_task" | "create_task" | "update_task" | "reorder_tasks" | "link_change_to_task" | "confirm_task", payload: unknown) => void;
  onOpenFile: (path: string, line: number) => void;
}) {
  const [expanded, setExpanded] = useState(tasks[0]?.id ?? "");
  const [newTitle, setNewTitle] = useState("");

  const createTask = () => {
    if (!newTitle.trim()) return;
    onSend("create_task", { projectId: project.id, title: newTitle.trim(), acceptanceCriteria: [] });
    setNewTitle("");
  };

  return (
    <section className="panel" aria-labelledby="tasks-heading">
      <div className="section-title">
        <div><span className="eyebrow">Checklist</span><h2 id="tasks-heading">Tasks</h2></div>
        <span className="count-pill">{tasks.length}</span>
      </div>
      <div className="add-row">
        <input value={newTitle} onChange={(event) => setNewTitle(event.target.value)} onKeyDown={(event) => event.key === "Enter" && createTask()} placeholder="Add a task" aria-label="New task title" />
        <button onClick={createTask}>Add</button>
      </div>
      <div className="task-list">
        {[...tasks].sort((a, b) => a.order - b.order).map((task, index) => {
          const taskChanges = changes.filter((batch) => batch.suggestedTaskLinks.some((link) => link.taskId === task.id) || task.evidenceIds.includes(batch.id));
          const taskRuns = verifications.filter((run) => run.taskIds.includes(task.id));
          const isExpanded = expanded === task.id;
          return (
            <article className={`task-card status-${task.status}`} key={task.id}>
              <button className="task-summary" onClick={() => { setExpanded(isExpanded ? "" : task.id); onSend("select_task", { taskId: task.id }); }} aria-expanded={isExpanded}>
                <span className="status-dot" />
                <span className="task-copy"><strong>{task.title}</strong><small>{statusLabels[task.status]} · {task.acceptanceCriteria.filter((item) => item.met).length}/{task.acceptanceCriteria.length} criteria</small></span>
                {attentionIds.has(task.id) && <span className="attention" title="Needs attention">!</span>}
                <span className="chevron">⌄</span>
              </button>
              {isExpanded && (
                <div className="task-details">
                  <div className="criteria-list">
                    {task.acceptanceCriteria.length === 0 && <p className="muted">No acceptance criteria yet.</p>}
                    {task.acceptanceCriteria.map((criterion) => (
                      <label key={criterion.id} className="criterion">
                        <input type="checkbox" checked={criterion.met} onChange={(event) => onSend("update_task", { taskId: task.id, acceptanceCriterion: { ...criterion, met: event.target.checked, metBy: event.target.checked ? "user" : "none" } })} />
                        <span>{criterion.text}<small>{criterion.met ? `Met by ${criterion.metBy}` : "Not evidenced"}</small></span>
                      </label>
                    ))}
                  </div>
                  {taskChanges.map((batch) => {
                    const suggestion = batch.suggestedTaskLinks.find((link) => link.taskId === task.id);
                    return (
                      <div className="evidence-block" key={batch.id}>
                        <div className="evidence-heading"><span>Change evidence</span>{suggestion && !task.evidenceIds.includes(batch.id) && <span className="suggested">Suggested {Math.round(suggestion.score * 100)}%</span>}</div>
                        {batch.changes.map((change) => <button className="file-link" key={change.path} onClick={() => onOpenFile(change.path, change.hunks[0]?.startLine ?? 1)}>{change.path}<span>{change.kind} · L{change.hunks[0]?.startLine ?? 1}–{change.hunks[0]?.endLine ?? 1}</span></button>)}
                        {suggestion && !task.evidenceIds.includes(batch.id) && <div className="suggestion-actions"><small>{suggestion.reason}</small><button onClick={() => onSend("link_change_to_task", { changeBatchId: batch.id, taskId: task.id })}>Accept link</button></div>}
                      </div>
                    );
                  })}
                  {taskRuns.map((run) => <div className={`run-row ${run.result}`} key={run.id}><strong>{run.result.toUpperCase()}</strong><code>{run.command}</code><small>{run.durationMs}ms · exit {run.exitCode ?? "—"}</small></div>)}
                  <details className="history"><summary>Status history</summary>{task.statusHistory.map((item) => <p key={`${item.timestamp}-${item.status}`}><strong>{statusLabels[item.status]}</strong> — {item.reason}<small>{new Date(item.timestamp).toLocaleString()}</small></p>)}</details>
                  <div className="task-actions">
                    <button className="secondary" disabled={index === 0} onClick={() => onSend("reorder_tasks", { taskId: task.id, order: index - 1 })}>Move up</button>
                    <button className="secondary" onClick={() => onSend("confirm_task", { taskId: task.id })}>Confirm manually</button>
                  </div>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
