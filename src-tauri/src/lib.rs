mod engine;
mod window;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            engine::engine_connection,
            window::set_always_on_top,
            window::set_compact_mode,
            window::pick_workspace,
            window::open_workspace_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running Local Code Companion");
}
