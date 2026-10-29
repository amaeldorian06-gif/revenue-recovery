import { redirect } from 'next/navigation';
import { isLocale } from '@rros/i18n';
import { getSession } from '../../../../lib/session';
import { getEntitlement } from '../../../../lib/licensing';
import { getDb } from '../../../../lib/db';
import { asSuperuser } from '@rros/db';
import { arSnapshot, PAYMENT_TERM_DAYS } from '@rros/db/ar';
import { sentences, whyNow } from '@rros/domain/scoring/explanations';
import type { ArFilters, ArRow } from '@rros/db/ar';

export const dynamic = 'force-dynamic';

/**
 * Accounts Receivable (AR) — per-client financial view over the workspace's
 * own créances, computed by the same scoring engine as the queue.
 *
 * Honesty rules (see repo/ar.ts): "échu" = open with age > 30 j (standard
 * term, no due-date column exists); DSO shows an explicit "données
 * insuffisantes" state; won amounts are labelled "clôturées gagnantes",
 * never "encaissé". Filters live in the URL (shareable, server-checked).
 */

const eurFmt = (cents: number, locale: string): string =>
  new Intl.NumberFormat(locale === 'fr' ? 'fr-FR' : 'en-GB', {
    style: 'currency', currency: 'EUR', maximumFractionDigits: 0,
  }).format(cents / 100);

type SearchParams = Record<string, string | string[] | undefined>;

function one(sp: SearchParams, key: string): string | undefined {
  const v = sp[key];
  return Array.isArray(v) ? v[0] : v;
}

