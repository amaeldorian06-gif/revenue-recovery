import { createDb, asWorkspace, asSuperuser, type Db } from '@rros/db';

/**
 * Single embedded Postgres instance for the whole dev process. In production this
 * module is replaced by the Supabase client; the tenant helper keeps the same
 * signature so callers never change.
 */
declare global {
  // eslint-disable-next-line no-var
  var __rrosDb: Promise<Db> | undefined;
}

export function getDb(): Promise<Db> {
  if (!globalThis.__rrosDb) {
    globalThis.__rrosDb = createDb();
  }
  return globalThis.__rrosDb;
}

/** Every tenant query goes through here: role + JWT claim set, exactly like PostgREST. */
export async function withTenant<T>(workspaceId: string | null, fn: (db: Db) => Promise<T>): Promise<T> {
  const db = await getDb();
  return asWorkspace(db, workspaceId, () => fn(db));
}

export async function asAdmin<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const db = await getDb();
  return asSuperuser(db, () => fn(db));
}
