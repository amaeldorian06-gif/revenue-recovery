/**
 * Criterion 1 — 18 unit tests, one per forbidden pattern, one per structural
 * rule, and a valid draft that must pass. A validator that rejects everything
 * would pass half of these; the valid case is the one that keeps it honest.
 */
import { describe, it, expect } from 'vitest';
import { validate, countWords, overlap } from '../guardrails.ts';
import type { PromptContext } from '../context.ts';

const ctx: PromptContext = {
  locale: 'fr',
  tone: 'warm',
  contactFirstName: 'Camille',
  clientName: 'Atelier Merlot',
  amount: '12 400 €',
  sentDate: '6 octobre',
  title: 'refonte du site vitrine',
  stage: 'proposal_sent',
  touchNumber: 1,
  daysSinceSend: 19,
  lastTouchDays: null,
  contextNote: 'le devis inclut la reprise du blog',
  previousMessages: [],
  senderName: 'Léa',
};

const VALID = `Bonjour Camille,

Je vous écris au sujet de la proposition « refonte du site vitrine », transmise le 6 octobre pour un montant de 12 400 €.
Le devis inclut la reprise du blog, ce qui n'était pas dans le périmètre initial.
Cela fait 19 jours qu'elle est entre vos mains, et je préfère suivre votre rythme plutôt que de vous presser.
Avez-vous pu en prendre connaissance ?
Si le moment n'est pas le bon ou si les priorités ont changé, dites-le-moi simplement et je cesserai de vous solliciter.

Bien à vous,
Léa`;

const withBody = (body: string) => validate({ subject: 'Votre avis', body }, ctx);

describe('a valid draft passes', () => {
  it('accepts the reference draft — and it is inside the length window', () => {
    const r = withBody(VALID);
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.wordCount).toBeGreaterThanOrEqual(60);
    expect(r.wordCount).toBeLessThanOrEqual(140);
  });

  it('accepts "nous sommes disponibles" — availability is not a commitment', () => {
    const body = VALID.replace('Avez-vous pu', 'Nous sommes disponibles. Avez-vous pu');
    expect(withBody(body).ok).toBe(true);
  });
});

describe('forbidden vocabulary', () => {
  it('rejects "remise de 10 %" (discount)', () => {
    const r = withBody(VALID.replace('Le devis', 'Une remise de 10 % sur le devis'));
    expect(r.violations.map((v) => v.code)).toContain('forbidden_discount');
  });

  it('rejects the word "prix"', () => {
    const r = withBody(VALID.replace('un montant de 12 400 €', 'un prix de 12 400 €'));
    expect(r.violations.map((v) => v.code)).toContain('forbidden_price');
  });

  it('rejects payment terms', () => {
    const r = withBody(VALID.replace('Le devis inclut', 'Le paiement peut être échelonné. Le devis inclut'));
    expect(r.violations.map((v) => v.code)).toContain('forbidden_payment');
  });

  it('rejects a bare percentage, even without the word "remise"', () => {
    const r = withBody(VALID.replace('Le devis inclut', 'Nous pouvons faire 15 %. Le devis inclut'));
    expect(r.violations.map((v) => v.code)).toContain('forbidden_percentage');
  });

  it('rejects an invented deadline', () => {
    const r = withBody(VALID.replace('Le devis inclut', 'Il nous faudrait une réponse avant le 12 novembre. Le devis inclut'));
    expect(r.violations.map((v) => v.code)).toContain('forbidden_deadline');
  });

  it('rejects "urgent"', () => {
    const r = withBody(VALID.replace('Le devis inclut', 'C’est assez urgent pour nous. Le devis inclut'));
    expect(r.violations.map((v) => v.code)).toContain('forbidden_urgency');
  });

  it('rejects "dernière relance"', () => {
    const r = withBody(VALID.replace('Le devis inclut', 'Ceci est ma dernière relance. Le devis inclut'));
    expect(r.violations.map((v) => v.code)).toContain('forbidden_reminder');
  });

  it('rejects "je me permets de revenir vers vous"', () => {
    const r = withBody(VALID.replace('Je vous écris', 'Je me permets de revenir vers vous'));
    expect(r.violations.map((v) => v.code)).toContain('forbidden_reminder');
  });

  it('rejects any claim about a competitor', () => {
    const r = withBody(VALID.replace('Le devis inclut', 'Contrairement à nos concurrents, le devis inclut'));
    expect(r.violations.map((v) => v.code)).toContain('forbidden_competitor');
  });

  it('rejects a date the dossier does not contain', () => {
    const r = withBody(VALID.replace('Le devis inclut', 'Je vous rappelle le 12 novembre. Le devis inclut'));
    expect(r.violations.map((v) => v.code)).toContain('commitment_date');
  });

  it('does not reject the send date itself — it is required by §8.2', () => {
    expect(withBody(VALID).violations.map((v) => v.code)).not.toContain('commitment_date');
  });
});

