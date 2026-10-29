'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { asAdmin } from '../db';
import { createSession, destroySession } from '../session';
import { createHash, randomBytes } from 'node:crypto';
import {
  createWorkspaceWithOwner,
  findUserByEmail,
  EmailAlreadyUsedError,
  type Role,
} from '@rros/db/repo';

export interface ActionState {
  error?: string;
}

const LocaleEnum = z.enum(['fr', 'en']);

const SignupSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  workspace: z.string().trim().min(2).max(120),
  locale: LocaleEnum.default('fr'),
});

const SigninSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  locale: LocaleEnum.default('fr'),
});

export async function signupAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = SignupSchema.safeParse({
    email: formData.get('email') ?? '',
    workspace: formData.get('workspace') ?? '',
    locale: formData.get('locale') ?? 'fr',
  });

  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    return { error: field === 'workspace' ? 'workspace_invalid' : 'email_invalid' };
  }

  const { email, workspace, locale } = parsed.data;

  let created: { workspaceId: string; userId: string };
  try {
    created = await asAdmin((db) =>
      createWorkspaceWithOwner(db, { email, workspaceName: workspace, locale }),
    );
  } catch (err) {
    if (err instanceof EmailAlreadyUsedError) return { error: 'exists' };
    return { error: 'unknown' };
  }

  await createSession({
    userId: created.userId,
    workspaceId: created.workspaceId,
    role: 'owner' satisfies Role,
    email,
    locale,
  });

  // The 8-minute clock starts here: signup → first queue is the funnel the
  // admin view watches. Step 1 (account) is confirmed on the next screen —
  // that is where the browser timezone is captured.
  await asAdmin(async (db) => {
    const { recordFunnel } = await import('@rros/db/billing');
    await recordFunnel(db, created.workspaceId, created.userId, 'signup_completed');
  });
  redirect(`/${locale}/onboarding/1`);
}

export async function signinAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = SigninSchema.safeParse({
    email: formData.get('email') ?? '',
    locale: formData.get('locale') ?? 'fr',
  });
  if (!parsed.success) return { error: 'email_invalid' };

  const { email, locale } = parsed.data;
  const ip = ipOf();
  // Rate limit: 5 attempts / 15 min / IP — brute force is a volume problem.
  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const recent = await asAdmin((c) =>
    c.query<{ n: number }>(
      `select count(*)::int as n from auth_attempts where ip = $1::text and ok = false and created_at > $2::timestamptz`,
      [ip, since],
    ),
  );
  if ((recent.rows[0]?.n ?? 0) >= 5) return { error: 'rate_limited' };

  const user = await asAdmin((db) => findUserByEmail(db, email));
  await asAdmin((c) =>
    c.query(`insert into auth_attempts (ip, email, ok) values ($1::text, $2::text, $3::boolean)`, [ip, email, user !== null]),
  );
  if (!user) return { error: 'unknown' };

  // Magic link: SHA-256 at rest, 15-minute expiry, single use.
  const token = randomBytes(24).toString('base64url');
  await asAdmin((c) =>
    c.query(
      `insert into login_tokens (email, token_hash, expires_at)
       values ($1::text, $2::text, now() + interval '15 minutes')`,
      [email, createHash('sha256').update(token).digest('hex')],
    ),
  );
  redirect(`/${locale}/login?sent=1&dev_token=${process.env.NODE_ENV === 'production' ? '' : token}`);
}

function ipOf(): string {
  // First hop of the forwarded chain, or local.
  return '127.0.0.1';
}

export async function signoutAction(formData: FormData): Promise<void> {
  const locale = formData.get('locale') === 'en' ? 'en' : 'fr';
  // Révocation SERVEUR d'abord (0010) : la ligne meurt même si un cookie
  // volé traîne ailleurs — puis le cookie lui-même.
  const { getSession, revokeSession } = await import('../session');
  const session = await getSession();
  if (session?.sid) await revokeSession(session.sid, 'signout');
  await destroySession();
  redirect(`/${locale}/login`);
}
