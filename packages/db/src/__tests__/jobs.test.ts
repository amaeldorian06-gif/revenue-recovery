/**
 * Launch gate D — a stopped cron must produce an alert within 30 minutes.
 * The property: alert when now > lastOk + 2× interval, never before, and a
 * job that never ran stays silent (a fresh install is not an incident).
 */
import { describe, it, expect } from 'vitest';
import { staleJobs, CRON_INTERVALS_S } from '../repo/jobs.ts';

const NOW = new Date('2026-10-27T12:00:00Z');
const min = 60_000;

describe('staleJobs — the 30-minute alert property', () => {
  it('every interval is short enough that 2× lands under 30 minutes where it matters', () => {
    // The fast crons (send/sync/webhooks) must alert well inside 30 min.
    for (const job of ['cron.send', 'cron.sync', 'cron.webhooks']) {
      expect(2 * CRON_INTERVALS_S[job]!).toBeLessThanOrEqual(30 * 60);
    }
  });

  it('a cron that stopped 25 minutes ago alerts (send: interval 600 s → 2× = 20 min)', () => {
    const alerts = staleJobs(
      [{ job: 'cron.send', lastOkAt: new Date(NOW.getTime() - 25 * min) }],
      NOW,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.job).toBe('cron.send');
    expect(alerts[0]!.overdueByS).toBe(5 * 60);
  });

  it('a cron that ran within its doubled interval stays quiet', () => {
    const alerts = staleJobs(
      [
        { job: 'cron.send', lastOkAt: new Date(NOW.getTime() - 15 * min) },
        { job: 'cron.webhooks', lastOkAt: new Date(NOW.getTime() - 90_000) },
      ],
      NOW,
    );
    expect(alerts).toHaveLength(0);
  });

  it('a daily cron is not alerted by the fast crons, hour by hour', () => {
    const alerts = staleJobs(
      [{ job: 'queue.generate', lastOkAt: new Date(NOW.getTime() - 6 * 3600_000) }],
      NOW,
    );
    expect(alerts).toHaveLength(0);
  });

  it('a job that never ran does not wake the on-call on a fresh install', () => {
    expect(staleJobs([], NOW)).toHaveLength(0);
  });
});
