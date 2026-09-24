/**
 * ARG's real FP&A workbook, end to end.
 *
 * Every Sheets pull against it failed. The link check read "Monthly Budget!A1"
 * and the tab is "Monthly Budget " — trailing space — and even past that, the
 * budget is laid out as titled sections of Divisions × JAN…DEC grids with the
 * year in the title, which neither the long nor the wide reader could see. The
 * fixtures are the workbook's own cells; the assertions are its own totals.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { and, eq, sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from './helpers/db';
import { seedDatabase } from '@/lib/seed/load';
import { conformBatch, readSectionedGrid } from '@/lib/etl/conform';
import { matchTab, rangeValues } from '@/lib/connectors/sheets';
import * as t from '@/lib/db/schema';
import { ARG_FORECAST_LOG, ARG_MONTHLY_BUDGET, ARG_TABS, ARG_TENX_BUDGET } from './fixtures/arg-sheets';

let harness: TestDb;

beforeAll(async () => {
  harness = await createTestDb();
  await seedDatabase(harness.db, { quiet: true });
  // The seeded budget would mask a failed load; this suite reads only its own.
  await harness.db.delete(t.factBudget);
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

async function load(entity: string, values: unknown[][]) {
  return conformBatch(harness.db, null as never, {
    sourceSystem: 'SHEETS',
    entity,
    window: { start: '2026-01-01', end: '2026-09-01' },
    fetchedAt: new Date(),
    records: [{ entity, key: 'range', payload: { range: 'range', values } }],
  });
}

async function sum(scenario: string, line: string, year: string, division?: string) {
  const [row] = await harness.db
    .select({ total: sql<string>`coalesce(sum(${t.factBudget.amount}), 0)` })
    .from(t.factBudget)
    .where(
      and(
        eq(t.factBudget.scenarioCode, scenario),
        eq(t.factBudget.lineItem, line as 'revenue'),
        sql`extract(year from ${t.factBudget.periodMonth}) = ${Number(year)}`,
        division ? eq(t.factBudget.divisionCode, division) : sql`true`,
      ),
    );
  return new Decimal(row!.total);
}

describe('finding the tabs', () => {
  it('picks the right tab for each import from the workbook’s real tab list', () => {
    expect(matchTab('monthly_budget', ARG_TABS)).toBe('Monthly Budget ');
    expect(matchTab('tenx_budget', ARG_TABS)).toBe('10X Budget');
    // The log of locked forecasts, not the one-month calculator beside it.
    expect(matchTab('forecast', ARG_TABS)).toBe('Running Forecast Log');
    expect(matchTab('headcount', ARG_TABS)).toBeNull();
  });
});

describe('reading a range, however Composio returns it', () => {
  it('reads the values out of a batch response', () => {
    const values = rangeValues(
      { spreadsheetId: 'x', valueRanges: [{ range: "'Monthly Budget '!A1:B2", values: [['a', 1]] }] },
      'r',
      'test',
    );
    expect(values).toEqual([['a', 1]]);
  });

  it('says what came back when it is not a Sheets response at all', () => {
    expect(() => rangeValues('<html><title>Error 404 (Not Found)</title></html>', 'r', 'the proxy')).toThrow(
      /Error 404 \(Not Found\)/,
    );
  });
});

describe('the Monthly Budget tab', () => {
  it('reads each titled section, with the year from the sheet title', () => {
    const grid = readSectionedGrid(ARG_MONTHLY_BUDGET)!;
    expect(grid.sections).toEqual(['Monthly Rev $', 'Monthly COGS $', 'Monthly OpEx $']);
    expect(grid.cells.every((cell) => cell.periodMonth.startsWith('2026-'))).toBe(true);
    // GP and NOI are derived; the YEAR and GP % columns are not months.
    expect(grid.cells.some((cell) => cell.amount === '2861373.8249333757')).toBe(false);
  });

  it('loads revenue, COGS and OpEx that add up to the workbook’s own year totals', async () => {
    const outcome = await load('monthly_budget', ARG_MONTHLY_BUDGET);
    // 4 divisions × 12 months × 3 lines.
    expect(outcome.rowsWritten).toBe(144);

    expect((await sum('MONTHLY_BUDGET', 'revenue', '2026')).toFixed(2)).toBe('6139743.00');
    expect((await sum('MONTHLY_BUDGET', 'cogs', '2026')).toFixed(2)).toBe('3769032.88');
    expect((await sum('MONTHLY_BUDGET', 'opex', '2026')).toFixed(2)).toBe('2022723.39');
    expect((await sum('MONTHLY_BUDGET', 'revenue', '2026', 'CLAIMS')).toFixed(2)).toBe('1419880.00');
  });

  it('never stores the ARG Total row', async () => {
    const rows = await harness.db.select().from(t.factBudget).where(eq(t.factBudget.divisionCode, 'ARG_TOTAL'));
    expect(rows).toHaveLength(0);
  });
});

describe('the 10X Budget tab', () => {
  it('takes each month’s year from the row of years above it', async () => {
    await load('tenx_budget', ARG_TENX_BUDGET);
    expect((await sum('TENX', 'revenue', '2026', 'SHRC')).toFixed(2)).toBe('2861373.82');
    expect((await sum('TENX', 'revenue', '2027', 'SHRC')).toFixed(2)).toBe('4682254.98');
    // The fixture carries January–April of 2028 only.
    expect((await sum('TENX', 'revenue', '2028', 'SHRC')).toFixed(2)).toBe('2954501.66');
    expect((await sum('TENX', 'cogs', '2027', 'SHRC')).toFixed(2)).toBe('2341127.49');
  });
});

describe('the Running Forecast Log tab', () => {
  it('loads the forecast figures, never the actuals beside them', async () => {
    await load('forecast', ARG_FORECAST_LOG);
    const rows = await harness.db
      .select()
      .from(t.factBudget)
      .where(eq(t.factBudget.scenarioCode, 'FORECAST'));

    const march = (division: string, line: string) =>
      rows.find((row) => row.periodMonth === '2026-03-01' && row.divisionCode === division && row.lineItem === line);
    expect(new Decimal(march('SHRC', 'revenue')!.amount).toFixed(2)).toBe('174219.00');
    expect(new Decimal(march('SHRC', 'cogs')!.amount).toFixed(2)).toBe('106274.00');
    expect(new Decimal(march('LITS', 'opex')!.amount).toFixed(2)).toBe('32000.00');

    // January was never forecast (blank), and a blank is not a zero.
    expect(rows.some((row) => row.periodMonth === '2026-01-01')).toBe(false);
    // Nor April, whose divisions are blank and whose only zero is the Total row.
    expect(rows.some((row) => row.periodMonth === '2026-04-01')).toBe(false);
  });
});
