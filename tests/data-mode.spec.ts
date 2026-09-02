/**
 * Demonstration data versus ARG's own books.
 *
 * The seeded dataset exists so every dashboard, control and export can be
 * exercised before a source is connected. It is also the most dangerous thing in
 * the system: a plausible number does not announce itself as fabricated, and a
 * reader who believes seeded figures are their own books will act on them.
 *
 * So the assertions here are about the switch actually switching. Not "the flag
 * is set" — that proves nothing — but that a KPI resolved through the same path
 * the dashboards use stops returning a figure, and that data genuinely loaded
 * from a source survives the switch while the seed does not.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, loadSeededUser, type TestDb } from './helpers/db';
import { seedDatabase } from '@/lib/seed/load';
import { getDataMode, setDataMode, seedLoadRunIds } from '@/lib/data-mode';
import { openSemanticSession, resolveKpi } from '@/lib/semantic/resolve';
import { conformBatch } from '@/lib/etl/conform';
import * as t from '@/lib/db/schema';
import type { SessionUser } from '@/lib/auth/session';
import type { RawBatch } from '@/lib/connectors/types';

let harness: TestDb;
let user: SessionUser;

const MONTH = '2026-05-01';

beforeAll(async () => {
  harness = await createTestDb();
  await seedDatabase(harness.db);
  user = await loadSeededUser(harness.db, 'cfo@westportfinancial.com');
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

async function revenue(month = '2026-03-01') {
  const session = await openSemanticSession(harness.db, user, month);
  return resolveKpi(session, 'revenue', 'SHRC');
}

describe('data mode', () => {
  it('defaults a fresh deployment to demonstration', async () => {
    expect(await getDataMode(harness.db)).toBe('DEMONSTRATION');
  });

  it('shows seeded figures in demonstration mode', async () => {
    const result = await revenue();
    expect(result.unavailable).toBeUndefined();
    expect(result.value!.toNumber()).toBeGreaterThan(0);
  });

  it('withholds seeded figures in live mode rather than showing them', async () => {
    await setDataMode(harness.db, 'LIVE', user.id);
    expect(await getDataMode(harness.db)).toBe('LIVE');

    const result = await revenue();
    // The figure is not zero and not stale — it is explicitly unavailable, which
    // is the difference between "ARG made nothing" and "nothing has been loaded".
    expect(result.unavailable).toBeDefined();
    expect(result.value ?? null).toBeNull();
  });

  it('returns the seeded figures when switched back', async () => {
    await setDataMode(harness.db, 'DEMONSTRATION', user.id);
    const result = await revenue();
    expect(result.unavailable).toBeUndefined();
    expect(result.value!.toNumber()).toBeGreaterThan(0);
  });

  it('keeps data loaded from a source visible in live mode', async () => {
    // A real load, through the same conform path a QuickBooks pull uses.
    const [run] = await harness.db
      .insert(t.loadRun)
      .values({ sourceSystem: 'QBO', entity: 'profit_and_loss', status: 'RUNNING' })
      .returning();

    const batch: RawBatch = {
      sourceSystem: 'QBO',
      entity: 'profit_and_loss',
      window: { start: MONTH, end: MONTH },
      fetchedAt: new Date(),
      records: [
        {
          entity: 'profit_and_loss',
          key: MONTH,
          payload: {
            Columns: {
              Column: [
                { ColTitle: '', ColType: 'Account' },
                { ColTitle: 'SHRC', ColType: 'Money', MetaData: [{ Name: 'ClassRef', Value: 'CLASS_SHRC' }] },
                { ColTitle: 'Total', ColType: 'Money', MetaData: [{ Name: 'ColKey', Value: 'total' }] },
              ],
            },
            Rows: {
              Row: [
                {
                  type: 'Section',
                  group: 'Income',
                  Rows: {
                    Row: [
                      {
                        type: 'Data',
                        ColData: [{ value: 'Service Revenue', id: '4000' }, { value: '310000.00' }, { value: '310000.00' }],
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      ],
    };

    await conformBatch(harness.db, run!.id, batch);

    await setDataMode(harness.db, 'LIVE', user.id);
    const live = await revenue(MONTH);

    expect(live.unavailable).toBeUndefined();
    expect(live.value!.toNumber()).toBe(310_000);

    await setDataMode(harness.db, 'DEMONSTRATION', user.id);
  });

  it('finds the seed run every seeded row is stamped with', async () => {
    const runIds = await seedLoadRunIds(harness.db);
    expect(runIds).toHaveLength(1);

    const [seedRun] = await harness.db
      .select()
      .from(t.loadRun)
      .where(eq(t.loadRun.id, runIds[0]!));

    expect(seedRun!.sourceSystem).toBe('SEED');
  });
});
