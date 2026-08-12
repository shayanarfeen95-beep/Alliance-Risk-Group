/**
 * Test database harness.
 *
 * Every suite runs against a fresh in-memory PGlite instance with the real
 * migrations applied — including the triggers and CHECK constraints. That means
 * the immutability guarantee in Acceptance Test 7 is proven against actual
 * Postgres behaviour, not mocked.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from '@/lib/db/schema';
import type { Database } from '@/lib/db/client';
import type { SessionUser } from '@/lib/auth/session';

export interface TestDb {
  db: Database;
  client: PGlite;
  close(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const client = await PGlite.create();
  const db = drizzle(client, { schema });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await migrate(db as any, { migrationsFolder: 'lib/db/migrations' });

  return {
    db: db as unknown as Database,
    client,
    close: async () => {
      await client.close();
    },
  };
}

/** The CFO persona — consolidated access, used by most assertions. */
export const CFO_USER = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'cfo@westportfinancial.com',
  name: 'Westport Financial',
  role: 'CFO' as const,
  canViewConsolidated: true,
  divisionCodes: [] as string[],
};

/** A division-scoped persona, used to prove entitlements are enforced. */
export const CLAIMS_MANAGER_USER = {
  id: '00000000-0000-0000-0000-000000000002',
  email: 'claims.lead@alliancerisk.com',
  name: 'Claims Division Manager',
  role: 'DIVISION_MANAGER' as const,
  canViewConsolidated: false,
  divisionCodes: ['CLAIMS'],
};

/**
 * Loads a seeded user as a real `SessionUser`.
 *
 * The personas above are fine for pure entitlement logic, but anything that
 * writes a row referencing `users.id` needs the actual seeded identity — a
 * synthetic UUID trips the foreign key, which is the constraint doing its job.
 */
export async function loadSeededUser(db: Database, email: string): Promise<SessionUser> {
  const { users, userDivisionAccess } = await import('@/lib/db/schema');
  const { eq, sql } = await import('drizzle-orm');

  const [row] = await db.select().from(users).where(sql`lower(${users.email}) = lower(${email})`).limit(1);
  if (!row) throw new Error(`Seeded user ${email} not found.`);

  const access = await db
    .select({ divisionCode: userDivisionAccess.divisionCode })
    .from(userDivisionAccess)
    .where(eq(userDivisionAccess.userId, row.id));

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role as SessionUser['role'],
    canViewConsolidated: row.canViewConsolidated,
    divisionCodes: access.map((a) => a.divisionCode),
  };
}
