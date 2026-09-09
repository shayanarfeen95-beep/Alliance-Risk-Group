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
 *
 * There is no third mode. A deployment reads ARG's own books or it reads
 * nothing: DATABASE_URL is required in production, and the app refuses to start
 * without one rather than falling back to something that looks like data.
 *
 * The demonstration mode that used to live here seeded an in-memory database per
 * instance on first use. On a single machine that is a convincing preview; on
 * serverless it is several unrelated databases wearing one domain name. Signing
 * in wrote a session to whichever instance served the request, the next request
 * landed on a different one, and the user was returned to the login page — over
 * and over, with nothing on screen explaining why. The same split broke the
 * source connections: the OAuth state written when you pressed Connect was read
 * back by an instance that had never heard of it.
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

export class DatabaseNotConfiguredError extends Error {
  constructor() {
    super(
      'DATABASE_URL is not set. This application reads ARG\u2019s own figures and keeps sessions, ' +
        'source authorisations and load history in Postgres, none of which survive without one. ' +
        'Set it to a Postgres connection string — Neon\u2019s free tier is enough, and its pooled ' +
        'endpoint is what this expects — then redeploy.',
    );
    this.name = 'DatabaseNotConfiguredError';
  }
}

/**
 * Parameters libpq understands and postgres-js does not.
 *
 * Anything in the query string that postgres-js has no option for is forwarded
 * to the server as a *startup parameter*, and Postgres rejects an unknown one
 * outright: `FATAL: unrecognized configuration parameter`. Every request then
 * fails with a 500 that says nothing about its cause.
 *
 * This matters because Neon's console hands you a connection string ending
 * `?sslmode=require&channel_binding=require`. That is correct for psql and fatal
 * here, and pasting the string you were given is the obvious thing to do. So the
 * ones that are meaningful only to a libpq client are dropped rather than
 * passed on — the TLS they describe is already handled by `sslmode`.
 */
const LIBPQ_ONLY_PARAMS = [
  'channel_binding',
  'gssencmode',
  'krbsrvname',
  'service',
  'passfile',
  'sslcert',
  'sslkey',
  'sslcrl',
  'sslcompression',
  'requiressl',
];

export function sanitiseConnectionString(url: string): string {
  try {
    const parsed = new URL(url);
    let changed = false;
    for (const param of LIBPQ_ONLY_PARAMS) {
      if (parsed.searchParams.has(param)) {
        parsed.searchParams.delete(param);
        changed = true;
      }
    }
    return changed ? parsed.toString() : url;
  } catch {
    // Not parseable as a URL — hand it over untouched and let the driver report
    // what is wrong with it, which it will do more precisely than this could.
    return url;
  }
}

async function create(): Promise<Database> {
  const url = process.env.DATABASE_URL;

  // Embedded Postgres is for development and the test suite. In production it
  // would be a per-instance database on a read-only filesystem, which is not a
  // degraded version of the real thing but a different and much worse one.
  if (!url && process.env.NODE_ENV === 'production') {
    throw new DatabaseNotConfiguredError();
  }

  if (url) {
    const { default: postgres } = await import('postgres');

    // Serverless changes the right pool shape. Each instance handles one
    // request at a time, so a pool of ten opens nine idle connections per
    // instance and exhausts Neon's connection limit under any real traffic.
    // `prepare: false` is required by pgbouncer in transaction mode, which is
    // what Neon's pooled endpoint runs.
    const serverless = Boolean(process.env.VERCEL);
    const client = postgres(sanitiseConnectionString(url), {
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
  // In-memory keeps the test suite hermetic; the dev server persists to disk so
  // a developer's data survives a restart.
  const dataDir = process.env.PGLITE_IN_MEMORY === '1' ? undefined : DATA_DIR;
  const client = await PGlite.create(dataDir);
  globalForDb.__argDbClose = async () => {
    await client.close();
  };
  return drizzlePglite(client, { schema });
}

/**
 * Brings an embedded PGlite database up to schema.
 *
 * Migration runs for *every* PGlite database, not only the demo one. Without
 * that, `pnpm install && pnpm dev` — which is what anyone actually types —
 * reaches a database with no tables, and the first-run screen fails on submit
 * with a 500. Requiring `db:migrate` first is a step that exists only because
 * the code did not do it, and the error it produces looks like a broken
 * application rather than a missing command.
 *
 * The migrator records what it has applied, so this is a no-op on every
 * subsequent start rather than repeated work.
 */
async function bootstrapEmbedded(db: Database): Promise<void> {
  const { migrate } = await import('drizzle-orm/pglite/migrator');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await migrate(db as any, { migrationsFolder: 'lib/db/migrations' });
  // Nothing is seeded. A database with a schema and no rows is the honest
  // starting state: the first visit offers the setup screen, and every figure
  // that appears afterwards came from a source somebody connected.
}

export async function getDb(): Promise<Database> {
  if (!globalForDb.__argDb) {
    const db = await create();

    if (!process.env.DATABASE_URL) {
      // Held as a promise rather than a boolean: concurrent requests during a
      // cold start must await the same bootstrap, not race to run four of them
      // against the same database.
      globalForDb.__argBootstrap ??= bootstrapEmbedded(db).catch((error) => {
        // A failed bootstrap must not be cached as done — the next request
        // should retry rather than serve an empty warehouse as if it were real.
        globalForDb.__argBootstrap = undefined;
        throw error;
      });
      await globalForDb.__argBootstrap;
    } else {
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
