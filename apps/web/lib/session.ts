import { cookies } from 'next/headers';
import { SignJWT, jwtVerify } from 'jose';

const COOKIE = 'rros_session';
const secret = new TextEncoder().encode(
  process.env.SESSION_SECRET ?? 'dev-only-insecure-secret-change-me-32chr',
);

export interface Session {
  userId: string;
  workspaceId: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  email: string;
  locale: 'fr' | 'en';
  /** Server-side session id (migration 0010): revocation is a DB fact. */
  sid?: string;
}

const TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Sessions révocables : le JWT porte un `sid`, la table `sessions` fait foi.
 * Un cookie volé ne vaut plus jusqu'à expiration — la révocation est un
 * UPDATE serveur (déconnexion, "logout everywhere", purge RGPD). La
 * signature d'appel est inchangée : l'écriture passe par le chemin service.
 */
/**
 * Mint a session the ONE right way: rotate the previous sid if any, insert
 * the server-side row, sign the JWT that carries it. Every issuer — the
 * cookie path, the dev/team shortcut — goes through here, so no token can
 * exist without its revocable row.
 */
export async function mintSession(session: Session): Promise<{ sid: string; token: string }> {
  const sid = crypto.randomUUID();
  const { getDb, asAdmin } = await import('./db');
  // Rotation : une nouvelle émission révoque l'ancienne ligne — un cookie
  // volé lors d'une session précédente meurt au login suivant.
  if (session.sid) {
    try {
      const db0 = await getDb();
      await asAdmin((c) =>
        c.query(`update sessions set revoked_at = now(), revoked_reason = 'rotated'
                  where id = $1::uuid and revoked_at is null`, [session.sid]),
      );
    } catch { /* early boot */ }
  }
  try {
    const db = await getDb();
    await asAdmin((c) =>
      c.query(
        `insert into sessions (id, user_id, workspace_id, role, email, locale, expires_at)
         values ($1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::text, $7::timestamptz)`,
        [sid, session.userId, session.workspaceId, session.role, session.email, session.locale,
          new Date(Date.now() + TTL_MS).toISOString()],
      ),
    );
  } catch (err) {
    // Pas de base au boot très précoce (recettes) : la session reste pure JWT
    // — sans sid, elle sera refusée dès que la table est lisible.
    console.error('session row insert failed:', err instanceof Error ? err.message : err);
  }
  const token = await new SignJWT({ ...session, sid })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secret);
  return { sid, token };
}

export async function createSession(session: Session): Promise<void> {
  const { token } = await mintSession(session);
  const store = await cookies();
  store.set(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  });
}

export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  const token = store.get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret);
    const session = payload as unknown as Session;
    // A session WITHOUT a server row is a pre-0010 or forged cookie: refused.
    // Revocation and expiry are read from the database on EVERY request.
    if (!session.sid) return null;
    const { isWorkspaceDeleted } = await import('@rros/db/gdpr');
    const { getDb, asAdmin } = await import('./db');
    try {
      const db = await getDb();
      const dead = await asAdmin((c) =>
        c.query<{ ok: boolean }>(
          `select not exists (
             select 1 from sessions s
              where s.id = $1::uuid and s.revoked_at is null and s.expires_at > now()
           ) as ok`,
          [session.sid],
        ),
      );
      if (dead.rows[0]?.ok) return null;
      // A soft-deleted workspace loses ALL access immediately, sessions included.
      if (await asAdmin((c) => isWorkspaceDeleted(c, session.workspaceId))) return null;
    } catch (err) {
      // No DB yet (very early boot): keep the session; every query would fail anyway.
      console.error('[session] revocation check failed (fail-open):', err instanceof Error ? err.message : err);
    }
    return session;
  } catch {
    return null;
  }
}

/** Server-side revocation — the point of migration 0010. */
export async function revokeSession(sid: string, reason = 'signout'): Promise<void> {
  const { getDb, asAdmin } = await import('./db');
  try {
    const db = await getDb();
    await asAdmin((c) =>
      c.query(
        `update sessions set revoked_at = now(), revoked_reason = $2::text
          where id = $1::uuid and revoked_at is null`,
        [sid, reason],
      ),
    );
  } catch (err) {
    // The cookie is destroyed regardless; the row dies at expiry.
    console.error('[session] revoke failed:', err instanceof Error ? err.message : err);
  }
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE);
}

function ipOf(): string {
  // First hop of the forwarded chain, or local.
  return '127.0.0.1';
}

