/**
 * QuickBooks and Sheets conform.
 *
 * The failure these guard against is the one HubSpot had: a load that reports
 * success and moves no figure. Beyond that, both readers face the same question
 * from different directions — what to do with an input nobody has mapped — and
 * the answer has to be the same. Count it, name it, leave it out. Never spread
 * it, never call it "other", never let it become a zero that looks like a fact.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from './helpers/db';
import { seedDatabase } from '@/lib/seed/load';
import { conformQbo, describeQboConform } from '@/lib/etl/qbo';
import { conformSheets, parseMonth } from '@/lib/etl/sheets';
import * as t from '@/lib/db/schema';

let harness: TestDb;
let loadRunId: string;

/**
 * A QuickBooks P&L by class, in Intuit's shape.
 *
 * Column 1 is a division that exists, column 2 is a class nobody has mapped,
 * column 3 is the report total — which must never be read as a division.
 */
const PL_REPORT = {
  Header: { ReportName: 'ProfitAndLoss', StartPeriod: '2026-05-01', EndPeriod: '2026-05-31' },
  Columns: {
    Column: [
      { ColTitle: 'Account', ColType: 'Account' },
      { ColTitle: 'SHRC', ColType: 'Money' },
      { ColTitle: 'Wellness Pilot', ColType: 'Money' },
      { ColTitle: 'TOTAL', ColType: 'Money' },
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
              ColData: [
                { value: 'Service Revenue', id: '4000' },
                { value: '100000.00' },
                { value: '5000.00' },
                { value: '105000.00' },
              ],
            },
          ],
        },
        // Intuit repeats every section total in a Summary row. Reading it as
        // data doubles the section.
        Summary: {
          ColData: [{ value: 'Total Income' }, { value: '100000.00' }, { value: '5000.00' }],
        },
      },
      {
        type: 'Section',
        group: 'COGS',
        Rows: {
          Row: [
            {
              type: 'Data',
              ColData: [
                { value: 'Direct Labor — Payroll', id: '5000' },
                { value: '40000.00' },
                { value: '0' },
                { value: '40000.00' },
              ],
            },
            {
              type: 'Data',
              // An account that exists in QuickBooks and carries no reporting
              // line in this warehouse.
              ColData: [
                { value: 'Brand New Account', id: '9999' },
                { value: '7000.00' },
                { value: '0' },
                { value: '7000.00' },
              ],
            },
          ],
        },
      },
      {
        type: 'Section',
        group: 'Expenses',
        Rows: {
          Row: [
            {
              type: 'Data',
              ColData: [
                { value: 'Salaries & Wages — Administrative', id: '6000' },
                { value: '20000.00' },
                { value: '0' },
                { value: '20000.00' },
              ],
            },
          ],
        },
      },
    ],
  },
};

