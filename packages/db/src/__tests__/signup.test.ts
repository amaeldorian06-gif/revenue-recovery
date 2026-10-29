import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, asWorkspace, truncateAll, type Db } from '../client.ts';
import { createWorkspaceWithOwner, findUserByEmail, EmailAlreadyUsedError, slugify } from '../repo/workspaces.ts';

let db: Db;
beforeEach(async () => {
  db = await createDb({ fresh: true });
});

describe('signup — workspace creation', () => {
  it('creates a workspace, an owner and an audit row', async () => {
    const { workspaceId, userId } = await createWorkspaceWithOwner(db, {
      email: 'Fondateur@Studio-Merlot.fr',
      workspaceName: 'Studio Merlot',
      locale: 'fr',
    });

    const ws = await db.query<{ name: string; plan: string; subscription_status: string; trial_ends_at: string; holdout_rate: string }>(
      'select name, plan, subscription_status, trial_ends_at, holdout_rate from workspaces where id = $1',
      [workspaceId],
    );
    expect(ws.rows[0]).toMatchObject({ name: 'Studio Merlot', plan: 'growth', subscription_status: 'trialing' });
    expect(ws.rows[0]!.holdout_rate).toBe('0.200');

    const users = await db.query<{ role: string; email: string }>('select role, email from users where id = $1', [userId]);
    expect(users.rows[0]).toEqual({ role: 'owner', email: 'fondateur@studio-merlot.fr' });

    const audit = await db.query<{ action: string }>('select action from audit_log where workspace_id = $1', [workspaceId]);
    expect(audit.rows.map((r) => r.action)).toEqual(['workspace.created']);
  });

  it('sets a 14-day trial', async () => {
    const { workspaceId } = await createWorkspaceWithOwner(db, {
      email: 'a@b.fr', workspaceName: 'Agence A', locale: 'fr',
    });
    const res = await db.query<{ days: number }>(
      `select extract(day from (trial_ends_at - now()))::int as days from workspaces where id = $1`,
      [workspaceId],
    );
    expect(res.rows[0]!.days).toBeGreaterThanOrEqual(13);
    expect(res.rows[0]!.days).toBeLessThanOrEqual(14);
  });

  it('refuses a duplicate email and leaves no orphan workspace', async () => {
    await createWorkspaceWithOwner(db, { email: 'a@b.fr', workspaceName: 'Agence A', locale: 'fr' });
    const before = await db.query<{ n: number }>('select count(*)::int as n from workspaces');
    await expect(
      createWorkspaceWithOwner(db, { email: 'A@B.fr', workspaceName: 'Autre', locale: 'fr' }),
    ).rejects.toBeInstanceOf(EmailAlreadyUsedError);
    const after = await db.query<{ n: number }>('select count(*)::int as n from workspaces');
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it('finds the user by email regardless of case', async () => {
    const { workspaceId } = await createWorkspaceWithOwner(db, {
      email: 'founder@agency.io', workspaceName: 'Agency', locale: 'en',
    });
    const found = await findUserByEmail(db, 'FOUNDER@agency.io');
    expect(found).toEqual({ id: expect.any(String), workspaceId, role: 'owner' });
  });
});

describe('slug generation', () => {
  it('strips accents and punctuation and stays unique', () => {
    const a = slugify('Agence Développement & Conseil');
    const b = slugify('Agence Développement & Conseil');
    expect(a).toMatch(/^agence-developpement-conseil-[0-9a-f]{6}$/);
    expect(a).not.toBe(b);
  });

  it('handles a name with no latin characters', () => {
    expect(slugify('日本語')).toMatch(/^agence-[0-9a-f]{6}$/);
  });
});

describe('tenant isolation after signup', () => {
  it('a new owner sees only their own workspace', async () => {
    const a = await createWorkspaceWithOwner(db, { email: 'a@x.fr', workspaceName: 'Alpha', locale: 'fr' });
    const b = await createWorkspaceWithOwner(db, { email: 'b@x.fr', workspaceName: 'Beta', locale: 'fr' });

    const rows = await asWorkspace(db, a.workspaceId, () => db.query<{ id: string }>('select id from workspaces'));
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.id).toBe(a.workspaceId);
    expect(rows.rows.some((r) => r.id === b.workspaceId)).toBe(false);
  });
});
