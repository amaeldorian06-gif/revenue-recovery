/**
 * Draft generation — provider-agnostic, deterministic under test.
 *
 * The shape of the contract matters more than the model behind it:
 *   • zero provider calls when the dossier has nothing worth saying;
 *   • exactly one retry, and only with the violation list attached;
 *   • after the second failure, `null` with reasons. Never a doubtful draft.
 *
 * The caller persists the outcome, including the failures: "we could not draft
 * this one" is a product fact, not an incident to swallow.
 */
import { buildContext, type BuildContextInput, type PromptContext } from './context.ts';
import { systemPrompt, userPrompt, violationPrompt, PROMPT_VERSION } from './prompts/v1.ts';
import { validate, violationCodes, type ValidatedDraft, type Violation } from './guardrails.ts';

export interface LlmRequest {
  system: string;
  user: string;
  /** Deterministic tests assert on this, so the template is passed explicitly. */
  promptVersion: string;
}

export interface LlmResponse {
  text: string;
  model: string;
}

export interface LlmProvider {
  readonly name: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export type GenerateFailure = 'insufficient_context' | 'guardrail_failed' | 'provider_error' | 'unparsable';

export interface GeneratedDraft {
  subject: string;
  body: string;
  model: string;
  promptVersion: string;
  /** 0 on the first attempt, 1 after the single authorised retry. */
  retries: number;
  violations: Violation[];
  context: PromptContext;
}

export interface GenerateResult {
  draft: GeneratedDraft | null;
  reason?: GenerateFailure;
  /** Observability: the endpoint test asserts this is 0 for insufficient context. */
  providerCalls: number;
  violations: Violation[];
  context: PromptContext | null;
}

export interface GenerateOptions {
  context: BuildContextInput;
  provider: LlmProvider;
}

const FENCE = /^```(?:json)?\s*|\s*```$/g;

/** Models wrap JSON in fences or add a sentence before it. Both are recovered. */
export function parseDraftJson(raw: string): ValidatedDraft | null {
  const cleaned = raw.replace(FENCE, '').trim();
  const candidates = [cleaned];
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(cleaned.slice(first, last + 1));

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c) as { subject?: unknown; body?: unknown };
      if (typeof parsed.body === 'string') {
        return {
          subject: typeof parsed.subject === 'string' ? parsed.subject.trim() : '',
          body: parsed.body.trim(),
        };
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

export async function generateDraft(opts: GenerateOptions): Promise<GenerateResult> {
  const ctxResult = buildContext(opts.context);
  if (!ctxResult.ok) {
    return { draft: null, reason: ctxResult.reason, providerCalls: 0, violations: [], context: null };
  }
  const ctx = ctxResult.value;

  const system = systemPrompt(ctx);
  const baseUser = userPrompt(ctx);
  const previous = ctx.previousMessages.at(-1) ?? null;

  let providerCalls = 0;
  let lastViolations: Violation[] = [];
  let lastReason: GenerateFailure = 'guardrail_failed';

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const user =
      attempt === 0 ? baseUser : baseUser + violationPrompt(violationCodes(lastViolations), ctx.locale);

    let response: LlmResponse;
    providerCalls += 1;
    try {
      response = await opts.provider.complete({ system, user, promptVersion: PROMPT_VERSION });
    } catch (err) {
      return {
        draft: null,
        reason: 'provider_error',
        providerCalls,
        violations: [{ code: 'empty_body', detail: (err as Error).message }],
        context: ctx,
      };
    }

    const parsed = parseDraftJson(response.text);
    if (!parsed) {
      lastViolations = [{ code: 'empty_body', detail: 'réponse non JSON' }];
      lastReason = 'unparsable';
      continue;
    }

    const verdict = validate(parsed, ctx, previous);
    if (verdict.ok) {
      return {
        draft: {
          subject: parsed.subject,
          body: parsed.body,
          model: response.model,
          promptVersion: PROMPT_VERSION,
          retries: attempt,
          violations: [],
          context: ctx,
        },
        providerCalls,
        violations: [],
        context: ctx,
      };
    }
    lastViolations = verdict.violations;
    lastReason = 'guardrail_failed';
  }

  return { draft: null, reason: lastReason, providerCalls, violations: lastViolations, context: ctx };
}
