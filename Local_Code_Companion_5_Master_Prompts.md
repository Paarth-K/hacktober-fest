# LOCAL CODE COMPANION

Five self-contained coding-agent prompts • Four parallel teammates • Tauri floating desktop window • HARD 3-hour MVP deadline

Repository: https://github.com/Paarth-K/hacktober-fest.git

How to use: Send PROMPT 0 to all four agents, followed by exactly one role prompt (1–4) to each agent. Agents work in separate clones/worktrees and push only their assigned feature branches. Everything needed to understand the product and execute the work is written here; documents the agents create during execution are outputs, not prerequisites.

---

# PROMPT 0 — Shared project contract

SEND TO ALL FOUR AGENTS BEFORE THEIR INDIVIDUAL ROLE PROMPT. Treat all instructions below as your specification.

## Non-negotiable starting conditions

- Use Git remote https://github.com/Paarth-K/hacktober-fest.git. Clone it; treat its application content as blank/uninitialized. If the remote has incidental files, inspect before editing and do not assume they contain the product specification. Do not delete user content without approval.
- No extra attachments, PROJECT_PLAN.md, INTEGRATION_CONTRACT.md, codebase, scaffold, source fixtures, or design documents exist at the start. THIS PROMPT plus your assigned role prompt are the complete requirements. Create all required files, docs, fixtures, scripts, and tests in the repository.
- HARD TEAM DEADLINE: 180 minutes from the team kickoff. All four work in parallel. By minute 180, a runnable, integrated, honestly demonstrated MVP must be in integration/mvp (and main if final checks pass). Optimize for end-to-end functionality, not speculative features.
- No agent may claim an unrun test passed, real model inference succeeded, or a feature is complete based on generated code alone. When scope slips, cut stretch features immediately.
- Toolchain: Node.js LTS + npm, plus the Rust stable toolchain and Tauri 2 platform prerequisites (macOS: Xcode Command Line Tools; Windows: MSVC build tools + WebView2; Linux: webkit2gtk-4.1 and related packages). Only P1 and P4 must build the Tauri shell; P2 and P3 can develop and test the engine headless with Node alone.

## Mission and boundaries

Build Local Code Companion: a local-first, cross-platform **floating desktop window** (Tauri 2) that sits on top of whatever editor or terminal the developer uses, **tracks how far their project has actually progressed**, and helps them understand edits made by Claude Code, Codex, or any other tool in their LOCAL workspace. Flow: project goal → task checklist with acceptance criteria → local edits → file watcher → evidence attached to tasks → honest completion progress → Gemma explanation → contextual question or beginner quiz. This is a progress-tracking and learning companion, not a PR review clone, not a new code-generating agent, and not proof that modifications work.

- **Primary UI:** Tauri 2 desktop app with a React + TypeScript frontend in a compact floating window: always-on-top (on by default, with a pin toggle), small default size (~380×640), resizable, remembers position/size, usable beside any editor (VS Code, JetBrains, Vim, Zed, a terminal agent). Must run on macOS, Windows and Linux from one codebase; each person builds/smoke-tests on the OS they have and reports untested platforms honestly. It is NOT an editor extension and has no editor dependency.
- **Architecture:**
  1. `src-tauri` — thin Rust shell: window config, always-on-top/compact-mode commands, workspace folder picker, opening files in the user's editor, launching the engine.
  2. `src/ui` — React frontend rendered in the Tauri webview.
  3. Engine — a Node.js/TypeScript process containing observer, context, AI, core, progress and storage. It talks to the UI over a loopback-only WebSocket (127.0.0.1, random port, per-launch token).
  In dev, one npm script starts engine + Tauri together. Packaging the engine as a bundled Tauri sidecar binary is a stretch goal.
