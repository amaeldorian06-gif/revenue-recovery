import Papa from 'papaparse';
import iconv from 'iconv-lite';

/**
 * File parsing. Encoding is the first place a French export breaks: Excel on
 * Windows still emits Windows-1252, and a naive UTF-8 read turns "Société" into
 * "SociÃ©tÃ©". Detection is heuristic but explicit about what it chose.
 */

export type Encoding = 'utf-8' | 'windows-1252';

export interface ParsedFile {
  headers: string[];
  rows: Record<string, unknown>[];
  encoding: Encoding;
  delimiter: string;
  warnings: string[];
}

/** Detect the encoding by attempting a strict UTF-8 decode. */
export function decodeBuffer(buf: Buffer): { text: string; encoding: Encoding } {
  // A UTF-8 BOM is decisive.
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8' };
  }
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const text = decoder.decode(buf);
    return { text, encoding: 'utf-8' };
  } catch {
    return { text: iconv.decode(buf, 'windows-1252'), encoding: 'windows-1252' };
  }
}

function detectDelimiter(sample: string): string {
  const candidates = [';', ',', '\t', '|'];
  const firstLine = sample.split(/\r?\n/, 1)[0] ?? '';
  let best = ',';
  let bestCount = -1;
  for (const c of candidates) {
    const count = firstLine.split(c).length - 1;
    if (count > bestCount) {
      bestCount = count;
      best = c;
    }
  }
  return best;
}

export interface ParseOptions {
  /** Hard limits: a 5 MB / 5 000 row file is the product ceiling (phase 02). */
  maxRows?: number;
}

export function parseCsvBuffer(buf: Buffer, opts: ParseOptions = {}): ParsedFile {
  const maxRows = opts.maxRows ?? 5_000;
  const { text, encoding } = decodeBuffer(buf);
  const delimiter = detectDelimiter(text);
  const warnings: string[] = [];

  const result = Papa.parse<Record<string, unknown>>(text, {
    header: true,
    delimiter,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.replace(/^\uFEFF/, '').trim(),
  });

  const headers = (result.meta.fields ?? []).filter((h) => h !== '');
  const rows = result.data.slice(0, maxRows);

  if (result.data.length > maxRows) {
    warnings.push(`Fichier tronqué : ${result.data.length} lignes lues, ${maxRows} importées.`);
  }
  for (const err of result.errors.slice(0, 5)) {
    warnings.push(`Ligne ${err.row ?? '?'} : ${err.message}`);
  }
  if (encoding === 'windows-1252') {
    warnings.push('Encodage détecté : Windows-1252 (export Excel Windows). Les accents ont été convertis.');
  }
  if (headers.length === 0) {
    warnings.push('Aucune colonne détectée : vérifiez que la première ligne contient les en-têtes.');
  }

  return { headers, rows, encoding, delimiter, warnings };
}

/** XLSX is deliberately out of scope for the pure layer: it needs a binary reader. */
export function assertSupportedFile(filename: string): void {
  const ext = filename.toLowerCase().split('.').pop();
  if (!['csv', 'txt', 'tsv'].includes(ext ?? '')) {
    throw new Error(`UNSUPPORTED_FILE:${ext}`);
  }
}
