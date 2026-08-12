/**
 * Applies migrations against whichever driver is configured.
 *
 * `pnpm db:migrate` with no DATABASE_URL runs against embedded PGlite, so a
 * fresh clone needs no Postgres server, no Docker and no cloud account.
 */
import { getDb, closeDb } from '../lib/db/client';

async function main() {
  const db = await getDb();
  const usingPglite = !process.env.DATABASE_URL;

  if (usingPglite) {
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await migrate(db as any, { migrationsFolder: 'lib/db/migrations' });
  } else {
    const { migrate } = await import('drizzle-orm/postgres-js/migrator');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await migrate(db as any, { migrationsFolder: 'lib/db/migrations' });
  }

  console.log(`migrations applied (${usingPglite ? 'PGlite' : 'Postgres'})`);
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
