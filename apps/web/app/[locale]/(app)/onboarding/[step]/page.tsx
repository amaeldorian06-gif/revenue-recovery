import { redirect } from 'next/navigation';
import { translator, isLocale, type MessageKey } from '@rros/i18n';
import { getSession } from '../../../../../lib/session';
import { asAdmin, withTenant } from '../../../../../lib/db';
import { getOnboardingState, demoOpportunities } from '@rros/db/onboarding';
import { portfolioSummary } from '@rros/db/imports';
import {
  generateFirstQueueAction, onboardingAccountAction, onboardingDemoAction,
  onboardingMailboxAction, replaceDemoAction,
} from '../../../../../lib/actions/onboarding';
import { ImportUpload } from '../../../../../components/ImportUpload';

export const dynamic = 'force-dynamic';

const STEPS = ['account', 'mailbox', 'import', 'calibration', 'queue'] as const;

const HOLDOUT_WORDING = {
  fr: '20 % de vos dossiers ne recevront aucune action de notre part. C’est ce qui nous permettra de vous dire, dans six mois, ce que le produit vous a réellement rapporté. Nous ne pouvons pas le mesurer autrement.',
  en: '20 % of your dossiers will receive no action from us. That is what will let us tell you, in six months, what the product really earned you. There is no other way to measure it.',
} as const;

const eur = (c: number, locale: 'fr' | 'en') =>
  new Intl.NumberFormat(locale === 'fr' ? 'fr-FR' : 'en-GB', {
    style: 'currency', currency: 'EUR', maximumFractionDigits: 0,
  }).format(c / 100);

