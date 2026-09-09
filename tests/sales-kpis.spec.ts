/**
 * Sales and marketing metrics, on both an empty warehouse and a loaded one.
 *
 * These had no coverage at all, and the gap bit immediately: a guard added so a
 * fresh deployment would stop reporting $0 for "HubSpot has never been read"
 * keyed on the load-run label, and the seeded dataset writes one run labelled
 * SEED rather than one per source. Every sales figure went unavailable on top of
 * 548 deals, and the whole suite stayed green.
 *
 * So both directions are asserted here: nothing loaded must not read as zero,
 * and data in hand must not read as nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, loadSeededUser, type TestDb } from './helpers/db';
import { seedDatabase } from '@/lib/seed/load';
import { openSemanticSession, resolveKpi } from '@/lib/semantic/resolve';
import { DIVISION_SEED } from '@/lib/divisions';
import * as t from '@/lib/db/schema';
import type { SessionUser } from '@/lib/auth/session';

const HUBSPOT_METRICS = ['dollars_booked', 'count_of_bookings', 'leads_received'];

describe('a warehouse nothing has loaded', () => {
  let harness: TestDb;
  let user: SessionUser;

  beforeAll(async () => {
    harness = await createTestDb();

    // What the setup screen creates: reference data, an administrator, no facts.
    await harness.db.insert(t.dimDivision).values(DIVISION_SEED);
    const { SEED_CONFIG } = await import('@/lib/seed/load');
    await harness.db.insert(t.appConfig).values(SEED_CONFIG).onConflictDoNothing();
    await harness.db
      .insert(t.dimPeriod)
      .values({ periodMonth: '2026-03-01', fiscalYear: 2026, monthOfYear: 3, daysInMonth: 31 });
    const [row] = await harness.db
      .insert(t.users)
      .values({
        email: 'admin@alliancerisk.com',
        name: 'Administrator',
        passwordHash: 'x',
        role: 'ADMIN',
        canViewConsolidated: true,
      })
      .returning();

    user = {
      id: row!.id,
      email: row!.email,
      name: row!.name,
      role: 'ADMIN',
      canViewConsolidated: true,
      divisionCodes: [],
    };
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('withholds every HubSpot metric rather than reporting zero', async () => {
    const session = await openSemanticSession(harness.db, user, '2026-03-01');

    for (const metric of HUBSPOT_METRICS) {
      const result = resolveKpi(session, metric, 'ARG_TOTAL');

      // Zero would read as "ARG booked nothing", which is a different and much
      // more alarming claim than "nobody has connected HubSpot".
      expect(result.unavailable, `${metric} should be unavailable`).toBeDefined();
      expect(result.value ?? null, `${metric} should have no value`).toBeNull();
      expect(result.unavailable!.detail).toMatch(/HubSpot has not been loaded/i);
    }
  });
});

describe('a warehouse with data in it', () => {
  let harness: TestDb;
  let user: SessionUser;

  beforeAll(async () => {
    harness = await createTestDb();
    await seedDatabase(harness.db);
    user = await loadSeededUser(harness.db, 'cfo@westportfinancial.com');
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('reports HubSpot metrics from the records it holds', async () => {
    const session = await openSemanticSession(harness.db, user, '2026-03-01');
    expect(session.bundle.deals.length).toBeGreaterThan(0);

    for (const metric of HUBSPOT_METRICS) {
      const result = resolveKpi(session, metric, 'ARG_TOTAL');
      expect(result.unavailable, `${metric} should resolve`).toBeUndefined();
      expect(result.value!.toNumber()).toBeGreaterThan(0);
    }
  });

  it('does not depend on the load run carrying the source’s own name', async () => {
    // The seed writes a single run labelled SEED. Records in hand are what
    // settle whether a source has been read.
    const session = await openSemanticSession(harness.db, user, '2026-03-01');
    expect([...session.bundle.loadedSources]).not.toContain('HUBSPOT');
    expect(resolveKpi(session, 'dollars_booked', 'ARG_TOTAL').unavailable).toBeUndefined();
  });
});
