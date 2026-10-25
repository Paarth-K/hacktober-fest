// OWNED BY P1: window behaviour commands (always-on-top toggle, compact mode,
// workspace folder picker helpers, open-in-editor with workspace path validation).
use tauri::{AppHandle, Manager};

#[tauri::command]
pub fn set_always_on_top(app: AppHandle, on_top: bool) -> Result<(), String> {
    let win = app.get_webview_window("main").ok_or("main window missing")?;
    win.set_always_on_top(on_top).map_err(|e| e.to_string())
}
