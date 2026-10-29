import { describe, it, expect } from 'vitest';
import { can, type Action, type Role } from './can.ts';

const ROLES: Role[] = ['owner', 'admin', 'member', 'viewer'];

const EXPECTED: Record<Action, Record<Role, boolean>> = {
  'read:queue':           { owner: true,  admin: true,  member: true,  viewer: true },
  'read:portfolio':       { owner: true,  admin: true,  member: true,  viewer: true },
  'read:results':         { owner: true,  admin: true,  member: true,  viewer: true },
  'approve:own':          { owner: true,  admin: true,  member: true,  viewer: false },
  'approve:any':          { owner: true,  admin: true,  member: false, viewer: false },
  'import:proposals':     { owner: true,  admin: true,  member: true,  viewer: false },
  'edit:opportunity':     { owner: true,  admin: true,  member: true,  viewer: false },
  'invite:member':        { owner: true,  admin: true,  member: false, viewer: false },
  'manage:mailbox':       { owner: true,  admin: true,  member: false, viewer: false },
  'manage:billing':       { owner: true,  admin: false, member: false, viewer: false },
  'configure:holdout':    { owner: true,  admin: false, member: false, viewer: false },
  'export:workspace':     { owner: true,  admin: false, member: false, viewer: false },
};

describe('permission matrix — 48 cells', () => {
  for (const [action, byRole] of Object.entries(EXPECTED) as [Action, Record<Role, boolean>][]) {
    for (const role of ROLES) {
      it(`${role} ${byRole[role] ? 'can' : 'cannot'} ${action}`, () => {
        const d = can({ role, userId: 'u1' }, action);
        expect(d.allowed).toBe(byRole[role]);
        if (!byRole[role]) expect(d.reasonCode).toBe('ROLE_FORBIDDEN');
      });
    }
  }
});

describe('ownership', () => {
  it('a member cannot approve another user\'s opportunity', () => {
    const d = can({ role: 'member', userId: 'u1', ownerUserId: 'u2' }, 'approve:own');
    expect(d).toEqual({ allowed: false, reasonCode: 'NOT_OWNER' });
  });

  it('a member can approve their own opportunity', () => {
    expect(can({ role: 'member', userId: 'u1', ownerUserId: 'u1' }, 'approve:own').allowed).toBe(true);
  });

  it('an admin can approve on behalf of anyone', () => {
    expect(can({ role: 'admin', userId: 'u1', ownerUserId: 'u2' }, 'approve:any').allowed).toBe(true);
  });

  it('a viewer cannot approve even their own opportunity', () => {
    expect(can({ role: 'viewer', userId: 'u1', ownerUserId: 'u1' }, 'approve:own').allowed).toBe(false);
  });
});
