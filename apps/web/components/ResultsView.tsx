'use client';

import { useMemo, useState } from 'react';

export type Locale = 'fr' | 'en';

export interface ResultsViewData {
  headline: { state: 'insufficient_data' | 'no_effect' | 'effect'; text: string };
  attribution: {
    weekStart: string;
    estimateCents: number;
    ciLow: number;
    ciHigh: number;
    pValue: number;
    significant: boolean;
    nTreatment: number;
    nHoldout: number;
    revenueBCents: number;
    revenueCCents: number;
    requiredPerArm: number | null;
    coherenceVerdict: 'ok' | 'investigate';
  };
  series: Array<{ weekStart: string; treatmentCents: number; holdoutCents: number }>;
  weeks: Array<{
    weekStart: string;
    treatment: { nOpportunities: number; nReplies: number; nWon: number; revenueCents: number };
    holdout: { nOpportunities: number; nReplies: number; nWon: number; revenueCents: number };
  }>;
  weeksMeasured: number;
  holdoutCount: number;
  experimentStatus: 'running' | 'stopped' | 'invalidated';
}

const nf = (locale: Locale) => new Intl.NumberFormat(locale === 'fr' ? 'fr-FR' : 'en-GB');
const money = (locale: Locale) => (cents: number) =>
  new Intl.NumberFormat(locale === 'fr' ? 'fr-FR' : 'en-GB', {
    style: 'currency', currency: 'EUR', maximumFractionDigits: 0,
  }).format(cents / 100);
const pct1 = (locale: Locale) => (x: number) =>
  new Intl.NumberFormat(locale === 'fr' ? 'fr-FR' : 'en-GB', {
    minimumFractionDigits: 1, maximumFractionDigits: 1,
  }).format(x * 100) + ' %';

