/**
 * Deciding what a QuickBooks class means.
 *
 * Class is how ARG separates divisions in QuickBooks, and conform refuses a
 * month containing a class it cannot place. That refusal is correct and must
 * stay: loading a class against the wrong division, or quietly dropping it,
 * moves revenue between two divisional P&Ls with nothing on any screen saying
 * so — the reader sees a division that grew and another that shrank, and both
 * are fiction.
 *
 * But the mapping lived only in seeded arrays, so a class the seed had never
 * heard of could not be placed at all, and "refuses" meant "nothing ever loads".
 * The first real QuickBooks pull wrote zero rows: PS-APS, PS-Other, PS-TP,
 * Z Alloc and Not Specified had nowhere to be decided.
 *
 * The missing state was the third one. Not every class is a division — an
 * allocation bucket is not, and neither is an unclassified catch-all. What is
 * asserted here is that the refusal survives, that a decision releases it, and
 * that excluding a class leaves its money OUT rather than redistributing it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { and, eq } from 'drizzle-orm';
import { createTestDb, loadSeededUser, type TestDb } from './helpers/db';
import { seedDatabase } from '@/lib/seed/load';
import { conformBatch } from '@/lib/etl/conform';
import { decideClass, listClassMap } from '@/lib/etl/class-map';
import * as t from '@/lib/db/schema';
import type { RawBatch } from '@/lib/connectors/types';
import type { SessionUser } from '@/lib/auth/session';

let harness: TestDb;
let user: SessionUser;
let runId: string;

/**
 * Past the seeded history, so the fixture is the only data in this month.
 *
 * Inside the seeded range these assertions would be against the sum of two
 * datasets and would move whenever the seed did.
 */
const MONTH = '2026-07-01';

beforeAll(async () => {
  harness = await createTestDb();
  await seedDatabase(harness.db);
  user = await loadSeededUser(harness.db, 'cfo@westportfinancial.com');
  const [run] = await harness.db.select({ id: t.loadRun.id }).from(t.loadRun).limit(1);
  runId = run!.id;
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.delete(t.dimClassMap);
  await harness.db.delete(t.auditEvent).where(eq(t.auditEvent.entity, 'dim_class_map'));
  await harness.db.delete(t.factPlActual).where(eq(t.factPlActual.periodMonth, MONTH));
});

/**
 * A P&L with one mapped division column and one that is an allocation bucket —
 * which is exactly the shape that blocked ARG's first live pull.
 */
function profitAndLoss(): RawBatch {
  const columns = [
    { ColTitle: '', ColType: 'Account' },
    { ColTitle: 'SHRC', ColType: 'Money', MetaData: [{ Name: 'ClassRef', Value: 'CLASS_SHRC' }] },
    { ColTitle: 'Z Alloc', ColType: 'Money', MetaData: [{ Name: 'ClassRef', Value: 'CLASS_ZALLOC' }] },
    { ColTitle: 'Total', ColType: 'Money', MetaData: [{ Name: 'ColKey', Value: 'total' }] },
  ];

  const row = (id: string, name: string, values: number[]) => ({
    type: 'Data',
    ColData: [
      { value: name, id },
      ...values.map((value) => ({ value: value.toFixed(2) })),
      { value: values.reduce((sum, value) => sum + value, 0).toFixed(2) },
    ],
  });

  return {
    sourceSystem: 'QBO',
    entity: 'profit_and_loss',
    window: { start: MONTH, end: MONTH },
    fetchedAt: new Date(),
    records: [
      {
        entity: 'ProfitAndLoss',
        key: MONTH,
        payload: {
          Header: { ReportName: 'ProfitAndLoss' },
          Columns: { Column: columns },
          Rows: {
            Row: [
              {
                type: 'Section',
                group: 'Income',
                Rows: { Row: [row('1', 'Consulting income', [100_000, 25_000])] },
              },
            ],
          },
        },
      },
    ],
  };
}

function classList(): RawBatch {
  return {
    sourceSystem: 'QBO',
    entity: 'classes',
    window: { start: MONTH, end: MONTH },
    fetchedAt: new Date(),
    records: [
      {
        entity: 'classes',
        key: 'all',
        payload: {
          QueryResponse: {
            Class: [
              { Id: 'CLASS_SHRC', Name: 'SHRC', Active: true },
              { Id: 'CLASS_ZALLOC', Name: 'Z Alloc', Active: true },
            ],
          },
        },
      },
    ],
  };
}

async function revenueFor(divisionCode: string): Promise<Decimal> {
  const [row] = await harness.db
    .select()
    .from(t.factPlActual)
    .where(
      and(eq(t.factPlActual.periodMonth, MONTH), eq(t.factPlActual.divisionCode, divisionCode)),
    );
  return new Decimal(row?.revenue ?? 0);
}

