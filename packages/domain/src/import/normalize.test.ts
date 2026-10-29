import { describe, it, expect } from 'vitest';
import {
  parseAmountToCents, parseDate, detectDateConvention,
  normalizeStage, cleanText, normalizeEmail,
} from './normalize.ts';

describe('amounts — 20 real-world variants', () => {
  const cases: [string | number, number | null][] = [
    ['4 500,00 €', 450000],
    ['4500.00', 450000],
    ['1,5k', 150000],
    ['1.5k', 150000],
    ['4\u00a0500,00', 450000],          // non-breaking space
    ['4\u202f500,00', 450000],          // narrow no-break space
    ['12 400 € HT', 1240000],
    ['12400', 1240000],
    ['12400 EUR', 1240000],
    ['12,400.50', 1240050],             // english thousands + decimals
    ['12.400,50', 1240050],             // french thousands + decimals
    ['4,500', 450000],                  // 3 digits after comma = thousands
    ['450,5', 45050],
    ['0,99', 99],
    ['45 000 €', 4500000],
    ["9'900.00", 990000],               // swiss apostrophe
    [4500, 450000],                     // already numeric
    [4500.5, 450050],
    ['€ 8 750', 875000],
    ['  2 100  ', 210000],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${expected}`, () => {
      expect(parseAmountToCents(input).cents).toBe(expected);
    });
  }

  it('rejects a zero amount', () => {
    expect(parseAmountToCents('0')).toEqual({ cents: null, reason: 'zero' });
    expect(parseAmountToCents(0).cents).toBeNull();
  });

  it('rejects a percentage', () => {
    expect(parseAmountToCents('12%').reason).toBe('percentage');
  });

  it('rejects a negative amount', () => {
    expect(parseAmountToCents('-4500').reason).toBe('negative');
    expect(parseAmountToCents(-10).reason).toBe('negative');
  });

  it('rejects empty and garbage', () => {
    expect(parseAmountToCents('').reason).toBe('empty');
    expect(parseAmountToCents('sur devis').reason).toBe('not_a_number');
  });

  it('never returns a float cent', () => {
    const r = parseAmountToCents('1 234,57');
    expect(r.cents).toBe(123457);
    expect(Number.isInteger(r.cents)).toBe(true);
  });
});

describe('dates — day-first market', () => {
  it('03/04/2026 is 3 April (French convention)', () => {
    expect(parseDate('03/04/2026').iso).toBe('2026-04-03T00:00:00.000Z');
  });
  it('15/03/2026 is 15 March (unambiguous)', () => {
    expect(parseDate('15/03/2026').iso).toBe('2026-03-15T00:00:00.000Z');
  });
  it('2026-03-04 is 4 March', () => {
    expect(parseDate('2026-03-04').iso).toBe('2026-03-04T00:00:00.000Z');
  });
  it('keeps the time when present', () => {
    expect(parseDate('2026-03-04 14:35').iso).toBe('2026-03-04T14:35:00.000Z');
    expect(parseDate('04/03/2026 09:12').iso).toBe('2026-03-04T09:12:00.000Z');
  });
  it('does not let the host timezone shift the day', () => {
    const iso = parseDate('01/01/2026').iso!;
    expect(iso.slice(0, 10)).toBe('2026-01-01');
  });
  it('rejects a roll-over date', () => {
    expect(parseDate('31/02/2026').reason).toBe('unparsable');
  });
  it('accepts compact YYYYMMDD', () => {
    expect(parseDate('20260304').iso).toBe('2026-03-04T00:00:00.000Z');
  });
  it('follows the file convention when the file is month-first', () => {
    expect(parseDate('03/04/2026', 'MDY').iso).toBe('2026-03-04T00:00:00.000Z');
  });
});

describe('date convention detection', () => {
  it('detects day-first from an ambiguous sample', () => {
    expect(detectDateConvention(['03/04/2026', '25/12/2026'])).toBe('DMY');
  });
  it('detects month-first', () => {
    expect(detectDateConvention(['03/04/2026', '12/25/2026'])).toBe('MDY');
  });
  it('defaults to day-first on a fully ambiguous file', () => {
    expect(detectDateConvention(['03/04/2026', '05/06/2026'])).toBe('DMY');
  });
});

describe('stages', () => {
  const cases: [string, string][] = [
    ['Proposition envoyée', 'proposal_sent'],
    ['Devis envoyé', 'proposal_sent'],
    ['Relance 1', 'followup_1'],
    ['2eme relance', 'followup_2'],
    ['Relance 3', 'followup_3'],
    ['Devis validé oralement', 'verbal_yes'],
    ['Négociation', 'negotiation'],
    ['NEGOCIATION', 'negotiation'],
    ['Négociation avancée', 'negotiation'],
    ['', 'other'],
    ['???', 'other'],
  ];
  for (const [input, expected] of cases) {
    it(`"${input}" → ${expected}`, () => {
      expect(normalizeStage(input).stage).toBe(expected);
    });
  }
  it('strips accents before matching', () => {
    expect(normalizeStage('RÉLANCE 2').stage).toBe('followup_2');
  });
});

describe('text hygiene', () => {
  it('collapses whitespace and nbsp', () => {
    expect(cleanText('Atelier\u00a0  Merlot  ')).toBe('Atelier Merlot');
  });
  it('strips emoji', () => {
    expect(cleanText('Studio Kamba 🚀')).toBe('Studio Kamba');
  });
  it('returns null on empty', () => {
    expect(cleanText('   ')).toBeNull();
  });
  it('validates emails', () => {
    expect(normalizeEmail(' Camille@Merlot.FR ')).toBe('camille@merlot.fr');
    expect(normalizeEmail('not-an-email')).toBeNull();
    expect(normalizeEmail('a@b')).toBeNull();
  });
});
