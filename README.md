# Local Code Companion

A local-first floating desktop window (Tauri 2) that sits on top of your editor, **tracks how far your project has actually progressed**, and explains local edits made by Claude Code, Codex, or any other tool, using a local Gemma model through Ollama.

> Status: **M0 foundation.** The scaffold, shared contract, engine core (progress engine, verification runner, JSON persistence, loopback WebSocket) and a placeholder UI are in. The observer (P2), AI (P3) and full UI (P1) are in progress on their feature branches. The "Tested" section below lists what has actually been run.

## Prerequisites

- Node.js LTS (tested with v24) + npm
- Rust stable (`rustup`), plus the Tauri 2 platform prerequisites:
  - **macOS:** Xcode Command Line Tools (`xcode-select --install`)
  - **Windows:** Microsoft C++ Build Tools (MSVC) + WebView2 runtime
  - **Linux (Debian/Ubuntu):** `sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`
- Optional: [Ollama](https://ollama.com) with a Gemma model. Run `ollama list` to see which tags you have installed, then `export OLLAMA_MODEL=<tag>`.

## Install & run

```bash
npm install
npm run dev          # engine + Tauri floating window (real mode)
npm run dev:mock     # same, but seeded with the demo fixture project + mock AI
npm run dev:web      # mock engine + Vite in a browser (no Rust needed); prints the URL
npm run engine       # headless engine only (P2/P3 development)
npm run check        # typecheck + tests
```

## Architecture

- `src-tauri/`: thin Rust shell (window, folder picker, open-in-editor, engine connection).
- `src/ui/`: React + TypeScript UI in the webview.
- Node engine (`src/engine/main.ts`): observer, context, AI, core/progress, storage. It talks to the UI over a WebSocket on 127.0.0.1 with a random port and a per-launch token.
- State is stored as JSON in the OS app-data directory (`~/Library/Application Support/local-code-companion` on macOS, `%APPDATA%\local-code-companion` on Windows, `~/.local/share/local-code-companion` on Linux). Set `LCC_DATA_DIR` to override.

See [docs/INTEGRATION_CONTRACT.md](docs/INTEGRATION_CONTRACT.md) for schemas, messages, ownership and status rules.

## Honest progress rules

Percent complete counts **only** tasks verified by a passing, user-run check command or explicitly confirmed by the user. Detected file activity and AI explanations never count as completion. Verification commands run only when you click **Verify**, and the exact command text is shown before it runs.

## Tested

| What | Result | OS |
|---|---|---|
| `npm run typecheck` | PASS | macOS (arm64) |
| `npm test` (schemas, progress rules, real verification processes, engine-over-WebSocket e2e incl. persistence) | PASS | macOS (arm64) |
| `cargo build` of `src-tauri` | PASS | macOS (arm64) |
| Windows / Linux | NOT TESTED | n/a |

## Known limitations

- Observer and AI are placeholder stubs on `main` until the P2/P3 branches are merged.
- The engine runs as a Node process started by `npm run dev`. It is not yet bundled as a Tauri sidecar.
