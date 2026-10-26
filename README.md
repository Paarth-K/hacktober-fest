# Sidekick

Sidekick is a local-first coding companion. Tell it what you want changed in plain language; it can clarify the request, hand a focused prompt to Claude Code or Codex, watch the workspace for real edits, and explain the resulting diff. Verification is always explicit: activity and model explanations never count as proof that a change works.

The primary interface is the interactive terminal app, `skck`. A Tauri floating window is also available from a source checkout.

## Install and run

Requirements: Node.js 22+ and npm. Rust and the platform-specific Tauri dependencies are needed only for the desktop window.

```bash
npm install
npm link                 # development command: skck
skck                     # use the current project
skck ~/path/to/project   # use another project
```

For a self-contained local package:

```bash
npm pack                 # builds dist-cli/skck.mjs first
npm install -g ./sidekick-cli-0.1.0.tgz
```

Useful terminal options:

```text
skck --setup             choose the audience, model, agent, and permissions
skck --agent=codex       use Codex for the next change
skck --prog              show progress as macOS notifications when available
skck --window            launch the Tauri window (source checkout only)
```

The terminal flow is: Ask → Progress → Learn. Enter a request, answer any consequential clarifying questions, review the agent’s progress, then read an evidence-based explanation or ask a follow-up question. `Esc` stops the active change; `Ctrl+N` starts another; `Ctrl+O` opens the See it view; `Tab` switches views.

## Models and privacy

Without a gateway key, Sidekick uses a Gemma model served by local Ollama when one is available. Set `OLLAMA_MODEL` to an installed tag, or leave it unset to use the first installed `gemma*` tag:

```bash
ollama list
export OLLAMA_MODEL=gemma4:31b
```

If Ollama is unavailable, Sidekick falls back to clearly labeled deterministic output. To use the Vercel AI Gateway instead, set `AI_GATEWAY_API_KEY` and optionally `SIDEKICK_GEMMA_MODEL`. In gateway mode, prompts and bounded code evidence leave the machine; local mode keeps inference on the loopback Ollama service.

The observer sends only bounded excerpts and diffs to the model. It excludes Git metadata, dependencies, build output, binaries, lockfiles, environment files, keys, credentials, and oversized files. State is stored as JSON in the OS application-data directory; set `LCC_DATA_DIR` to override it.

## Development commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the real engine and Tauri window |
| `npm run dev:mock` | Start the seeded mock engine and Tauri window |
| `npm run dev:web` | Start the mock engine and Vite UI without Rust |
| `npm run engine` | Run the headless engine |
| `npm run engine:mock` | Run the headless seeded mock engine |
| `npm run check` | Typecheck, Vitest, and standalone AI provider tests |
| `npm run gate` | Run the real engine/observer/check-command integration gate with mock AI |
| `npm run gate:live` | Run the same gate with live Ollama when configured |
| `npm run smoke:gemma` | Exercise the integrated Gemma adapter |
| `npm run demo` | Create a temporary demo project and launch Sidekick |
| `npm run demo:agent -- login\|break\|fix` | Simulate real workspace edits for the demo |
| `npm run build:cli` | Build the installable terminal bundle |
| `npm run ui:build` | Build the Tauri web UI |

The end-to-end gate creates its own temporary workspace and data directory. The demo does the same, so neither command changes a real project unless you explicitly point it at one.

## Architecture

```text
bin/skck.mjs       package entry point and source/bundle launcher
src/tui/           Ink terminal UI
src/engine/        Node engine lifecycle and loopback connection
src/core/          orchestration, progress rules, reports, verification
src/observer/      file watcher, diffs, ignore rules, and evidence
src/context/       bounded context retrieval and task attribution
src/ai/            Ollama/Gemma and deterministic mock providers
src/vibe/          request clarification, agent launch, and explanations
src/shared/        canonical schemas, events, fixtures, and WebSocket client
src/ui/            React frontend used by the Tauri window
src-tauri/         thin Rust shell for the floating desktop window
toasts/            optional macOS notification helper for `skck --prog`
```

The engine listens only on `127.0.0.1` with a per-launch token. Progress is based on explicit user confirmation or passing checks; a changed file is evidence of activity, not completion.

The shared contract is documented in [docs/INTEGRATION_CONTRACT.md](docs/INTEGRATION_CONTRACT.md). Component-level behavior is documented in [src/observer/README.md](src/observer/README.md) and [src/ai/README.md](src/ai/README.md).

## Verification status

Run `npm run check` for the local verification gate. `npm run gate` covers the real observer, uncommitted create/modify/delete events, secret filtering, task attribution, verification results, report export, and engine restart persistence. Live-model and Tauri checks depend on the machine’s installed model and platform dependencies; the commands report failures instead of treating unavailable services as successful.

## Known limitations

- The Node engine is not yet bundled as a Tauri sidecar, so the desktop app is a development/source-checkout workflow.
- Linux and the Tauri window on Windows require platform-specific validation.
- Check commands run through the system shell with the exact text configured by the user; configure only commands you trust.
- Change-to-task attribution is heuristic and remains a suggestion until accepted.
- Model explanations are grounded in bounded evidence but are not verification.
