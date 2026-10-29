/** Criterion 3 (pure half): which plan may hold which scope, checked at request time. */
import { describe, it, expect } from 'vitest';
import { scopesForPlan, scopeAllowed } from './scopes.ts';

describe('scopes per plan', () => {
  it('starter gets no API at all', () => {
    expect(scopesForPlan('starter')).toEqual([]);
    expect(scopeAllowed('starter', ['read:opportunities'], 'read:opportunities'))
      .toEqual({ allowed: false, reasonCode: 'PLAN_FEATURE_UNAVAILABLE' });
  });

  it('growth is read-only — a write scope is PLAN_FEATURE_UNAVAILABLE even if the key has it', () => {
    expect(scopesForPlan('growth')).toEqual(['read:opportunities', 'read:results']);
    expect(scopeAllowed('growth', ['write:actions'], 'write:actions'))
      .toEqual({ allowed: false, reasonCode: 'PLAN_FEATURE_UNAVAILABLE' });
  });

  it('scale can write', () => {
    expect(scopeAllowed('scale', ['write:actions'], 'write:actions').allowed).toBe(true);
  });

  it('a key missing its scope but on a good plan gets SCOPE_MISSING, not a plan error', () => {
    expect(scopeAllowed('scale', ['read:results'], 'write:actions'))
      .toEqual({ allowed: false, reasonCode: 'SCOPE_MISSING' });
  });

  it('a DOWNGRADED plan is enforced at request time: the old key does not resurrect rights', () => {
    // The key was created on Scale with write:actions; the workspace is now Growth.
    expect(scopeAllowed('growth', ['write:actions'], 'write:actions').reasonCode).toBe('PLAN_FEATURE_UNAVAILABLE');
  });
});
