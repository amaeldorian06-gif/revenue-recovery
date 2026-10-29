import { PGlite } from '@electric-sql/pglite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { migrate } from './migrate.ts';

/**
 * The database handle every repo speaks to. Structurally, all the code needs
 * is parameterised queries and raw SQL — PGlite (sandbox, in-memory, ONE
 * connection) and the real Postgres driver (validation toward Supabase) both
 * provide exactly that, so `Db` is an interface, not the PGlite class.
 */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
}

/**
 * Driver selection: PGlite by default. RROS_DB_DRIVER=pg + DATABASE_URL
 * switches to a real Postgres server — same migrations, same RLS, same SQL —
 * with per-block dedicated connections (see asWorkspace). tools/pg_local.sh
 * boots the local cluster the suite runs against.
 */
export async function createDb(opts: { fresh?: boolean } = {}): Promise<Db> {
  if (process.env.RROS_DB_DRIVER === 'pg') return createPgDb(opts);
  const raw = new PGlite();
  const db = raw as unknown as Db;
  await raw.waitReady;
  await migrate(db);
  if (opts.fresh) await truncateAll(db);
  return db;
}

export async function truncateAll(db: Db): Promise<void> {
  // stripe_events, login_tokens and auth_attempts have no workspace cascade
  // (keyed by event id / e-mail / IP), so they are truncated explicitly.
  // Everything else falls from workspaces. A magic-link e2e that finds a
  // leftover token from a previous test is a flaky test, not a product bug.
  await db.exec(
    'truncate stripe_events, audit_log, invitations, users, workspaces, ' +
    'login_tokens, auth_attempts, sessions restart identity cascade',
  );
}

/**
 * PHASE 08 FIX — the role/claims state machine is now serialized.
 *
 * PGlite exposes ONE connection. The previous implementation set
 * `role`/`request.jwt.claims` at SESSION level and reset them in a finally:
 * concurrent requests interleaved their statements, and an admin query could
 * execute under the tenant role with empty claims — zero rows, a 500 on the
 * Today screen, headers that lied. Single-user dev masked the race; the load
 * test made it certain. Every block now runs through this mutex (a promise
 * chain), so a role/claims pair can never outlive its own block. Nested
 * wrappers run inline (AsyncLocalStorage) — no self-deadlock.
 */
const dbLock = new AsyncLocalStorage<boolean>();
let chain: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  if (dbLock.getStore()) return fn();
  const run = chain.then(() => dbLock.run(true, fn));
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Exclusive access to the single connection, for MULTI-STATEMENT operations
 * that must run inside one transaction (licensing confirmation, imports).
 * Without it, two racing transactions interleave on the one PGlite session
 * and a second `begin` silently joins the first one's transaction. On the
 * real-Postgres driver the shared handle is still one connection, so the same
 * serialization applies; TRUE cross-connection concurrency (row locks, RLS
 * per connection) is exercised by pg_multi.test.ts with its own raw clients.
 */
export function withExclusive<T>(fn: () => Promise<T>): Promise<T> {
  return serialize(fn);
}

// ------------------------------------------------- real-Postgres plumbing
// The shared handle is ONE dedicated client (begin/commit behave exactly like
// on PGlite). asWorkspace/asSuperuser instead borrow their own client from a
// pool: the tenant role and the JWT claims live on THAT connection only, so
// RLS is enforced per connection — the multi-connection topology Supabase
// runs in production. Statements issued inside a block are routed to the
// block's client through the same AsyncLocalStorage the mutex already uses.

type PgClient = import('pg').Client;

type PgDriver = {
  base: Db;
  pool: import('pg').Pool;
  scope: AsyncLocalStorage<PgClient>;
};

let pgDriver: PgDriver | null = null;

function routed(driver: PgDriver, fallback: Db): Db {
  return {
    async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
      const client = driver.scope.getStore();
      if (client) return { rows: (await client.query(sql, params as never[])).rows as T[] };
      return fallback.query<T>(sql, params);
    },
    async exec(sql: string): Promise<void> {
      const client = driver.scope.getStore();
      if (client) {
        await client.query(sql);
        return;
      }
      return fallback.exec(sql);
    },
  };
}

async function createPgDb(opts: { fresh?: boolean } = {}): Promise<Db> {
  const { Client, Pool } = await import('pg');
  const url = process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/rros';
  const base = new Client({ connectionString: url });
  await base.connect();
  const pool = new Pool({ connectionString: url, max: 8 });
  const driver: PgDriver = {
    base: {
      query: async (sql, params) => ({ rows: (await base.query(sql, params as never[])).rows }),
      exec: async (sql) => { await base.query(sql); },
    },
    pool,
    scope: new AsyncLocalStorage<PgClient>(),
  };
  pgDriver = driver;
  const db = routed(driver, driver.base);
  await migrate(db);
  if (opts.fresh) await truncateAll(db);
  return db;
}

/** Run `fn` as the tenant application role, claim set like PostgREST would. */
export async function asWorkspace<T>(db: Db, workspaceId: string | null, fn: () => Promise<T>): Promise<T> {
  if (pgDriver) {
    const driver = pgDriver;
    return serialize(async () => {
      const client = await driver.pool.connect();
      try {
        await client.query('set role app_authenticated');
        const claims = workspaceId ? JSON.stringify({ workspace_id: workspaceId }) : '';
        await client.query(`select set_config('request.jwt.claims', $1, false)`, [claims]);
        return await driver.scope.run(client, fn);
      } finally {
        await client.query(`select set_config('request.jwt.claims', '', false)`).catch(() => {});
        await client.query('reset role').catch(() => {});
        client.release();
      }
    });
  }
  return serialize(async () => {
    await db.exec('set role app_authenticated');
    try {
      const claims = workspaceId ? JSON.stringify({ workspace_id: workspaceId }) : '';
      await db.query(`select set_config('request.jwt.claims', $1, false)`, [claims]);
      return await fn();
    } finally {
      await db.query(`select set_config('request.jwt.claims', '', false)`);
      await db.exec('reset role');
    }
  });
}

export async function asSuperuser<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  if (pgDriver) {
    const driver = pgDriver;
    return serialize(async () => {
      const client = await driver.pool.connect();
      try {
        return await driver.scope.run(client, fn);
      } finally {
        client.release();
      }
    });
  }
  return serialize(async () => {
    await db.exec('reset role');
    return fn();
  });
}
