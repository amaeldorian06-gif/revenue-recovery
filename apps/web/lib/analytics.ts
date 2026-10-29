/**
 * First-party funnel analytics — SERVER side. §12 of the growth prompt:
 * measure activation, never finance. Hard rules enforced here, not hoped
 * for: event names are an allowlist, props are size-capped, obvious crawlers
 * are refused, and nothing that holds invoice details, client names or
 * amounts can ever reach the table (the schema has no column for it).
 */
import type { Db } from '@rros/db';

export const EVENT_NAMES = [
  'landing_page_view',
  'primary_cta_clicked',
  'secondary_cta_clicked',
  'pricing_viewed',
  'signup_started',
  'prioritization_viewed',
] as const;
export type EventName = (typeof EVENT_NAMES)[number];

export function isEventName(v: unknown): v is EventName {
  return typeof v === 'string' && (EVENT_NAMES as readonly string[]).includes(v);
}

/** Obvious crawlers never see client JS; this is defense in depth, not a wall. */
export function looksLikeBot(userAgent: string | null): boolean {
  if (!userAgent) return true;
  return /bot|crawler|spider|headless|lighthouse|curl|wget|python-requests/i.test(userAgent);
}

const MAX_PROPS_BYTES = 600;

export interface FunnelEvent {
  name: EventName;
  path?: string;
  locale?: string;
  anonymousId?: string | null;
  workspaceId?: string | null;
  props?: Record<string, unknown>;
}

/**
 * Best-effort insert. Analytics must NEVER break a user flow: errors are
 * swallowed after being logged. Returns true when a row was written.
 */
export async function recordEvent(db: Db, ev: FunnelEvent): Promise<boolean> {
  try {
    const props = JSON.stringify(ev.props ?? {});
    if (props.length > MAX_PROPS_BYTES) return false;
    await db.query(
      `insert into analytics_events (name, path, locale, anonymous_id, workspace_id, props)
       values ($1::text, $2::text, $3::text, $4::text, $5::uuid, $6::jsonb)`,
      [
        ev.name,
        (ev.path ?? '').slice(0, 160),
        ev.locale === 'en' ? 'en' : 'fr',
        ev.anonymousId ? String(ev.anonymousId).slice(0, 64) : null,
        ev.workspaceId ?? null,
        props,
      ],
    );
    return true;
  } catch (err) {
    console.error('[analytics] recordEvent failed:', (err as Error).message);
    return false;
  }
}
