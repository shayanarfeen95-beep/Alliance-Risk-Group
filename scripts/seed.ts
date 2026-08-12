/**
 * `pnpm db:seed` — loads the generated dataset into the configured database.
 *
 * The work lives in lib/seed/load.ts so the test suite can seed an in-memory
 * database through exactly the same code path.
 */
import { getDb, closeDb } from '../lib/db/client';
import { seedDatabase } from '../lib/seed/load';

async function main() {
  const db = await getDb();
  console.log('seeding…');
  await seedDatabase(db);
  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeDb().catch(() => {});
  process.exit(1);
});
