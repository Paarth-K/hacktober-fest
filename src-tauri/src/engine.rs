// OWNED BY P4. Hands the per-launch engine port/token to the webview.
// In dev, scripts/dev.mjs starts the Node engine and passes these env vars to `tauri dev`.
// (Packaging the engine as a bundled sidecar is a stretch goal.)
use serde::Serialize;

#[derive(Serialize)]
pub struct EngineConnection {
    port: u16,
    token: String,
}

#[tauri::command]
pub fn engine_connection() -> Option<EngineConnection> {
    let port = std::env::var("LCC_ENGINE_PORT").ok()?.parse().ok()?;
    let token = std::env::var("LCC_ENGINE_TOKEN").ok()?;
    Some(EngineConnection { port, token })
}
