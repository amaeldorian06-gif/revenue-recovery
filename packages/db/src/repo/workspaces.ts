import { randomBytes } from 'node:crypto';
import type { Db } from '../client.ts';

export type Role = 'owner' | 'admin' | 'member' | 'viewer';
export type Plan = 'starter' | 'growth' | 'scale';

export interface SignupInput {
  email: string;
  workspaceName: string;
  locale: 'fr' | 'en';
  plan?: Plan;
}

export interface SignupResult {
  workspaceId: string;
  userId: string;
}

export function slugify(name: string): string {
  const base =
    name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'agence';
  return `${base}-${randomBytes(3).toString('hex')}`;
}

/**
 * Create a workspace and its owner in one transaction. The first user of a
 * workspace is always the owner (master prompt §4); the database enforces
 * uniqueness of that role with a partial index.
 */
export async function createWorkspaceWithOwner(db: Db, input: SignupInput): Promise<SignupResult> {
  const email = input.email.trim().toLowerCase();
  await db.exec('begin');
  try {
    const existing = await db.query<{ id: string }>('select id from users where email = $1', [email]);
    if (existing.rows.length > 0) throw new EmailAlreadyUsedError(email);

    const plan = input.plan ?? 'growth';
    const ws = await db.query<{ id: string }>(
      `insert into workspaces (name, slug, locale, plan, subscription_status, trial_ends_at)
       values ($1, $2, $3, $4, 'trialing', now() + interval '14 days')
       returning id`,
      [input.workspaceName.trim(), slugify(input.workspaceName), input.locale, plan],
    );
    const workspaceId = ws.rows[0]!.id;

    const user = await db.query<{ id: string }>(
      `insert into users (auth_user_id, workspace_id, email, full_name, role)
       values ($1, $2, $3, $4, 'owner') returning id`,
      [`local:${email}`, workspaceId, email, email.split('@')[0] ?? 'owner'],
    );
    const userId = user.rows[0]!.id;

    await db.query(
      `insert into audit_log (workspace_id, actor_type, action, entity, entity_id, after)
       values ($1::uuid, 'user', 'workspace.created', 'workspace', $1::text, $2::jsonb)`,
      [workspaceId, JSON.stringify({ email, plan, locale: input.locale })],
    );

    await db.exec('commit');
    return { workspaceId, userId };
  } catch (err) {
    await db.exec('rollback');
    throw err;
  }
}

export class EmailAlreadyUsedError extends Error {
  readonly code = 'EMAIL_ALREADY_USED';
  constructor(email: string) {
    super(`An account already exists for ${email}`);
    this.name = 'EmailAlreadyUsedError';
  }
}

export async function findUserByEmail(
  db: Db,
  email: string,
): Promise<{ id: string; workspaceId: string; role: Role } | null> {
  const res = await db.query<{ id: string; workspace_id: string; role: Role }>(
    'select id, workspace_id, role from users where email = $1 limit 1',
    [email.trim().toLowerCase()],
  );
  const row = res.rows[0];
  return row ? { id: row.id, workspaceId: row.workspace_id, role: row.role } : null;
}
