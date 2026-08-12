/**
 * Database client.
 *
 * One schema, two drivers:
 *   - DATABASE_URL set  -> postgres-js against a real server (Neon in production)
 *   - DATABASE_URL unset -> PGlite, Postgres compiled to WASM, storing in ./.pgdata
 *
 * PGlite is real Postgres, so triggers, CHECK constraints, arrays and jsonb all
 * behave identically to production. That means the forecast-immutability trigger
 * and the ARG_TOTAL constraints are exercised by the local test suite, not just
 * asserted in a comment.
 */
import { drizzle as drizzlePglite, type PgliteDatabase } from 'drizzle-orm/pglite';
import { drizzle as drizzlePostgres, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from './schema';

export type Database = PgliteDatabase<typeof schema> | PostgresJsDatabase<typeof schema>;

/**
 * Next.js dev-mode hot reload re-evaluates modules; without a global singleton
 * every reload would open a second PGlite instance on the same data directory.
 */
const globalForDb = globalThis as unknown as {
  __argDb?: Database;
  __argDbClose?: () => Promise<void>;
  __argBootstrap?: Promise<void>;
};

export const DATA_DIR = process.env.PGLITE_DATA_DIR ?? '.pgdata';

async function create(): Promise<Database> {
  const url = process.env.DATABASE_URL;

  if (url) {
    const { default: postgres } = await import('postgres');

    // Serverless changes the right pool shape. Each instance handles one
    // request at a time, so a pool of ten opens nine idle connections per
    // instance and exhausts Neon's connection limit under any real traffic.
    // `prepare: false` is required by pgbouncer in transaction mode, which is
    // what Neon's pooled endpoint runs.
    const serverless = Boolean(process.env.VERCEL);
    const client = postgres(url, {
      max: serverless ? 1 : 10,
      prepare: false,
      idle_timeout: serverless ? 20 : undefined,
      connect_timeout: 15,
    });

    globalForDb.__argDbClose = async () => {
      await client.end();
    };
    return drizzlePostgres(client, { schema });
  }

  const { PGlite } = await import('@electric-sql/pglite');
  // In-memory keeps the test suite hermetic; the dev server persists to disk.
  // Demo mode is always in-memory — a serverless filesystem is read-only, and
  // an instance that cannot write its data directory fails at import time with
  // an error that looks nothing like its cause.
  const dataDir =
    process.env.PGLITE_IN_MEMORY === '1' || isDemoMode() ? undefined : DATA_DIR;
  const client = await PGlite.create(dataDir);
  globalForDb.__argDbClose = async () => {
    await client.close();
  };
  return drizzlePglite(client, { schema });
}

/**
 * Demo mode.
 *
 * With `DEMO_MODE=1` and no `DATABASE_URL`, an instance brings up its own
 * in-memory Postgres, applies the real migrations and loads the seed on first
 * use. That makes the app explorable from a bare deployment with no database
 * provisioned — which is the only way a reviewer sees it before ARG's own
 * QuickBooks credentials exist.
 *
 * Two things are true of this mode and both matter:
 *
 *   - It is **ephemeral**. Each serverless instance holds its own copy, so a
 *     write in one request may not be visible to the next, and everything
 *     resets when the instance recycles. It is a demonstration, not a
 *     deployment.
 *   - It is **opt-in**. Setting `DATABASE_URL` takes precedence and this code
 *     never runs. A real deployment cannot accidentally end up seeded, and a
 *     seeded instance cannot be mistaken for one — the app labels it.
 *
 * The seed is the same deterministic dataset the test suite ties out against,
 * so the figures on a demo instance are the spec's published figures rather
 * than plausible-looking noise.
 */
export function isDemoMode(): boolean {
  return process.env.DEMO_MODE === '1' && !process.env.DATABASE_URL;
}

async function bootstrapDemo(db: Database): Promise<void> {
  const { migrate } = await import('drizzle-orm/pglite/migrator');
  const { seedDatabase } = await import('@/lib/seed/load');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await migrate(db as any, { migrationsFolder: 'lib/db/migrations' });
  await seedDatabase(db, { quiet: true });
}

export async function getDb(): Promise<Database> {
  if (!globalForDb.__argDb) {
    const db = await create();

    if (isDemoMode()) {
      // Held as a promise rather than a boolean: concurrent requests during a
      // cold start must await the same bootstrap, not race to run four of them
      // against the same database.
      globalForDb.__argBootstrap ??= bootstrapDemo(db).catch((error) => {
        // A failed bootstrap must not be cached as done — the next request
        // should retry rather than serve an empty warehouse as if it were real.
        globalForDb.__argBootstrap = undefined;
        throw error;
      });
      await globalForDb.__argBootstrap;
    } else if (process.env.DATABASE_URL) {
      // A real database brings itself up to schema on first use. An operator
      // pointing at an empty Neon database should get a working app, not
      // "relation does not exist" on every route until they remember to run a
      // migration from their laptop.
      const { ensureSchema } = await import('./bootstrap');
      await ensureSchema(db);
    }

    globalForDb.__argDb = db;
  }
  return globalForDb.__argDb;
}

/** Test/script teardown. Not used by the app. */
export async function closeDb(): Promise<void> {
  await globalForDb.__argDbClose?.();
  globalForDb.__argDb = undefined;
  globalForDb.__argDbClose = undefined;
}

export { schema };
