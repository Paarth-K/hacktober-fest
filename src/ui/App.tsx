// M0 placeholder UI from P4 proving the engine <-> webview wiring. OWNED BY P1: replace freely.
import { useEffect, useState } from "react";
import { EngineClient, type ConnectionState } from "../shared/wsClient.js";
import type { StateSnapshot } from "../shared/events.js";
import type { ProgressSnapshot } from "../shared/schemas.js";
import { resolveEngineConnection } from "./lib/engineConnection";

export function App() {
  const [conn, setConn] = useState<ConnectionState | "no-engine">("connecting");
  const [snap, setSnap] = useState<StateSnapshot | null>(null);
  const [progress, setProgress] = useState<ProgressSnapshot | null>(null);

  useEffect(() => {
    let client: EngineClient | null = null;
    void resolveEngineConnection().then((c) => {
      if (!c) return setConn("no-engine");
      client = new EngineClient(c);
      client.onState(setConn);
      client.on("state_snapshot", (s) => {
        setSnap(s);
        setProgress(s.progress);
      });
      client.on("progress_updated", setProgress);
      client.connect();
    });
    return () => client?.close();
  }, []);

  return (
    <main style={{ fontFamily: "system-ui", padding: 12 }}>
      <h3 style={{ margin: 0 }}>Local Code Companion</h3>
      <p>engine: {conn}{snap?.engine.mock ? " (MOCK)" : ""}</p>
      {snap?.project && <p><b>{snap.project.name}</b> — {progress?.percentComplete ?? 0}% complete</p>}
      <ul>{snap?.tasks.map((t) => <li key={t.id}>{t.title} — {t.status}</li>)}</ul>
    </main>
  );
}
