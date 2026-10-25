# Integration contract (canonical, owned by P4)

The source of truth is the code in `src/shared/`. This doc tells you what to import and what each module owns. If you need a contract change, post a `coord/` note on the `communication` branch first. P4 makes the change.

## Layout and ownership

| Path | Owner | What it is |
|---|---|---|
| `src/shared/schemas.ts` | P4 | Zod domain schemas: Project, Task, AcceptanceCriterion, ProgressSnapshot, VerificationRun, ChangeBatch, FileChange, DiffHunk, EvidenceRef, Omission, ContextPacket, Explanation*, TaskBreakdown*, ModelStatus, Preferences, `isSafeRelPath` |
| `src/shared/events.ts` | P4 | `ClientMessageSchema` (UI→engine), `ServerMessageSchema` (engine→UI), envelopes, `makeEnvelope`, `newId` |
| `src/shared/interfaces.ts` | P4 | `ModelProvider` (P3 implements), `Observer` (P2 implements) |
| `src/shared/wsClient.ts` | P4 | `EngineClient`, the typed WebSocket client for the UI (Zod-validated, dedupes by eventId, reconnects) |
| `src/shared/fixtures.ts` + `fixtures/demo-state.json` | P4 | `loadDemoFixture()`: tasks in every status, a 3-file change batch, pass + fail runs, a mock explanation and breakdown |
| `src/core/` | P4 | `progress.ts` (status rules + snapshot maths), `orchestrator.ts`, `verification.ts`, `report.ts` |
| `src/storage/` | P4 | `JsonStore`: JSON in the OS app-data dir (`LCC_DATA_DIR` overrides it) |
| `src/integrations/wsServer.ts` | P4 | Loopback WebSocket bridge (127.0.0.1, random port, per-launch token) |
| `src/engine/main.ts` | P4 | Engine entry point: wires observer + provider + orchestrator + bridge |
| `src/observer/`, `src/context/` | **P2** | Must export `createObserver(): Observer` from `src/observer/index.ts` |
| `src/ai/`, `src/skills/` | **P3** | Must export `createModelProvider(opts: ModelProviderOptions): ModelProvider` from `src/ai/index.ts` |
| `src/ui/` | **P1** | React UI. The M0 `App.tsx` is a placeholder you can replace |
| `src-tauri/src/window.rs`, window config | **P1** | Window commands. `src-tauri/src/engine.rs` (`engine_connection`) is P4's |

The files in P2/P3/P1 areas are **placeholders**. Overwrite them, but keep the export names above so `src/engine/main.ts` keeps compiling.

Imports use `.js` suffixes (`import { TaskSchema } from "../shared/index.js"`). Vite, tsx and `tsc --moduleResolution Bundler` all resolve these to `.ts`.

## Status rules (enforced only in `src/core/progress.ts`)

- `not_started → activity_detected`: the **user** links a ChangeBatch to the task (`link_change_to_task`). Observed changes alone only produce *suggestions* (`ChangeBatch.suggestedTaskLinks`). The engine never sets `linkedTaskId` itself.
- `→ verified_complete`: every acceptance criterion is `met`, and at least one was met by a passing check (`metBy: "check"`). A criterion with `checkCommandId = X` becomes met when check X passes.
- `→ user_confirmed`: the user ticks every criterion (`set_criterion_met`), or sends `confirm_task`.
- `→ needs_verification`: a linked check fails, times out or errors. If that check had passed before, it is a **regression**: `regressedAt` is set and the reason starts with `Regression:`. The same happens if a complete task loses a met criterion (user untick, or a criterion edited or added).
- `percentComplete = (verified_complete + user_confirmed) / total × 100`, rounded to 0.1, and 0 when there are no tasks.
- Stalled: an in-flight task idle for ≥ `preferences.stallMinutes` while another task moved more recently.
- Each transition appends `statusHistory {at, from, to, reason, actor, verificationRunId?}`.
- `update_task` **cannot** set status or met flags. The schema strips them.

## WebSocket protocol

