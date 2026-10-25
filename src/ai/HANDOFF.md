# P3 → P4 tested learning-service handoff

ID: P3-M4-HANDOFF-01
From/to: P3 → P4
Type: tested handoff + pending canonical-contract alignment
Branch: feature/gemma-learning
Initial implementation SHA: be372c66c9984fb37f218b9cda024ddecebabd8d
Final handoff SHA: resolve branch head with `git rev-parse origin/feature/gemma-learning` (this file is committed in that head).
OS: macOS arm64. Node v26.7.0 / npm 11.19.0. Node LTS / other operating systems untested.
Model actually installed/tested: gemma4:31b via Ollama at http://127.0.0.1:11434.

## PASS

- `npm ci --prefix src/ai` (standalone dependency installation).
- `npm run --prefix src/ai typecheck` (strict TypeScript).
- `npm test --prefix src/ai` (12 tests: deterministic level-aware mocks and breakdowns; filtering/budgets; ref validation; malformed JSON; explicit local transport; injection policy serialization; timeout/offline fallback; criterion counts; factual report wording; fictional prose paths; secret/mismatched batch rejection; HTTP/oversized responses).
- `npm audit --prefix src/ai`: zero reported vulnerabilities after upgrading the original Zod 3 dependency to Zod 4.6.7.
- `OLLAMA_MODEL=gemma4:31b AI_SMOKE_OUTPUT=src/ai/tests/live-results.json npm run --prefix src/ai smoke:live`: real beginner explanation + quiz, expert explanation, fresh targeted follow-up, and five-task project breakdown. All four requests PASS; stored raw structured outputs and latency in `tests/live-results.json`. These use explicitly labeled sample excerpts, not a connected watcher.

The first attempt at the live smoke had four successful inference requests but failed at writing the artifact because npm changed cwd. Fixed artifact paths to resolve relative to npm's initial cwd and reran the full command successfully.

## P4 integration action

Read `README.md` in this folder for the exact import/API/input shape. Import `LearningService`, `MockProvider`, `OllamaProvider` from `src/ai/index.ts`. Instantiate a provider according to explicit UI settings and pass bounded context excerpts with EvidenceRefs. `LearningService` preserves `mode: mock` on fallback and exposes `lastFailure` for offline/error UI. Route breakdown output to review/accept UI; never create tasks automatically from a suggestion. Follow-ups must retrieve fresh targeted P2 context before calling `explain`. No code here changes completion status or runs checks.

Use `summarizeProgress` as deterministic short report wording; P4 still owns full Markdown export, evidence assembly and progress math.

No communication branch or shared M0 foundation existed on origin at startup or the follow-up check. The only other remote branch was main at c74e1b3. Consequently P3 schemas are explicitly local boundary types, ready for an adapter/alignment once P4 publishes canonical contracts. The nested package avoids changing P4-owned root scaffold. It is not evidence of integrated UI/engine behavior.

## Limits / not verified

- P2 watcher → P4 router → P3 integration has NOT been tested.
- P4 canonical imports/schema compatibility pending published foundation.
- Independent second-machine inference belongs to P4 and was NOT performed by P3.
- Prompt policy + citation checks reduce injection/hallucination risk but do not prove semantic claims. Explanations never count as verification.
- Secret filtering is heuristic defense in depth; P2 must enforce workspace filtering.
- Completion/test-success phrasing is conservatively rejected; actual check results belong in P4's deterministic report.

## Final observed-edit regression — PASS

`OLLAMA_MODEL=gemma4:31b AI_SMOKE_OUTPUT=src/ai/tests/observed-results.json npm run --prefix src/ai smoke:observed`

Three actual temporary-workspace disk edits were read before and after writing, then submitted to real Gemma. All returned valid structured explanations and citations: cart reducer initial zero (18,599 ms, beginner + quiz), trim normalization (10,691 ms, expert), bounded page size with NaN question (12,827 ms, expert). Raw observed source text and model responses are in `tests/observed-results.json`. Temporary workspace was removed. This tests live inference from disk evidence; it does not claim the P2 watcher was exercised.

The short report formatter expects `percentComplete` as the fraction specified by Prompt 0, formats that value as percent, and does not recompute status-derived completion. P4 must map its canonical numeric convention explicitly if it differs.

## Post-announcement integration regression — PASS

P4's M3-P4-to-P3-BUG-01 reproduced a false positive: express.json() and res.json() were treated as fictional file references. Fixed in 4c210ca with provider-level regression tests. Slashless dotted call expressions are skipped; explicit paths, line ranges and citations remain grounded. Unique supplied basenames are accepted and all supplied ranges for the same file are considered.

Tested a detached checkout of integration/mvp @ a4d8a77 plus fix 4c210ca (local detached commit e4fa175). `npm run check` PASS: root strict typecheck, 31 Vitest tests and 16 Node AI tests. On P3's machine A:

`OLLAMA_MODEL=gemma4:31b npx tsx scripts/live-gemma-smoke.ts /tmp/p3-adapter-after-fix.json`

All three canonical adapter responses returned mode:real: beginner + two quiz questions (25,558 ms), expert follow-up (10,680 ms), six-task breakdown (14,775 ms). Citation arrays had zero invalid refs. Raw receipt copied to `tests/adapter-after-fix-results.json`. This is a local adapter regression; P4's independent machine-B rerun remains P4's responsibility.
