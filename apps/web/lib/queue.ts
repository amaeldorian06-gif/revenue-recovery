import { getSession, type Session } from './session';
import { withTenant } from './db';
import { generateQueue, readQueue, rejectionSummary, isoDate } from '@rros/db/queue';
import type { QueueItemView } from '@rros/db/queue';

export const WORKSPACE_TZ = 'Europe/Paris';

/**
 * The day's queue, served from the table. It is generated only when the day has
 * no rows yet — the first visitor of the morning triggers the same work the
 * 06:00 job would have done, instead of showing an empty screen until then.
 */
export async function getTodayQueue(session: Session, date = new Date()) {
  const generatedFor = isoDate(date);

  const existing = await withTenant(session.workspaceId, (db) =>
    readQueue(db, session.workspaceId, generatedFor),
  );
  if (existing.length > 0) {
    const totals = await withTenant(session.workspaceId, (db) =>
      db.query<{ total: string }>(
        `select count(*) as total from opportunities where workspace_id = $1::uuid`,
        [session.workspaceId],
      ),
    );
    return {
      generatedFor,
      items: existing,
      totalOpportunities: Number(totals.rows[0]?.total ?? 0),
      rejections: {} as Record<string, number>,
      rejectedTotal: 0,
      capacity: 0,
      actedKept: 0,
      generated: false,
    };
  }

  const result = await withTenant(session.workspaceId, (db) =>
    generateQueue(db, { workspaceId: session.workspaceId, date }),
  );
  return { ...result, generated: true };
}

/** Why the queue is empty — the screen must never be blank without a reason. */
export async function getRejectionSummary(session: Session, date = new Date()) {
  return withTenant(session.workspaceId, (db) => rejectionSummary(db, session.workspaceId, date));
}

export async function requireSession(): Promise<Session | null> {
  return getSession();
}

export type { QueueItemView };
