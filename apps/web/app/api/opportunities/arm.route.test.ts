/**
 * Criterion 4, second half — "through any endpoint or service function".
 *
 * The database trigger is the real lock (asserted in packages/db). This test proves
 * there is no HTTP door either: every verb the route answers returns 403 with a
 * reason, so a future contributor finds a sign on the door instead of an idea for
 * a feature.
 */
import { describe, it, expect } from 'vitest';
import { POST, PUT, PATCH } from './[id]/arm/route.ts';

describe('arm changes have no HTTP path', () => {
  it.each([
    ['POST', POST],
    ['PUT', PUT],
    ['PATCH', PATCH],
  ])('%s answers 403 with a reason', async (_verb, handler) => {
    const res = await handler();
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe('arm_immutable');
    expect(body.detail).toContain('figé');
  });
});
