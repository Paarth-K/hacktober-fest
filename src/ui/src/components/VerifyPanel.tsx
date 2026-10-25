import { useState } from "react";
import type { Project, VerificationRun } from "../lib/contracts";

export function VerifyPanel({ project, runs, onRun }: { project: Project; runs: VerificationRun[]; onRun: (commandId: string) => void }) {
  const [running, setRunning] = useState<string | null>(null);
  return (
    <section className="panel" aria-labelledby="verify-heading">
      <div className="section-title"><div><span className="eyebrow">Evidence gate</span><h2 id="verify-heading">Verify</h2></div></div>
      <p className="muted">Commands only run when you click Verify. Review the exact text first.</p>
      <div className="command-list">
        {project.checkCommands.map((check) => {
          const latest = runs.find((run) => run.command === check.command);
          return <div className="command" key={check.id}><code>{check.command}</code><div>{latest && <span className={`result ${latest.result}`}>{latest.result}</span>}<button onClick={() => { setRunning(check.id); onRun(check.id); window.setTimeout(() => setRunning(null), 900); }} disabled={running === check.id}>{running === check.id ? "Running…" : "Verify"}</button></div>{latest?.outputTail && <pre>{latest.outputTail}</pre>}</div>;
        })}
      </div>
    </section>
  );
}
