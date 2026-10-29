/**
 * Normalisation of messy spreadsheet input. Every function here is pure and
 * exhaustively tested: this is where a real agency's export either becomes
 * usable or silently destroys the portfolio.
 */

/* ------------------------------------------------------------------ amounts */

const AMOUNT_RE = /^-?[\d\s\u00a0\u202f.,']*\d[\d\s\u00a0\u202f.,']*$/;

export interface AmountParse {
  cents: number | null;
  reason?: 'empty' | 'not_a_number' | 'percentage' | 'negative' | 'zero' | 'too_large';
}

/**
 * "4 500,00 €" → 450000, "4500.00" → 450000, "1,5k" → 150000, "12%" → null.
 * The hard part is not the maths, it is the separator: French uses a comma for
 * decimals and a space for thousands, English does the opposite, and both appear
 * in the same export.
 */
export function parseAmountToCents(input: unknown): AmountParse {
  if (input === null || input === undefined) return { cents: null, reason: 'empty' };
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return { cents: null, reason: 'not_a_number' };
    if (input < 0) return { cents: null, reason: 'negative' };
    if (input === 0) return { cents: null, reason: 'zero' };
    return { cents: Math.round(input * 100) };
  }

  let s = String(input).trim();
  if (s === '') return { cents: null, reason: 'empty' };

  if (s.includes('%')) return { cents: null, reason: 'percentage' };

  // Strip currency symbols and letters used as units; keep digits and separators.
  const multiplier = /k$/i.test(s.replace(/[^\dkK]/g, '')) ? 1000 : 1;
  // Order matters: word units must be removed while the spaces still delimit
  // them, otherwise "12 400 € HT" collapses to "12400€HT" and \bht\b never fires.
  s = s
    .replace(/\b(eur|usd|gbp|ht|ttc|hors taxes|toutes taxes)\b/gi, '')
    .replace(/\u00a0|\u202f|\s/g, '')
    .replace(/[€$£]/g, '')
    .replace(/[kK]$/, '')
    .replace(/'/g, '');

  if (s === '' || !AMOUNT_RE.test(s)) return { cents: null, reason: 'not_a_number' };

  if (s.startsWith('-')) return { cents: null, reason: 'negative' };

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');

  let integerPart: string;
  let decimalPart = '';

  const bothPresent = lastComma >= 0 && lastDot >= 0;
  if (bothPresent) {
    // The right-most separator is the decimal one.
    const decimalSep = lastComma > lastDot ? ',' : '.';
    const idx = lastComma > lastDot ? lastComma : lastDot;
    integerPart = s.slice(0, idx);
    decimalPart = s.slice(idx + 1);
    integerPart = integerPart.replace(decimalSep === ',' ? /\./g : /,/g, '');
  } else if (lastComma >= 0) {
    const occurrences = (s.match(/,/g) ?? []).length;
    const digitsAfter = s.length - lastComma - 1;
    // "4,500" with 3 digits after and no other separator is ambiguous; French
    // exports never write 3 decimals, so treat it as a thousands separator only
    // when the group is exactly 3 digits and the value has no decimals.
    if (occurrences === 1 && digitsAfter === 3) {
      integerPart = s.replace(',', '');
    } else {
      integerPart = s.slice(0, lastComma);
      decimalPart = s.slice(lastComma + 1);
    }
  } else if (lastDot >= 0) {
    const occurrences = (s.match(/\./g) ?? []).length;
    const digitsAfter = s.length - lastDot - 1;
    if (occurrences > 1 || (occurrences === 1 && digitsAfter === 3)) {
      integerPart = s.replace(/\./g, '');
    } else {
      integerPart = s.slice(0, lastDot);
      decimalPart = s.slice(lastDot + 1);
    }
  } else {
    integerPart = s;
  }

  integerPart = integerPart.replace(/[.,]/g, '').replace(/[^\d]/g, '');
  decimalPart = decimalPart.replace(/[^\d]/g, '').slice(0, 2).padEnd(2, '0');

  if (integerPart === '' && decimalPart === '') return { cents: null, reason: 'not_a_number' };
  const cents = Number(integerPart || '0') * 100 + Number(decimalPart || '0');
  if (!Number.isFinite(cents)) return { cents: null, reason: 'not_a_number' };
  if (cents === 0) return { cents: null, reason: 'zero' };
  if (cents > 10_000_000_000) return { cents: null, reason: 'too_large' };
  return { cents: cents * multiplier };
}

/* -------------------------------------------------------------------- dates */

export interface DateParse {
  iso: string | null;
  reason?: 'empty' | 'unparsable' | 'ambiguous';
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/;
const DMY = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})(?:[ T](\d{1,2}):(\d{2}))?/;
const YMD_COMPACT = /^(\d{4})(\d{2})(\d{2})$/;

function build(y: number, m: number, d: number, hh = 0, mm = 0, ss = 0): DateParse {
  if (m < 1 || m > 12 || d < 1 || d > 31 || hh > 23 || mm > 59 || ss > 59) {
    return { iso: null, reason: 'unparsable' };
  }
  const dt = new Date(Date.UTC(y, m - 1, d, hh, mm, ss));
  // Reject roll-over (31 February becoming 3 March).
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return { iso: null, reason: 'unparsable' };
  }
  return { iso: dt.toISOString() };
}

