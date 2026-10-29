/**
 * Single source of truth for authorisation. Imported by every server action and
 * route handler — never re-implemented inline. Phase 08 asserts all 40 cells of
 * the matrix; adding a role means adding it here first.
 */
export type Role = 'owner' | 'admin' | 'member' | 'viewer';

export type Action =
  | 'read:queue'
  | 'read:portfolio'
  | 'read:results'
  | 'approve:own'
  | 'approve:any'
  | 'import:proposals'
  | 'edit:opportunity'
  | 'invite:member'
  | 'manage:mailbox'
  | 'manage:billing'
  | 'configure:holdout'
  | 'export:workspace';

const MATRIX: Record<Role, readonly Action[]> = {
  owner: [
    'read:queue', 'read:portfolio', 'read:results',
    'approve:own', 'approve:any', 'import:proposals', 'edit:opportunity',
    'invite:member', 'manage:mailbox', 'manage:billing', 'configure:holdout',
    'export:workspace',
  ],
  admin: [
    'read:queue', 'read:portfolio', 'read:results',
    'approve:own', 'approve:any', 'import:proposals', 'edit:opportunity',
    'invite:member', 'manage:mailbox',
  ],
  member: [
    'read:queue', 'read:portfolio', 'read:results',
    'approve:own', 'import:proposals', 'edit:opportunity',
  ],
  viewer: ['read:queue', 'read:portfolio', 'read:results'],
};

export interface AuthzContext {
  role: Role;
  /** id of the user performing the action */
  userId: string;
  /** id of the user who owns the opportunity, when relevant */
  ownerUserId?: string;
}

export interface Decision {
  allowed: boolean;
  reasonCode?: 'ROLE_FORBIDDEN' | 'NOT_OWNER';
}

export function can(ctx: AuthzContext, action: Action): Decision {
  if (!MATRIX[ctx.role].includes(action)) return { allowed: false, reasonCode: 'ROLE_FORBIDDEN' };
  if (action === 'approve:own' && ctx.ownerUserId && ctx.ownerUserId !== ctx.userId) {
    return { allowed: false, reasonCode: 'NOT_OWNER' };
  }
  return { allowed: true };
}

/** Used by the UI to hide controls. Never used as the only enforcement. */
export function allowedActions(role: Role): readonly Action[] {
  return MATRIX[role];
}
