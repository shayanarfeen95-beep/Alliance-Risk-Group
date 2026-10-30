/**
 * "Chart of Accounts · 0 rows", "Class list · 0 rows", "Trial Balance · 0 rows".
 *
 * All three had read QuickBooks successfully — 289 accounts, 11 classes, a trial
 * balance per month — and reported zero, because the count was of rows that
 * CHANGED and the trial balance was dropped after landing. A pull screen that
 * says QuickBooks returned nothing when it returned everything is exactly the
 * doubt this project exists to remove. The count is now what was synced.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from './helpers/db';
import { seedDatabase } from '@/lib/seed/load';
import { conformBatch, readTrialBalance } from '@/lib/etl/conform';
import { checkTrialBalanceBalances } from '@/lib/recon/checks';
import * as t from '@/lib/db/schema';

let harness: TestDb;

beforeAll(async () => {
  harness = await createTestDb();
  await seedDatabase(harness.db, { quiet: true });
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

const accounts = {
  QueryResponse: {
    Account: [
      { Id: '1', Name: 'Litigation Support Income', Classification: 'Revenue', AccountType: 'Income', Active: true },
      { Id: '2', Name: 'Pass Throughs', Classification: 'Expense', AccountType: 'Cost of Goods Sold', Active: true },
      { Id: '3', Name: 'Berkshire Bank LOC-1343 (deleted)', Classification: 'Liability', AccountType: 'Other Current Liability', Active: false },
    ],
  },
};

function batch(entity: string, records: Array<{ key: string; payload: unknown }>) {
  return {
    sourceSystem: 'QBO' as const,
    entity,
    window: { start: '2026-08-01', end: '2026-08-01' },
    fetchedAt: new Date(),
    records: records.map((record) => ({ entity, ...record })),
  };
}

describe('the chart of accounts', () => {
  it('counts every account it synced, not only the ones that changed', async () => {
    const first = await conformBatch(harness.db, null as never, batch('accounts', [{ key: 'p1', payload: accounts }]));
    expect(first.rowsWritten).toBe(3);

    const second = await conformBatch(harness.db, null as never, batch('accounts', [{ key: 'p1', payload: accounts }]));
    expect(second.rowsWritten).toBe(3);
    expect(second.notes.join(' ')).toMatch(/3 accounts .*2 active, 1 inactive.*0 new, 0 updated/);
  });

  it('takes a rename from QuickBooks, and keeps a reporting line somebody set', async () => {
    await harness.db.update(t.dimAccount).set({ reportingLine: 'opex' }).where(eq(t.dimAccount.accountId, '1'));
    const renamed = structuredClone(accounts);
    renamed.QueryResponse.Account[0]!.Name = 'Litigation Support Revenue';
    const outcome = await conformBatch(harness.db, null as never, batch('accounts', [{ key: 'p1', payload: renamed }]));
    expect(outcome.notes.join(' ')).toMatch(/1 updated/);

    const [row] = await harness.db.select().from(t.dimAccount).where(eq(t.dimAccount.accountId, '1'));
    expect(row!.accountName).toBe('Litigation Support Revenue');
    expect(row!.reportingLine).toBe('opex');
  });
});

describe('the class list', () => {
  it('counts the classes QuickBooks returned', async () => {
    const outcome = await conformBatch(
      harness.db,
      null as never,
      batch('classes', [
        {
          key: 'p1',
          payload: { QueryResponse: { Class: [{ Id: 'c1', Name: 'SHRC', Active: true }, { Id: 'c2', Name: 'Old', Active: false }] } },
        },
      ]),
    );
    expect(outcome.rowsWritten).toBe(2);
    expect(outcome.notes[0]).toMatch(/2 QuickBooks classes \(1 active\)/);
  });
});

describe('the trial balance', () => {
  const report = (credit: string) => ({
    Header: { ReportName: 'TrialBalance' },
    Columns: { Column: [{ ColTitle: '' }, { ColTitle: 'Debit' }, { ColTitle: 'Credit' }] },
    Rows: {
      Row: [
        { ColData: [{ value: 'Checking', id: '35' }, { value: '120000.00' }, { value: '' }] },
        { ColData: [{ value: 'Accounts Payable (A/P)', id: '33' }, { value: '' }, { value: '20000.00' }] },
        { ColData: [{ value: 'Litigation Support Income', id: '1' }, { value: '' }, { value: credit }] },
        { Summary: { ColData: [{ value: 'TOTAL' }, { value: '120000.00' }, { value: (20000 + Number(credit)).toFixed(2) }] }, type: 'Section' },
      ],
    },
  });

  it('reads every account and QuickBooks’ own totals', () => {
    const tb = readTrialBalance(report('100000.00') as never);
    expect(tb.accounts).toHaveLength(3);
    expect(tb.debits.toFixed(2)).toBe('120000.00');
    expect(tb.credits.toFixed(2)).toBe('120000.00');
    expect(tb.accounts.find((a) => a.id === '33')!.net.toFixed(2)).toBe('-20000.00');
  });

  it('stores it at company level and checks that it balances', async () => {
    const outcome = await conformBatch(
      harness.db,
      null as never,
      batch('trial_balance', [{ key: '2026-08-01', payload: report('100000.00') }]),
    );
    // Three accounts plus the two column totals.
    expect(outcome.rowsWritten).toBe(5);

    const rows = await harness.db
      .select()
      .from(t.factCompanyTotal)
      .where(and(eq(t.factCompanyTotal.statement, 'TB'), eq(t.factCompanyTotal.periodMonth, '2026-08-01')));
    expect(rows).toHaveLength(5);

    const [finding] = await checkTrialBalanceBalances(harness.db, { fromMonth: '2026-08-01', toMonth: '2026-08-01' });
    expect(finding!.status).toBe('PASS');
  });

  it('fails the check when debits and credits differ', async () => {
    await conformBatch(harness.db, null as never, batch('trial_balance', [{ key: '2026-07-01', payload: report('99000.00') }]));
    const findings = await checkTrialBalanceBalances(harness.db);
    expect(findings.find((f) => f.periodMonth === '2026-07-01')!.status).toBe('FAIL');
  });
});
