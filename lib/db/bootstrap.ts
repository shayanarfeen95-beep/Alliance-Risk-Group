import { sql } from 'drizzle-orm';
import type { Database } from './client';

/**
 * Brings a real Postgres database up to schema on first use.
 *
 * A deployment points at an empty Neon database and nothing else. Requiring the
 * operator to run a migration from their laptop before the first page load is a
 * step that gets skipped, and the failure it produces — "relation does not
 * exist" on every route — looks like a broken application rather than a missing
 * command.
 *
 * Two things make this safe to do on a request path:
 *
 *   1. **A Postgres advisory lock.** Serverless means many instances can cold
 *      start at once. Without the lock they would race, and concurrent CREATE
 *      TABLE against the same database is how you get a half-applied schema.
 *      The lock is held for the migration and released after; whoever loses the
 *      race waits, then finds the work already done.
 *   2. **Drizzle's own migration table.** Applied migrations are recorded, so
 *      this is a no-op on every subsequent boot rather than a repeated attempt.
 *
 * PGlite is excluded: it runs its migrations at seed time and has no concurrency
 * to guard against.
 */

/** Arbitrary but fixed — any constant works so long as nothing else uses it. */
const ADVISORY_LOCK_KEY = 4_071_355_211;

let applied: Promise<void> | null = null;

export function ensureSchema(db: Database): Promise<void> {
  applied ??= run(db).catch((error) => {
    // A failed migration must not be remembered as done: the next request
    // should try again rather than serve a database that is missing tables.
    applied = null;
    throw error;
  });
  return applied;
}

/** How many migrations the database has recorded as applied; null when it cannot say. */
async function appliedCount(db: Database): Promise<number | null> {
  try {
    const rows = (await db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`)) as unknown as
      | Array<{ n: number }>
      | { rows: Array<{ n: number }> };
    const list = Array.isArray(rows) ? rows : rows.rows;
    return Number(list[0]?.n ?? 0);
  } catch {
    return null; // No migrations table yet: a fresh database.
  }
}

async function expectedCount(): Promise<number> {
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const journal = JSON.parse(
    await readFile(path.join(process.cwd(), 'lib/db/migrations/meta/_journal.json'), 'utf8'),
  ) as { entries: unknown[] };
  return journal.entries.length;
}

async function run(db: Database): Promise<void> {
  const { migrate } = await import('drizzle-orm/postgres-js/migrator');

  // Already up to date — the case on every boot but the first after a deploy
  // with a new migration. No lock is taken at all. A session advisory lock
  // can be left held when an instance is killed at its time limit mid-boot
  // (the unlock in `finally` never runs, and a pooled connection keeps the
  // lock alive); every cold start after that waited on it forever and every
  // page timed out. November 2026.
  const expected = await expectedCount().catch(() => null);
  const recorded = await appliedCount(db);
  if (expected !== null && recorded !== null && recorded >= expected) return;

  // Something to apply: take the lock, but never wait on it for long. If it
  // cannot be had, look again — another instance may have just finished —
  // and otherwise migrate without it: every migration here is written to be
  // re-runnable (IF NOT EXISTS), and drizzle records what it applied.
  let locked = false;
  for (let attempt = 0; attempt < 20 && !locked; attempt++) {
    const result = (await db.execute(sql`select pg_try_advisory_lock(${ADVISORY_LOCK_KEY}) as ok`)) as unknown as
      | Array<{ ok: boolean }>
      | { rows: Array<{ ok: boolean }> };
    const list = Array.isArray(result) ? result : result.rows;
    locked = Boolean(list[0]?.ok);
    if (!locked) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const now = await appliedCount(db);
      if (expected !== null && now !== null && now >= expected) return;
    }
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await migrate(db as any, { migrationsFolder: 'lib/db/migrations' });
  } finally {
    if (locked) await db.execute(sql`select pg_advisory_unlock(${ADVISORY_LOCK_KEY})`);
  }
}

/**
 * Whether the warehouse has any users yet.
 *
 * Drives the first-run screen: a freshly migrated database has a schema and no
 * way to sign in, which would otherwise be a locked door with no key.
 */
export async function isUninitialised(db: Database): Promise<boolean> {
  try {
    const { users } = await import('./schema');
    const rows = await db.select({ id: users.id }).from(users).limit(1);
    return rows.length === 0;
  } catch {
    // No users table yet means nothing has been set up.
    return true;
  }
}
