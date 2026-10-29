/**
 * Criteria 2, 3 and 4 — the retry policy and its two failure modes.
 * Plus a test that the deterministic composer passes its own guardrails in every
 * tone and both locales: a fallback that produces rejected drafts is worse than
 * no fallback, because it hides the problem until a customer sees it.
 */
import { describe, it, expect } from 'vitest';
import { generateDraft, parseDraftJson } from '../generate.ts';
import { MemoryProvider, FailingProvider } from '../providers/memory.ts';
import { LocalComposer } from '../providers/local.ts';
import { validate } from '../guardrails.ts';
import { buildContext } from '../context.ts';

const NOW = new Date('2026-10-25T09:00:00Z');
const baseInput = {
  opportunity: {
    clientName: 'Atelier Merlot',
    title: 'refonte du site vitrine',
    amountCents: 12_400_00,
    sentAt: new Date('2026-10-06T00:00:00Z'),
    stage: 'proposal_sent',
    touchCount: 0,
    lastTouchAt: null,
    contextNote: 'le devis inclut la reprise du blog',
  },
  contact: { firstName: 'Camille', email: 'camille@merlot.fr', locale: 'fr' as const },
  senderName: 'Léa',
  now: NOW,
};

const GOOD = JSON.stringify({
  subject: 'Votre avis sur la refonte',
  body: `Bonjour Camille,

Je vous écris au sujet de la proposition « refonte du site vitrine », transmise le 6 octobre pour un montant de 12 400 €.
Le devis inclut la reprise du blog, ce qui n'était pas dans le périmètre initial.
Cela fait 19 jours qu'elle est entre vos mains, et je préfère suivre votre rythme plutôt que de vous presser.
Avez-vous pu en prendre connaissance ?
Si le moment n'est pas le bon ou si les priorités ont changé, dites-le-moi simplement et je cesserai de vous solliciter.

Bien à vous,
Léa`,
});

const BAD = JSON.stringify({
  subject: 'Dernière relance',
  body: 'Bonjour Camille, une remise de 10 % si vous signez avant le 12 novembre. Urgent ! Bien à vous, Léa',
});

describe('criterion 2 — one regeneration with the violation list', () => {
  it('returns the valid second draft and records exactly one retry', async () => {
    const provider = new MemoryProvider([BAD, GOOD]);
    const res = await generateDraft({ context: baseInput, provider });

    expect(res.draft).not.toBeNull();
    expect(res.draft!.retries).toBe(1);
    expect(res.providerCalls).toBe(2);
    expect(provider.calls).toHaveLength(2);

    // The retry prompt names the violations instead of saying "try again".
    expect(provider.calls[1]!.user).toContain('Violations');
    expect(provider.calls[1]!.user).toMatch(/forbidden_discount|forbidden_deadline/);
  });
});

describe('criterion 3 — double failure returns null, not a bad draft', () => {
  it('returns null with guardrail_failed after exactly two calls', async () => {
    const provider = new MemoryProvider([BAD, BAD]);
    const res = await generateDraft({ context: baseInput, provider });

    expect(res.draft).toBeNull();
    expect(res.reason).toBe('guardrail_failed');
    expect(res.providerCalls).toBe(2);
    expect(res.violations.length).toBeGreaterThan(0);
    expect(res.violations.map((v) => v.code)).toContain('forbidden_discount');
  });

  it('surfaces a provider error instead of throwing', async () => {
    const provider = new FailingProvider();
    const res = await generateDraft({ context: baseInput, provider });
    expect(res.draft).toBeNull();
    expect(res.reason).toBe('provider_error');
  });
});

describe('criterion 4 — insufficient context costs zero provider calls', () => {
  it('returns insufficient_context without calling the provider', async () => {
    const provider = new MemoryProvider(GOOD);
    const res = await generateDraft({
      context: {
        ...baseInput,
        opportunity: { ...baseInput.opportunity, title: null, contextNote: null },
      },
      provider,
    });

    expect(res.draft).toBeNull();
    expect(res.reason).toBe('insufficient_context');
    expect(res.providerCalls).toBe(0);
    expect(provider.calls).toHaveLength(0);
  });
});

describe('parsing', () => {
  it('recovers JSON wrapped in a markdown fence', () => {
    const parsed = parseDraftJson('```json\n{"subject":"s","body":"b"}\n```');
    expect(parsed).toEqual({ subject: 's', body: 'b' });
  });

  it('recovers JSON preceded by a sentence', () => {
    const parsed = parseDraftJson('Voici le brouillon : {"subject":"s","body":"b"} — bonne journée');
    expect(parsed).toEqual({ subject: 's', body: 'b' });
  });

  it('returns null on text that contains no JSON object', () => {
    expect(parseDraftJson('Je ne peux pas répondre à cette demande.')).toBeNull();
  });
});

describe('the deterministic composer passes its own guardrails', () => {
  for (const locale of ['fr', 'en'] as const) {
    for (const tone of ['warm', 'direct', 'formal'] as const) {
      it(`${locale} / ${tone}`, async () => {
        const res = await generateDraft({
          context: { ...baseInput, locale, tone, contact: { ...baseInput.contact!, locale } },
          provider: new LocalComposer(),
        });
        expect(res.reason, JSON.stringify(res.violations)).toBeUndefined();
        expect(res.draft).not.toBeNull();
      });
    }
  }

  it('the composer output really is 60–140 words, not just accepted', async () => {
    const res = await generateDraft({ context: baseInput, provider: new LocalComposer() });
    const ctx = buildContext(baseInput);
    expect(ctx.ok).toBe(true);
    const verdict = validate(
      { subject: res.draft!.subject, body: res.draft!.body },
      (ctx as { ok: true; value: never }).value,
    );
    expect(verdict.wordCount).toBeGreaterThanOrEqual(60);
    expect(verdict.wordCount).toBeLessThanOrEqual(140);
  });
});