- **Stack:** TypeScript everywhere except the thin Rust shell; official Tauri 2 plugins as needed (dialog, opener, window-state; global-shortcut is stretch); chokidar (or equivalent) file watching + simple diffs/context extraction; Zod shared schemas used by UI and engine; persistence via SQLite (better-sqlite3) if stable, otherwise a JSON file in the OS app-data directory; pluggable ModelProvider with local Ollama/Gemma and a deterministic mock.
- **Gemma setup:** Persons 3 and 4 have separate Ollama-capable machines. P3 owns primary live inference tests; P4 performs independent verification. Query locally installed model tags (`ollama list`), do not assume one. P1 and P2 use mocks and need no Ollama.
- Observer must work regardless of agent vendor, SDK session connection, or Git commit; optional hooks/SDK integration is a stretch. LLM sees only bounded, filtered excerpts; never promise full-repo visibility.
- No secret-bearing files (.env, keys, credentials), binaries, node_modules, .git, or build outputs may enter model context; avoid sending repository code remotely unless the user explicitly opts in. The engine never listens on a non-loopback interface.

## HEADLINE FEATURE: project completion tracking

Completion tracking is the reason users keep the window open. It must be visible at a glance, honest, and backed by evidence. Every role builds part of it.

- **Project model:** the user picks a workspace folder and states a project goal. The goal is broken into ordered tasks (optionally grouped into milestones), each with 1–5 acceptance criteria. Tasks come from manual entry, from pasting the prompt they gave their coding agent, or from an AI-suggested breakdown the user must review/accept before it counts.
- **Progress meter:** a segmented bar + percentage, always visible at the top of the window and in compact mode. Percent complete counts ONLY `verified_complete` and `user_confirmed` tasks. `activity_detected` and `needs_verification` are shown as separate segments and never folded into the percentage. Also show per-status counts, "X of Y criteria met", and time since last activity.
- **Evidence per task:** each task shows linked change batches, touched files/line ranges, verification runs, and a timestamped status history with reasons. The engine suggests which task a change belongs to; suggestions are labeled "suggested" until the user accepts or reassigns them.
- **Verification:** per project, the user configures check commands (e.g. `npm test`, `cargo test`, `pytest -k auth`). A user-clicked **Verify** runs the command in the workspace with a timeout and records exit code, duration and output tail as a VerificationRun. A task becomes `verified_complete` only when every acceptance criterion is linked to a passing check or explicitly ticked by the user. No command ever runs automatically or without the user seeing its exact text.
- **Attention signals:** flag tasks with activity but no verification, stalled tasks (no activity for a configurable N minutes while others move), and regressions (a previously passing check now fails → task drops back to `needs_verification` with a visible reason).
- **Progress report:** one click produces a Markdown summary — done (with evidence), in progress, unverified, not started, failing checks — copyable to clipboard or saved into the workspace. It must never claim anything the evidence does not support.

## Ownership and Git workflow

