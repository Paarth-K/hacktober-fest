// Open a URL/file in the default app, and copy text to the clipboard (macOS, Windows, Linux).
import { spawn } from "node:child_process";

export function openExternal(target: string): Promise<boolean> {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [target]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", target]] : ["xdg-open", [target]];
  return run(cmd, args as string[]);
}

export async function copyText(text: string): Promise<boolean> {
  if (process.platform === "darwin") return run("pbcopy", [], text);
  if (process.platform === "win32") return run("clip", [], text);
  return (await run("wl-copy", [], text)) || run("xclip", ["-selection", "clipboard"], text);
}

function run(cmd: string, args: string[], stdin?: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const c = spawn(cmd, args, { stdio: [stdin === undefined ? "ignore" : "pipe", "ignore", "ignore"], detached: stdin === undefined });
      c.on("error", () => resolve(false));
      c.on("close", (code) => resolve(code === 0));
      if (stdin !== undefined) c.stdin?.end(stdin);
      else c.unref();
      if (stdin === undefined) setTimeout(() => resolve(true), 300);
    } catch {
      resolve(false);
    }
  });
}
