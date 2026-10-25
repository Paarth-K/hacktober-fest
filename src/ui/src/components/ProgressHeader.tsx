import type { ProgressSnapshot, Project, Task } from "../../../shared/index.js";

const statusMeta = {
  verified_complete: { label: "Verified", color: "var(--verified)" },
  user_confirmed: { label: "Confirmed", color: "var(--confirmed)" },
  needs_verification: { label: "Needs verification", color: "var(--needs)" },
  activity_detected: { label: "Activity", color: "var(--activity)" },
  not_started: { label: "Not started", color: "var(--idle)" }
} as const;

function relativeTime(value: string | null | undefined) {
  if (!value) return "No activity yet";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function ProgressHeader({ project, progress, tasks, compact, onExpand }: {
  project: Project | null;
  progress: ProgressSnapshot | null;
  tasks: Task[];
  compact: boolean;
  onExpand: () => void;
}) {
  const currentTask = tasks.find((task) => task.status === "activity_detected" || task.status === "needs_verification") ?? tasks[0];
  const total = progress?.total || 1;

  return (
    <section className={`progress-shell ${compact ? "compact" : ""}`} aria-label="Project completion">
      <div className="progress-heading">
        <div className="project-mark">LC</div>
        <div className="project-title">
          <strong>{project?.name ?? "No project selected"}</strong>
          {compact && <span>{currentTask?.title ?? "Choose a task"}</span>}
        </div>
        <div className="percent" aria-label={`${progress?.percentComplete ?? 0} percent complete`}>
          {progress?.percentComplete ?? 0}<small>%</small>
        </div>
        {compact && <button className="icon-button" onClick={onExpand} aria-label="Expand window">↗</button>}
      </div>
      <div className="segmented-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress?.percentComplete ?? 0}>
        {progress && Object.entries(statusMeta).map(([status, meta]) => (
          <span
            key={status}
            title={`${meta.label}: ${progress.byStatus[status as keyof typeof progress.byStatus]}`}
            style={{ width: `${(progress.byStatus[status as keyof typeof progress.byStatus] / total) * 100}%`, background: meta.color }}
          />
        ))}
      </div>
      {!compact && progress && (
        <>
          <div className="progress-facts">
            <span><strong>{progress.criteriaMet}</strong> of {progress.criteriaTotal} criteria met</span>
            <span>Activity {relativeTime(progress.lastActivityAt)}</span>
          </div>
          <div className="status-legend">
            {Object.entries(statusMeta).map(([status, meta]) => (
              <span key={status}><i style={{ background: meta.color }} />{progress.byStatus[status as keyof typeof progress.byStatus]} {meta.label}</span>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
