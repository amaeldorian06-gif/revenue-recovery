import { describe, it, expect } from 'vitest';
import { renderWeeklyEmail } from '../weeklyEmail.ts';

/** French typography uses narrow no-break spaces; assertions should not depend on them. */
const flat = (s: string) => s.replace(/[\u00a0\u202f\u2009]/g, ' ');

const base = {
  workspaceName: 'Studio Merlot',
  locale: 'fr' as const,
  weekStart: '2026-10-19',
  nReplies: 3,
  nWon: 1,
  revenueCents: 485_000,
  headline: 'À ce stade, nous ne pouvons pas démontrer de gain.',
  queueSize: 8,
  holdoutCount: 13,
};

describe('weekly email', () => {
  it('says what happened, what it is worth, what to do — in three lines', () => {
    const { subject, text } = renderWeeklyEmail(base);
    const body = flat(text);
    const lines = body.trim().split('\n').filter(Boolean);
    expect(flat(subject)).toBe('Votre semaine : 3 réponses, 1 affaire signée');
    expect(lines).toHaveLength(4); // trois lignes + la signature
    expect(body).toContain('3 réponses reçues, 1 affaire signée (4 850 € sur les dossiers relancés).');
    expect(body).toContain('pas démontrer de gain');
    expect(body).toContain('8 dossiers dans la file');
    expect(text).not.toMatch(/!|🎉|exclusif|offre/i);
  });

  it('carries the honest headline verbatim, including when it is not flattering', () => {
    const { text } = renderWeeklyEmail({ ...base, headline: 'Nous ne pouvons rien démontrer.', nWon: 0 });
    expect(flat(text)).toContain('Nous ne pouvons rien démontrer.');
    expect(flat(text)).toContain('0 affaire');
  });

  it('switches language with the workspace', () => {
    const { subject, text } = renderWeeklyEmail({ ...base, locale: 'en' });
    expect(subject).toMatch(/^Your week:/);
    expect(flat(text)).toContain('3 replies received');
    expect(flat(text)).toContain('Studio Merlot');
  });
});
