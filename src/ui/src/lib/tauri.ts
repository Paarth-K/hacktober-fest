import { invoke } from "@tauri-apps/api/core";

const isTauri = () => "__TAURI_INTERNALS__" in window;

export async function setPinned(pinned: boolean) {
  if (isTauri()) await invoke("set_always_on_top", { pinned });
}

export async function setCompact(compact: boolean) {
  if (isTauri()) await invoke("set_compact_mode", { compact });
}

export async function pickWorkspace(): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string | null>("pick_workspace");
}

export async function openWorkspaceFile(rootPath: string, relativePath: string, line: number, editorCommand: string) {
  if (!isTauri()) return;
  await invoke("open_workspace_file", { rootPath, relativePath, line, editorCommand: editorCommand || null });
}
