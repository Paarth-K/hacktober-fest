# P3 learning service

Owns only `src/ai` and `src/skills`. Entry point: `src/ai/index.ts`.

## Standalone commands

```sh
npm ci --prefix src/ai
npm run --prefix src/ai typecheck
npm test --prefix src/ai
ollama list
OLLAMA_MODEL=gemma4:31b npm run --prefix src/ai smoke:live
```

Node tested: v26.7.0, macOS arm64. Node LTS, Windows and Linux have not been tested here. The tag above was actually installed on this machine; use your own installed Gemma tag. `OLLAMA_BASE_URL` defaults to `http://127.0.0.1:11434` and must resolve through a loopback hostname. Requests reject redirects. No hosted provider is implemented. The deadline budget default per request is 120 seconds.

## Engine handoff

```ts
import { LearningService, MockProvider, OllamaProvider } from './ai/index.js';
const mock = new MockProvider();
// Explicit deterministic operation; no Ollama needed:
const output = await mock.explain(request);
// Local inference with explicitly labeled fallback:
const live = new LearningService(new OllamaProvider({ model: configuredTag }));
const explanation = await live.explain(request);
const suggestion = await live.breakdown({ goal, promptText });
// Inspect live.lastFailure for a model error after either action.
```

`ModelProvider` exposes `name`, `explain`, and `breakdown`. Input/output schemas and types are exported. `LearningService` catches model failures only; invalid caller inputs throw. Fallback outputs always have `mode: 'mock'` and `provider: 'deterministic-mock'`. The explanation includes the failure reason in uncertainties. Task breakdown fallback is labeled mock and `lastFailure` contains the reason. All breakdowns are suggestions; the caller must request user acceptance. No method mutates task state or computes progress.

`ExplanationRequest.context` contains `excerpts: [{ evidence: { id, path, startLine, endLine, changeBatchId }, text }]`, `omissions: string[]`, and optional `verificationRuns: [{id,command,result,exitCode}]`. P2/P4 must supply freshly retrieved targeted excerpts for each follow-up. Ref line ranges are inclusive and refer to the supplied source text. `changeBatchIds` must include every context ref's batch. Ask for a quiz with `includeQuiz: true`. Levels are `beginner | intermediate | expert`.

Shared M0 schemas were not yet published when this module was started. `contracts.ts` is a P3-local boundary, not a replacement for P4 canonical schemas. P4 should map canonical context into the packet above; once the canonical contract is available P3 can align imports. The private nested package provides independent tests without editing P4's root scaffold. Root integration should install Zod and its test tools or use the commands above.

`summarizeProgress(snapshot)` is deterministic wording from P4 facts only, always available without a model. It does not calculate percentages, render a full evidence report, execute checks, or infer completion.

## Boundaries

Source excerpts are limited to 24,000 UTF-8 bytes (including ref metadata); oversized excerpts are omitted whole to preserve line-range meaning. Omission messages and verification summaries have separate small caps. Secret-like paths and common credential patterns are excluded. Secret heuristics are defense in depth; P2 remains responsible for filtering source files before retrieval. Goal/task/question text matching common secret patterns is rejected before local inference.

JSON shape, citation IDs, paths, batches and line bounds are checked. Explicit slash-separated file references in prose are also checked. Invalid output is discarded, and the service can return an explicit mock. Prompts treat repository contents as untrusted data. These checks cannot prove semantic claims or prevent every prompt injection. Model content must remain explanation only and never affect verification or progress status. Conservative completion/test-success wording is rejected even when a supplied verification run might support it; P4's deterministic report is the authority for check results.

The live smoke uses sample source excerpts, not the not-yet-integrated P2 watcher. A separate observed-edit regression creates and edits three files in an isolated temporary workspace, reads their real before/after contents, and submits bounded evidence. This tests inference from actual disk edits but does not validate P2 watcher integration. Live result artifacts record precise commands/output separately. No independent second-machine test is performed by P3.
