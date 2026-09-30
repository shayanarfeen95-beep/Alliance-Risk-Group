/**
 * A pull imports what is new or changed — not the same months every time.
 *
 * Before this, every press of Pull and every nightly refresh re-imported every
 * month in its window: a year of closed, unchanged QuickBooks months rewritten,
 * and a log that could not say what had actually changed. These tests pin the
 * rules: what is fetched, what is compared, what is left alone, and that
 * anything uncertain is fetched rather than skipped.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db';
import * as t from '@/lib/db/schema';
import {
  compareBatch,
  planReportMonths,
  saveFingerprints,
} from '@/lib/etl/fingerprint';
import type { RawBatch } from '@/lib/connectors/types';

let harness: TestDb;
const TODAY = new Date('2026-09-24T12:00:00Z');
const WINDOW = { start: '2026-01-01', end: '2026-09-01' };
const ALL = ['01', '02', '03', '04', '05', '06', '07', '08', '09'].map((m) => `2026-${m}-01`);

beforeAll(async () => {
  harness = await createTestDb();
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.delete(t.syncFingerprint);
});

const report = (month: string, revenue: string, time = '2026-09-24T01:00:00-07:00') => ({
  Header: { ReportName: 'ProfitAndLoss', Time: time, StartPeriod: month },
  Rows: { Row: [{ ColData: [{ value: 'Income' }, { value: revenue }] }] },
});

function batch(entity: string, records: Array<{ key: string; payload: unknown }>, source: 'QBO' | 'SHEETS' = 'QBO'): RawBatch {
  return {
    sourceSystem: source,
    entity,
    window: WINDOW,
    fetchedAt: TODAY,
    records: records.map((record) => ({ entity, ...record })),
    nextCursor: null,
  };
}

/** Imports every month once, as a first pull would. */
async function firstPull(entity = 'profit_and_loss') {
  const comparison = await compareBatch(
    harness.db,
    batch(entity, ALL.map((month) => ({ key: month, payload: report(month, '100.00') }))),
    true,
    TODAY,
  );
  expect(comparison.batch.records).toHaveLength(9);
  await saveFingerprints(harness.db, 'QBO', entity, comparison, null as never);
}

const quiet = { changedMonths: async () => ({ months: [] as string[], undated: 0 }) };

