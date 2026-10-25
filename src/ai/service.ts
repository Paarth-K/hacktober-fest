import type { ExplanationRequest, ExplanationResponse, ModelProvider, TaskBreakdownRequest, TaskBreakdownSuggestion } from './contracts.js';
import { MockProvider } from './mock.js';
import { ModelError } from './ollama.js';

export interface ProviderFailure { code: string; message: string; provider: string }
export class LearningService implements ModelProvider {
  readonly name = 'learning-service';
  lastFailure: ProviderFailure | undefined;
  constructor(private readonly primary: ModelProvider, private readonly fallback: ModelProvider = new MockProvider()) {}
  private async run<T>(action: (provider: ModelProvider) => Promise<T>): Promise<{ value: T; failure?: ProviderFailure }> {
    try { const value = await action(this.primary); this.lastFailure = undefined; return { value }; }
    catch (error) {
      // Caller input errors must not be disguised as model outages.
      if (!(error instanceof ModelError)) throw error;
      const failure = { code: error.code, message: error.message, provider: this.primary.name };
      this.lastFailure = failure;
      return { value: await action(this.fallback), failure };
    }
  }
  async explain(request: ExplanationRequest): Promise<ExplanationResponse> {
    const result = await this.run(provider => provider.explain(request));
    return result.failure ? { ...result.value, uncertainties: [...result.value.uncertainties, `Live model ${result.failure.code}: ${result.failure.message}. Explicit mock fallback.`].slice(-20) } : result.value;
  }
  async breakdown(request: TaskBreakdownRequest): Promise<TaskBreakdownSuggestion> {
    return (await this.run(provider => provider.breakdown(request))).value;
  }
}
