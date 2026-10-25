use std::path::{Component, Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, LogicalSize, Manager, Size};
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub fn set_always_on_top(app: AppHandle, pinned: bool) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("main window missing")?;
    window
        .set_always_on_top(pinned)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn set_compact_mode(app: AppHandle, compact: bool) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("main window missing")?;
    let size = if compact {
        LogicalSize::new(380.0, 88.0)
    } else {
        LogicalSize::new(380.0, 640.0)
    };
    window
        .set_size(Size::Logical(size))
        .map_err(|error| error.to_string())?;
    window
        .set_resizable(!compact)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn pick_workspace(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .blocking_pick_folder()
        .map(|path| path.to_string())
}

fn resolve_workspace_file(root_path: &Path, relative_path: &Path) -> Result<PathBuf, String> {
    if relative_path.is_absolute()
        || relative_path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
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
pub fn open_workspace_file(
    root_path: String,
    relative_path: String,
    line: u32,
    editor_command: Option<String>,
) -> Result<(), String> {
    let target = resolve_workspace_file(Path::new(&root_path), Path::new(&relative_path))?;
    let line = line.max(1);

    if let Some(command_line) = editor_command.filter(|value| !value.trim().is_empty()) {
        let parts =
            shell_words::split(&command_line).map_err(|_| "Invalid editor command".to_string())?;
        let (program, raw_arguments) = parts
            .split_first()
            .ok_or_else(|| "Editor command is empty".to_string())?;
        let file = target.to_string_lossy();
        let line_text = line.to_string();
        let uses_placeholders = raw_arguments
            .iter()
            .any(|argument| argument.contains("{file}") || argument.contains("{line}"));
        let arguments = raw_arguments.iter().map(|argument| {
            argument
                .replace("{file}", &file)
                .replace("{line}", &line_text)
        });
        let mut command = Command::new(program);
        command.args(arguments);
        if !uses_placeholders {
            command.arg(format!("{}:{line}", target.display()));
        }
        command
            .spawn()
            .map_err(|error| format!("Could not launch configured editor: {error}"))?;
        return Ok(());
    }

    open::that(&target)
        .map_err(|error| format!("Could not open file with the system default: {error}"))
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
        let error =
            resolve_workspace_file(workspace.path(), Path::new("../outside.ts")).unwrap_err();
        assert_eq!(error, "File path must be workspace-relative");
    }
}
