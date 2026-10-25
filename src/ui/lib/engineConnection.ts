// Resolve the engine port/token: Tauri command first, then URL params / Vite env (browser dev).
import type { EngineConnection } from "../../shared/wsClient.js";

export async function resolveEngineConnection(): Promise<EngineConnection | null> {
  if ("__TAURI_INTERNALS__" in window) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const c = await invoke<{ port: number; token: string } | null>("engine_connection");
      if (c) return c;
    } catch (e) {
      console.warn("engine_connection failed", e);
    }
  }
  const q = new URLSearchParams(location.search);
  const port = Number(q.get("port") ?? import.meta.env.VITE_LCC_ENGINE_PORT);
  const token = q.get("token") ?? import.meta.env.VITE_LCC_ENGINE_TOKEN;
  return port && token ? { port, token } : null;
}