function readFilters(sp: SearchParams): ArFilters {
  const num = (v: string | undefined): number | undefined => {
    if (v === undefined || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.min(3650, Math.floor(n)) : undefined;
  };
  const status = one(sp, 'status');
  const priority = one(sp, 'priority');
  const view = one(sp, 'view');
  const sort = one(sp, 'sort');
  return {
    q: one(sp, 'q')?.slice(0, 120) || undefined,
    status: status === 'won' || status === 'lost' || status === 'all' ? status : 'open',
    ageMin: num(one(sp, 'age_min')),
    ageMax: num(one(sp, 'age_max')),
    priority: priority === 'high' || priority === 'mid' || priority === 'low' ? priority : undefined,
    view: view === 'priority_high' || view === 'overdue90' || view === 'stale' ? view : 'all',
    sort: sort === 'amount_asc' || sort === 'age_desc' || sort === 'priority_desc' || sort === 'name_asc'
      ? sort : 'amount_desc',
    page: Math.max(1, Number(one(sp, 'page') ?? 1) || 1),
    pageSize: 25,
  };
}

const VIEWS: Array<{ id: NonNullable<ArFilters['view']>; fr: string; en: string; rule: string }> = [
  { id: 'all', fr: 'Tous les clients', en: 'All customers', rule: 'toutes créances ouvertes' },
  { id: 'priority_high', fr: 'Priorité haute', en: 'High priority', rule: 'bande haute de l’indice de relance (≥ 66/100)' },
  { id: 'overdue90', fr: 'Très en retard', en: 'Severely overdue', rule: 'ancienneté ≥ 90 j et échu > 30 j' },
  { id: 'stale', fr: 'Sans contact récent', en: 'Stale', rule: 'dernier contact > 45 j ou jamais' },
];

function buildUrl(base: string, filters: ArFilters, patch: Partial<ArFilters>): string {
  const merged = { ...filters, ...patch };
  const p = new URLSearchParams();
  if (merged.q) p.set('q', merged.q);
  if (merged.status !== 'open') p.set('status', merged.status);
  if (merged.ageMin !== undefined) p.set('age_min', String(merged.ageMin));
  if (merged.ageMax !== undefined) p.set('age_max', String(merged.ageMax));
  if (merged.priority) p.set('priority', merged.priority);
  if (merged.view && merged.view !== 'all') p.set('view', merged.view);
  if (merged.sort !== 'amount_desc') p.set('sort', merged.sort);
  if (merged.page > 1) p.set('page', String(merged.page));
  const qs = p.toString();
  return qs ? `${base}?${qs}` : base;
}

export default async function ArPage({
  params, searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) redirect('/fr');
  const fr = raw === 'fr';
  const session = await getSession();
  if (!session) redirect(`/${raw}/login`);
  const ent = await getEntitlement(session);
  if (!ent.accessAllowed) redirect(`/${raw}/subscription`);

  const filters = readFilters(await searchParams);
  const db = await getDb();
  // Scoring + agrégation : lecture admin du workspace de la session (les
  // montants affichés restent limités à CET espace, jamais autre chose).
  const snap = await asSuperuser(db, () =>
    arSnapshot(db, session.workspaceId, new Date(), filters));
  const { kpis } = snap;
  const totalPages = Math.max(1, Math.ceil(snap.total / snap.pageSize));
  const t = (f: string, e: string) => (fr ? f : e);

  const priorityLabel = { high: t('Priorité haute', 'High priority'), mid: t('Moyenne', 'Medium'), low: t('Faible', 'Low') };

  return (
    <section style={{ margin: '18px auto', maxWidth: 1180, padding: '0 16px' }} data-testid="ar-page">
      <header style={{ display: 'flex', gap: 14, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>{t('Comptes clients — créances', 'Accounts receivable')}</h1>
        <span className="sub" style={{ fontSize: 13 }}>
          {t(`${kpis.clientCount} clients · ${kpis.openCount} créances ouvertes`,
             `${kpis.clientCount} customers · ${kpis.openCount} open receivables`)}
        </span>
        <a className="btn" style={{ marginLeft: 'auto', textDecoration: 'none' }}
           href={`/api/ar?format=csv&status=${filters.status}${filters.view !== 'all' ? `&view=${filters.view}` : ''}${filters.priority ? `&priority=${filters.priority}` : ''}${filters.q ? `&q=${encodeURIComponent(filters.q)}` : ''}`}
           data-testid="ar-export">
          {t('Exporter (CSV)', 'Export (CSV)')}
        </a>
      </header>

      {/* KPIs — each one names its perimeter; no estimate is shown as cash. */}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10, margin: '14px 0' }}>
        <div className="card"><div className="pad">
          <div className="sub" style={{ fontSize: 12 }}>{t('Encours ouvert', 'Total outstanding')}</div>
          <div style={{ fontSize: 21, fontWeight: 680, fontVariantNumeric: 'tabular-nums' }} data-testid="kpi-outstanding">
            {eurFmt(kpis.outstandingCents, raw)}
          </div>
          <div className="sub" style={{ fontSize: 11.5 }}>{t('créances au statut « ouverte »', 'opportunities with status “open”')}</div>
        </div></div>
        <div className="card"><div className="pad">
          <div className="sub" style={{ fontSize: 12 }}>{t('Échu (terme 30 j)', 'Overdue (30-day term)')}</div>
          <div style={{ fontSize: 21, fontWeight: 680, fontVariantNumeric: 'tabular-nums', color: kpis.overdueCents > 0 ? 'var(--warn, #b45309)' : undefined }} data-testid="kpi-overdue">
            {eurFmt(kpis.overdueCents, raw)}
          </div>
          <div className="sub" style={{ fontSize: 11.5 }}>
            {t(`ouvertes de plus de ${PAYMENT_TERM_DAYS} j d’ancienneté`, `open, older than ${PAYMENT_TERM_DAYS} days`)}
          </div>
        </div></div>
        <div className="card"><div className="pad">
          <div className="sub" style={{ fontSize: 12 }}>{t('Encours à relancer en priorité', 'Top-priority outstanding')}</div>
          <div style={{ fontSize: 21, fontWeight: 680, fontVariantNumeric: 'tabular-nums' }} data-testid="kpi-priorityhigh">
            {eurFmt(kpis.priorityHighCents, raw)}
          </div>
          <div className="sub" style={{ fontSize: 11.5 }}>{t('clients de la bande haute de l’indice de relance (≥ 66/100)', 'clients in the high band of the relance index (≥ 66)')}</div>
        </div></div>
        <div className="card"><div className="pad">
          <div className="sub" style={{ fontSize: 12 }}>{t('DSO', 'DSO')}</div>
          <div style={{ fontSize: 15, fontWeight: 680, marginTop: 6 }} data-testid="kpi-dso">
            {t('Données insuffisantes', 'Not enough data')}
          </div>
          <div className="sub" style={{ fontSize: 11.5 }}>
            {t('aucune date d’échéance ni paiement confirmé dans le schéma', 'no due dates or confirmed payments in the schema')}
          </div>
        </div></div>
        <div className="card"><div className="pad">
          <div className="sub" style={{ fontSize: 12 }}>{t('Clôturées gagnantes (30 j)', 'Won & closed (30 d)')}</div>
          <div style={{ fontSize: 21, fontWeight: 680, fontVariantNumeric: 'tabular-nums' }}>
            {eurFmt(kpis.wonClosed30dCents, raw)}
          </div>
          <div className="sub" style={{ fontSize: 11.5 }}>{t('statut « gagnée » ≠ encaissement confirmé', 'status “won” is not a confirmed payment')}</div>
        </div></div>
      </div>

      {/* Saved views — documented rules, one click, URL-synced. */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '12px 0' }} data-testid="ar-views">
        {VIEWS.map((v) => {
          const active = filters.view === v.id;
          return (
            <a key={v.id} href={buildUrl(`/${raw}/ar`, filters, { view: v.id, page: 1 })}
               className={active ? 'pill live' : 'pill'}
               style={{ textDecoration: 'none', outline: active ? '2px solid var(--accent)' : undefined }}
               title={`${t('Règle', 'Rule')} : ${v.rule}`} data-testid={`ar-view-${v.id}`}>
              {fr ? v.fr : v.en}
            </a>
          );
        })}
      </div>

      {/* Filters — a GET form: the state lives in the URL, the server re-checks everything. */}
      <form method="get" action={`/${raw}/ar`} className="card" style={{ marginBottom: 10 }}>
        <div className="pad" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input type="hidden" name="view" value={filters.view} />
          <input name="q" defaultValue={filters.q ?? ''} placeholder={t('Client ou objet…', 'Customer or subject…')}
                 style={{ flex: '1 1 200px' }} aria-label={t('Recherche', 'Search')} data-testid="ar-q" />
          <select name="status" defaultValue={filters.status} aria-label={t('Statut', 'Status')} data-testid="ar-status">
            <option value="open">{t('Ouvertes', 'Open')}</option>
            <option value="all">{t('Tous statuts', 'All statuses')}</option>
            <option value="won">{t('Gagnées', 'Won')}</option>
            <option value="lost">{t('Perdues', 'Lost')}</option>
          </select>
          <select name="priority" defaultValue={filters.priority ?? ''} aria-label={t('Priorité de relance', 'Follow-up priority')} data-testid="ar-priority">
            <option value="">{t('Priorité : toutes', 'Priority: all')}</option>
            <option value="high">{t('Priorité haute', 'High priority')}</option>
            <option value="mid">{t('Priorité moyenne', 'Medium')}</option>
            <option value="low">{t('Priorité faible', 'Low')}</option>
          </select>
          <label style={{ fontSize: 12.5 }}>
            {t('Ancienneté ≥', 'Age ≥')} <input name="age_min" type="number" min={0} max={3650} defaultValue={filters.ageMin ?? ''}
              style={{ width: 76 }} aria-label={t('Ancienneté minimum (jours)', 'Minimum age (days)')} /> {t('j', 'd')}
          </label>
          <button className="btn primary" type="submit" data-testid="ar-apply">{t('Filtrer', 'Apply')}</button>
          <a className="btn" href={`/${raw}/ar`} style={{ textDecoration: 'none' }} data-testid="ar-reset">{t('Réinitialiser', 'Reset')}</a>
        </div>
      </form>

      {snap.total === 0 ? (
        <div className="card"><div className="pad" data-testid="ar-empty">
          <strong>{t('Aucun client ne correspond', 'No customer matches')}</strong>
          <p className="sub" style={{ fontSize: 13 }}>
            {t('Ajustez les filtres ou importez un CSV de créances depuis l’onglet Import.',
               'Adjust the filters or import a receivables CSV from the Import tab.')}
          </p>
          <a className="btn" href={`/${raw}/import`} style={{ textDecoration: 'none' }}>{t('Aller à l’import', 'Go to Import')}</a>
        </div></div>
      ) : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="list" style={{ width: '100%', borderCollapse: 'collapse', minWidth: 860 }} data-testid="ar-table">
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--line-2)' }}>
                <th style={{ padding: '8px 10px' }}>
                  <a href={buildUrl(`/${raw}/ar`, filters, { sort: filters.sort === 'name_asc' ? 'amount_desc' : 'name_asc', page: 1 })}>
                    {t('Client', 'Customer')}{filters.sort === 'name_asc' ? ' ↑' : ''}
                  </a>
                </th>
                <th className="num" style={{ padding: '8px 10px' }}>
                  <a href={buildUrl(`/${raw}/ar`, filters, { sort: filters.sort === 'amount_asc' ? 'amount_desc' : 'amount_asc', page: 1 })}>
                    {t('Encours', 'Outstanding')}{filters.sort.startsWith('amount') ? (filters.sort === 'amount_desc' ? ' ↓' : ' ↑') : ''}
                  </a>
                </th>
                <th className="num" style={{ padding: '8px 10px' }}>{t('Échu 30 j', 'Overdue 30 d')}</th>
                <th className="num" style={{ padding: '8px 10px' }}>
                  <a href={buildUrl(`/${raw}/ar`, filters, { sort: filters.sort === 'age_desc' ? 'amount_desc' : 'age_desc', page: 1 })}>
                    {t('Ancienneté max', 'Oldest age')}{filters.sort === 'age_desc' ? ' ↓' : ''}
                  </a>
                </th>
                <th style={{ padding: '8px 10px' }}>
                  <a href={buildUrl(`/${raw}/ar`, filters, { sort: filters.sort === 'priority_desc' ? 'amount_desc' : 'priority_desc', page: 1 })}>
                    {t('Priorité', 'Priority')}{filters.sort === 'priority_desc' ? ' ↓' : ''}
                  </a>
                </th>
              </tr>
            </thead>
            <tbody>
              {(snap.rows as ArRow[]).map((row) => (
                <tr key={row.client} style={{ borderBottom: '1px solid var(--line-2)' }} data-testid="ar-row">
                  <td style={{ padding: 0 }}>
                    <details>
                      <summary style={{ cursor: 'pointer', padding: '9px 10px', listStyle: 'revert' }}>
                        <strong>{row.client}</strong>
                        <span className="sub" style={{ fontSize: 12, marginLeft: 8 }}>
                          {t(`${row.openCount} créance(s)`, `${row.openCount} item(s)`)}
                          {row.lastTouchAt ? ` · ${t('dernier contact', 'last touch')} ${row.lastTouchAt.slice(0, 10)}` : ` · ${t('jamais contacté', 'never touched')}`}
                        </span>
                      </summary>
                      <div style={{ padding: '4px 12px 12px', background: 'var(--bg-2, #fafafa)' }} data-testid="ar-detail">
                        <p className="sub" style={{ fontSize: 12, margin: '6px 0' }}>
                          {t('Détail par créance — chaque ligne mène au dossier existant (historique, brouillons).',
                             'Per-receivable detail — each line opens the existing dossier (history, drafts).')}
                        </p>
                        {(row.lines as NonNullable<ArRow['lines']>).map((l) => (
                          <div key={l.id} style={{ display: 'flex', gap: 10, padding: '5px 0', borderTop: '1px solid var(--line-2)', fontSize: 13, flexWrap: 'wrap' }}>
                            <a href={`/${raw}/pipeline/${l.id}`}>{l.title ?? t('(sans objet)', '(no subject)')}</a>
                            <span style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>{eurFmt(l.amountCents, raw)}</span>
                            <span className="sub" style={{ minWidth: 130, textAlign: 'right' }}>
                              {t(`${l.ageDays} j · ${l.stage}`, `${l.ageDays} d · ${l.stage}`)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </details>
                  </td>
                  <td className="num" style={{ padding: '9px 10px', fontWeight: 620 }}>{eurFmt(row.outstandingCents, raw)}</td>
                  <td className="num" style={{ padding: '9px 10px', color: row.overdueCents > 0 ? 'var(--warn, #b45309)' : 'var(--ink-3)' }}>
                    {row.overdueCents > 0 ? eurFmt(row.overdueCents, raw) : '—'}
                  </td>
                  <td className="num" style={{ padding: '9px 10px' }}>
                    {row.openCount === 0 ? '—' : t(`${row.oldestAgeDays} j`, `${row.oldestAgeDays} d`)}
                  </td>
                  <td style={{ padding: '9px 10px' }}>
                    {row.openCount === 0 ? (
                      <span className="sub" style={{ fontSize: 12.5 }}>—</span>
                    ) : (
                      <span style={{
                        display: 'inline-block', padding: '2px 9px', borderRadius: 999, fontSize: 12.5, fontWeight: 620,
                        background: row.priorityBand === 'high' ? '#fde8e8' : row.priorityBand === 'mid' ? '#fdf3e0' : '#e7f4ec',
                        color: row.priorityBand === 'high' ? '#b42318' : row.priorityBand === 'mid' ? '#92510a' : '#067647',
                      }}
                        data-testid={`ar-priority-${row.priorityBand}`}
                        title={`${t('Indice de relance', 'Relance index')} : ${row.priorityIndex}/100 · ${t('score moteur', 'engine score')} ${row.priorityScoreCents} · ${row.engineVersion} · ${snap.computedAt.slice(0, 10)}`}>
                        {priorityLabel[row.priorityBand]} · {row.priorityIndex}
                      </span>
                    )}
                    {row.factors.length > 0 && (
                      <span className="sub" style={{ display: 'block', fontSize: 11.5, maxWidth: 260 }}>
                        {whyNow(row.factors, fr ? 'fr' : 'en')}
                      </span>
                    )}
                    {row.factors.length === 0 && row.openCount > 0 && (
                      <span className="sub" style={{ display: 'block', fontSize: 11.5 }}>
                        {t('Pas assez de données pour expliquer', 'Not enough data to explain')}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination — server-side, honest counts. */}
      {snap.total > snap.pageSize && (
        <nav style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10 }} data-testid="ar-pagination"
             aria-label={t('Pagination', 'Pagination')}>
          <span className="sub" style={{ fontSize: 12.5 }}>
            {t(`${snap.total} clients — page ${snap.page}/${totalPages}`,
               `${snap.total} customers — page ${snap.page}/${totalPages}`)}
          </span>
          {snap.page > 1 && (
            <a className="btn" style={{ textDecoration: 'none' }}
               href={buildUrl(`/${raw}/ar`, filters, { page: snap.page - 1 })}>{t('← Précédent', '← Prev')}</a>
          )}
          {snap.page < totalPages && (
            <a className="btn" style={{ textDecoration: 'none' }}
               href={buildUrl(`/${raw}/ar`, filters, { page: snap.page + 1 })}>{t('Suivant →', 'Next →')}</a>
          )}
        </nav>
      )}

      <p className="sub" style={{ fontSize: 11.5, marginTop: 12 }}>
        {t(`Calculé le ${snap.computedAt.slice(0, 16).replace('T', ' ')} UTC · moteur de score ${snap.engineVersion} · « échu » = ouverte de plus de ${PAYMENT_TERM_DAYS} j d’ancienneté (aucune date d’échéance dans les données) · l’indice de priorité est celui du moteur de relance, ce n’est pas une probabilité d’impayé.`,
           `Computed ${snap.computedAt.slice(0, 16).replace('T', ' ')} UTC · scoring engine ${snap.engineVersion} · “overdue” = open older than ${PAYMENT_TERM_DAYS} days (no due-date field exists) · the priority index is the follow-up engine's score, not a default probability.`)}
      </p>
    </section>
  );
}
