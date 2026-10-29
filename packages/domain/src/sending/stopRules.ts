/**
 * The stop rules of §9, evaluated immediately before every send.
 *
 * They are checked twice on purpose: when the user approves (to refuse an
 * impossible action) and again inside the job (because an hour passed, the client
 * may have answered, and a queue position is not a permission to write).
 *
 * Each rule returns its own code. "Cancelled" without a reason is undebuggable
 * for us and unexplainable to the customer.
 */

export type StopCode =
  | 'REPLY_RECEIVED'
  | 'CONTACT_OPTED_OUT'
  | 'CONTACT_BOUNCED'
  | 'TOUCH_LIMIT'
  | 'RECENT_TOUCH'
  | 'OPPORTUNITY_CLOSED'
  | 'HOLDOUT'
  | 'WORKSPACE_SUSPENDED'
  | 'DAILY_CAP_REACHED';

export const STOP_RULES = {
  MAX_TOUCHES: 3,
  MIN_DAYS_BETWEEN_TOUCHES: 7,
  /** §9: a workspace has a hard daily ceiling; `daily_capacity` is the soft one. */
  DAILY_SEND_CAP: 40,
} as const;

export interface SendState {
  arm: 'treatment' | 'holdout';
  opportunityStatus: string;
  touchCount: number;
  lastTouchAt: Date | null;
  replyReceivedAt: Date | null;
  contactOptedOut: boolean;
  contactBouncedAt?: Date | null;
  workspaceStatus: string;
  sendsToday: number;
}

export interface StopVerdict {
  sendable: boolean;
  code?: StopCode;
  detail?: string;
}

const DAY = 86_400_000;

export function checkStopRules(state: SendState, now: Date): StopVerdict {
  if (state.workspaceStatus === 'canceled' || state.workspaceStatus === 'suspended') {
    return { sendable: false, code: 'WORKSPACE_SUSPENDED', detail: state.workspaceStatus };
  }
  if (state.contactOptedOut) return { sendable: false, code: 'CONTACT_OPTED_OUT' };
  if (state.contactBouncedAt) return { sendable: false, code: 'CONTACT_BOUNCED' };
  if (state.arm !== 'treatment') return { sendable: false, code: 'HOLDOUT' };
  if (state.replyReceivedAt) return { sendable: false, code: 'REPLY_RECEIVED' };
  if (state.opportunityStatus !== 'open') {
    return { sendable: false, code: 'OPPORTUNITY_CLOSED', detail: state.opportunityStatus };
  }
  if (state.touchCount >= STOP_RULES.MAX_TOUCHES) {
    return { sendable: false, code: 'TOUCH_LIMIT', detail: String(state.touchCount) };
  }
  if (state.lastTouchAt) {
    const days = Math.floor((now.getTime() - state.lastTouchAt.getTime()) / DAY);
    if (days < STOP_RULES.MIN_DAYS_BETWEEN_TOUCHES) {
      return { sendable: false, code: 'RECENT_TOUCH', detail: `${days} j` };
    }
  }
  if (state.sendsToday >= STOP_RULES.DAILY_SEND_CAP) {
    return { sendable: false, code: 'DAILY_CAP_REACHED', detail: String(state.sendsToday) };
  }
  return { sendable: true };
}

export const STOP_LABELS: Record<StopCode, { fr: string; en: string }> = {
  REPLY_RECEIVED: { fr: 'le client a répondu', en: 'the client replied' },
  CONTACT_OPTED_OUT: { fr: 'le contact s’est opposé', en: 'the contact opted out' },
  CONTACT_BOUNCED: { fr: 'l’adresse a rebondi — renvoi bloqué', en: 'the address bounced — resending blocked' },
  TOUCH_LIMIT: { fr: 'plafond de relances atteint', en: 'follow-up limit reached' },
  RECENT_TOUCH: { fr: 'contact trop récent', en: 'contacted too recently' },
  OPPORTUNITY_CLOSED: { fr: 'dossier clos', en: 'opportunity closed' },
  HOLDOUT: { fr: 'groupe témoin', en: 'control group' },
  WORKSPACE_SUSPENDED: { fr: 'workspace suspendu', en: 'workspace suspended' },
  DAILY_CAP_REACHED: { fr: 'plafond quotidien atteint', en: 'daily cap reached' },
};