describe('structure', () => {
  it('rejects more than one question', () => {
    const r = withBody(VALID.replace('Avez-vous pu en prendre connaissance ?', 'Avez-vous pu en prendre connaissance ? Et le budget ?'));
    expect(r.violations.map((v) => v.code)).toContain('structure_question_count');
  });

  it('rejects a draft without a greeting', () => {
    const r = withBody(VALID.replace('Bonjour Camille,', 'Camille,'));
    expect(r.violations.map((v) => v.code)).toContain('structure_no_greeting');
  });

  it('rejects a draft without a signature', () => {
    const r = withBody(VALID.replace('Bien à vous,\nLéa', 'Léa'));
    expect(r.violations.map((v) => v.code)).toContain('structure_no_signature');
  });
});

describe('length, placeholders and encoding', () => {
  it('rejects a draft that is too short', () => {
    const r = withBody('Bonjour Camille,\n\nUne question ?\n\nBien à vous,\nLéa');
    expect(r.violations.map((v) => v.code)).toContain('length_out_of_range');
  });

  it('rejects a draft that is too long', () => {
    const r = withBody(`${VALID}\n${'mot '.repeat(120)}`);
    expect(r.violations.map((v) => v.code)).toContain('length_out_of_range');
  });

  it('rejects an unfilled placeholder', () => {
    const r = withBody(VALID.replace('refonte du site vitrine', '{{titre}}'));
    expect(r.violations.map((v) => v.code)).toContain('placeholder');
  });

  it('rejects an emoji', () => {
    const r = withBody(VALID.replace('Bonjour Camille,', 'Bonjour Camille 👋'));
    expect(r.violations.map((v) => v.code)).toContain('encoding_emoji');
  });

  it('rejects two exclamation marks', () => {
    const r = withBody(VALID.replace('Le devis inclut', 'Bravo !! Le devis inclut'));
    expect(r.violations.map((v) => v.code)).toContain('encoding_exclamations');
  });

  it('rejects a word longer than 40 characters — broken model output', () => {
    const r = withBody(VALID.replace('Le devis inclut', `${'a'.repeat(45)} Le devis inclut`));
    expect(r.violations.map((v) => v.code)).toContain('encoding_long_word');
  });

  it('rejects a body that repeats the previous message too closely', () => {
    const r = validate({ subject: 'x', body: VALID }, ctx, VALID);
    expect(r.violations.map((v) => v.code)).toContain('repetition');
  });
});

describe('helpers', () => {
  it('counts words the way a human does, ignoring punctuation', () => {
    expect(countWords('Bonjour, Camille !')).toBe(2);
  });

  it('measures trigram overlap independently of word order at the sentence level', () => {
    expect(overlap('a b c d', 'a b c d')).toBe(1);
    expect(overlap('a b c d', 'x y z w')).toBe(0);
  });
});
