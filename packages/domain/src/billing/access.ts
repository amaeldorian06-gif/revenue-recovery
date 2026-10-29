/**
 * What a workspace may do, derived only from its subscription row in the
 * database — never from the client (trap §Traps: never trust `plan` from the
 * client). Pure function: the same state always yields the same access.
 */

export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'incomplete';

export const TRIAL_DAYS = 14;
export const PAST_DUE_GRACE_DAYS = 3;
export const PURGE_AFTER_DAYS = 90;

export interface SubscriptionState {
  subscriptionStatus: SubscriptionStatus;
  trialEndsAt: Date | null;
  pastDueAt: Date | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: Date | null;
}

export type BannerKind =
  | 'trial'
  | 'trial_expired'
  | 'past_due'
  | 'canceled'
  | 'canceled_soon';

export interface Banner {
  kind: BannerKind;
  /** For trial: days left. For canceled: days until purge. */
  days?: number;
}

export interface Access {
  /** The send job may pick actions for this workspace. */
  canSend: boolean;
  /** Sending is forced through the sandbox provider. */
  sandbox: boolean;
  /** Mutations blocked (new imports, approvals); reading stays possible. */
  readOnly: boolean;
  /** CSV export remains available even when frozen. */
  canExport: boolean;
  /** Checkout never finished: no data was ever created. */
  blocked: boolean;
  banner: Banner | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const daysBetween = (a: Date, b: Date) => Math.floor((b.getTime() - a.getTime()) / DAY_MS);

export function accessFor(state: SubscriptionState, now: Date = new Date()): Access {
  switch (state.subscriptionStatus) {
    case 'incomplete':
      return { canSend: false, sandbox: true, readOnly: true, canExport: false, blocked: true, banner: null };

    case 'trialing': {
      const trialEnd = state.trialEndsAt;
      if (trialEnd !== null && trialEnd.getTime() <= now.getTime()) {
        // Expired trial: the queue keeps working read-only, sending stops. The
        // screen says exactly which two features stop: sending and new imports.
        return {
          canSend: false, sandbox: true, readOnly: true, canExport: true, blocked: false,
          banner: { kind: 'trial_expired' },
        };
      }
      const days = trialEnd === null ? TRIAL_DAYS : Math.max(0, daysBetween(now, trialEnd));
      return {
        canSend: true, sandbox: true, readOnly: false, canExport: true, blocked: false,
        banner: { kind: 'trial', days },
      };
    }

    case 'active':
      return {
        canSend: true, sandbox: false, readOnly: false, canExport: true, blocked: false,
        banner: state.cancelAtPeriodEnd && state.currentPeriodEnd !== null
          ? { kind: 'canceled_soon', days: Math.max(0, daysBetween(now, state.currentPeriodEnd)) }
          : null,
      };

    case 'past_due': {
      // Sending pauses immediately; the workspace freezes read-only after the
      // 3-day grace period. The banner carries the fix link the whole time.
      const frozen = state.pastDueAt !== null
        && daysBetween(state.pastDueAt, now) >= PAST_DUE_GRACE_DAYS;
      return {
        canSend: false, sandbox: false, readOnly: frozen, canExport: true, blocked: false,
        banner: { kind: 'past_due' },
      };
    }

    case 'canceled':
      return {
        canSend: false, sandbox: false, readOnly: true, canExport: true, blocked: false,
        banner: { kind: 'canceled', days: PURGE_AFTER_DAYS },
      };

    default:
      return { canSend: false, sandbox: true, readOnly: true, canExport: false, blocked: true, banner: null };
  }
}

/** The two features a customer loses on trial expiry, in plain words. */
export const TRIAL_EXPIRED_STOPS = {
  fr: 'Deux fonctions s’arrêtent : l’envoi de relances et les nouveaux imports. Vos données restent consultables et exportables.',
  en: 'Two features stop: sending follow-ups and new imports. Your data stays readable and exportable.',
} as const;
