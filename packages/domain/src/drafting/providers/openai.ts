/**
 * OpenAI-compatible provider (OpenAI, Azure OpenAI, OpenRouter, local vLLM).
 *
 * Only used when a key is configured; the composer stays the default so a trial
 * without credentials is not a dead end. Temperature is low on purpose: this is
 * a business email, not a creative exercise, and the guardrails are the last
 * line of defence, not the first.
 */
import type { LlmProvider, LlmRequest, LlmResponse } from '../generate.ts';

export interface OpenAiConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export class OpenAiProvider implements LlmProvider {
  readonly name = 'openai';
  private readonly cfg: Required<OpenAiConfig>;

  constructor(cfg: OpenAiConfig) {
    this.cfg = {
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.openai.com/v1',
      timeoutMs: 20_000,
      ...cfg,
    };
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    try {
      const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.cfg.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.cfg.model,
          temperature: 0.4,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`provider ${res.status}`);
      const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const text = json.choices?.[0]?.message?.content ?? '';
      return { text, model: this.cfg.model };
    } finally {
      clearTimeout(timer);
    }
  }
}
