# Local Code Companion

Tell it what you want changed in your project, in plain words. A local Gemma model asks a quick question if something important is unclear, writes clear instructions for **Claude Code**, and Claude makes the change while you watch. Afterwards Gemma explains what changed at your level: new to coding, learning, or experienced. Every change is kept as its own package you can go back to.

```
◆ Companion  ·  my-app                                                       ● ready
╭ Changes ───────────────╮╭──────────────────────────────────────────────────────────╮
│  + New change          ││ Ask  Progress  Learn                                     │
│  ✔ add a contact page  ││                                                          │
│  ● dark mode           ││ ✔ Understood your request                                │
│                        ││ ✔ Wrote instructions for Claude                          │
│                        ││ ⠋ Claude is making the changes  1:12                     │
│                        ││     Editing styles.css…                                  │
╰────────────────────────╯╰──────────────────────────────────────────────────────────╯
 Esc stop Claude · Tab switch view · ↑↓ changes · Ctrl+C quit
```

## Open it

```bash
# one time, from this repo
npm install
npm link            # installs the `lcc` command

# every time: from inside the project you want to change
cd ~/path/to/your/project
lcc                 # or: lcc ~/path/to/your/project
```

You need [Ollama](https://ollama.com) running with a Gemma model (`ollama pull gemma4:31b`), and Claude Code installed and logged in (run `claude` once). `lcc --window` opens the older floating desktop window instead.

**How it works:** type what you want and press Enter. Answer Gemma's question if it asks (press a number or type your own answer). The view switches to **Progress** while Claude works, with automatic permissions (Esc stops it), and then to **Learn** when it's done. In Learn, press 1, 2 or 3 to change how technical the explanation is, Enter to reveal the quiz answer, or type a question about the change. ↑/↓ moves between your past changes.

## Prerequisites

| | macOS | Windows | Linux (Debian/Ubuntu) |
|---|---|---|---|
| Node.js LTS + npm | ✓ (tested v24) | ✓ | ✓ |
| Rust stable | `curl https://sh.rustup.rs -sSf \| sh` | rustup-init.exe | `curl https://sh.rustup.rs -sSf \| sh` |
| Tauri 2 system deps | Xcode Command Line Tools: `xcode-select --install` | Microsoft C++ Build Tools (MSVC) + WebView2 runtime | `sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev` |

Optional, for real explanations: [Ollama](https://ollama.com) running locally with a Gemma model.

```bash
ollama list                      # see which tags you actually have installed
export OLLAMA_MODEL=gemma4:31b   # use one of YOUR tags (tested: gemma4:31b)
# OLLAMA_BASE_URL defaults to http://127.0.0.1:11434 and must be a loopback address
```

If `OLLAMA_MODEL` is unset, the engine uses the first installed `gemma*` tag. If Ollama is unreachable, the UI shows **model offline** and explanations come from a clearly labeled **MOCK** provider.

## Install & run

```bash
git clone https://github.com/Paarth-K/hacktober-fest.git && cd hacktober-fest
npm install
npm run dev          # engine + floating Tauri window (real mode, your workspaces)
```

| Command | What it does |
|---|---|
| `npm run dev` | Starts the Node engine, then `tauri dev` with the engine's port/token. Real observer, real checks, Gemma if available |
| `npm run dev:mock` | The same, seeded with a demo project (every task status), mock AI and a fake live change after 3 s. State goes to a temp dir |
| `npm run dev:web` | Mock engine + Vite only (no Rust needed). Open the URL it prints |
| `npm run engine` | Headless engine. Prints `LCC_ENGINE_READY {"port":…,"token":…}` |
| `npm run check` | Strict typecheck + all Vitest suites + AI provider tests |
| `npm run gate` | End-to-end gate against the real engine with real file edits and real check commands (mock AI) |
| `npm run gate:live` | Same gate using live Ollama/Gemma (set `OLLAMA_MODEL`) |
| `npm run smoke:gemma` | Live Gemma explanation / follow-up / breakdown through the engine's adapter |


## Quick demo (one command)

```bash
npm run demo               # creates a small real Node project in your temp dir and opens the window on it
npm run demo:agent -- login   # in a 2nd terminal: plays the coding agent (create/edit/delete files, uncommitted)
npm run demo:agent -- break   # introduces a bug -> Verify shows a regression
npm run demo:agent -- fix     # repairs it
```

The demo uses its own data dir, so your real projects aren't touched. `npm run demo -- --reset` starts over. In the window, type the goal (*Add token login to the demo API*), add the checks `npm test` and `node --test test/login.test.js`, then add a task whose criteria are linked to those checks.

## Demo walkthrough

1. `npm run dev`. The window opens always-on-top at 380×640. Use the pin toggle to unpin it, and compact mode to collapse it to a strip.
2. Pick a workspace folder and type the project goal.
3. Add tasks with acceptance criteria. You can type them, paste the prompt you gave your coding agent, or ask for an AI breakdown. Review and edit the breakdown, then accept it (it doesn't count until you do).
4. Configure a check command, e.g. `npm test`, and link criteria to it.
5. Let your coding agent edit files. Changes appear within a few seconds with real diffs and a **suggested** task. Accept the suggestion and the task moves to *activity detected*, while the percentage stays the same.
6. Click **Verify**. The exact command runs in the workspace with a timeout. On a pass, linked criteria are met and the task becomes *verified complete*. On a fail, it goes to *needs verification*. If a check that used to pass now fails, the task is flagged as a **regression**.
7. Ask for an explanation (beginner / intermediate / expert), ask a follow-up question, or take a mini quiz. Each answer cites file:line ranges that come only from observed evidence.
8. **Export report** copies a Markdown progress report or saves it to `<workspace>/.local-code-companion/progress-report.md`.

## Architecture

```
src-tauri/        Rust shell: window (always-on-top, compact mode, folder picker, open-in-editor with
                  workspace path validation), engine_connection (per-launch port/token)
src/ui/           React + TypeScript UI in the webview (P1)
src/engine/       Node engine entry point: wires everything below
src/shared/       Canonical Zod schemas, typed WS messages, EngineClient, Observer/ModelProvider interfaces
src/core/         Progress engine (status rules, %), orchestrator, verification runner, Markdown report
src/observer/     chokidar watcher, baselines, debounced batches, real diffs, ignores/secrets (P2)
src/context/      Bounded context retrieval + change→task attribution hints (P2)
src/ai/, skills/  Gemma/Ollama + deterministic mock learning service, prompts, guards (P3)
src/integrations/ Loopback WebSocket bridge + canonical↔AI adapter
```

- The UI and engine talk over `ws://127.0.0.1:<random port>` with a per-launch token. The engine never listens on another interface.
- State is stored as JSON in the OS app-data dir: `~/Library/Application Support/local-code-companion` (macOS), `%APPDATA%\local-code-companion` (Windows), `~/.local/share/local-code-companion` (Linux). Set `LCC_DATA_DIR` to override.
- Ignored by the observer: `.git`, `node_modules`, `dist`, `build`, `target`, `.local-code-companion`, binaries, large files, and `.env` / keys / credentials. Secret files show up only as omissions and are never read or sent to the model.
- The model gets only bounded excerpts. It is never shown the full repo, and nothing is sent to hosted models.

Contract, message list and ownership: [docs/INTEGRATION_CONTRACT.md](docs/INTEGRATION_CONTRACT.md).

## What was actually tested

Machine B: macOS arm64, Node 24.21, rustc 1.99, Ollama `gemma4:31b`, `integration/mvp`.

| Check | Result |
|---|---|
| `npm run check`: strict typecheck, 65 Vitest (schemas, progress rules, real check processes, engine-over-WS e2e, adapter, observer, context), 16 AI provider tests | PASS |
| `npx vite build`, `cargo test` (open-file path safety) | PASS |
| `npm run dev:mock` / `npm run dev`: Tauri window launches, UI connects to the engine | PASS |
| Visual check of the UI (P1 + P4, live UI against the running engine): all status segments, 40%, compact strip, criteria readable, MOCK labels, Verify running/pass/fail with 40%→20% regression and 0%→100% on a real workspace, model-offline banner, relaunch | PASS (pixels of the native Tauri frame and always-on-top were not screen-captured) |
| `npm run gate`: real uncommitted create/modify/delete → real hunks, `.env` excluded, suggested link not auto-applied, 0% after activity, failing check does not complete, passing check → verified (50%), report saved, relaunch persists | 19/19 PASS |
| `npm run gate:live` with `gemma4:31b`: same + live explanation (17.6 s, 2 quiz questions, valid citations) + live follow-up (9.3 s) | 19/19 PASS |
| Independent live Gemma on a second machine (P3 on A, P4 on B) | PASS on both |
| Windows 11 (P2, Node 24.19): `npm run check`, e2e gate with mock AI (real observer, real edits, real checks) | PASS (P2) |
| Tauri window / UI on Windows; anything on Linux; live Gemma on Windows | **NOT TESTED** |

## Known limitations

- The engine runs as a separate Node process started by `npm run dev`. It is not yet bundled as a Tauri sidecar, so there is no single-binary install.
- Only macOS has had a full app run. On Windows, the engine, observer and e2e gate pass but the Tauri window is untested. Linux is untested.
- Checks run through the system shell with the exact text you configured. Only configure commands you trust.
- Change→task attribution is heuristic (paths, keywords, previously linked files). It is always a suggestion.
- Explanations are grounded in bounded excerpts and can still be wrong. They are never verification.
- No tray icon, global shortcut, frameless window, or Git/PR integration (cut as stretch).