- **P1** — `feature/tauri-ui`; owns `src-tauri` window behavior/commands and `src/ui` (floating window, progress dashboard, all screens).
- **P2** — `feature/code-observer`; owns `src/observer` and `src/context`, including change-to-task attribution hints.
- **P3** — `feature/gemma-learning`; owns `src/ai` and `src/skills`, including AI task-breakdown suggestions and progress-report wording.
- **P4** — `feature/core-integrations`; owns `src/shared`, `src/core` (incl. progress engine and verification runner), `src/storage`, `src/integrations` (engine WebSocket bridge), repo scaffold incl. the initial `src-tauri` skeleton, and integrations; responsible for branch merges (not fixing every other owner's bugs).
- Use separate clones or worktrees. P4 establishes a minimal main foundation by minute 20; feature branches track that foundation. Integrate into integration/mvp; merge main only after the final gate. Never force push, overwrite another role's ownership, or require another person's workstation to run Ollama.

## Timeboxes: mandatory merge gates

| Elapsed | Gate | Required result |
|---|---|---|
| 0–20 min | M0 foundation | Scaffold (Tauri shell + Node engine + UI build), shared Zod types incl. Project/Task/Progress, fixtures, scripts, contract README compile |
| 20–55 min | M1 vertical slice | Floating window shows a mocked project with checklist and progress bar; engine stores basic state over WebSocket; mock change/explanation route |
| 55–100 min | M2 live changes | Uncommitted edits detected, deduplicated, suggested to tasks, shown as activity separate from completion — not verified |
| 100–140 min | M3 real Gemma + Verify | Ollama A real grounded explanation + task breakdown; Ollama B independent smoke; user-run Verify updates task status from a real exit code |
| 140–180 min | M4 final demo | End-to-end floating-window workflow on at least one OS, progress report, smoke tests, failure fallback, README and final integration |

Treat each interval as a firm budget. At any slipping gate: deliver a minimal working vertical slice; drop global shortcut, tray icon, frameless/transparent window styling, packaged sidecar binary, sophisticated symbol graphs, direct Claude/Codex SDKs, Git PR automation, extra UI polish, then SQLite if necessary. Never cut real file watching, accurate evidence, the task checklist + honest progress meter, the floating always-on-top window, or a clearly labeled real-vs-mock AI state.

## Shared contracts (P4 writes actual canonical schemas during M0)

- `Project {id,name,rootPath,goal,checkCommands[],createdAt,updatedAt}`; optional `Milestone {id,projectId,title,order}`.
- `Task {id,projectId,milestoneId?,title,order,status,acceptanceCriteria[],evidenceIds,verificationRunIds,statusHistory[],createdAt,updatedAt,lastActivityAt?}`; `AcceptanceCriterion {id,text,met,metBy: none|check|user,checkCommandId?}`. Status enum: `not_started | activity_detected | needs_verification | verified_complete | user_confirmed`. Only a passing linked check or explicit user action can produce `verified_complete`/`user_confirmed`; no change event or model output implies success.
- `ProgressSnapshot {projectId,total,byStatus,percentComplete,criteriaMet,criteriaTotal,stalledTaskIds,regressedTaskIds,lastActivityAt,computedAt}` where `percentComplete = (verified_complete + user_confirmed) / total`. `VerificationRun {id,projectId,taskIds,command,startedAt,finishedAt,exitCode,durationMs,outputTail,result: pass|fail|timeout|error}`.
- `ChangeBatch {id,sessionId,timestamp,source,changes[],omissions[],suggestedTaskLinks[{taskId,score,reason}]}`, `FileChange {path,kind,before?,after?,hunks[]}`, `EvidenceRef {id,path,startLine,endLine,changeBatchId}`. Paths must be workspace-relative (POSIX-style) and safe; timestamps and omissions recorded. Exact property names finalized by P4.
- `ExplanationRequest {sessionId,taskId?,changeBatchIds,level,question?,context}`, `ExplanationResponse {summary,behaviorChanges,concepts,concerns,evidence,uncertainties,quiz?,provider,mode}`. `TaskBreakdownRequest {goal,promptText?}` → `TaskBreakdownSuggestion {tasks[{title,acceptanceCriteria[]}],provider,mode}`. Validate with Zod; never invent file references.
- `EventEnvelope` with sessionId/eventId/type/timestamp/payload, plus typed UI messages: `state_snapshot, progress_updated, change_batch, task_updated, create_task, update_task, reorder_tasks, link_change_to_task, request_breakdown, accept_breakdown, run_verification, verification_result, export_report, request_explanation, ask_followup, preferences_changed, confirm_task, open_file, select_task, window_mode_changed`. Deduplicate events by stable IDs.
- Provide a ModelProvider interface used by a deterministic MockProvider and local OllamaProvider. The UI must explicitly label mock output and model-offline errors.

## Communication branch: low-noise coordination

P4 creates remote `communication` branch with ONLY `coord/*.md` and a branch README. Do not merge this branch into code branches. Fetch/read via `git fetch origin communication` and `git show origin/communication:coord/<name>`. Every agent posts only actionable blocker, cross-team dependency, tested handoff, or verified contract decision. Use new unique .md records; no force pushes or overwrites. Check at startup, after M0, and once around each merge gate; avoid polling or message loops. Example `coord/M2-P2-to-P4-HANDOFF-01.md` with fields ID, stage, from/to, type, branch/SHA, exact tests PASS/FAIL, blocker/action. P4 publishes one consolidated gate result after each merge. If the branch is unavailable, continue from the merged contract and communicate a critical blocker directly.

## Implementation/testing/acceptance rules

- Each stage: implement only owned scope; run targeted typecheck/tests; fix routine bugs; commit and push only your own branch; send one actionable handoff; P4 merges to integration/mvp and runs the integration gate.
- **M1** prove a synthetic change updates the mock UI, the progress bar renders every status segment, and preferences persist. **M2** prove a real 3-file create/edit/delete (no commit) appears with correct safe paths, a suggested task link, and non-verified status while `percentComplete` stays unchanged. **M3** prove one genuine Gemma response from a real observed diff; independent second-machine smoke when available; a user-run passing check moves its task to `verified_complete` and a failing one does not; validate references and offline fallback. **M4** prove goal → tasks → edit → evidence → Verify → progress bar → explanation → question/quiz → progress report, plus relaunch persistence and ignored-secret tests.
- Never say a model tested the change unless a test actually ran. An LLM explanation is not verification. If Ollama is unavailable, retain a functioning explicit mock mode and report Gemma integration NOT VERIFIED.
- At minute 180 deliver a usable README with exact install (incl. Rust/Tauri prerequisites per OS)/build/run/demo commands, configured model tag instructions, which OSes were actually tested, tested scenarios, and known limitations. Give final commit SHAs and failing/passing commands; do not claim unsupported feature completeness.

---

# PROMPT 1 — Tauri floating window + companion UI

**PERSON 1 • NO OLLAMA • Branch `feature/tauri-ui` • Own `src-tauri` window behavior/commands, `src/ui`**

COPY THIS PROMPT TO THE ASSIGNED CODING AGENT. It is self-contained. No attachments, local planning files, or pre-existing application files are supplied.

You are building the entire developer-facing UI — a floating Tauri desktop window — from an empty repository. Read Prompt 0; do NOT request another project spec or wait for missing files. Wait only for P4's M0 shared contract and Tauri skeleton to be committed, then use them. Never implement model inference, filesystem diffs, progress computation, verification command execution, or persistence in your owned modules; the UI renders what the engine reports.

## Product screen and interactions

- **Floating window:** always-on-top by default with a pin toggle; compact default size; resizable; remembers position/size between launches; a **compact mode** that collapses to a slim strip showing project name, progress bar, percent and the current task, expandable with one click. Keep native window decorations for MVP; frameless/transparent styling, tray icon and a global show/hide shortcut are stretch.
- **Project & progress dashboard (home view):** workspace folder picker, project goal, segmented progress bar + percent (verified/confirmed only), per-status counts, criteria met, time since last activity, and attention badges for stalled, unverified-activity and regressed tasks.
- **Task checklist:** create/edit/reorder tasks and acceptance criteria; paste a coding prompt or request an AI breakdown, then review/edit/accept suggestions before they count. Each task expands to show evidence (changed files + line ranges), suggested change links to accept/reassign, verification runs, and status history.
- **Verify & report:** list configured check commands with their exact text; Verify button with running/pass/fail/timeout states and output tail; Export progress report (copy Markdown / save to workspace).
- **Learning:** choose beginner/intermediate/expert, request an explanation, ask follow-ups, request a mini quiz, open cited paths/lines in the user's editor (Rust command using a configured editor command such as `code -g file:line`, else the OS default opener), and manually confirm a task.
- **No false Done:** visually distinguish not started, activity detected, needs verification, verified complete, user confirmed. Include loading, empty state, engine disconnected/reconnecting, model offline, mock label, invalid citation warning.
- Talk to the engine only through P4's typed WebSocket client with Zod-validated messages; render only source refs the engine says exist. Rust commands are limited to window control, folder picking and opening files; validate in Rust that opened paths stay inside the selected workspace.

## Timed deliverables

1. **M0 (0–20):** Review P4 schemas (Project/Task/ProgressSnapshot/VerificationRun) and mock fixture import; confirm the Tauri skeleton launches on your OS; report only critical missing fields.
2. **M1 (20–55):** Floating window config (always-on-top, size, position memory), compact mode, progress dashboard, checklist, explanation card, preferences, and fake event replay against the mock engine. Confirm `npm run tauri dev` launches and types/build pass. Push.
3. **M2 (55–100):** Connect state snapshots, `progress_updated`, ChangeBatch/`task_updated` events from the engine. Show real file activity, suggested task links and evidence; dedupe by ID/session; never raise the percentage on activity. Test bursts and engine reconnect. Push.
4. **M3 (100–140):** Verify flow UI, AI breakdown review/accept, validated Gemma explanation, evidence links, uncertain claims, quiz/answer, beginner/expert and follow-up modes, errors. Test mock and offline UI. Push.
5. **M4 (140–180):** Progress report export, theming (follow OS light/dark), overflow, giant batches, persistence on relaunch, open-in-editor; run the integrated app smoke on your OS and note others untested. Provide exact launch command and final push.

## Interface expectations

Consume engine `state_snapshot`, `progress_updated`, `task_updated`, `verification_result`, explanation and quiz events; emit typed `select_task`, `create_task`, `update_task`, `reorder_tasks`, `link_change_to_task`, `request_breakdown`, `accept_breakdown`, `run_verification`, `export_report`, `preferences_changed`, `request_explanation`, `ask_followup`, `confirm_task`, `open_file` and `window_mode_changed` as agreed at M0. No private or ad hoc message names. Test against the mock engine first; integration is owned by P4.

## Done criteria / handoff

Prove: the app launches as a floating always-on-top window and survives relaunch with position and data intact; a project goal and tasks can be created; a fixture and then an actual observed edit show activity and a suggested task link without moving the percentage; a user-run passing check moves a task to verified and the bar updates; compact mode shows live progress; the user can open a grounded explanation and ask a question; model failure and engine disconnect are visible; the UI works in deterministic mock mode. Report branch commit SHA, OS tested, exact commands, PASS/FAIL, and gaps.

---

# PROMPT 2 — Local edit observer + grounded context

**PERSON 2 • NO OLLAMA • Branch `feature/code-observer` • Own `src/observer` and `src/context`**

COPY THIS PROMPT TO THE ASSIGNED CODING AGENT. It is self-contained. No attachments, local planning files, or pre-existing application files are supplied.

Start with an empty repo and Prompt 0; P4 supplies canonical M0 contracts from code created during this project. Your module runs inside the Node engine (no Rust/Tauri needed to develop or test it) and must detect file edits by ANY local coding agent/editor without Git commits, Claude hooks, Codex SDK, or a running model. Never implement UI, model calls, task completion verdicts, progress percentages, or DB.

## Required responsibilities

- Watch the workspace folder the user selected in the floating window (path passed in by P4's core); baseline relevant file contents, debounce bursts (~2–5 seconds), detect create/modify/delete, normalize to POSIX-style workspace-relative paths (handle macOS/Windows/Linux separators and case rules), and extract readable changed line ranges. Avoid fabricated before/after state when baseline is absent.
- Ignore .git, node_modules, dist/build, target, binaries, large files, .env/secrets/credential patterns. Bound bytes/tokens and clearly report omitted context. Do not follow path traversal or out-of-workspace symlink targets.
- Emit typed ChangeBatch with event ID, timestamp, safe paths, kind, actual hunks, evidence references and suggested task links. Provide start/stop, replayFixture, getContext, retrieveForQuestion and suggestTasks APIs compatible with P4 shared types.
- **Change-to-task attribution hints (feeds completion tracking):** given the current task list (titles, acceptance criteria, files previously linked), score each ChangeBatch against tasks using cheap signals — paths/filenames mentioned in task text, keyword overlap with changed identifiers, files already linked to a task — and return ranked suggestions with a short reason. These are hints only: never link silently, and return none when confidence is low.
- For context retrieval, begin with changed lines and the enclosing function (simple text/regex is okay), then direct imports and nearby dependencies only where cheap. For follow-up questions search changed/related files and cap context; report uncertainty when a symbol is absent.
- Never mark `verified_complete`; return only activity evidence, attribution hints and missing-context indicators. Do not notify the frontend directly; P4 routes events.

## Timed deliverables

1. **M0 (0–20):** Review ChangeBatch, DiffHunk, EvidenceRef, attribution fields, source attribution, omission flags; import fixture.
2. **M1 (20–55):** Export stable start/stop/replayFixture/getContext stubs plus a deterministic suggestTasks stub, and a deterministic multi-file fixture with tests for safe paths and contract conformity. Push.
3. **M2 (55–100):** Implement real observer/diff/debounce/ignore path and test create/edit/delete, three rapid edits, secret exclusion, large file, restart. Run on your OS; note Windows/Linux path behavior if untestable. Push ASAP; this is a critical path gate.
4. **M3 (100–140):** Implement bounded retrieveForQuestion with actual code and exact references; prove nonexistent symbols yield uncertainty. Implement real attribution heuristics; test that a change to `src/auth/login.ts` suggests an "Add login" task and an unrelated change suggests nothing. Push.
5. **M4 (140–180):** Reproduce the 3-file uncommitted edit demo against a demo task list and document limits; fix real-event bugs. No optional Git import unless all tests pass.

## Done criteria / handoff

Run automated tests; show an uncommitted local modification produces accurate safe paths + actual diff (not synthetic), three rapid writes collapse, ignored secrets never enter context, attribution suggestions are sensible on the demo while low-confidence changes stay unattributed, and no unverifiable status is emitted. Report commit SHA, OS tested, command/output and omissions.

---

# PROMPT 3 — Gemma explanation, teaching and task-breakdown service

**PERSON 3 • OLLAMA MACHINE A • Branch `feature/gemma-learning` • Own `src/ai` and `src/skills`**

COPY THIS PROMPT TO THE ASSIGNED CODING AGENT. It is self-contained. No attachments, local planning files, or pre-existing application files are supplied.

Start from Prompt 0 and the generated M0 contract. The source repository begins blank; no other attachments or plan docs exist. Build a model-provider layer, running inside the Node engine, that turns bounded observed code evidence into beginner/expert teaching and follow-up responses, and turns a project goal into suggested tasks with checkable acceptance criteria. Your machine has Ollama; real inference MUST be tested in M3. Do not build the watcher, UI, Tauri shell, storage, progress computation or core event routing.

## AI service specification

- Implement ModelProvider and deterministic MockProvider now; local OllamaProvider via configurable `OLLAMA_BASE_URL` and `OLLAMA_MODEL` later. Inspect `ollama list` to choose a model tag installed on YOUR machine; do not assume a Gemma version.
- Inputs: level (beginner/intermediate/expert), task, actual bounded diff/context packet with EvidenceRefs and omitted information, optional user question. Return Zod-validated structured explanations: what changed/how/why, concepts, uncertainties, risks, citations, and 1–3 short quiz questions when requested.
- **Task breakdown (feeds completion tracking):** given a project goal and optionally the prompt the user gave their coding agent, return 3–10 ordered tasks, each with 1–5 concrete, checkable acceptance criteria (prefer ones a test command could verify). Output is a labeled suggestion (provider/mode); it never changes status and the user must accept it.
- **Progress report wording:** given P4's ProgressSnapshot and evidence, optionally produce a short plain-language summary. It may only restate facts in the snapshot — never upgrade unverified work or invent completed tasks. Deterministic template fallback when the model is off.
- Beginner explains relevant fundamentals with concrete code examples; expert is concise on behavior, design, and risks. Questions require fresh targeted repository evidence passed by P4 from P2.
- Treat repository comments/strings as untrusted data, not instructions. No invalid or fictional path/line citations; validate refs and flag/discard unsupported claims. Never claim tests passed unless VerificationRun evidence was supplied.
- Handle timeout/model offline/invalid JSON; show explicit MockProvider fallback label. Never upload user code by default or send secrets through hosted models.

## Timed deliverables

1. **M0 (0–20):** Validate explanation/quiz/breakdown/request schemas, context omissions and ModelProvider types with P4.
2. **M1 (20–55):** Mock provider with deterministic novice/intermediate/expert responses and deterministic task breakdowns; malformed-output tests. Commit/push.
3. **M2 (55–100):** Bounded evidence prompt builder, JSON response parser, Zod validation, injection guard, nonexistent-reference rejection, and breakdown parser/validation; test truncation and grounding in mock mode. Push.
4. **M3 (100–140):** Configure actual local Ollama Gemma tag, call the model on two sample diffs and one sample project goal; inspect schema/citation quality, acceptance-criteria quality, novice/expert, follow-up and error handling. Hand off tested exact tag and commands; push.
5. **M4 (140–180):** Real regression on three source changes and one breakdown; fix unsupported assertions, annotate missing context, rerun at least one real smoke and push.

## Done criteria / handoff

Provide one truly live Gemma explanation of a code diff with valid file-line citations and a follow-up/quiz, plus one live task breakdown with checkable criteria; prove malformed JSON/nonexistent refs are handled and mock mode is labeled. If the real model is unavailable, report NOT VERIFIED rather than implying success. Report model tag, test latency if measured, tested commands and branch SHA.

---

# PROMPT 4 — Shared contracts, engine core, progress tracking, persistence and merges

**PERSON 4 • OLLAMA MACHINE B • Branch `feature/core-integrations` • Own `src/shared`, `src/core`, `src/storage`, `src/integrations`, root scaffold (incl. initial `src-tauri` skeleton), integration/mvp**

COPY THIS PROMPT TO THE ASSIGNED CODING AGENT. It is self-contained. No attachments, local planning files, or pre-existing application files are supplied.

You are team integration lead and owner of the M0 foundation. Repo: https://github.com/Paarth-K/hacktober-fest.git. Treat it as starting blank. NO separate spec, integration contract, or existing files are provided. Prompt 0 plus this role prompt contain all product requirements. Create docs/INTEGRATION_CONTRACT.md, README, package config, scripts and fixtures yourself; do not instruct teammates to read files you have not committed.

## First 20 minutes are blocking: M0 foundation

1. Clone and inspect repo. Preserve unrelated user data. Initialize a minimal TypeScript npm project containing a Tauri 2 app (React + TypeScript + Vite frontend in `src/ui`, Rust shell in `src-tauri`) and a separate Node engine entry point (e.g. `src/engine/main.ts`), with Zod, testing and fixtures. `npm run dev` starts engine + Tauri together; `npm run engine` runs the engine headless for P2/P3. Avoid elaborate monorepo tooling.
2. Create `src/shared` Zod schemas & event envelopes following Prompt 0 (incl. Project, Task, AcceptanceCriterion, ProgressSnapshot, VerificationRun, TaskBreakdown); publish exact exports, module paths, typed UI messages, provider interface and mock examples in docs/INTEGRATION_CONTRACT.md. Include a typed WebSocket client for P1 and a mock engine that replays fixtures.
3. Commit foundation to main (or the existing intended default branch) and publish; create four feature branches and integration/mvp from it. Tell P1–P3 the commit SHA and to start coding against the same contract.
4. Create the communication branch containing coord/README.md only, with no app files. Use a safe worktree/push strategy. Run npm install, typecheck, schema fixture test, shared imports and a Tauri dev launch on your OS; post M0 gate result.

## Core architecture

- Engine orchestrator associates the project, sessions, task checklists, source changes, verification runs and explanation requests. Persist projects, tasks, status history, verification runs, preferences, events and explanation cache in SQLite if reliable, else JSON in the OS app-data dir. No full code storage by default.
- **Progress engine (headline feature):** recompute ProgressSnapshot on every task/evidence/verification change and push `progress_updated`; apply status rules exactly as in Prompt 0 (activity never raises `percentComplete`); detect stalled tasks and regressions; keep statusHistory with reasons. Unit-test the status rules and the percentage maths.
- **Verification runner:** run only project-configured check commands, only on explicit `run_verification` from the UI, with cwd = workspace root, a timeout, an output size cap and no shell interpolation of user content; store VerificationRun; map passing checks to linked criteria; generate the Markdown progress report on `export_report`.
- Route observer ChangeBatch to task activity state with evidence and P2's suggested task links; deduplicate by event/changeBatch IDs and debounce explanation jobs. Activity is tentative; only explicit user action or a real passing check permits a verified state.
- Run the loopback WebSocket bridge (127.0.0.1 only, random port, per-launch token handed to the Tauri shell) connecting UI, observer, AI and progress engine. Support open-file navigation and follow-up retrieval. Show model status (real/mocked/offline). Expose Analyze now if feasible.
- Configure local Ollama via environment or app settings; test independently on your own Ollama machine using a model tag found via `ollama list`. No Gemma dependency for P1/P2. Optional Claude hooks/Codex App Server adapters are stretch, never blockers.
- Only you own merge gating. Merge tested work into integration/mvp (contract/core → observer → AI → UI), run install, typecheck, tests, Tauri app smoke; record exact fail/reproduction and send fixes to the module owner. Keep the communication branch out of application branches.

## Timed deliverables

1. **M0 (0–20):** Foundation (Tauri shell + engine + shared contract) on main, fixture tests, branch setup, communication README. This is the highest-priority responsibility.
2. **M1 (20–55):** Basic orchestrator + progress engine + persistence + mock event routing over WebSocket; merge role M1 outputs; test sample change → activity (percentage unchanged) → mock explanation in the floating window, and settings persistence.
3. **M2 (55–100):** Integrate real observer + attribution hints and current session persistence; test an actual uncommitted edit, no status inflation, event dedupe, privacy exclusions. Gate/push integration.
4. **M3 (100–140):** Connect P3 provider with local Ollama configuration; run second-machine real Gemma smoke; verification runner with one real passing and one real failing check; route quiz/question/breakdown; tolerate offline; gate.
5. **M4 (140–180):** Resolve merge failures with owners; demo real goal → tasks → 3-file edit → evidence → Verify → progress bar → Gemma → question/quiz → progress report; test relaunch, ignores, errors; write exact launch instructions per OS; merge integration/mvp to main only after the final gate passes.

## Acceptance and deadline decisions

At minute 180 stop scope expansion. Required: runnable Tauri floating always-on-top window on at least one OS (others reported honestly), project goal + task checklist with acceptance criteria, honest progress meter backed by evidence and user-run checks, locally observed uncommitted changes, grounded code explanation via real Gemma if available (explicit mock otherwise), beginner/expert UI and one quiz/follow-up, exportable progress report, stable README and documented tests. Cut tray/global shortcut, frameless styling, sidecar packaging, richer parsing, SDK bridges, PR automation, and advanced persistence first. A successful mock is NOT a validated live Gemma integration. Deliver final branch SHA, tested commands, OS tested, PASS/FAIL and missing functions.