const dateLabel = (locale: Locale) => (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(locale === 'fr' ? 'fr-FR' : 'en-GB', {
    day: 'numeric', month: 'short', timeZone: 'UTC',
  });

export function ResultsView({ locale, data }: { locale: Locale; data: ResultsViewData }) {
  const fr = locale === 'fr';
  const [tableView, setTableView] = useState(false);

  const eur = useMemo(() => money(locale), [locale]);
  const num = useMemo(() => nf(locale), [locale]);
  const percent = useMemo(() => pct1(locale), [locale]);
  const day = useMemo(() => dateLabel(locale), [locale]);

  const a = data.attribution;
  const scale = a.nHoldout > 0 ? a.nTreatment / a.nHoldout : 1;
  const neutral = data.headline.state !== 'effect';
  const totals = useMemo(() => {
    const t = data.weeks.reduce(
      (acc, w) => ({
        n: acc.n + w.treatment.nOpportunities,
        won: acc.won + w.treatment.nWon,
        replies: acc.replies + w.treatment.nReplies,
      }),
      { n: 0, won: 0, replies: 0 },
    );
    const h = data.weeks.reduce(
      (acc, w) => ({ n: acc.n + w.holdout.nOpportunities, won: acc.won + w.holdout.nWon }),
      { n: 0, won: 0 },
    );
    return {
      ...t,
      winRateT: t.n > 0 ? t.won / t.n : 0,
      holdN: h.n,
      winRateH: h.n > 0 ? h.won / h.n : 0,
    };
  }, [data.weeks]);

  const required = a.requiredPerArm;
  const current = Math.min(a.nTreatment, a.nHoldout);
  const progress = required ? Math.min(100, Math.round((100 * current) / Math.max(1, required))) : 100;

  // ---------------------------------------------------------------- chart
  const chartW = 720;
  const chartH = 220;
  const pad = { top: 14, right: 12, bottom: 26, left: 64 };
  const innerW = chartW - pad.left - pad.right;
  const innerH = chartH - pad.top - pad.bottom;

  const maxValue = Math.max(
    1,
    ...data.series.map((p) => p.treatmentCents),
    ...data.series.map((p) => Math.round(p.holdoutCents * scale)),
  );
  const x = (i: number) => pad.left + (data.series.length <= 1 ? 0 : (i / (data.series.length - 1)) * innerW);
  const y = (v: number) => pad.top + innerH - (v / maxValue) * innerH;

  const path = (get: (p: ResultsViewData['series'][number]) => number) =>
    data.series
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(get(p)).toFixed(1)}`)
      .join(' ');

  const treatmentPath = path((p) => p.treatmentCents);
  const holdoutPath = path((p) => Math.round(p.holdoutCents * scale));

  const stateLabel =
    data.headline.state === 'effect'
      ? fr ? 'Effet mesuré' : 'Measured effect'
      : data.headline.state === 'no_effect'
      ? fr ? 'Non concluant' : 'Not conclusive'
      : fr ? 'Mesure en cours' : 'Measuring';

  const dashStyle = { borderColor: '#e4e7ec' } as const;

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {data.experimentStatus !== 'running' && (
        <div
          data-testid="experiment-banner"
          style={{ border: '1px solid #fde3c4', background: '#fffbf3', borderRadius: 10, padding: '10px 13px', fontSize: 13, color: '#7a4a06' }}
        >
          <strong>{fr ? 'Mesure arrêtée.' : 'Measurement stopped.'}</strong>{' '}
          {fr
            ? 'Les chiffres ci-dessous restent affichés comme historique, mais ils ne mesurent plus une relation de cause à effet.'
            : 'The figures below remain as history, but they no longer measure a causal relationship.'}
        </div>
      )}

      {/* 1. La phrase d'en-tête */}
      <div
        className="card"
        data-testid="headline"
        data-state={data.headline.state}
        style={{
          borderColor: neutral ? '#e4e7ec' : '#b7e4d6',
          background: neutral ? '#fff' : 'linear-gradient(180deg,#f7fdfa,#fff)',
        }}
      >
        <div style={{ padding: '16px 18px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span
              className="pill"
              style={{
                background: neutral ? '#f2f4f7' : '#e7f6f0',
                color: neutral ? '#475467' : '#067647',
                fontSize: 11, padding: '2px 8px', borderRadius: 99, fontWeight: 600,
              }}
            >
              {stateLabel}
            </span>
            <span style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>
              {fr ? 'semaine du' : 'week of'} {day(a.weekStart)}
            </span>
          </div>
          <p style={{ margin: 0, fontSize: 17, lineHeight: 1.5, fontWeight: 550, letterSpacing: '-.2px' }}>
            {data.headline.text}
          </p>
        </div>
      </div>

      {/* 2. Trois niveaux */}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        {[
          {
            key: 'A',
            title: fr ? 'A — effet causal' : 'A — causal effect',
            definition: fr
              ? 'Écart entre les dossiers relancés et le groupe témoin, avec un intervalle de confiance à 95 %.'
              : 'Difference between followed-up dossiers and the control group, with a 95 % confidence interval.',
            value: `${eur(a.ciLow)} → ${eur(a.ciHigh)}`,
            sub: fr
              ? `estimation ${eur(a.estimateCents)} · p = ${a.pValue.toFixed(3)}`
              : `estimate ${eur(a.estimateCents)} · p = ${a.pValue.toFixed(3)}`,
            accent: !neutral,
            testid: 'panel-a',
          },
          {
            key: 'B',
            title: fr ? 'B — revenu sur les dossiers relancés' : 'B — revenue on followed-up dossiers',
            definition: fr
              ? `Chiffre d’affaires réellement signé sur les ${num.format(a.nTreatment)} dossiers traités.`
              : `Revenue actually won on the ${num.format(a.nTreatment)} treated dossiers.`,
            value: eur(a.revenueBCents),
            sub: fr
              ? `${num.format(a.nTreatment)} dossiers · ${percent(totals.winRateT)} signés`
              : `${num.format(a.nTreatment)} dossiers · ${percent(totals.winRateT)} won`,
            accent: false,
            testid: 'panel-b',
          },
          {
            key: 'C',
            title: fr ? 'C — ce qui se serait passé de toute façon' : 'C — what would have happened anyway',
            definition: fr
              ? `Revenu du groupe témoin, ramené à l’échelle des dossiers traités (× ${scale.toFixed(2)}).`
              : `Control-group revenue, rescaled to the treated cohort (× ${scale.toFixed(2)}).`,
            value: eur(a.revenueCCents),
            sub: fr
              ? `${num.format(a.nHoldout)} témoins · ${percent(totals.winRateH)} signés · × ${scale.toFixed(2)}`
              : `${num.format(a.nHoldout)} controls · ${percent(totals.winRateH)} won · × ${scale.toFixed(2)}`,
            accent: false,
            testid: 'panel-c',
          },
        ].map((panel) => (
          <div className="card" key={panel.key} data-testid={panel.testid} style={{ borderColor: panel.accent ? '#b7e4d6' : undefined }}>
            <div style={{ padding: '14px 16px' }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '.4px', textTransform: 'uppercase', color: 'var(--ink-2)' }}>
                {panel.title}
              </div>
              <div style={{ fontSize: 22, fontWeight: 680, margin: '6px 0 2px', fontVariantNumeric: 'tabular-nums', letterSpacing: '-.5px' }}>
                {panel.value}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>{panel.sub}</div>
              <p style={{ fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.55, margin: '8px 0 0' }}>
                {panel.definition}
              </p>
            </div>
          </div>
        ))}
      </div>

      {/* 3. Le graphique */}
      <div className="card">
        <div style={{ padding: '14px 16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <div>
              <strong style={{ fontSize: 14 }}>{fr ? 'Revenu cumulé, semaine après semaine' : 'Cumulative revenue, week by week'}</strong>
              <p style={{ fontSize: 11.5, color: 'var(--ink-3)', margin: '2px 0 0' }}>
                {fr
                  ? `Témoin tracé à l’échelle × ${scale.toFixed(2)} (ramené à l’échelle des dossiers traités).`
                  : `Control line drawn at × ${scale.toFixed(2)} (rescaled to the treated cohort).`}
              </p>
            </div>
            <button type="button" className="btn" onClick={() => setTableView((v) => !v)} style={{ padding: '5px 11px', fontSize: 12 }} data-testid="toggle-table">
              {tableView ? (fr ? 'Voir le graphique' : 'See the chart') : (fr ? 'Voir les données' : 'See the data')}
            </button>
          </div>

          {tableView ? (
            <div style={{ overflowX: 'auto', marginTop: 10 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }} data-testid="chart-table">
                <caption style={{ captionSide: 'bottom', textAlign: 'left', fontSize: 11.5, color: 'var(--ink-3)', paddingTop: 6 }}>
                  {fr ? 'Revenu cumulé par semaine, en euros' : 'Cumulative revenue by week, in euros'}
                </caption>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--ink-2)' }}>
                    <th scope="col" style={{ padding: '6px 8px', borderBottom: '1px solid #e4e7ec' }}>{fr ? 'Semaine' : 'Week'}</th>
                    <th scope="col" style={{ padding: '6px 8px', borderBottom: '1px solid #e4e7ec' }}>{fr ? 'Relancés' : 'Treated'}</th>
                    <th scope="col" style={{ padding: '6px 8px', borderBottom: '1px solid #e4e7ec' }}>
                      {fr ? 'Témoin (ramené à l’échelle)' : 'Control (rescaled)'}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.series.map((p) => (
                    <tr key={p.weekStart}>
                      <td style={{ padding: '5px 8px', borderBottom: '1px solid #f2f4f7' }}>{day(p.weekStart)}</td>
                      <td style={{ padding: '5px 8px', borderBottom: '1px solid #f2f4f7', fontVariantNumeric: 'tabular-nums' }}>{eur(p.treatmentCents)}</td>
                      <td style={{ padding: '5px 8px', borderBottom: '1px solid #f2f4f7', fontVariantNumeric: 'tabular-nums' }}>
                        {eur(Math.round(p.holdoutCents * scale))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <svg
              viewBox={`0 0 ${chartW} ${chartH}`}
              role="img"
              aria-label={fr ? 'Revenu cumulé : dossiers relancés et groupe témoin ramené à l’échelle' : 'Cumulative revenue: treated dossiers and rescaled control group'}
              style={{ width: '100%', height: 'auto', marginTop: 8 }}
            >
              {[0, 0.5, 1].map((f) => (
                <g key={f}>
                  <line x1={pad.left} x2={chartW - pad.right} y1={y(maxValue * f)} y2={y(maxValue * f)} stroke="#eef0f3" strokeWidth={1} />
                  <text x={pad.left - 8} y={y(maxValue * f) + 4} textAnchor="end" fontSize={10} fill="#667085">
                    {eur(Math.round(maxValue * f))}
                  </text>
                </g>
              ))}
              <path d={treatmentPath} fill="none" stroke="#0f766e" strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" />
              <path
                d={holdoutPath}
                fill="none"
                stroke="#667085"
                strokeWidth={2}
                strokeDasharray="5 4"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {data.series.map((p, i) => (
                <text key={p.weekStart} x={x(i)} y={chartH - 8} textAnchor="middle" fontSize={9.5} fill="#667085">
                  {i % 2 === 0 ? day(p.weekStart) : ''}
                </text>
              ))}
            </svg>
          )}

          <div style={{ display: 'flex', gap: 16, fontSize: 11.5, color: 'var(--ink-2)', marginTop: 4 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 18, height: 2, background: '#0f766e', display: 'inline-block' }} />
              {fr ? 'dossiers relancés' : 'treated dossiers'}
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 18, height: 0, borderTop: '2px dashed #667085', display: 'inline-block' }} />
              {fr ? 'groupe témoin, ramené à l’échelle' : 'control group, rescaled'}
            </span>
          </div>
        </div>
      </div>

      {/* 4. Progression vers la significativité */}
      <div className="card">
        <div style={{ padding: '14px 16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
            <strong style={{ fontSize: 14 }}>{fr ? 'De quoi conclure' : 'What it takes to conclude'}</strong>
            <span style={{ fontSize: 12, color: 'var(--ink-2)', fontVariantNumeric: 'tabular-nums' }}>
              {required ? `${num.format(current)} / ${num.format(required)} ${fr ? 'par groupe' : 'per arm'}` : (fr ? 'effet non estimable' : 'effect not estimable')}
            </span>
          </div>
          <div style={{ height: 7, background: '#eef0f3', borderRadius: 99, marginTop: 9, overflow: 'hidden' }}>
            <div
              style={{
                height: 7, width: `${required ? progress : 2}%`,
                background: data.headline.state === 'effect' ? '#0f766e' : '#667085',
                borderRadius: 99, transition: 'width .4s ease',
              }}
            />
          </div>
          <p style={{ fontSize: 12, color: 'var(--ink-2)', margin: '9px 0 0', lineHeight: 1.55 }}>
            {required
              ? fr
                ? `Il y a ${num.format(a.nTreatment)} dossiers traités et ${num.format(a.nHoldout)} témoins. Le calcul exige ${num.format(required)} dossiers par groupe pour distinguer un effet de cette taille du hasard.`
                : `There are ${num.format(a.nTreatment)} treated dossiers and ${num.format(a.nHoldout)} controls. The calculation requires ${num.format(required)} per arm to tell an effect of this size from noise.`
              : fr
              ? 'Aucun effet positif n’est mesurable pour l’instant : le nombre de dossiers nécessaires n’a pas de sens tant que l’écart reste nul ou négatif.'
              : 'No positive effect is measurable yet: the number of dossiers required is meaningless while the gap stays at or below zero.'}
          </p>
        </div>
      </div>

      {/* 5. Journal hebdomadaire */}
      <div className="card">
        <div style={{ padding: '14px 16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 14 }}>{fr ? 'Journal des 12 dernières semaines' : 'Last 12 weeks log'}</strong>
            <a className="btn" href="/api/results/export" style={{ padding: '5px 11px', fontSize: 12 }} data-testid="export-csv">
              {fr ? 'Exporter en CSV' : 'Export CSV'}
            </a>
          </div>

          <div style={{ overflowX: 'auto', marginTop: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }} data-testid="weekly-log">
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--ink-2)' }}>
                  {[
                    fr ? 'Semaine' : 'Week',
                    fr ? 'Traités' : 'Treated',
                    fr ? 'Réponses' : 'Replies',
                    fr ? 'Signés' : 'Won',
                    fr ? 'Revenu traité' : 'Treated revenue',
                    fr ? 'Témoins' : 'Controls',
                    fr ? 'Revenu témoin' : 'Control revenue',
                  ].map((h) => (
                    <th key={h} scope="col" style={{ padding: '6px 8px', borderBottom: '1px solid #e4e7ec', fontWeight: 600 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...data.weeks].reverse().map((w) => (
                  <tr key={w.weekStart}>
                    <td style={{ padding: '5px 8px', borderBottom: '1px solid #f2f4f7' }}>{day(w.weekStart)}</td>
                    <td style={{ padding: '5px 8px', borderBottom: '1px solid #f2f4f7', fontVariantNumeric: 'tabular-nums' }}>{num.format(w.treatment.nOpportunities)}</td>
                    <td style={{ padding: '5px 8px', borderBottom: '1px solid #f2f4f7', fontVariantNumeric: 'tabular-nums' }}>{num.format(w.treatment.nReplies)}</td>
                    <td style={{ padding: '5px 8px', borderBottom: '1px solid #f2f4f7', fontVariantNumeric: 'tabular-nums' }}>{num.format(w.treatment.nWon)}</td>
                    <td style={{ padding: '5px 8px', borderBottom: '1px solid #f2f4f7', fontVariantNumeric: 'tabular-nums' }}>{eur(w.treatment.revenueCents)}</td>
                    <td style={{ padding: '5px 8px', borderBottom: '1px solid #f2f4f7', fontVariantNumeric: 'tabular-nums' }}>{num.format(w.holdout.nOpportunities)}</td>
                    <td style={{ padding: '5px 8px', borderBottom: '1px solid #f2f4f7', fontVariantNumeric: 'tabular-nums' }}>{eur(w.holdout.revenueCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p style={{ fontSize: 11.5, color: 'var(--ink-3)', margin: '10px 0 0', lineHeight: 1.6, borderTop: `1px solid ${dashStyle.borderColor}`, paddingTop: 8 }}>
            {fr
              ? `Les ${num.format(data.holdoutCount)} dossiers du groupe témoin n’ont reçu aucun message. C’est la seule raison pour laquelle le niveau A existe : sans eux, un chiffre d’affaires ne prouve rien.`
              : `The ${num.format(data.holdoutCount)} control dossiers received no message. That is the only reason level A exists: without them, revenue proves nothing.`}
          </p>
        </div>
      </div>
    </div>
  );
}
