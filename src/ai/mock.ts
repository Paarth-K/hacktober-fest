import { ExplanationRequestSchema, ExplanationResponseSchema, TaskBreakdownRequestSchema, TaskBreakdownSuggestionSchema, type ExplanationRequest, type ExplanationResponse, type ModelProvider, type TaskBreakdownRequest, type TaskBreakdownSuggestion } from './contracts.js';
import { boundContext } from './context.js';

export class MockProvider implements ModelProvider {
  readonly name = 'deterministic-mock';
  async explain(input: ExplanationRequest): Promise<ExplanationResponse> {
    const request = ExplanationRequestSchema.parse(input);
    const context = boundContext(request.context);
    const detail = { beginner: 'A code edit changes text in a file. Reading that text helps explain its behavior; running a check provides separate evidence about whether it works.', intermediate: 'Review the supplied edits and their dependencies; behavior outside these excerpts is unknown.', expert: 'Bounded excerpt review only; runtime behavior and regressions require verification.' }[request.level];
    return ExplanationResponseSchema.parse({
      summary: `Mock explanation: ${context.excerpts.length} supplied excerpt(s). ${detail}`,
      behaviorChanges: context.excerpts.map(({ evidence }) => `Observed code evidence at ${evidence.path}:${evidence.startLine}–${evidence.endLine}; this mock does not infer behavior.`),
      concepts: [detail], concerns: ['An explanation is not a test result.'], evidence: context.excerpts.map(e => e.evidence),
      uncertainties: [...context.omissions, ...(request.question ? ['This deterministic mock cannot answer the follow-up; request a live model with fresh targeted context.'] : []), 'Mock mode does not perform model inference.'],
      ...(request.includeQuiz ? { quiz: [{ question: 'Does observing a file edit prove that its tests passed?', answer: 'No. A recorded verification run is separate evidence.' }] } : {}),
      provider: this.name, mode: 'mock',
    });
  }
  async breakdown(input: TaskBreakdownRequest): Promise<TaskBreakdownSuggestion> {
    TaskBreakdownRequestSchema.parse(input);
    return TaskBreakdownSuggestionSchema.parse({ tasks: [
      { title: 'Define observable requirements for the goal', acceptanceCriteria: ['Write at least one example input and expected output for the requested behavior.', 'Review and accept the task checklist before implementing it.'] },
      { title: 'Implement the smallest working behavior', acceptanceCriteria: ['Demonstrate the accepted example input producing its expected output.', 'Demonstrate an invalid input producing a documented error.'] },
      { title: 'Verify behavior and record limitations', acceptanceCriteria: ['Run an explicitly selected check and record its exit code.', 'Document unsupported cases and any failing checks.'] },
    ], provider: this.name, mode: 'mock' });
  }
}
