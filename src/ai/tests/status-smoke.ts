import { OllamaProvider } from '../ollama.js';
const started = Date.now();
const result = await new OllamaProvider().status();
console.log(JSON.stringify({ ...result, latencyMs: Date.now() - started }, null, 2));
if (result.state !== 'real') process.exitCode = 1;
