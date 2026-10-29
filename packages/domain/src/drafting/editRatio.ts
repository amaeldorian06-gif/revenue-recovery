/**
 * `edit_ratio = 1 - levenshtein(draft, sent) / max(len(draft), len(sent))` (§8.4).
 *
 * This is product KPI #1: "drafts approved without modification". It is shown to
 * the user as a quality signal about the product, never as a score about them —
 * a human who rewrites everything is giving us information, not failing a test.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Two rolling rows: O(min(n,m)) memory, which matters when a user pastes a page.
  let previous = new Array<number>(b.length + 1);
  let current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j += 1) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      current[j] = Math.min(
        previous[j]! + 1,       // deletion
        current[j - 1]! + 1,    // insertion
        previous[j - 1]! + cost // substitution
      );
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[b.length]!;
}

export function editRatio(draft: string, finalText: string): number {
  const a = normalize(draft);
  const b = normalize(finalText);
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  const ratio = 1 - levenshtein(a, b) / longest;
  return Math.round(Math.max(0, Math.min(1, ratio)) * 10_000) / 10_000;
}

/** Whitespace differences from a textarea round-trip are not human edits. */
function normalize(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
}