beforeAll(async () => {
  harness = await createTestDb();
  await seedDatabase(harness.db, { quiet: true });

  const [run] = await harness.db
    .insert(t.loadRun)
    .values({ sourceSystem: 'QBO', entity: 'profit_and_loss', status: 'SUCCEEDED' })
    .returning();
  loadRunId = run!.id;
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

describe('QuickBooks profit and loss', () => {
  it('lands the five reporting lines for a mapped class', async () => {
    const result = await conformQbo(harness.db, loadRunId, 'profit_and_loss', [
      { payload: PL_REPORT, key: '2026-05-01' },
    ]);

    expect(result.written).toBe(1);

    const [row] = await harness.db
      .select()
      .from(t.factPlActual)
      .where(
        and(eq(t.factPlActual.periodMonth, '2026-05-01'), eq(t.factPlActual.divisionCode, 'SHRC')),
      );

    expect(Number(row!.revenue)).toBe(100_000);
    // Payroll is a memo *inside* COGS and OpEx, never a deduction of its own.
    expect(Number(row!.payrollDirect)).toBe(40_000);
    expect(Number(row!.cogs)).toBe(40_000);
    expect(Number(row!.payrollExpense)).toBe(20_000);
    expect(Number(row!.opex)).toBe(20_000);
    expect(row!.sourceSystem).toBe('QBO');
  });

  it('never reads a section summary as another data row', async () => {
    // Revenue is 100,000 once. If the Summary row were walked it would be
    // 200,000, and every figure downstream would be double.
    const [row] = await harness.db
      .select()
      .from(t.factPlActual)
      .where(
        and(eq(t.factPlActual.periodMonth, '2026-05-01'), eq(t.factPlActual.divisionCode, 'SHRC')),
      );
    expect(Number(row!.revenue)).toBe(100_000);
  });

  it('counts an unmapped class instead of folding it into a division', async () => {
    const result = await conformQbo(harness.db, loadRunId, 'profit_and_loss', [
      { payload: PL_REPORT, key: '2026-05-01' },
    ]);

    expect(result.unmappedClasses).toContain('Wellness Pilot');
    // And the TOTAL column is never mistaken for one.
    expect(result.unmappedClasses).not.toContain('TOTAL');

    const rows = await harness.db
      .select()
      .from(t.factPlActual)
      .where(eq(t.factPlActual.periodMonth, '2026-05-01'));
    expect(rows.map((row) => row.divisionCode)).toEqual(['SHRC']);
  });

  it('excludes an account with no reporting line, and says which', async () => {
    const result = await conformQbo(harness.db, loadRunId, 'profit_and_loss', [
      { payload: PL_REPORT, key: '2026-05-01' },
    ]);

    expect(result.unmappedAccounts.join()).toContain('Brand New Account');
    // 7,000 from that account is absent from COGS rather than guessed into it.
    const [row] = await harness.db
      .select()
      .from(t.factPlActual)
      .where(
        and(eq(t.factPlActual.periodMonth, '2026-05-01'), eq(t.factPlActual.divisionCode, 'SHRC')),
      );
    expect(Number(row!.cogs)).toBe(40_000);

    expect(describeQboConform(result)).toMatch(/excluded rather than guessed/);
  });
});

describe('QuickBooks chart of accounts', () => {
  it('lands new accounts with no reporting line, for a person to classify', async () => {
    const result = await conformQbo(harness.db, loadRunId, 'accounts', [
      {
        payload: {
          QueryResponse: {
            Account: [
              {
                Id: 'qb-new-1',
                Name: 'Subscriptions & Software',
                AcctNum: '6400',
                Classification: 'Expense',
                AccountType: 'Expense',
                Active: true,
              },
            ],
          },
        },
      },
    ]);

    expect(result.written).toBe(1);

    const [row] = await harness.db
      .select()
      .from(t.dimAccount)
      .where(eq(t.dimAccount.accountId, 'qb-new-1'));

    expect(row!.accountType).toBe('EXPENSE');
    // Knowing it is an expense says nothing about COGS versus OpEx, and that
    // distinction moves gross profit. A person decides.
    expect(row!.reportingLine).toBeNull();
    expect(result.unmappedAccounts.join()).toContain('Subscriptions & Software');
  });
});

describe('Sheets budget', () => {
  const GRID = {
    range: 'Monthly Budget!A1:E20',
    values: [
      ['Division', 'Month', 'Revenue', 'COGS', 'OpEx'],
      ['SHRC', '2026-05', '210000', '130000', '48000'],
      ['LITS', 'May 2026', '190000', '', '30000'],
      ['Wellness Pilot', '2026-05', '15000', '9000', '4000'],
      ['SHRC', 'not a month', '1', '2', '3'],
    ],
  };

  it('writes only the three loaded line items, for divisions it recognises', async () => {
    const [run] = await harness.db
      .insert(t.loadRun)
      .values({ sourceSystem: 'SHEETS', entity: 'monthly_budget', status: 'SUCCEEDED' })
      .returning();

    const result = await conformSheets(harness.db, run!.id, 'monthly_budget', [{ payload: GRID }]);

    // SHRC: three values. LITS: revenue and opex — the blank COGS cell is
    // absent, not zero.
    expect(result.written).toBe(5);

    // Scoped to this run: the seeded budget already covers these months, and
    // the question is what conform wrote, not what is in the table.
    const rows = await harness.db
      .select()
      .from(t.factBudget)
      .where(eq(t.factBudget.loadRunId, run!.id));

    const lits = rows.filter((row) => row.divisionCode === 'LITS').map((row) => row.lineItem);
    expect(lits.sort()).toEqual(['opex', 'revenue']);
    // A blank budget cell and a budget of nothing are different claims.
    expect(lits).not.toContain('cogs');
  });

  it('names the division it could not resolve rather than spreading it', async () => {
    const [run] = await harness.db
      .insert(t.loadRun)
      .values({ sourceSystem: 'SHEETS', entity: 'monthly_budget', status: 'SUCCEEDED' })
      .returning();

    const result = await conformSheets(harness.db, run!.id, 'monthly_budget', [{ payload: GRID }]);

    expect(result.unresolvedRows).toContain('Wellness Pilot');
    expect(result.skipped).toBeGreaterThanOrEqual(2);

    const rows = await harness.db
      .select()
      .from(t.factBudget)
      .where(eq(t.factBudget.loadRunId, run!.id));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => ['SHRC', 'LITS'].includes(row.divisionCode))).toBe(true);
  });

  it('reads the month formats a maintained sheet actually contains', () => {
    expect(parseMonth('2026-05')).toBe('2026-05-01');
    expect(parseMonth('2026-05-01')).toBe('2026-05-01');
    expect(parseMonth('5/1/2026')).toBe('2026-05-01');
    expect(parseMonth('May 2026')).toBe('2026-05-01');
    expect(parseMonth('March 2026')).toBe('2026-03-01');
    // A bare number could be a budget figure as easily as a date serial.
    expect(parseMonth('45000')).toBeNull();
    expect(parseMonth('')).toBeNull();
  });
});
