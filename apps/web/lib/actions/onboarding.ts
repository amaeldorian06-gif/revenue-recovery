'use server';

import { redirect } from 'next/navigation';
import { asAdmin, withTenant, getDb } from '../db';
import { getSession } from '../session';
import {
  getOnboardingState, markCalibrationSeen, markFirstQueue,
  patchOnboardingState, seedDemo, dismissCoachMark, createDemoWorkspace,
} from '@rros/db/onboarding';
import { assertEntitlement, recordFunnel } from '@rros/db/billing';
import { generateQueue } from '@rros/db/queue';

/**
 * The five-step wizard. Every action persists before it redirects: a refresh
 * lands on the same step with the same data (server-side state, no session
 * storage).
 */

export async function onboardingAccountAction(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session) redirect('/fr/login');
  const timezone = String(formData.get('timezone') ?? 'Europe/Paris').slice(0, 60) || 'Europe/Paris';
  const locale = formData.get('locale') === 'en' ? 'en' : 'fr';

  await withTenant(session.workspaceId, async (db) => {
    await patchOnboardingState(db, session.workspaceId, { stepDone: 'account', step: 2, timezone });
    await db.query('update workspaces set timezone = $2, locale = $3 where id = $1::uuid',
      [session.workspaceId, timezone, locale]);
  });
  await createSessionLocale(session, locale);
  redirect(`/${locale}/onboarding/2`);
}

async function createSessionLocale(session: { userId: string; workspaceId: string; role: 'owner' | 'admin' | 'member' | 'viewer'; email: string; locale: 'fr' | 'en' }, locale: 'fr' | 'en'): Promise<void> {
  const { createSession } = await import('../session');
  await createSession({ ...session, locale });
}

export async function onboardingMailboxAction(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session) redirect('/fr/login');
  const choice = String(formData.get('choice') ?? 'later');
  const locale = session.locale;

  if (choice === 'later') {
    // The explicit sandbox path: says what it does, right on the button.
    await withTenant(session.workspaceId, async (db) => {
      await patchOnboardingState(db, session.workspaceId, { stepDone: 'mailbox', step: 3, mailboxChoice: 'later' });
    });
    await asAdmin(async (db) => recordFunnel(db, session.workspaceId, session.userId, 'mailbox_step_done'));
    redirect(`/${locale}/onboarding/3?sandbox=1`);
  }

  // Gmail OAuth needs Google credentials (phase 07 wires the real flow);
  // SMTP/IMAP is form-ready now. The entitlement gate runs before anything is
  // stored, in both cases.
  const { decision } = await asAdmin((db) =>
    assertEntitlement(db, session.workspaceId, 'connect_mailbox'),
  );
  if (!decision.allowed) redirect(`/${locale}/onboarding/2?error=mailbox_limit`);

  const provider = choice === 'gmail' ? 'gmail_oauth' : 'smtp_imap';
  const host = String(formData.get('host') ?? '');
  if (choice === 'smtp_imap' && host === '') {
    redirect(`/${locale}/onboarding/2?error=smtp_host`);
  }
  await withTenant(session.workspaceId, async (db) => {
    await db.query(
      `insert into mailbox_connections (workspace_id, provider, status)
       values ($1::uuid, $2, 'pending')
       on conflict (workspace_id, provider) do nothing`,
      [session.workspaceId, provider],
    );
    await patchOnboardingState(db, session.workspaceId, { stepDone: 'mailbox', step: 3, mailboxChoice: choice === 'gmail' ? 'gmail' : 'smtp_imap' });
  });
  await asAdmin(async (db) => recordFunnel(db, session.workspaceId, session.userId, 'mailbox_step_done'));
  // Credentials themselves are stored encrypted in phase 07; the pending row
  // records intent without pretending the mailbox is synced.
  redirect(`/${locale}/onboarding/3?pending=1`);
}

export async function onboardingDemoAction(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session) redirect('/fr/login');
  const replace = formData.get('replace') === '1';

  try {
    await asAdmin((db) => seedDemo(db, session.workspaceId, { replace, userId: session.userId }));
  } catch {
    // Workspace holds real data: the guard refused. The UI offers the
    // explicit "remplacer les données de démonstration" path instead.
    redirect(`/${session.locale}/onboarding/3?error=not_empty`);
  }
  await withTenant(session.workspaceId, async (db) => {
    await patchOnboardingState(db, session.workspaceId, { stepDone: 'import', step: 4, stagedImportId: null });
  });
  await asAdmin(async (db) => recordFunnel(db, session.workspaceId, session.userId, 'import_confirmed'));
  redirect(`/${session.locale}/onboarding/4?demo=1`);
}

export async function onboardingImportDoneAction(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session) redirect('/fr/login');
  const importId = String(formData.get('importId') ?? '');
  await withTenant(session.workspaceId, async (db) => {
    await patchOnboardingState(db, session.workspaceId, { stepDone: 'import', step: 4, stagedImportId: importId || null });
  });
  redirect(`/${session.locale}/onboarding/4`);
}

/** Step 4's single button: the queue is generated immediately. */
export async function generateFirstQueueAction(): Promise<void> {
  const session = await getSession();
  if (!session) redirect('/fr/login');

  const db = await getDb();
  await asAdmin((conn) => generateQueue(conn, { workspaceId: session.workspaceId, date: new Date() }));
  await asAdmin(async (conn) => {
    await markFirstQueue(conn, session.workspaceId);
    await recordFunnel(conn, session.workspaceId, session.userId, 'queue_generated');
  });
  await withTenant(session.workspaceId, async (conn) => {
    await patchOnboardingState(conn, session.workspaceId, { stepDone: 'calibration', step: 5 });
  });
  redirect(`/${session.locale}?coach=1`);
}

export async function markCalibrationSeenAction(): Promise<void> {
  const session = await getSession();
  if (!session) return;
  await asAdmin((db) => markCalibrationSeen(db, session.workspaceId));
}

export async function dismissCoachMarkAction(): Promise<void> {
  const session = await getSession();
  if (!session) redirect('/fr/login');
  await asAdmin((db) => dismissCoachMark(db, session.workspaceId));
}

export async function replaceDemoAction(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session) redirect('/fr/login');
  const confirm = formData.get('confirm') === 'oui';
  if (!confirm) redirect(`/${session.locale}/onboarding/3?error=confirm_missing`);
  await asAdmin((db) => seedDemo(db, session.workspaceId, { replace: true, userId: session.userId }));
  redirect(`/${session.locale}/onboarding/3?replaced=1`);
}

/** The login-screen demo: one click, a seeded workspace, sandbox sending. */
export async function demoLoginAction(formData: FormData): Promise<void> {
  const locale = formData.get('locale') === 'en' ? 'en' : 'fr';
  const demo = await asAdmin((db) => createDemoWorkspace(db));
  const { createSession } = await import('../session');
  await createSession({
    userId: demo.userId,
    workspaceId: demo.workspaceId,
    role: 'owner',
    email: demo.email,
    locale,
  });
  redirect(`/${locale}?coach=1`);
}