describe('which QuickBooks months a pull fetches', () => {
  it('fetches every month the first time', async () => {
    const plan = await planReportMonths(harness.db, quiet, 'QBO', 'profit_and_loss', WINDOW, TODAY);
    expect(plan.months).toEqual(ALL);
    expect(plan.notes[0]).toMatch(/9 not yet loaded/);
  });

  it('then fetches only the three latest months when QuickBooks shows no edits', async () => {
    await firstPull();
    const plan = await planReportMonths(harness.db, quiet, 'QBO', 'profit_and_loss', WINDOW, TODAY);
    expect(plan.months).toEqual(['2026-07-01', '2026-08-01', '2026-09-01']);
    expect(plan.notes[0]).toMatch(/6 held unchanged and not fetched/);
  });

  it('adds a month QuickBooks’ change log says was edited', async () => {
    await firstPull();
    const feed = { changedMonths: async () => ({ months: ['2026-03-01'], undated: 0 }) };
    const plan = await planReportMonths(harness.db, feed, 'QBO', 'profit_and_loss', WINDOW, TODAY);
    expect(plan.months).toEqual(['2026-03-01', '2026-07-01', '2026-08-01', '2026-09-01']);
    expect(plan.notes[0]).toMatch(/edited in QuickBooks/);
  });

  it('re-checks every later balance sheet after an edit, because balances carry forward', async () => {
    await firstPull('balance_sheet');
    const feed = { changedMonths: async () => ({ months: ['2026-03-01'], undated: 0 }) };
    const plan = await planReportMonths(harness.db, feed, 'QBO', 'balance_sheet', WINDOW, TODAY);
    expect(plan.months).toEqual(ALL.slice(2));
  });

  it('fetches everything when it cannot be sure: a deletion, an unreadable log, or a stale check', async () => {
    await firstPull();
    const deletion = { changedMonths: async () => ({ months: [], undated: 1 }) };
    expect((await planReportMonths(harness.db, deletion, 'QBO', 'profit_and_loss', WINDOW, TODAY)).months).toEqual(ALL);

    const broken = { changedMonths: async () => { throw new Error('HTTP 500'); } };
    const plan = await planReportMonths(harness.db, broken, 'QBO', 'profit_and_loss', WINDOW, TODAY);
    expect(plan.months).toEqual(ALL);
    expect(plan.notes.join(' ')).toMatch(/could not be read/);

    const later = new Date('2026-11-24T12:00:00Z');
    const stale = await planReportMonths(harness.db, quiet, 'QBO', 'profit_and_loss', { start: '2026-01-01', end: '2026-11-01' }, later);
    expect(stale.months).toHaveLength(11);
    expect(stale.notes.join(' ')).toMatch(/further back than QuickBooks keeps its change log/);
  });

  it('re-checks every month when the class mapping changes', async () => {
    await firstPull();
    await harness.db.insert(t.dimClassMap).values({ classKey: 'new-class', className: 'New', decision: 'EXCLUDED' });
    const plan = await planReportMonths(harness.db, quiet, 'QBO', 'profit_and_loss', WINDOW, TODAY);
    expect(plan.months).toEqual(ALL);
    expect(plan.notes[0]).toMatch(/class mapping changed/);
    await harness.db.delete(t.dimClassMap);
  });
});

describe('what a fetched batch imports', () => {
  it('imports only the months whose content differs, ignoring QuickBooks’ report timestamp', async () => {
    await firstPull();
    const refetched = batch('profit_and_loss', [
      { key: '2026-07-01', payload: report('2026-07-01', '100.00', '2026-09-25T09:00:00-07:00') },
      { key: '2026-08-01', payload: report('2026-08-01', '250.00') },
      { key: '2026-09-01', payload: report('2026-09-01', '100.00') },
    ]);
    const comparison = await compareBatch(harness.db, refetched, true, TODAY);
    expect(comparison.batch.records.map((record) => record.key)).toEqual(['2026-08-01']);
    expect(comparison.notes.join(' ')).toMatch(/re-imported: 2026-08/);
    expect(comparison.notes.join(' ')).toMatch(/identical to what is loaded, not re-imported: 2026-07, 2026-09/);
  });

  it('re-imports everything on request, and still records fingerprints', async () => {
    await firstPull();
    const comparison = await compareBatch(
      harness.db,
      batch('profit_and_loss', [{ key: '2026-07-01', payload: report('2026-07-01', '100.00') }]),
      false,
      TODAY,
    );
    expect(comparison.batch.records).toHaveLength(1);
    expect(comparison.hashes.has('2026-07-01')).toBe(true);
  });

  it('leaves an unchanged Sheets tab alone, and imports it once it changes', async () => {
    const tab = (value: number) => batch('monthly_budget', [{ key: 'range', payload: { range: 'r', values: [['SHRC', value]] } }], 'SHEETS');

    const first = await compareBatch(harness.db, tab(1), true, TODAY);
    expect(first.batch.records).toHaveLength(1);
    await saveFingerprints(harness.db, 'SHEETS', 'monthly_budget', first, null as never);

    const same = await compareBatch(harness.db, tab(1), true, TODAY);
    expect(same.batch.records).toHaveLength(0);
    expect(same.notes[0]).toMatch(/Unchanged since it was last imported/);

    const edited = await compareBatch(harness.db, tab(2), true, TODAY);
    expect(edited.batch.records).toHaveLength(1);
    expect(edited.notes[0]).toMatch(/Changed since the last import/);
  });
});
