/**
 * Funnel analytics — the honesty rules, on the real database:
 * allowlisted names only, size-capped props, bots refused, and the schema
 * itself cannot hold financial data (no column for it).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createDb, truncateAll, type Db } from '../../../../packages/db/src/client.ts';
import { recordEvent, isEventName, looksLikeBot, EVENT_NAMES } from '../analytics';

let db: Db;

beforeAll(async () => {
  db = await createDb({ fresh: true });
});

describe('allowlist and bot filter', () => {
  it('accepts exactly the wired funnel events, nothing else', () => {
    expect(EVENT_NAMES).toContain('landing_page_view');
    expect(EVENT_NAMES).toContain('signup_started');
    expect(isEventName('primary_cta_clicked')).toBe(true);
    expect(isEventName('invoice_amount_viewed')).toBe(false);
    expect(isEventName('')).toBe(false);
    expect(isEventName(42)).toBe(false);
  });

  it('refuses obvious crawlers and empty user agents', () => {
    expect(looksLikeBot('Googlebot/2.1')).toBe(true);
    expect(looksLikeBot('curl/8.0')).toBe(true);
    expect(looksLikeBot('python-requests/2.31')).toBe(true);
    expect(looksLikeBot(null)).toBe(true);
    expect(looksLikeBot('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15')).toBe(false);
  });
});

describe('recordEvent — real inserts, real constraints', () => {
  it('writes an anonymous event without workspace and reads it back', async () => {
    await truncateAll(db);
    const ok = await recordEvent(db, {
      name: 'landing_page_view',
      path: '/fr/product',
      locale: 'fr',
      anonymousId: 'an-123',
      props: { cta: 'hero' },
    });
    expect(ok).toBe(true);
    const rows = await db.query<{ name: string; path: string; locale: string; anonymous_id: string | null; workspace_id: string | null; props: Record<string, string> }>(
      `select name, path, locale, anonymous_id, workspace_id, props from analytics_events`,
    );
    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0]!;
    expect(row).toMatchObject({ name: 'landing_page_view', path: '/fr/product', locale: 'fr', anonymous_id: 'an-123' });
    expect(row.workspace_id).toBeNull();
    expect(row.props).toEqual({ cta: 'hero' });
  });

  it('normalizes the locale and keeps unknown locales out', async () => {
    await truncateAll(db);
    await recordEvent(db, { name: 'pricing_viewed', locale: 'de' });
    const rows = await db.query<{ locale: string }>(`select locale from analytics_events`);
    expect(rows.rows[0]!.locale).toBe('fr');
  });

  it('oversized props are refused (no free-text dump into the table)', async () => {
    await truncateAll(db);
    const ok = await recordEvent(db, {
      name: 'primary_cta_clicked',
      props: { blob: 'x'.repeat(1000) },
    });
    expect(ok).toBe(false);
    const n = await db.query<{ n: string }>(`select count(*)::text as n from analytics_events`);
    expect(n.rows[0]!.n).toBe('0');
  });

  it('a bogus workspace reference fails soft (analytics never breaks a flow)', async () => {
    const ok = await recordEvent(db, {
      name: 'prioritization_viewed',
      workspaceId: '00000000-0000-0000-0000-000000000000',
    });
    expect(ok).toBe(false); // FK violation swallowed, logged, flow unaffected
  });

  it('the table has NO column that could hold invoice amounts or client names', async () => {
    const cols = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'analytics_events'`,
    );
    const names = cols.rows.map((r) => r.column_name);
    expect(names.sort()).toEqual(['anonymous_id', 'created_at', 'id', 'locale', 'name', 'path', 'props', 'workspace_id']);
    expect(names).not.toContain('amount');
    expect(names).not.toContain('client');
  });

  it('no grant lets the application role read analytics (service-only table)', async () => {
    const grants = await db.query<{ n: string }>(
      `select count(*)::text as n from information_schema.role_table_grants
        where table_name = 'analytics_events' and grantee = 'app_authenticated'`,
    );
    expect(grants.rows[0]!.n).toBe('0');
  });
});
