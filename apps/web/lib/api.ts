import { NextResponse } from 'next/server';
import { getSession, type Session } from './session';

/**
 * One shape for every route: 401 without a session, 403 when the role may not act,
 * 200 with JSON otherwise. A route handler that invents its own error format is a
 * route handler the client cannot trust.
 */
export async function withSession(
  fn: (session: Session) => Promise<Response>,
): Promise<Response> {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  try {
    return await fn(session);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return NextResponse.json({ error: 'server_error', message }, { status: 500 });
  }
}
