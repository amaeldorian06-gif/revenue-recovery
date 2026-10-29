import { LocalComposer } from './local.ts';
import { OpenAiProvider } from './openai.ts';
import type { LlmProvider } from '../generate.ts';

/**
 * Which writer answers. No key → the deterministic composer, which keeps the
 * flow usable in a trial. LLM_PROVIDER=local forces it even with a key, which is
 * what the end-to-end tests use.
 */
export function defaultProvider(env: Record<string, string | undefined> = process.env): LlmProvider {
  const forced = env.LLM_PROVIDER;
  if (forced === 'local' || !env.OPENAI_API_KEY) return new LocalComposer();
  return new OpenAiProvider({
    apiKey: env.OPENAI_API_KEY,
    model: env.LLM_MODEL ?? 'gpt-4o-mini',
    baseUrl: env.OPENAI_BASE_URL,
  });
}

export { LocalComposer, OpenAiProvider };