/**
 * Day-first by default (French market). "03/04/2026" → 3 April. The ambiguity is
 * resolved by the data itself: a first component above 12 can only be a day, so
 * the file's convention is inferred from the first unambiguous row and reused.
 */
export function parseDate(input: unknown, convention: 'DMY' | 'MDY' = 'DMY'): DateParse {
  if (input === null || input === undefined) return { iso: null, reason: 'empty' };
  if (input instanceof Date) {
    return Number.isNaN(input.getTime()) ? { iso: null, reason: 'unparsable' } : { iso: input.toISOString() };
  }
  const s = String(input).trim();
  if (s === '') return { iso: null, reason: 'empty' };

  const iso = ISO_DATE.exec(s);
  if (iso) return build(+iso[1]!, +iso[2]!, +iso[3]!, +(iso[4] ?? 0), +(iso[5] ?? 0), +(iso[6] ?? 0));

  const compact = YMD_COMPACT.exec(s);
  if (compact) return build(+compact[1]!, +compact[2]!, +compact[3]!);

  const dmy = DMY.exec(s);
  if (dmy) {
    const a = +dmy[1]!;
    const b = +dmy[2]!;
    const y = +dmy[3]!;
    const hh = +(dmy[4] ?? 0);
    const mm = +(dmy[5] ?? 0);
    if (convention === 'MDY' && a <= 12) return build(y, a, b, hh, mm);
    if (a > 12 && b <= 12) return build(y, b, a, hh, mm); // unambiguous day-first
    if (b > 12 && a <= 12) return build(y, a, b, hh, mm); // unambiguous month-first
    return build(y, b, a, hh, mm); // ambiguous → follow the file convention (DMY)
  }

  const parsed = Date.parse(s);
  if (!Number.isNaN(parsed)) return { iso: new Date(parsed).toISOString() };
  return { iso: null, reason: 'unparsable' };
}

/** Detect the file-level convention from the first unambiguous row. */
export function detectDateConvention(values: unknown[]): 'DMY' | 'MDY' {
  for (const v of values) {
    const m = DMY.exec(String(v ?? '').trim());
    if (!m) continue;
    const a = +m[1]!;
    const b = +m[2]!;
    if (a > 12 && b <= 12) return 'DMY';
    if (b > 12 && a <= 12) return 'MDY';
  }
  return 'DMY';
}

/* ------------------------------------------------------------------- stages */

export const STAGES = [
  'proposal_sent',
  'followup_1',
  'followup_2',
  'followup_3',
  'verbal_yes',
  'negotiation',
  'other',
] as const;
export type Stage = (typeof STAGES)[number];

const STAGE_SYNONYMS: Record<Stage, string[]> = {
  proposal_sent: ['proposition envoyee', 'devis envoye', 'envoye', 'proposal sent', 'sent', 'proposition', 'devis', 'quote sent', 'new'],
  followup_1: ['relance 1', 'relance1', 'follow up 1', 'followup 1', 'relance une', '1ere relance'],
  followup_2: ['relance 2', 'relance2', 'follow up 2', 'followup 2', '2eme relance'],
  followup_3: ['relance 3', 'relance3', 'follow up 3', 'followup 3', '3eme relance'],
  verbal_yes: ['accord oral', 'valide oralement', 'devis valide', 'verbal yes', 'verbal', 'accord de principe'],
  negotiation: ['negociation', 'negotiation', 'discussion', 'en negociation', 'revision'],
  other: ['autre', 'other', 'inconnu', 'unknown', ''],
};

function deburr(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');
}

export function normalizeStage(input: unknown): { stage: Stage; matched: boolean } {
  const raw = deburr(String(input ?? ''));
  if (raw === '') return { stage: 'other', matched: false };

  // Longest synonym wins. Enumeration order cannot decide: "devis valide
  // oralement" contains "devis" (proposal_sent) but is unambiguously verbal_yes.
  let best: { stage: Stage; len: number } | null = null;
  for (const stage of STAGES) {
    for (const syn of STAGE_SYNONYMS[stage]) {
      if (syn === '' || !raw.includes(syn)) continue;
      if (!best || syn.length > best.len) best = { stage, len: syn.length };
    }
  }
  if (best) return { stage: best.stage, matched: true };
  // Numeric or "relance N" shorthand.
  const n = /(?:relance|follow ?up)\s*(\d)/.exec(raw);
  if (n) {
    const idx = Number(n[1]);
    if (idx === 1) return { stage: 'followup_1', matched: true };
    if (idx === 2) return { stage: 'followup_2', matched: true };
    if (idx >= 3) return { stage: 'followup_3', matched: true };
  }
  return { stage: 'other', matched: false };
}

/* --------------------------------------------------------------- text utils */

export function cleanText(input: unknown, max = 200): string | null {
  if (input === null || input === undefined) return null;
  const s = String(input)
    .replace(/\u00a0/g, ' ')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s === '' ? null : s.slice(0, max);
}

export function normalizeEmail(input: unknown): string | null {
  const s = String(input ?? '').trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(s) ? s : null;
}

export function parseDayCount(input: unknown): number | null {
  if (input === null || input === undefined || input === '') return null;
  const n = Number(String(input).replace(/[^\d]/g, ''));
  return Number.isFinite(n) ? n : null;
}
