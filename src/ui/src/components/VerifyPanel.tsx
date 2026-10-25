import type { Project, VerificationRun } from "../../../shared/index.js";

export function VerifyPanel({ project, runs, runningCheckIds, onRun }: { project: Project; runs: VerificationRun[]; runningCheckIds: Set<string>; onRun: (commandId: string) => void }) {
  return (
    <section className="panel" aria-labelledby="verify-heading">
      <div className="section-title"><div><span className="eyebrow">Evidence gate</span><h2 id="verify-heading">Verify</h2></div></div>
      <p className="muted">Commands only run when you click Verify. Review the exact text first.</p>
      <div className="command-list">
        {project.checkCommands.map((check) => {
          const latest = [...runs].reverse().find((run) => run.checkCommandId === check.id);
          const running = runningCheckIds.has(check.id);
          return <div className="command" key={check.id}><div><strong>{check.label}</strong><code>{check.command}</code></div><div>{latest && <span className={`result ${latest.result}`}>{latest.result}</span>}<button onClick={() => onRun(check.id)} disabled={running}>{running ? "Running…" : "Verify"}</button></div>{latest?.outputTail && <pre>{latest.outputTail}</pre>}</div>;
        })}
      </div>
    </section>
  );
}