describe('a class nobody has placed', () => {
  it('refuses the month rather than guessing', async () => {
    await expect(conformBatch(harness.db, runId, profitAndLoss())).rejects.toThrow(
      /map to no division/i,
    );
  });

  it('names where the decision is made', async () => {
    // The old message pointed at a database column. Nobody reading a failed
    // pull can act on that.
    await expect(conformBatch(harness.db, runId, profitAndLoss())).rejects.toThrow(
      /Class mapping/i,
    );
  });

  it('offers the blocking class for a decision afterwards', async () => {
    await conformBatch(harness.db, runId, profitAndLoss()).catch(() => {});

    const rows = await listClassMap(harness.db);
    // The class list runs weekly and a P&L daily, so the thing that actually
    // blocked the load has to reach the screen without waiting for the list.
    expect(rows.map((row) => row.className)).toContain('Z Alloc');
    expect(rows.find((row) => row.className === 'Z Alloc')?.decision).toBe('UNMAPPED');
  });
});

describe('once the decision is made', () => {
  it('loads the month, with excluded money left OUT', async () => {
    await conformBatch(harness.db, runId, classList());
    await decideClass(harness.db, user, { classKey: 'class_zalloc', divisionCode: null });

    const outcome = await conformBatch(harness.db, runId, profitAndLoss());
    expect(outcome.rowsWritten).toBeGreaterThan(0);

    // SHRC gets its own 100k. The 25k on the allocation bucket is not added to
    // it, not spread across divisions, and not silently attached to ARG Total —
    // excluding a class means the money is out, which is the whole point of
    // saying so deliberately.
    expect((await revenueFor('SHRC')).toNumber()).toBe(100_000);

    const rows = await harness.db
      .select()
      .from(t.factPlActual)
      .where(eq(t.factPlActual.periodMonth, MONTH));
    const total = rows.reduce((sum, row) => sum.plus(row.revenue), new Decimal(0));
    expect(total.toNumber()).toBe(100_000);
  });

  it('loads it against the division when one is chosen', async () => {
    await conformBatch(harness.db, runId, classList());
    await decideClass(harness.db, user, { classKey: 'class_zalloc', divisionCode: 'CLAIMS' });

    await conformBatch(harness.db, runId, profitAndLoss());

    expect((await revenueFor('SHRC')).toNumber()).toBe(100_000);
    expect((await revenueFor('CLAIMS')).toNumber()).toBe(25_000);
  });

  it('records who decided, because it changes what the P&Ls say', async () => {
    await conformBatch(harness.db, runId, classList());
    await decideClass(harness.db, user, { classKey: 'class_zalloc', divisionCode: null });

    const [row] = await harness.db
      .select()
      .from(t.dimClassMap)
      .where(eq(t.dimClassMap.classKey, 'class_zalloc'));

    expect(row!.decision).toBe('EXCLUDED');
    expect(row!.decidedByUserId).toBe(user.id);
    expect(row!.decidedAt).not.toBeNull();

    const audit = await harness.db
      .select()
      .from(t.auditEvent)
      .where(eq(t.auditEvent.entityId, 'class_zalloc'));
    expect(audit).toHaveLength(1);
  });

  it('keeps ONE row per class however it was first noticed', async () => {
    // A report column carries a class TITLE; the class list carries an ID. Each
    // route used to insert its own row, so the screen offered two entries for
    // one class and mapping the one it showed left the other UNMAPPED — the
    // pull refused anyway. That is "I mapped it and it still did not work".
    await conformBatch(harness.db, runId, profitAndLoss()).catch(() => {});
    await conformBatch(harness.db, runId, classList());

    const rows = await listClassMap(harness.db);
    const zAlloc = rows.filter((row) => /z alloc/i.test(row.className));
    expect(zAlloc).toHaveLength(1);
  });

  it('can be decided by the name the screen shows, not just the id', async () => {
    await conformBatch(harness.db, runId, profitAndLoss()).catch(() => {});

    // The blocking class was recorded under its name. Deciding it must work
    // without the operator knowing QuickBooks' internal id for it.
    await decideClass(harness.db, user, { classKey: 'z alloc', divisionCode: null });

    const rows = await listClassMap(harness.db);
    expect(rows.find((row) => /z alloc/i.test(row.className))?.decision).toBe('EXCLUDED');
  });

  it('says which months a class is blocking', async () => {
    await conformBatch(harness.db, runId, profitAndLoss()).catch(() => {});

    // Recorded against a FAILED run so the screen can show the consequence of
    // the decision before it is made.
    await harness.db.insert(t.loadRun).values({
      sourceSystem: 'QBO',
      entity: 'profit_and_loss',
      windowStart: MONTH,
      windowEnd: MONTH,
      status: 'FAILED',
      errorMessage: 'classes that map to no division: Z Alloc. Nothing was written.',
    });

    const rows = await listClassMap(harness.db);
    const zAlloc = rows.find((row) => /z alloc/i.test(row.className));
    expect(zAlloc?.blockingMonths).toContain(MONTH.slice(0, 7));
  });

  it('refuses a class nobody has reported, by name', async () => {
    await expect(
      decideClass(harness.db, user, { classKey: 'not a real class', divisionCode: null }),
    ).rejects.toThrow(/No class called/i);
  });

  it('refuses a division that does not exist', async () => {
    await conformBatch(harness.db, runId, classList());
    await expect(
      decideClass(harness.db, user, { classKey: 'class_zalloc', divisionCode: 'NOPE' }),
    ).rejects.toThrow(/No division/i);
  });
});