- URL: `ws://127.0.0.1:<port>/?token=<token>`. A missing or bad token gets HTTP 401. Connections from non-loopback addresses are rejected.
- Each frame is one JSON envelope: `{sessionId, eventId, timestamp, replyTo?, type, payload}`.
- The engine sends `state_snapshot` as soon as a client connects. Responses to a request carry `replyTo = <request eventId>`. Invalid frames get `{type:"error", payload:{code:"invalid_message"}}`.
- Both sides dedupe by `eventId`. The engine also dedupes ChangeBatches by `id`.

UI → engine (`ClientMessage`): `set_project, update_project, create_task, update_task, delete_task, reorder_tasks, set_criterion_met, link_change_to_task, request_breakdown, accept_breakdown, run_verification, export_report, request_explanation, ask_followup, preferences_changed, confirm_task, open_file, select_task, window_mode_changed, request_snapshot`

Engine → UI (`ServerMessage`): `state_snapshot, progress_updated, change_batch, task_updated, task_deleted, verification_started, verification_result, breakdown_suggestion, explanation_result, explanation_error, report_ready, model_status, preferences_updated, open_file_result, error`

Main flows:

| User action | Send | Expect |
|---|---|---|
| Pick folder | `set_project {rootPath, goal?}` | `state_snapshot` (the engine starts the observer on rootPath) |
| Configure checks | `update_project {checkCommands:[{label, command, timeoutMs?}]}` | `state_snapshot` (ids are assigned) |
| Accept suggested link | `link_change_to_task {changeBatchId, taskId}` (`taskId:null` dismisses) | `task_updated`, `change_batch` (with `linkedTaskId`), `progress_updated` |
| Verify | `run_verification {checkCommandId, taskIds?}` | `verification_started`, then `task_updated`*, `verification_result`, `progress_updated` |
| AI breakdown | `request_breakdown {goal, promptText?}` → user edits → `accept_breakdown {requestId, tasks}` | `breakdown_suggestion`, then `state_snapshot` |
| Explain / quiz | `request_explanation {changeBatchIds, level, wantQuiz}` | `explanation_result` or `explanation_error` |
| Follow-up | `ask_followup {question, changeBatchIds?, taskId?, level}` | same as above |
| Report | `export_report {saveToWorkspace}` | `report_ready {markdown, savedPath?}` (saved to `<root>/.local-code-companion/progress-report.md`) |
| Open cited file | `open_file {path, line?}` | `open_file_result {ok, absPath?}`, after which the UI invokes the Rust open command |

## Observer contract (P2)

`Observer.start({rootPath, sessionId, onBatch, getTasks, onError})`. Requirements:
- Emit ChangeBatches with safe POSIX relative paths (`RelPathSchema` rejects anything else), real hunks, `EvidenceRef`s for changed line ranges, and `omissions` for anything skipped.
- Set `baselineMissing: true` when there was no "before" content. Do not invent one.
- Set `suggestedTaskLinks` with a score and reason, or `[]` when confidence is low. The engine drops links to unknown task ids and never applies them automatically.
- **Ignore** `.git, node_modules, dist, build, target, .local-code-companion/` (the engine writes reports there), secrets, binaries and large files.
- `getContext` / `retrieveForQuestion` return a bounded `ContextPacket`. Put symbols you could not find in `missing`.

## Provider contract (P3)

- `ModelProvider { name, mode: "real"|"mock", status(), explain(req), breakdown(req), summarizeProgress?(input) }`.
- `ModelProviderOptions { provider: "auto"|"mock"|"ollama", ollamaBaseUrl?, ollamaModel? }`. Env vars: `OLLAMA_BASE_URL`, `OLLAMA_MODEL`.
- `explain` must return `ExplanationResponseSchema` output with `mode` labeled correctly. The engine also runs `enforceCitations()` and moves any citation that is not inside `context.evidence` or `context.excerpts` ranges to `invalidCitations`.
- Explanation results with `mode: "real"` are cached per (batches, level, question, quiz).

## Running

- `npm run engine` / `npm run engine:mock`: headless engine. Prints `LCC_ENGINE_READY {"port":N,"token":"..."}` and writes `<dataDir>/engine.json`.
- `npm run dev`: engine + `tauri dev`. `npm run dev:mock` does the same with the fixture project. `npm run dev:web` runs the mock engine + Vite in a browser.
- `npm run check` runs typecheck + vitest.
