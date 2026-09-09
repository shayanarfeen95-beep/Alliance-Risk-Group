/**
 * A warehouse with HubSpot in it and no QuickBooks.
 *
 * This is the state a new deployment is in the moment the first source is
 * signed in, and it did not work. The month selector was built from
 * `fact_pl_actual` alone — the QuickBooks profit and loss — so with only HubSpot
 * connected it came back empty, every dashboard fell through to a configured
 * reporting month that nothing had ever loaded into, and tens of thousands of
 * landed contacts, deals and meetings had no month to appear under. Every figure
 * on every screen read zero, and nothing said why.
 *
 * Two things had to be true and neither was: HubSpot data has to create the
 * periods it falls into, the way QuickBooks data always did, and the month axis
 * has to be built from every source rather than from one of them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from './helpers/db';
import { seedDatabase } from '@/lib/seed/load';
import { conformBatch } from '@/lib/etl/conform';
import * as t from '@/lib/db/schema';
import type { RawBatch } from '@/lib/connectors/types';

let harness: TestDb;

beforeAll(async () => {
  harness = await createTestDb();
  await seedDatabase(harness.db);
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

/** Well past the seeded history, which is exactly the case that broke. */
const BEYOND_SEED = '2026-08';

function dealBatch(): RawBatch {
  return {
    sourceSystem: 'HUBSPOT',
    entity: 'deals',
    window: { start: '2026-08-01', end: '2026-08-01' },
    fetchedAt: new Date(),
    records: [
      {
        entity: '/crm/v3/objects/deals',
        key: 'd1',
        payload: {
          id: 'd1',
          properties: {
            dealname: 'Fleet renewal',
            amount: '100000',
            dealstage: 'closedwon',
            hs_is_closed_won: 'true',
            hs_is_closed: 'true',
            createdate: `${BEYOND_SEED}-04T00:00:00Z`,
            closedate: `${BEYOND_SEED}-28T00:00:00Z`,
          },
        },
      },
    ],
  };
}

describe('HubSpot data beyond the seeded period history', () => {
  it('creates the period it falls into', async () => {
    const before = await harness.db
      .select()
      .from(t.dimPeriod)
      .where(sql`${t.dimPeriod.periodMonth} = ${`${BEYOND_SEED}-01`}`);
    expect(before).toHaveLength(0);

    await conformBatch(harness.db, seedRunId(), dealBatch());

    const after = await harness.db
      .select()
      .from(t.dimPeriod)
      .where(sql`${t.dimPeriod.periodMonth} = ${`${BEYOND_SEED}-01`}`);

    // Without this the deal is written and then invisible: no period, so no
    // month on the selector, so no screen that could show it.
    expect(after).toHaveLength(1);
    expect(after[0]!.isClosed).toBe(false);
  });

  it('refuses to invent a period from an implausible date', async () => {
    const batch = dealBatch();
    const payload = batch.records[0]!.payload as { id: string; properties: Record<string, string> };
    payload.id = 'd2';
    payload.properties.closedate = '2187-04-01T00:00:00Z';
    payload.properties.createdate = '2187-04-01T00:00:00Z';
    batch.records[0]!.key = 'd2';

    await conformBatch(harness.db, seedRunId(), batch);

    // The deal is still written with the date it carries. What must not happen
    // is a month selector that runs to the next century.
    const invented = await harness.db
      .select()
      .from(t.dimPeriod)
      .where(sql`${t.dimPeriod.periodMonth} = '2187-04-01'`);
    expect(invented).toHaveLength(0);
  });
});

/** conform needs a load run to attribute rows to; any real one will do. */
function seedRunId(): string {
  return runId!;
}

let runId: string | null = null;

beforeAll(async () => {
  const [run] = await harness.db
    .select({ id: t.loadRun.id })
    .from(t.loadRun)
    .limit(1);
  runId = run!.id;
});
