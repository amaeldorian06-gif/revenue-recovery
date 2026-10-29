import { describe, it, expect, beforeAll } from 'vitest';
import { createDb, asWorkspace, asSuperuser, type Db } from '../client.ts';

let db: Db;
let wsA: string;
let wsB: string;

beforeAll(async () => {
  db = await createDb({ fresh: true });
  const seed = await db.query<{ id: string; slug: string }>(`
    insert into workspaces (name, slug) values ('Agence A','agence-a'), ('Agence B','agence-b')
    returning id, slug`);
  wsA = seed.rows.find((r) => r.slug === 'agence-a')!.id;
  wsB = seed.rows.find((r) => r.slug === 'agence-b')!.id;

  await db.query(
    `insert into users (auth_user_id, workspace_id, email, role)
     values ('auth-a','${wsA}','a@example.com','owner'), ('auth-b','${wsB}','b@example.com','owner')`,
  );
  await db.query(
    `insert into invitations (workspace_id, email, role, token_hash, expires_at)
     values ('${wsA}','x@example.com','member','hash-a',now()+interval '7 days'),
            ('${wsB}','y@example.com','member','hash-b',now()+interval '7 days')`,
  );
  await db.query(
    `insert into audit_log (workspace_id, actor_type, action, entity)
     values ('${wsA}','system','test','workspace'), ('${wsB}','system','test','workspace')`,
  );
});

describe('RLS — tenant isolation', () => {
  it('a session in workspace A sees only its own users', async () => {
    const rows = await asWorkspace(db, wsA, () =>
      db.query<{ workspace_id: string }>('select workspace_id from users'),
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.workspace_id).toBe(wsA);
  });

  it('a session in workspace A sees only its own invitations', async () => {
    const rows = await asWorkspace(db, wsA, () =>
      db.query<{ workspace_id: string }>('select workspace_id from invitations'),
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.workspace_id).toBe(wsA);
  });

  it('a session in workspace A sees only its own audit rows', async () => {
    const rows = await asWorkspace(db, wsA, () =>
      db.query<{ workspace_id: string }>('select workspace_id from audit_log'),
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.workspace_id).toBe(wsA);
  });

  it('a session in workspace A cannot read workspace B directly', async () => {
    const rows = await asWorkspace(db, wsA, () =>
      db.query('select * from workspaces where id = $1', [wsB]),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it('a session with no claim sees nothing at all', async () => {
    const rows = await asWorkspace(db, null, () => db.query('select * from users'));
    expect(rows.rows).toHaveLength(0);
  });

  it('inserting a row into another workspace is rejected by the policy', async () => {
    await expect(
      asWorkspace(db, wsA, () =>
        db.query(
          `insert into users (auth_user_id, workspace_id, email, role)
           values ('auth-x','${wsB}','x@evil.com','viewer')`,
        ),
      ),
    ).rejects.toThrow(/row-level security|policy/i);
  });
});

describe('audit_log is append-only', () => {
  it('UPDATE raises a permission error for the application role', async () => {
    await expect(
      asWorkspace(db, wsA, () => db.query(`update audit_log set action = 'tampered'`)),
    ).rejects.toThrow(/permission denied/i);
  });

  it('DELETE raises a permission error for the application role', async () => {
    await expect(
      asWorkspace(db, wsA, () => db.query('delete from audit_log')),
    ).rejects.toThrow(/permission denied/i);
  });

  it('INSERT is allowed and attributed to the workspace', async () => {
    await asWorkspace(db, wsA, () =>
      db.query(`insert into audit_log (workspace_id, actor_type, action, entity) values ($1,'user','login','user')`, [wsA]),
    );
    const n = await asSuperuser(db, () =>
      db.query<{ n: number }>(`select count(*)::int as n from audit_log where workspace_id = $1 and action = 'login'`, [wsA]),
    );
    expect(n.rows[0]!.n).toBe(1);
  });
});

describe('constraints', () => {
  it('a workspace can have only one owner', async () => {
    await expect(
      db.query(
        `insert into users (auth_user_id, workspace_id, email, role)
         values ('auth-a2','${wsA}','a2@example.com','owner')`,
      ),
    ).rejects.toThrow(/users_single_owner_idx|duplicate key/i);
  });

  it('an invalid slug is rejected', async () => {
    await expect(
      db.query(`insert into workspaces (name, slug) values ('Bad','Not A Slug!')`),
    ).rejects.toThrow(/slug/i);
  });

  it('holdout_rate outside 10–30 % is rejected', async () => {
    await expect(
      db.query(`insert into workspaces (name, slug, holdout_rate) values ('C','agence-c',0.5)`),
    ).rejects.toThrow(/holdout_rate/i);
  });
});

describe('migrations', () => {
  it('are idempotent', async () => {
    const { migrate } = await import('../migrate.ts');
    const applied = await migrate(db);
    expect(applied).toEqual([]);
  });
});

describe('RLS coverage — every tenant table has a policy (criterion 8)', () => {
  it('every table carrying workspace_id carries a policy — the loop fails when a new table forgets', async () => {
    const tenantTables = await asSuperuser(db, () =>
      db.query<{ table_name: string }>(
        `select distinct c.table_name
           from information_schema.columns c
          where c.table_schema = 'public' and c.column_name = 'workspace_id'
            and c.table_name not in ('stripe_events')`,
      ),
    );
    expect(tenantTables.rows.length).toBeGreaterThan(20); // the schema is big; the loop is real

    const policies = await asSuperuser(db, () =>
      db.query<{ table_name: string }>(
        `select distinct tablename as table_name from pg_policies where schemaname = 'public'`,
      ),
    );
    const covered = new Set(policies.rows.map((r) => r.table_name));
    const missing = tenantTables.rows.map((r) => r.table_name).filter((t) => !covered.has(t));
    expect(missing, `tables with workspace_id but NO policy: ${missing.join(', ')}`).toEqual([]);
  });

  it('the phase-08 tables are functionally tenant-isolated, not just tagged', async () => {
    const seed = await asSuperuser(db, () => db.query<{ id: string }>(
      `insert into workspaces (name, slug) values ('Agence K','agence-k') returning id`,
    ));
    const wsK = seed.rows[0]!.id;
    await asSuperuser(db, () => db.query(
      `insert into api_keys (workspace_id, name, prefix, key_hash, scopes)
       values ('${wsK}','k','rrs_live_','hash-k', array['read:opportunities'])`,
    ));
    await asSuperuser(db, () => db.query(
      `insert into webhook_endpoints (workspace_id, url, secret, events)
       values ('${wsK}','https://k.example.com/h','v1:aa:bb:cc:dd', array['reply.received'])`,
    ));
    await asSuperuser(db, () => db.query(
      `insert into job_runs (job, workspace_id) values ('cron.webhooks','${wsK}')`,
    ));
    // A session scoped to workspace A sees none of K's rows — on ANY new table.
    for (const [table, count] of [['api_keys', 0], ['webhook_endpoints', 0], ['webhook_deliveries', 0], ['job_runs', 0]] as const) {
      await asWorkspace(db, wsA, async () => {
        const r = await db.query<{ n: number }>(`select count(*)::int as n from ${table}`);
        expect(r.rows[0]!.n, `${table} leaked workspace K into workspace A`).toBe(count);
      });
    }
  });
});
