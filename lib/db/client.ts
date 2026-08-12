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
};

export const DATA_DIR = process.env.PGLITE_DATA_DIR ?? '.pgdata';

async function create(): Promise<Database> {
  const url = process.env.DATABASE_URL;

  if (url) {
    const { default: postgres } = await import('postgres');
    const client = postgres(url, { max: 10, prepare: false });
    globalForDb.__argDbClose = async () => {
      await client.end();
    };
    return drizzlePostgres(client, { schema });
  }

  const { PGlite } = await import('@electric-sql/pglite');
  // ':memory:' keeps the test suite hermetic; the dev server persists to disk.
  const dataDir = process.env.PGLITE_IN_MEMORY === '1' ? undefined : DATA_DIR;
  const client = await PGlite.create(dataDir);
  globalForDb.__argDbClose = async () => {
    await client.close();
  };
  return drizzlePglite(client, { schema });
}

export async function getDb(): Promise<Database> {
  if (!globalForDb.__argDb) {
    globalForDb.__argDb = await create();
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
