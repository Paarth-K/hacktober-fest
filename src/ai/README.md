# AI providers

The AI layer owns bounded explanations and task-breakdown suggestions. Its public entry point is `src/ai/index.ts`; the canonical engine adapter is `src/integrations/aiAdapter.ts`.

## Standalone commands

```sh
npm ci --prefix src/ai
npm run --prefix src/ai typecheck
npm test --prefix src/ai
OLLAMA_MODEL=<tag from `ollama list`> npm run --prefix src/ai smoke:live
OLLAMA_MODEL=<tag from `ollama list`> npm run --prefix src/ai smoke:observed
OLLAMA_MODEL=<tag from `ollama list`> npm run --prefix src/ai smoke:status
```

The standalone package uses local Ollama at `http://127.0.0.1:11434` by default. Set `OLLAMA_BASE_URL` only to a loopback address. The provider selects `OLLAMA_MODEL`, or the first installed `gemma*` tag when no model is configured. The root integration also supports a deterministic mock provider and falls back to labeled mock output when Ollama is unavailable.

## Engine boundary

```ts
import { LearningService, MockProvider, OllamaProvider } from "./ai/index.js";

const mock = new MockProvider();
const output = await mock.explain(request);
const live = new LearningService(new OllamaProvider({ model: configuredTag }));
const explanation = await live.explain(request);
const suggestion = await live.breakdown({ goal, promptText });
```

`LearningService` validates inputs and model output, bounds context, checks citations, and returns a deterministic mock response when the live provider fails. Breakdowns are suggestions only; the caller must request user acceptance before creating tasks. This layer does not mutate task state, compute progress, execute checks, or treat an explanation as verification.

`ExplanationRequest.context` contains bounded excerpts with evidence IDs, omissions, and optional verification summaries. Follow-up questions should supply freshly retrieved context. Citation ranges are inclusive and must refer to the supplied excerpts.

## Safety boundary

Context is capped by size, secret-like paths and credential patterns are excluded, and repository text is treated as untrusted data rather than instructions. Invalid JSON, citations, paths, or line ranges are rejected or converted to an explicitly labeled mock result. These checks reduce risk but cannot prove semantic correctness; the deterministic progress and verification layers remain authoritative.
