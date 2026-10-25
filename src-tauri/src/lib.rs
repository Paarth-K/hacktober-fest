use std::path::{Component, Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, LogicalSize, Manager, Size, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
fn set_always_on_top(window: WebviewWindow, pinned: bool) -> Result<(), String> {
    window.set_always_on_top(pinned).map_err(|error| error.to_string())
}

#[tauri::command]
fn set_compact_mode(window: WebviewWindow, compact: bool) -> Result<(), String> {
    let size = if compact {
        LogicalSize::new(380.0, 88.0)
    } else {
        LogicalSize::new(380.0, 640.0)
    };
    window.set_size(Size::Logical(size)).map_err(|error| error.to_string())?;
    window.set_resizable(!compact).map_err(|error| error.to_string())
}

#[tauri::command]
fn pick_workspace(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .blocking_pick_folder()
        .map(|path| path.to_string())
}

fn resolve_workspace_file(root_path: &Path, relative_path: &Path) -> Result<PathBuf, String> {
    if relative_path.is_absolute()
        || relative_path.components().any(|component| matches!(component, Component::ParentDir | Component::RootDir | Component::Prefix(_)))
    {
        return Err("File path must be workspace-relative".into());
    }

    let canonical_root = root_path
        .canonicalize()
        .map_err(|_| "Selected workspace does not exist".to_string())?;
    let canonical_target = canonical_root
        .join(relative_path)
        .canonicalize()
        .map_err(|_| "Selected file does not exist".to_string())?;

    if !canonical_target.starts_with(&canonical_root) {
        return Err("Refusing to open a file outside the selected workspace".into());
    }
    if !canonical_target.is_file() {
        return Err("Selected path is not a file".into());
    }
    Ok(canonical_target)
}

#[tauri::command]
fn open_workspace_file(
    root_path: String,
    relative_path: String,
    line: u32,
    editor_command: Option<String>,
) -> Result<(), String> {
    let target = resolve_workspace_file(Path::new(&root_path), Path::new(&relative_path))?;

    if let Some(command_line) = editor_command.filter(|value| !value.trim().is_empty()) {
        let parts = shell_words::split(&command_line).map_err(|_| "Invalid editor command".to_string())?;
        let (program, arguments) = parts.split_first().ok_or_else(|| "Editor command is empty".to_string())?;
        let target_argument = format!("{}:{}", target.display(), line.max(1));
        Command::new(program)
            .args(arguments)
            .arg(target_argument)
            .spawn()
            .map_err(|error| format!("Could not launch configured editor: {error}"))?;
        return Ok(());
    }

    open::that(&target).map_err(|error| format!("Could not open file with the system default: {error}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                window.set_always_on_top(true)?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_always_on_top,
            set_compact_mode,
            pick_workspace,
            open_workspace_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running Local Code Companion");
}

#[cfg(test)]
mod tests {
    use super::resolve_workspace_file;
    use std::fs;
    use std::path::Path;

    #[test]
    fn accepts_existing_file_inside_workspace() {
        let workspace = tempfile::tempdir().unwrap();
        fs::write(workspace.path().join("inside.ts"), "export {};\n").unwrap();
        let resolved = resolve_workspace_file(workspace.path(), Path::new("inside.ts")).unwrap();
        assert!(resolved.ends_with("inside.ts"));
    }

    #[test]
    fn rejects_parent_traversal() {
        let workspace = tempfile::tempdir().unwrap();
        let error = resolve_workspace_file(workspace.path(), Path::new("../outside.ts")).unwrap_err();
        assert_eq!(error, "File path must be workspace-relative");
    }
}
