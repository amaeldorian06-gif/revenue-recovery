import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './client.ts';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export function migrationFiles(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS_DIR, name), 'utf8') }));
}

/** Apply every migration not yet recorded. Idempotent: safe to call on each boot. */
export async function migrate(db: Db, opts: { verbose?: boolean } = {}): Promise<string[]> {
  await db.exec(`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    );
  `);
  const applied = new Set(
    (await db.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name),
  );
  const done: string[] = [];
  for (const file of migrationFiles()) {
    if (applied.has(file.name)) continue;
    await db.exec('begin');
    try {
      await db.exec(file.sql);
      await db.query('insert into schema_migrations (name) values ($1)', [file.name]);
      await db.exec('commit');
      done.push(file.name);
      if (opts.verbose) console.log(`  ✓ ${file.name}`);
    } catch (err) {
      await db.exec('rollback');
      throw new Error(`Migration ${file.name} failed: ${(err as Error).message}`);
    }
  }
  return done;
}
