/**
 * Plan entitlements. Enforced server-side in the action *and* in the job — the
 * UI only reflects the decision. Every boundary (29/30/31, 89/90/91…) is tested,
 * because an off-by-one here is either a lost customer or free revenue.
 */

export type Plan = 'starter' | 'growth' | 'scale';

export interface PlanLimits {
  proposalsPerMonth: number;
  seats: number;
  mailboxes: number;
  api: 'none' | 'read' | 'read_write';
  holdoutConfigurable: boolean;
  priceMonthlyEur: number;
}

export const PLANS: Record<Plan, PlanLimits> = {
  starter: { proposalsPerMonth: 30, seats: 1, mailboxes: 1, api: 'none', holdoutConfigurable: false, priceMonthlyEur: 299 },
  growth: { proposalsPerMonth: 90, seats: 4, mailboxes: 2, api: 'read', holdoutConfigurable: false, priceMonthlyEur: 699 },
  scale: { proposalsPerMonth: 300, seats: 12, mailboxes: 5, api: 'read_write', holdoutConfigurable: true, priceMonthlyEur: 1490 },
};

export type EntitlementAction =
  | 'import_proposals'
  | 'send_email'
  | 'add_seat'
  | 'connect_mailbox'
  | 'use_api'
  | 'configure_holdout';

export interface Usage {
  proposalsTracked: number;
  emailsSent: number;
  seats: number;
  mailboxes: number;
}

export interface Decision {
  allowed: boolean;
  softBlock: boolean;
  limit: number;
  remaining: number;
  reasonCode?: 'PLAN_LIMIT_EXCEEDED' | 'PLAN_FEATURE_UNAVAILABLE' | 'SOFT_LIMIT_REACHED';
}

/** Soft block at 100 %, hard block above 110 %. Never drop rows silently. */
const SOFT_PCT = 100;
const HARD_PCT = 110;

/* Integer arithmetic on purpose: 300 * 1.1 is 330.00000000000006 in IEEE 754,
   so a floating-point ceiling silently grants one extra row on every boundary. */
const pctOf = (limit: number, pct: number) => Math.ceil((limit * pct) / 100);

function decideProposals(limits: PlanLimits, usage: Usage, incoming: number): Decision {
  const limit = limits.proposalsPerMonth;
  const projected = usage.proposalsTracked + incoming;
  const remaining = Math.max(0, limit - usage.proposalsTracked);

  if (projected > pctOf(limit, HARD_PCT)) {
    return { allowed: false, softBlock: false, limit, remaining, reasonCode: 'PLAN_LIMIT_EXCEEDED' };
  }
  if (projected > pctOf(limit, SOFT_PCT)) {
    return { allowed: true, softBlock: true, limit, remaining, reasonCode: 'SOFT_LIMIT_REACHED' };
  }
  return { allowed: true, softBlock: false, limit, remaining };
}

export function check(
  plan: Plan,
  usage: Usage,
  action: EntitlementAction,
  opts: { incoming?: number; requestedHoldoutRate?: number } = {},
): Decision {
  const limits = PLANS[plan];

  switch (action) {
    case 'import_proposals':
      return decideProposals(limits, usage, opts.incoming ?? 1);

    case 'send_email': {
      // Sending is bounded by the same ceiling as tracking: no plan sells more
      // emails than dossiers. Warn at 100 %, refuse above 110 %.
      const limit = limits.proposalsPerMonth;
      const remaining = Math.max(0, limit - usage.proposalsTracked);
      if (usage.proposalsTracked > pctOf(limit, HARD_PCT)) {
        return { allowed: false, softBlock: false, limit, remaining, reasonCode: 'PLAN_LIMIT_EXCEEDED' };
      }
      if (usage.proposalsTracked >= pctOf(limit, SOFT_PCT)) {
        return { allowed: true, softBlock: true, limit, remaining, reasonCode: 'SOFT_LIMIT_REACHED' };
      }
      return { allowed: true, softBlock: false, limit, remaining };
    }

    case 'add_seat': {
      const limit = limits.seats;
      const remaining = Math.max(0, limit - usage.seats);
      if (usage.seats + 1 > limit) {
        return { allowed: false, softBlock: false, limit, remaining, reasonCode: 'PLAN_LIMIT_EXCEEDED' };
      }
      return { allowed: true, softBlock: false, limit, remaining };
    }

    case 'connect_mailbox': {
      const limit = limits.mailboxes;
      const remaining = Math.max(0, limit - usage.mailboxes);
      if (usage.mailboxes + 1 > limit) {
        return { allowed: false, softBlock: false, limit, remaining, reasonCode: 'PLAN_LIMIT_EXCEEDED' };
      }
      return { allowed: true, softBlock: false, limit, remaining };
    }

    case 'use_api': {
      const available = limits.api !== 'none';
      return {
        allowed: available,
        softBlock: false,
        limit: limits.api === 'read_write' ? 2 : limits.api === 'read' ? 1 : 0,
        remaining: available ? 1 : 0,
        ...(available ? {} : { reasonCode: 'PLAN_FEATURE_UNAVAILABLE' as const }),
      };
    }

    case 'configure_holdout': {
      if (!limits.holdoutConfigurable) {
        return { allowed: false, softBlock: false, limit: 0, remaining: 0, reasonCode: 'PLAN_FEATURE_UNAVAILABLE' };
      }
      const rate = opts.requestedHoldoutRate;
      if (rate !== undefined && (rate < 0.1 || rate > 0.3)) {
        return { allowed: false, softBlock: false, limit: 0, remaining: 0, reasonCode: 'PLAN_LIMIT_EXCEEDED' };
      }
      return { allowed: true, softBlock: false, limit: 1, remaining: 1 };
    }

    default:
      return { allowed: false, softBlock: false, limit: 0, remaining: 0, reasonCode: 'PLAN_FEATURE_UNAVAILABLE' };
  }
}

/** Revenue target helper used by the internal pricing page, not by customers. */
export function clientsNeededForMrr(monthlyMrr: number, plan: Plan): number {
  return Math.ceil(monthlyMrr / PLANS[plan].priceMonthlyEur);
}
