/**
 * Criterion 8 — three known strings, so the metric cannot drift silently.
 * The numbers are the point: `1.0`, `> 0.9`, `< 0.3`.
 */
import { describe, it, expect } from 'vitest';
import { editRatio, levenshtein } from '../editRatio.ts';

const DRAFT = `Bonjour Camille,

Je vous écris au sujet de la proposition « refonte du site vitrine », transmise le 6 octobre pour un montant de 12 400 €.
Le devis inclut la reprise du blog.
Avez-vous pu en prendre connaissance ?
Si ce n'est pas le moment, dites-le-moi simplement.

Bien à vous,
Léa`;

describe('edit_ratio', () => {
  it('1.0 when the draft is sent untouched', () => {
    expect(editRatio(DRAFT, DRAFT)).toBe(1);
  });

  it('above 0.9 when a single word changes', () => {
    const edited = DRAFT.replace('transmise', 'envoyée');
    const r = editRatio(DRAFT, edited);
    expect(r).toBeGreaterThan(0.9);
    expect(r).toBeLessThan(1);
  });

  it('below 0.3 when everything is replaced', () => {
    // A user who rewrites from scratch writes much less than the draft: the
    // denominator is max(len(draft), len(sent)), per §8.4. Measured: 0.29.
    const rewritten = `Bonjour Camille,

Je clos ce dossier de mon côté. Si le besoin revient, écrivez-moi et nous repartirons de zéro.

Cordialement,
Marc`;
    expect(editRatio(DRAFT, rewritten)).toBeLessThan(0.3);
  });

  it('stays between 0.3 and 0.5 for a full rewrite that keeps the greeting and the sign-off', () => {
    // Documented on purpose: a human always keeps "Bonjour" and "Cordialement",
    // so a complete rewrite does not score 0. The metric measures drift, not effort.
    const rewritten = `Bonjour Camille,

Nous avons repensé la proposition : je peux vous proposer un dispositif plus léger, avec un périmètre différent et un budget revu à la baisse.
Dites-moi ce que vous en pensez.

Cordialement,
Marc`;
    const r = editRatio(DRAFT, rewritten);
    expect(r).toBeGreaterThan(0.3);
    expect(r).toBeLessThan(0.5);
  });

  it('ignores whitespace noise from a textarea round-trip', () => {
    expect(editRatio(DRAFT, DRAFT.replace(/\n/g, '\r\n'))).toBe(1);
  });

  it('computes a plain levenshtein distance', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('', 'abc')).toBe(3);
  });
});
