/**
 * Test double. Records every call so the acceptance criteria can assert
 * "zero provider calls" — an assertion that only means something if the double
 * is the one being counted.
 */
import type { LlmProvider, LlmRequest, LlmResponse } from '../generate.ts';

export class MemoryProvider implements LlmProvider {
  readonly name = 'memory';
  readonly calls: LlmRequest[] = [];
  private readonly replies: string[];

  constructor(replies: string | string[]) {
    this.replies = Array.isArray(replies) ? replies : [replies];
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push(req);
    const text = this.replies[Math.min(this.calls.length - 1, this.replies.length - 1)]!;
    return { text, model: 'memory-test' };
  }
}

/** A provider that throws, for the provider_error path. */
export class FailingProvider implements LlmProvider {
  readonly name = 'failing';
  calls = 0;
  async complete(): Promise<LlmResponse> {
    this.calls += 1;
    throw new Error('provider timeout');
  }
}
