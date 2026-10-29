/**
 * API key scopes and their plan availability — pure, tested, imported by the
 * v1 auth layer. The plan is checked at REQUEST time, never trusted from the
 * moment the key was issued: a downgraded workspace loses the API mid-flight.
 */
export type Scope = 'read:opportunities' | 'write:actions' | 'read:results';

export const ALL_SCOPES: readonly Scope[] = ['read:opportunities', 'write:actions', 'read:results'];

export type PlanId = 'starter' | 'growth' | 'scale';

/** Which scopes each plan may hold. Starter: none; Growth: read-only; Scale: all. */
export function scopesForPlan(plan: PlanId): readonly Scope[] {
  switch (plan) {
    case 'scale':
      return ALL_SCOPES;
    case 'growth':
      return ['read:opportunities', 'read:results'];
    default:
      return [];
  }
}

export interface ScopeDecision {
  allowed: boolean;
  reasonCode?: 'PLAN_FEATURE_UNAVAILABLE' | 'SCOPE_MISSING';
}

/**
 * A key is usable when the plan still grants its scopes AND the key itself was
 * created with the requested scope. PLAN_FEATURE_UNAVAILABLE wins over
 * SCOPE_MISSING: the workspace must upgrade, the key is not at fault.
 */
export function scopeAllowed(plan: PlanId, keyScopes: readonly string[], required: Scope): ScopeDecision {
  if (!scopesForPlan(plan).includes(required)) return { allowed: false, reasonCode: 'PLAN_FEATURE_UNAVAILABLE' };
  if (!keyScopes.includes(required)) return { allowed: false, reasonCode: 'SCOPE_MISSING' };
  return { allowed: true };
}
