# Observer + context (P2)

`createObserver(options?)` returns a `LocalObserver`, which implements the shared `Observer`
interface (`src/shared/interfaces.ts`). It runs inside the Node engine and needs no Git, editor
hooks, agent SDK or model.

## What it does

- **Baseline:** on `start({rootPath, sessionId, onBatch, getTasks, onError})` it reads every
  eligible text file (up to 20k files and 64M chars in memory), then watches with chokidar.
- **Debounce:** file events mark paths dirty. A batch is flushed 2.5 s after the last event, and
  at most 10 s after the first one. Three rapid saves become one batch with the final content.
- **Reconcile:** each dirty path is compared with its baseline:
  - created / modified / deleted files get real unified hunks (a bounded Myers diff);
  - a save with identical content emits nothing;
  - CRLF/LF churn is ignored.
- **Honesty:** when no earlier version is known, the change has `baselineMissing: true` and no
  hunks. The observer never invents a "before".
- **Evidence:** each batch gets one `EvidenceRef` per changed line range. For deletes, the lines
  are those of the removed content.
- **Attribution:** `suggestedTaskLinks` come from `suggestTasks`. Signals: the task text names the
  file, the file was in a batch already linked to the task, path words, and identifiers in the
  changed lines. Links under 0.4 are dropped, so low confidence means `[]`. Nothing is ever
  linked automatically.
- **Restart:** `stop()` flushes pending edits. `start()` on the same root keeps the baseline and
  reports edits made while stopped as a `source: "manual"` batch.

## Never read

- **Ignored dirs:** `.git`, `node_modules`, `dist`, `build`, `out`, `target`, `.next`, `.venv`,
  `__pycache__`, `coverage`, `.local-code-companion`, …
- **Secrets:** `.env*`, `*.pem`/`*.key`/`*.p12`, `id_rsa*`, `credentials*`, `*secret*.json|yaml`,
  `.npmrc`, `.netrc`, and the dirs `.ssh`, `.aws`, `.gnupg`. A changed secret file shows up
  only as an `omissions` entry (`reason: "secret"`); its content is never opened.
- **Binary:** detected by extension or a NUL byte.
- **Lockfiles**, minified/map files, and editor temp/swap files.
- **Symlinks:** never followed (`omissions`: `symlink` / `outside_workspace`).
- **Large files** (> 256 KiB): reported as changed with `too_large`, no hunks.

## Context packets

- **`getContext(ids, {maxChars})`** (default 24k chars) returns, in order:
  - the batch diffs;
  - the enclosing function/class of each changed range (regex + brace/indent matching, ≤ 80
    lines, else a window);
  - definitions that the changed lines import from relative modules.
- **`retrieveForQuestion(q, ids, {maxChars})`** (default 16k chars):
  - pulls the symbols the question names (backticks, `camelCase`, `snake_case`, `call()`,
    `a.b`), file names and plain words;
  - searches changed files first, then their direct imports, then other indexed files;
  - anything not found goes in `missing` (for example ``symbol `x` was not found…``);
  - with no IDs it uses the 3 most recent batches.

Every excerpt is a real line range. `evidenceId` is set only when the excerpt contains changed
lines. Unknown or expired batch IDs, including those from an earlier engine run, are listed in
`missing`.

## Extras beyond the interface

- `replayFiles(fixture)` makes a deterministic batch from in-memory files (`MULTI_FILE_FIXTURE`).
- `flush()` processes pending edits now ("Analyze now").
- `rescan()` does a full reconcile.
- `onBatch(cb)`, `status()` and `notifyPath(p)` are also available.
- `restoreBatches(batches)` makes batches from an earlier engine run known again without emitting
  them. Context for them is the stored diffs and evidence only; no excerpts, because the files may
  have changed since those lines were recorded.

## Tests

`npx vitest run src/observer src/context` covers:

- safe paths on POSIX and win32;
- ignore rules;
- diff correctness and caps;
- a live create/edit/delete with no commit;
- three rapid writes collapsing into one batch;
- secrets, `node_modules` and large files excluded;
- unchanged saves emitting nothing;
- restart reporting edits made while stopped;
- attribution (login → "Add login", unrelated change → nothing);
- context and retrieval, including missing symbols.
