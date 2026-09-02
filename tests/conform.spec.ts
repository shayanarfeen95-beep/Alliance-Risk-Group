/**
 * The conform step — landed source data becoming figures the dashboards read.
 *
 * This is the seam that decides whether "QuickBooks is connected" and "the
 * dashboard shows ARG's numbers" are the same statement. Everything here runs
 * against real Postgres with the real migrations, so the triggers that reject an
 * unmapped account or a closed-month write are the ones doing the rejecting.
 *
 * The assertions that matter most are the ones about what conform REFUSES to do.
 * A load that quietly drops an unmapped class produces a division that reads low
 * and an ARG Total that reads low with it — and nothing on any screen would say
 * so. Those cases are asserted as errors, deliberately.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { and, eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from './helpers/db';
import { seedDatabase } from '@/lib/seed/load';
import { conformBatch, findSheetTable, parseMonthHeader } from '@/lib/etl/conform';
import * as t from '@/lib/db/schema';
import type { RawBatch } from '@/lib/connectors/types';

/** An open month, so the closed-period guard is not what is being tested. */
const MONTH = '2026-05-01';

let harness: TestDb;

beforeAll(async () => {
  harness = await createTestDb();
  await seedDatabase(harness.db);
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

/**
 * A QuickBooks profit-and-loss in the shape the report API actually returns:
 * one money column per class, a Total column that must NOT be read as a
 * division, and section rows that carry the classification.
 */
function profitAndLossReport(options: { classes: Array<{ id: string; title: string }> }) {
  const columns = [
    { ColTitle: '', ColType: 'Account' },
    ...options.classes.map((entry) => ({
      ColTitle: entry.title,
      ColType: 'Money',
      MetaData: [{ Name: 'ClassRef', Value: entry.id }],
    })),
    { ColTitle: 'Total', ColType: 'Money', MetaData: [{ Name: 'ColKey', Value: 'total' }] },
  ];

  const dataRow = (id: string, name: string, perClass: number[]) => ({
    type: 'Data',
    ColData: [
      { value: name, id },
      ...perClass.map((value) => ({ value: value.toFixed(2) })),
      { value: perClass.reduce((sum, value) => sum + value, 0).toFixed(2) },
    ],
  });

  const section = (group: string, rows: ReturnType<typeof dataRow>[]) => ({
    type: 'Section',
    group,
    Rows: { Row: rows },
    Summary: {
      ColData: [{ value: `Total ${group}` }, ...options.classes.map(() => ({ value: '0.00' }))],
    },
  });

  return {
    Header: { ReportName: 'ProfitAndLoss', StartPeriod: MONTH, EndPeriod: '2026-05-31' },
    Columns: { Column: columns },
    Rows: {
      Row: [
        section('Income', [
          dataRow('4000', 'Service Revenue', [200_000, 100_000]),
          dataRow('4010', 'Recurring Program Revenue', [50_000, 25_000]),
        ]),
        // 5000 is a payroll-direct account: a COGS component carried as a memo
        // line. If it is ever subtracted separately, gross profit collapses.
        section('COGS', [
          dataRow('5000', 'Direct Labor — Payroll', [60_000, 30_000]),
          dataRow('5010', 'Contract Labor — Field Agents', [40_000, 20_000]),
        ]),
        section('Expenses', [
          dataRow('6000', 'Salaries & Wages — Administrative', [30_000, 15_000]),
          dataRow('6100', 'Rent & Occupancy', [20_000, 10_000]),
        ]),
      ],
    },
  };
}

function batch(entity: string, payload: unknown, key = MONTH): RawBatch {
  return {
    sourceSystem: 'QBO',
    entity,
    window: { start: MONTH, end: MONTH },
    records: [{ entity, key, payload }],
    fetchedAt: new Date(),
  };
}

describe('QuickBooks profit and loss', () => {
  it('writes the five reporting lines per division, with payroll held as a memo', async () => {
    const report = profitAndLossReport({
      classes: [
        { id: 'CLASS_SHRC', title: 'SHRC' },
        { id: 'CLASS_CLAIMS', title: 'Claims' },
      ],
    });

    const outcome = await conformBatch(harness.db, null as never, batch('profit_and_loss', report));
    expect(outcome.rowsWritten).toBeGreaterThan(0);

    const [shrc] = await harness.db
      .select()
      .from(t.factPlActual)
      .where(and(eq(t.factPlActual.periodMonth, MONTH), eq(t.factPlActual.divisionCode, 'SHRC')));

    expect(shrc).toBeDefined();
    expect(new Decimal(shrc!.revenue).toNumber()).toBe(250_000);

    // COGS is inclusive of the payroll memo: 60,000 + 40,000.
    expect(new Decimal(shrc!.cogs).toNumber()).toBe(100_000);
    expect(new Decimal(shrc!.payrollDirect).toNumber()).toBe(60_000);

    // OpEx is inclusive of administrative payroll: 30,000 + 20,000.
    expect(new Decimal(shrc!.opex).toNumber()).toBe(50_000);
    expect(new Decimal(shrc!.payrollExpense).toNumber()).toBe(30_000);

    // Gross profit is revenue less COGS. Subtracting the memo would give
    // 190,000 here, which is precisely the failure the spec names.
    const grossProfit = new Decimal(shrc!.revenue).minus(shrc!.cogs);
    expect(grossProfit.toNumber()).toBe(150_000);
  });

  it('does not read the Total column as a division', async () => {
    const rows = await harness.db
      .select()
      .from(t.factPlActual)
      .where(eq(t.factPlActual.periodMonth, MONTH));

    expect(rows.map((row) => row.divisionCode).sort()).toEqual(['CLAIMS', 'SHRC']);
  });

  it('lands the account-level detail the summary was rolled up from', async () => {
    const balances = await harness.db
      .select()
      .from(t.factGlBalance)
      .where(and(eq(t.factGlBalance.periodMonth, MONTH), eq(t.factGlBalance.divisionCode, 'SHRC')));

    const total = balances
      .filter((row) => row.accountId.startsWith('4'))
      .reduce((sum, row) => sum.plus(row.amount), new Decimal(0));

    expect(total.toNumber()).toBe(250_000);
  });

  it('refuses a class that maps to no division rather than dropping its money', async () => {
    const report = profitAndLossReport({
      classes: [
        { id: 'CLASS_SHRC', title: 'SHRC' },
        { id: 'CLASS_NEW_VENTURE', title: 'New Venture' },
      ],
    });

    await expect(
      conformBatch(harness.db, null as never, batch('profit_and_loss', report)),
    ).rejects.toThrow(/New Venture/);
  });

  it('leaves a closed month untouched and says so', async () => {
    const report = profitAndLossReport({ classes: [{ id: 'CLASS_SHRC', title: 'SHRC' }] });

    const before = await harness.db
      .select()
      .from(t.factPlActual)
      .where(and(eq(t.factPlActual.periodMonth, '2026-03-01'), eq(t.factPlActual.divisionCode, 'SHRC')));

    const outcome = await conformBatch(
      harness.db,
      null as never,
      batch('profit_and_loss', report, '2026-03-01'),
    );

    const after = await harness.db
      .select()
      .from(t.factPlActual)
      .where(and(eq(t.factPlActual.periodMonth, '2026-03-01'), eq(t.factPlActual.divisionCode, 'SHRC')));

    expect(outcome.notes.join(' ')).toMatch(/closed/i);
    expect(after[0]?.revenue).toBe(before[0]?.revenue);
  });
});

describe('HubSpot deals', () => {
  it('takes the proposal timestamp from stage history, not the current stage', async () => {
    const deals: RawBatch = {
      sourceSystem: 'HUBSPOT',
      entity: 'deals',
      window: { start: MONTH, end: MONTH },
      fetchedAt: new Date(),
      records: [
        {
          entity: 'deals',
          key: '9001',
          payload: {
            id: '9001',
            properties: {
              dealname: 'Regional screening programme',
              amount: '48000',
              dealstage: 'closedwon',
              pipeline: 'default',
              hs_is_closed_won: 'true',
              hs_is_closed: 'true',
              createdate: '2026-04-02T09:00:00Z',
              closedate: '2026-05-20T09:00:00Z',
              hubspot_owner_id: '77',
            },
            propertiesWithHistory: {
              dealstage: [
                { value: 'proposal', timestamp: '2026-04-18T10:00:00Z' },
                { value: 'closedwon', timestamp: '2026-05-20T09:00:00Z' },
              ],
            },
          },
        },
      ],
    };

    const outcome = await conformBatch(harness.db, null as never, deals);
    expect(outcome.rowsWritten).toBe(1);

    const [deal] = await harness.db
      .select()
      .from(t.factDeal)
      .where(eq(t.factDeal.dealId, '9001'));

    expect(deal!.isClosedWon).toBe(true);
    expect(new Decimal(deal!.amount).toNumber()).toBe(48_000);
    expect(deal!.enteredProposalAt?.toISOString()).toBe('2026-04-18T10:00:00.000Z');

    const history = await harness.db
      .select()
      .from(t.factDealStageHistory)
      .where(eq(t.factDealStageHistory.dealId, '9001'));

    expect(history).toHaveLength(2);
  });
});

describe('Google Sheets budget', () => {
  it('reads a month-per-column budget sheet', async () => {
    const values = [
      ['FY2026 Operating Budget'],
      ['Division', 'Line Item', '2026-05', '2026-06'],
      ['SHRC', 'Revenue', '260000', '265000'],
      ['SHRC', 'COGS', '104000', '106000'],
      ['SHRC', 'OpEx', '52000', '53000'],
      ['ARG Total', 'Revenue', '900000', '910000'],
    ];

    const outcome = await conformBatch(harness.db, null as never, {
      sourceSystem: 'SHEETS',
      entity: 'monthly_budget',
      window: { start: MONTH, end: MONTH },
      fetchedAt: new Date(),
      records: [{ entity: 'monthly_budget', key: 'range', payload: { values } }],
    });

    expect(outcome.rowsWritten).toBe(6);

    const [row] = await harness.db
      .select()
      .from(t.factBudget)
      .where(
        and(
          eq(t.factBudget.scenarioCode, 'MONTHLY_BUDGET'),
          eq(t.factBudget.periodMonth, MONTH),
          eq(t.factBudget.divisionCode, 'SHRC'),
          eq(t.factBudget.lineItem, 'revenue'),
        ),
      );

    expect(new Decimal(row!.amount).toNumber()).toBe(260_000);
  });

  it('refuses a sheet it cannot find a header row in, rather than loading zeroes', async () => {
    await expect(
      conformBatch(harness.db, null as never, {
        sourceSystem: 'SHEETS',
        entity: 'monthly_budget',
        window: { start: MONTH, end: MONTH },
        fetchedAt: new Date(),
        records: [{ entity: 'monthly_budget', key: 'range', payload: { values: [['a', 'b']] } }],
      }),
    ).rejects.toThrow(/header row/i);
  });
});

describe('sheet header parsing', () => {
  it('recognises the ways a month is written in a spreadsheet', () => {
    expect(parseMonthHeader('2026-05')).toBe('2026-05-01');
    expect(parseMonthHeader('May 2026')).toBe('2026-05-01');
    expect(parseMonthHeader('5/1/2026')).toBe('2026-05-01');
    expect(parseMonthHeader('Division')).toBeNull();
  });

  it('finds the header row below a title row', () => {
    const table = findSheetTable([
      ['Monthly Budget'],
      [],
      ['Division', 'Line', 'Jan 2026', 'Feb 2026'],
      ['SHRC', 'Revenue', '1', '2'],
    ]);

    expect(table?.headerIndex).toBe(2);
    expect(table?.months.map((month) => month.month)).toEqual(['2026-01-01', '2026-02-01']);
  });
});
