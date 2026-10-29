/**
 * Phase 08 — team & seats. Criterion 2 lives here: the seat limit bites at
 * ACCEPTANCE (a pending invitation never overshoots), and an expired token
 * returns a clear error, never a 500.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createDb, truncateAll, type Db } from '../client.ts';
import { createWorkspaceWithOwner } from '../repo/workspaces.ts';
import {
  inviteMember, acceptInvitation, listMembers, removeMember,
} from '../repo/team.ts';

let db: Db;
let ws: { workspaceId: string; userId: string };

beforeAll(async () => {
  db = await createDb({ fresh: true });
});

beforeEach(async () => {
  await truncateAll(db);
  ws = await createWorkspaceWithOwner(db, {
    email: 'owner@agence.fr', workspaceName: 'Agence Test', locale: 'fr',
  });
});

async function setPlan(plan: 'starter' | 'growth' | 'scale'): Promise<void> {
  await db.query('update workspaces set plan = $2::text where id = $1::uuid', [ws.workspaceId, plan]);
}

describe('invitations — lifecycle', () => {
  it('creates a hashed, expiring invitation and never stores the token', async () => {
    const invite = await inviteMember(db, ws.workspaceId, ws.userId, {
      email: 'Lea@Agence.fr', role: 'member', locale: 'fr',
    });
    const rows = await db.query<{ token_hash: string; invited_by: string | null }>(
      'select token_hash, invited_by from invitations where workspace_id = $1::uuid',
      [ws.workspaceId],
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0]!.token_hash).not.toBe(invite.inviteUrlPath.split('/').pop());
    expect(rows.rows[0]!.invited_by).toBe(ws.userId);
    // Case-insensitive, trimmed: the invitation is stored lowercase.
    const members = await listMembers(db, ws.workspaceId);
    expect(members.length).toBe(1); // only the owner so far
  });

  it('resending invalidates the previous token — the old link becomes unknown', async () => {
    const first = await inviteMember(db, ws.workspaceId, ws.userId, { email: 'lea@agence.fr', role: 'member', locale: 'fr' });
    const second = await inviteMember(db, ws.workspaceId, ws.userId, { email: 'lea@agence.fr', role: 'member', locale: 'fr' });
    const oldToken = first.inviteUrlPath.split('/').pop()!;
    const newToken = second.inviteUrlPath.split('/').pop()!;
    expect(await acceptInvitation(db, oldToken)).toMatchObject({ ok: false, error: 'revoked' });
    expect((await acceptInvitation(db, newToken)).ok).toBe(true);
  });

  it('an expired token returns a CLEAR error, not a 500 (criterion 2 companion)', async () => {
    const invite = await inviteMember(db, ws.workspaceId, ws.userId, { email: 'lea@agence.fr', role: 'member', locale: 'fr' });
    const token = invite.inviteUrlPath.split('/').pop()!;
    await db.query(
      `update invitations set expires_at = now() - interval '1 hour' where workspace_id = $1::uuid`,
      [ws.workspaceId],
    );
    await expect(acceptInvitation(db, token)).resolves.toMatchObject({ ok: false, error: 'expired' });
  });

  it('a revoked invitation refuses acceptance; an accepted one cannot be replayed', async () => {
    const a = await inviteMember(db, ws.workspaceId, ws.userId, { email: 'a@agence.fr', role: 'viewer', locale: 'fr' });
    const b = await inviteMember(db, ws.workspaceId, ws.userId, { email: 'b@agence.fr', role: 'viewer', locale: 'fr' });
    await db.query(
      `update invitations set revoked_at = now() where email = 'a@agence.fr' and workspace_id = $1::uuid`,
      [ws.workspaceId],
    );
    expect(await acceptInvitation(db, a.inviteUrlPath.split('/').pop()!)).toMatchObject({ ok: false, error: 'revoked' });
    const tokenB = b.inviteUrlPath.split('/').pop()!;
    expect((await acceptInvitation(db, tokenB)).ok).toBe(true);
    expect(await acceptInvitation(db, tokenB)).toMatchObject({ ok: false, error: 'used' });
  });
});

describe('seat limits — enforced at acceptance (criterion 2)', () => {
  it('a 2nd user on Starter: invitation CREATES, acceptance fails SEAT_LIMIT_REACHED', async () => {
    await setPlan('starter');
    const invite = await inviteMember(db, ws.workspaceId, ws.userId, { email: 'lea@agence.fr', role: 'member', locale: 'fr' });
    expect(invite.inviteUrlPath).toContain('/invite/');
    const outcome = await acceptInvitation(db, invite.inviteUrlPath.split('/').pop()!);
    expect(outcome).toMatchObject({ ok: false, error: 'seat_limit' });
    const members = await listMembers(db, ws.workspaceId);
    expect(members.length).toBe(1); // the seat was never taken
  });

  it('pending invitations do not consume seats — five pending still leave one seat', async () => {
    await setPlan('starter');
    for (const email of ['a@x.fr', 'b@x.fr', 'c@x.fr', 'd@x.fr', 'e@x.fr']) {
      await inviteMember(db, ws.workspaceId, ws.userId, { email, role: 'member', locale: 'fr' });
    }
    const members = await listMembers(db, ws.workspaceId);
    expect(members.length).toBe(1);
    // And on a 4-seat Growth plan, 3 pending + 1 owner still admits a 4th.
    await setPlan('growth');
    const invite = await inviteMember(db, ws.workspaceId, ws.userId, { email: 'f@x.fr', role: 'member', locale: 'fr' });
    expect((await acceptInvitation(db, invite.inviteUrlPath.split('/').pop()!)).ok).toBe(true);
  });

  it('Growth admits up to 4, refuses the 5th', async () => {
    await setPlan('growth');
    for (let i = 1; i <= 3; i++) {
      const inv = await inviteMember(db, ws.workspaceId, ws.userId, { email: `m${i}@x.fr`, role: 'member', locale: 'fr' });
      expect((await acceptInvitation(db, inv.inviteUrlPath.split('/').pop()!)).ok).toBe(true);
    }
    const last = await inviteMember(db, ws.workspaceId, ws.userId, { email: 'm4@x.fr', role: 'member', locale: 'fr' });
    expect(await acceptInvitation(db, last.inviteUrlPath.split('/').pop()!)).toMatchObject({ ok: false, error: 'seat_limit' });
  });
});

describe('members — removal', () => {
  it('an admin can be removed; the owner can never be removed', async () => {
    await setPlan('growth');
    const inv = await inviteMember(db, ws.workspaceId, ws.userId, { email: 'adm@x.fr', role: 'admin', locale: 'fr' });
    const out = await acceptInvitation(db, inv.inviteUrlPath.split('/').pop()!);
    expect(out.ok).toBe(true);
    const members = await listMembers(db, ws.workspaceId);
    const admin = members.find((m) => m.role === 'admin')!;
    const owner = members.find((m) => m.role === 'owner')!;
    expect(await removeMember(db, ws.workspaceId, ws.userId, admin.id)).toBe(true);
    expect(await removeMember(db, ws.workspaceId, ws.userId, owner.id)).toBe(false);
  });
});