export default async function OnboardingPage({
  params, searchParams,
}: {
  params: Promise<{ locale: string; step: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { locale: rawLocale, step: rawStep } = await params;
  if (!isLocale(rawLocale)) redirect('/fr');
  const locale = rawLocale;
  const query = await searchParams;
  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);
  const tr = translator(locale);

  const step = Math.min(5, Math.max(1, Number(rawStep) || 1));
  const state = await asAdmin((db) => getOnboardingState(db, session.workspaceId));
  // Resumable: never step backwards by URL. A bookmark to /onboarding/1 after
  // finishing step 3 lands on step 3.
  const effective = Math.max(step, state.currentStep);
  if (effective !== step) redirect(`/${locale}/onboarding/${effective}`);

  const pct = Math.round(((effective - 1) / 4) * 100);

  return (
    <section style={{ maxWidth: 760, margin: '0 auto' }}>
      <div data-testid="onboarding" data-step={effective}>
        <div style={{ display: 'flex', gap: 6, margin: '26px 0 8px' }}>
          {STEPS.map((name, i) => (
            <div key={name} style={{
              flex: 1, height: 4, borderRadius: 99,
              background: i < effective ? 'var(--accent)' : '#e6e8ec',
            }} />
          ))}
        </div>
        <p className="sub" style={{ marginBottom: 18 }}>
          {tr('onboarding.step')} {effective}/5 · {pct} %
        </p>

        {effective === 1 && <StepAccount locale={locale} tr={tr} state={state} />}
        {effective === 2 && <StepMailbox locale={locale} query={query} />}
        {effective === 3 && <StepImport locale={locale} query={query} hasDemo={state.demoData} />}
        {effective === 4 && <StepCalibration locale={locale} workspaceId={session.workspaceId} />}
        {effective === 5 && <StepQueue locale={locale} firstQueueAt={state.firstQueueAt} />}
      </div>
    </section>
  );
}

type Tr = (key: MessageKey) => string;

function StepAccount({ locale, tr, state }: {
  locale: 'fr' | 'en'; tr: Tr;
  state: Awaited<ReturnType<typeof getOnboardingState>>;
}) {
  return (
    <form action={onboardingAccountAction}>
      <div className="card"><div className="pad">
        <h2>{tr('onboarding.account.title')}</h2>
        <p className="sub">{tr('onboarding.account.sub')}</p>
        <label style={labelStyle}>{tr('onboarding.timezone')}
          <input name="timezone" defaultValue={state.timezone ?? 'Europe/Paris'}
            style={inputStyle} data-testid="tz-input" />
        </label>
        <label style={labelStyle}>{tr('common.locale')}
          <select name="locale" defaultValue={locale} style={inputStyle}>
            <option value="fr">Français</option>
            <option value="en">English</option>
          </select>
        </label>
        <button className="btn primary" type="submit" data-testid="step1-continue">
          {tr('onboarding.continue')}
        </button>
      </div></div>
    </form>
  );
}

async function StepMailbox({ locale, query }: {
  locale: 'fr' | 'en'; query: Record<string, string | undefined>;
}) {
  const session = await getSession();
  const error = query.error;
  return (
    <div className="card"><div className="pad">
      <h2>{locale === 'fr' ? 'Votre boîte d’envoi' : 'Your sending mailbox'}</h2>
      <p className="sub">
        {locale === 'fr'
          ? 'Le produit envoie depuis votre propre adresse. Sans boîte, tout part en bac à sable : les emails sont interceptés, rien n’atteint un client.'
          : 'The product sends from your own address. Without a mailbox everything stays in sandbox: emails are intercepted, no client is ever reached.'}
      </p>
      {error === 'mailbox_limit' && (
        <p data-testid="mailbox-limit" style={{ color: '#b42318', fontWeight: 600 }}>
          {locale === 'fr' ? 'Limite de boîtes atteinte pour votre offre.' : 'Mailbox limit reached for your plan.'}
        </p>
      )}
      <form action={onboardingMailboxAction} style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
        <input type="hidden" name="choice" value="gmail" />
        <button className="btn" type="submit" data-testid="connect-gmail">
          {locale === 'fr' ? 'Connecter Gmail (OAuth)' : 'Connect Gmail (OAuth)'}
        </button>
      </form>
      <form action={onboardingMailboxAction} style={{ display: 'flex', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
        <input type="hidden" name="choice" value="smtp_imap" />
        <input name="host" placeholder="smtp.exemple.fr" style={{ ...inputStyle, maxWidth: 240 }} />
        <button className="btn" type="submit" data-testid="connect-smtp">SMTP / IMAP</button>
      </form>
      <form action={onboardingMailboxAction} style={{ marginTop: 16 }}>
        <input type="hidden" name="choice" value="later" />
        <button className="btn primary" type="submit" data-testid="mailbox-later">
          {locale === 'fr' ? 'Configurer plus tard — essayer en bac à sable' : 'Configure later — try in sandbox'}
        </button>
      </form>
      {query.sandbox === '1' && null}
      <p className="sub" style={{ marginTop: 12, fontSize: 12.5 }}>
        {locale === 'fr'
          ? '« Configurer plus tard » active le mode bac à sable et vous le dit clairement : chaque envoi est préfixé [SANDBOX] et dirigé vers votre propre adresse.'
          : '“Configure later” switches to sandbox mode and says so: every send is prefixed [SANDBOX] and redirected to your own address.'}
      </p>
      {session === null && <p>session</p>}
    </div></div>
  );
}

async function StepImport({ locale, query, hasDemo }: {
  locale: 'fr' | 'en'; query: Record<string, string | undefined>; hasDemo: boolean;
}) {
  const session = await getSession();
  const demoRows = demoOpportunities().length;
  return (
    <div className="card"><div className="pad">
      <h2>{locale === 'fr' ? 'Vos dossiers' : 'Your dossiers'}</h2>
      <p className="sub">
        {locale === 'fr'
          ? 'Importez un export CSV de votre logiciel, ou essayez avec un portefeuille de démonstration.'
          : 'Import a CSV export from your software, or try with a demo portfolio.'}
      </p>
      {query.error === 'not_empty' && (
        <p data-testid="demo-guard" style={{ color: '#b42318', fontWeight: 600 }}>
          {locale === 'fr'
            ? 'Cet espace contient déjà de vraies données : impossible d’y mélanger la démonstration.'
            : 'This workspace already holds real data: the demo cannot be mixed in.'}
        </p>
      )}
      {query.replaced === '1' && (
        <p data-testid="demo-replaced" style={{ color: '#067647', fontWeight: 600 }}>
          {locale === 'fr' ? 'Données de démonstration remplacées.' : 'Demo data replaced.'}
        </p>
      )}
      <form action={onboardingDemoAction} style={{ marginTop: 12 }}>
        <button className="btn primary" type="submit" data-testid="use-demo">
          {locale === 'fr'
            ? `Essayer avec des données de démonstration (${demoRows} dossiers)`
            : `Try with demo data (${demoRows} dossiers)`}
        </button>
      </form>
      {hasDemo && (
        <form action={replaceDemoAction} style={{ marginTop: 10 }} data-testid="replace-demo">
          <input type="hidden" name="replace" value="1" />
          <label style={{ fontSize: 13 }}>
            <input type="checkbox" name="confirm" value="oui" />{' '}
            {locale === 'fr' ? 'Remplacer les données de démonstration' : 'Replace the demo data'}
          </label>{' '}
          <button className="btn" type="submit">{locale === 'fr' ? 'Remplacer' : 'Replace'}</button>
        </form>
      )}
      <div style={{ borderTop: '1px solid var(--line-2)', margin: '18px 0' }} />
      <ImportUpload locale={locale} from="onboarding" />
      {query.sandbox === '1' && (
        <p className="sub" style={{ marginTop: 12, fontSize: 12.5 }}>
          {locale === 'fr' ? 'Mode bac à sable actif — vous pourrez connecter une boîte plus tard dans les réglages.' : 'Sandbox mode active — you can connect a mailbox later in settings.'}
        </p>
      )}
      {session === null && <p>session</p>}
    </div></div>
  );
}

async function StepCalibration({ locale, workspaceId }: { locale: 'fr' | 'en'; workspaceId: string }) {
  const summary = await asAdmin((db) => portfolioSummary(db, workspaceId));
  await asAdmin(async (db) => {
    const { markCalibrationSeen: m } = await import('@rros/db/onboarding');
    const { recordFunnel } = await import('@rros/db/billing');
    await m(db, workspaceId);
    await recordFunnel(db, workspaceId, null, 'calibration_seen');
  });
  const session = await getSession();
  const share = summary.total > 0 ? Math.round((summary.unanswered / summary.total) * 100) : 0;
  return (
    <div data-testid="calibration">
      <div className="grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 14 }}>
        {[
          { label: locale === 'fr' ? 'Propositions' : 'Proposals', value: summary.total.toLocaleString('fr-FR') },
          { label: locale === 'fr' ? 'Sans réponse' : 'Unanswered', value: `${share} %` },
          { label: locale === 'fr' ? '€ exposés' : '€ exposed', value: eur(summary.exposedCents, locale) },
          { label: locale === 'fr' ? 'Groupe témoin' : 'Holdout', value: String(summary.holdout) },
        ].map((k) => (
          <div className="card" key={k.label}><div className="pad">
            <div style={{ fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--ink-2)', fontWeight: 600 }}>
              {k.label}
            </div>
            <div style={{ fontSize: 24, fontWeight: 680, letterSpacing: '-.8px', marginTop: 6, fontVariantNumeric: 'tabular-nums' }}>
              {k.value}
            </div>
          </div></div>
        ))}
      </div>
      <div className="card" style={{ borderLeft: '3px solid var(--accent)' }}><div className="pad">
        <p style={{ fontSize: 14.5, lineHeight: 1.55 }}>{HOLDOUT_WORDING[locale]}</p>
      </div></div>
      <form action={generateFirstQueueAction} style={{ marginTop: 16 }}>
        <button className="btn primary" type="submit" data-testid="generate-first-queue">
          {locale === 'fr' ? 'Générer ma première file' : 'Generate my first queue'}
        </button>
      </form>
      {session === null && <p>session</p>}
    </div>
  );
}

function StepQueue({ locale, firstQueueAt }: { locale: 'fr' | 'en'; firstQueueAt: Date | null }) {
  return (
    <div className="card"><div className="pad" style={{ textAlign: 'center' }}>
      <h2>{locale === 'fr' ? 'Votre file est prête' : 'Your queue is ready'}</h2>
      <p className="sub">
        {firstQueueAt === null
          ? (locale === 'fr' ? 'Générez la file pour voir vos dossiers du jour.' : 'Generate the queue to see today’s dossiers.')
          : (locale === 'fr' ? 'Elle est régénérée chaque matin à l’heure de votre espace.' : 'It regenerates every morning in your workspace timezone.')}
      </p>
      <a className="btn primary" href={`/${locale}?coach=1`} data-testid="go-today">
        {locale === 'fr' ? 'Ouvrir Aujourd’hui' : 'Open Today'}
      </a>
    </div></div>
  );
}

const labelStyle = { display: 'grid', gap: 6, fontSize: 13.5, fontWeight: 600, margin: '12px 0' } as const;
const inputStyle = { padding: '9px 12px', border: '1px solid var(--line-2)', borderRadius: 8, fontSize: 14 } as const;
