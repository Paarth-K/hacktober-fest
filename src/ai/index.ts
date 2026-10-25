export * from './contracts.js';
export * from './context.js';
export * from './mock.js';
export * from './ollama.js';
export * from './service.js';
export * from '../skills/report.js';
// Temporary M0 compatibility: P4 replaces the engine import with aiAdapter.ts.
export { createModelProvider, type ModelProviderOptions } from './foundation-placeholder.js';
