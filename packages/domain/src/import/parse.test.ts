import { describe, it, expect } from 'vitest';
import iconv from 'iconv-lite';
import { parseCsvBuffer, decodeBuffer, assertSupportedFile } from './parse.ts';
import { detectMapping, isMappingUsable } from './detect.ts';
import { importPipeline } from './pipeline.ts';

const NOW = new Date('2026-10-25T09:00:00Z');

/** A deliberately nasty 500-row export: the kind agencies actually send. */
function buildFixture(count = 500): string {
  const clients = ['Atelier Merlot', 'Studio Kamba', 'Nordwave Digital', 'Bâtiplus SA', 'Helios Conseil'];
  const stages = ['Proposition envoyée', 'Relance 1', 'Négociation', 'Devis validé oralement', 'Relance 2', '???'];
  const lines = ['N° devis;Client;Objet;Montant HT;Date envoi;Stade;Nb relances;Email contact'];
  for (let i = 0; i < count; i += 1) {
    // All dates strictly in the past relative to NOW (2026-10-25): a future
    // proposal date is a data error the pipeline refuses by design.
    const day = String((i % 28) + 1).padStart(2, '0');
    const month = String((i % 8) + 1).padStart(2, '0');
    const amount = i % 19 === 0
      ? '12%'                                                 // a discount column, not an amount
      : i % 17 === 0
        ? '1,5k'                                              // shorthand: 150 000 cents
        : i % 7 === 0
          ? `${(1000 + i * 13).toLocaleString('fr-FR')},50 € HT` // spaced + comma decimals
          : i % 5 === 0
            ? `${(2000 + i).toFixed(2)}`                      // dot decimals
            : `${Math.round(1500 + i * 37)}`;                  // bare integer
    // Four date shapes in one file: ISO, French with a HH:MM timestamp, French
    // with seconds, and dotted dates — the format a CRM export really contains.
    const day2 = String((i % 28) + 1).padStart(2, '0');
    const month2 = String((i % 8) + 1).padStart(2, '0');
    const date = i % 4 === 0
      ? `2026-${month2}-${day2}`
      : i % 4 === 1
        ? `${day2}/${month2}/2026 14:35`
        : i % 4 === 2
          ? `${day2}/${month2}/2026 09:12:44`
          : `${day2}.${month2}.2026`;
    lines.push(
      [
        `D-${1000 + i}`,
        clients[i % clients.length],
        i % 11 === 0 ? '' : `Projet ${i}`,
        amount,
        date,
        stages[i % stages.length],
        String(i % 4),
        i % 3 === 0 ? `contact${i}@exemple.fr` : '',
      ].join(';'),
    );
  }
  return lines.join('\n');
}

describe('encoding', () => {
  it('reads UTF-8 with a BOM', () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Client;Montant\nSociété;1000', 'utf8')]);
    const { text, encoding } = decodeBuffer(buf);
    expect(encoding).toBe('utf-8');
    expect(text.startsWith('Client')).toBe(true);
  });

  it('falls back to Windows-1252 and keeps accents readable', () => {
    const buf = iconv.encode('Client;Montant\nSociété;Bâtiplus', 'windows-1252');
    const { text, encoding } = decodeBuffer(buf);
    expect(encoding).toBe('windows-1252');
    expect(text).toContain('Société');
  });

  it('a naive UTF-8 read of the same buffer would have mangled it', () => {
    const buf = iconv.encode('Société', 'windows-1252');
    expect(buf.toString('utf8')).not.toBe('Société');
  });
});

describe('CSV parsing — 500 rows, three encodings, mixed formats', () => {
  const csv = buildFixture(500);

  for (const enc of ['utf-8', 'windows-1252'] as const) {
    it(`parses ${enc} without crashing and finds 500 rows`, () => {
      const buf = enc === 'utf-8' ? Buffer.from(csv, 'utf8') : iconv.encode(csv, 'windows-1252');
      const parsed = parseCsvBuffer(buf);
      expect(parsed.rows).toHaveLength(500);
      expect(parsed.headers).toContain('Client');
      expect(parsed.delimiter).toBe(';');
      expect(parsed.encoding).toBe(enc === 'utf-8' ? 'utf-8' : 'windows-1252');
    });
  }

  it('detects the columns with confidence above 0.6', () => {
    const parsed = parseCsvBuffer(Buffer.from(csv, 'utf8'));
    const mapping = detectMapping(parsed.headers);
    const byField = Object.fromEntries(mapping.map((m) => [m.field, m]));
    for (const f of ['client_name', 'amount_cents', 'sent_at', 'stage', 'external_ref'] as const) {
      expect(byField[f]!.column).not.toBeNull();
      expect(byField[f]!.confidence).toBeGreaterThan(0.6);
    }
    expect(isMappingUsable(mapping).ok).toBe(true);
  });

  it('imports the whole fixture end-to-end', () => {
    const parsed = parseCsvBuffer(Buffer.from(csv, 'utf8'));
    const mapping = detectMapping(parsed.headers);
    const res = importPipeline(parsed.rows, {
      mapping, existing: [], now: NOW, holdoutRate: 0.2,
      assignArm: () => 'treatment',
    });
    expect(res.stats.rows).toBe(500);
    expect(res.stats.created).toBeGreaterThan(450);
    expect(res.stats.skipped).toBeLessThan(50);
    // Every skip carries an explicit reason.
    for (const s of res.skipped) expect(typeof s.reason).toBe('string');
    // The discount column ("12%") is refused, never guessed into an amount.
    expect(res.skipped.some((s) => s.reason === 'invalid_amount')).toBe(true);
    // "1,5k" is read as 150 000 cents, and every mixing of date shapes parsed.
    const withK = res.toCreate.find((o) => o.amountCents === 150_000);
    expect(withK).toBeDefined();
    for (const o of res.toCreate) {
      expect(Number.isNaN(new Date(o.sentAt).getTime())).toBe(false);
      expect(new Date(o.sentAt) <= NOW).toBe(true);
    }
  });

  it('survives a tab-delimited export', () => {
    const tsv = 'Client\tMontant\tDate envoi\nAtelier\t1200\t06/10/2026';
    const parsed = parseCsvBuffer(Buffer.from(tsv, 'utf8'));
    expect(parsed.delimiter).toBe('\t');
    expect(parsed.rows[0]!.Client).toBe('Atelier');
  });

  it('warns instead of truncating silently', () => {
    const big = buildFixture(600);
    const parsed = parseCsvBuffer(Buffer.from(big, 'utf8'), { maxRows: 100 });
    expect(parsed.rows).toHaveLength(100);
    expect(parsed.warnings.join(' ')).toMatch(/tronqué/i);
  });

  it('warns when there are no columns at all', () => {
    const parsed = parseCsvBuffer(Buffer.from('', 'utf8'));
    expect(parsed.warnings.join(' ')).toMatch(/Aucune colonne/i);
  });
});

describe('file type guard', () => {
  it('accepts csv and refuses xlsx in the pure layer', () => {
    expect(() => assertSupportedFile('export.csv')).not.toThrow();
    expect(() => assertSupportedFile('export.xlsx')).toThrow(/UNSUPPORTED_FILE/);
  });
});
