/**
 * Reading ARG's connector workbook.
 *
 * Two faults, both silent, both found against the real file.
 *
 * The workbook is in LONG form — one row per month per division, with Revenue,
 * COGS and OpEx across the columns — and it carries a "Row Type" column whose
 * value on a division row is literally the word "Division". The old detector
 * looked for any cell matching /^div(ision)?$/ and found it in the DATA. Having
 * decided row 2 was the header, it scanned that row for month columns, hit the
 * Excel serial in "Month Start" and any figure that happened to land in the
 * serial-date range, and read revenue and headcount numbers as dates.
 *
 * A header row is mostly words. That is the property being asserted here.
 */
import { describe, expect, it } from 'vitest';
import {
  findLongSheetTable,
  findSheetTable,
  monthFromNameAndYear,
  parseMonthHeader,
} from '@/lib/etl/conform';

/** The real shape of FPA_Connector_Source_FY2026.xlsx, row for row. */
const ARG_BUDGET: string[][] = [
  ['Month', 'Month Start', 'Year', 'Division', 'Row Type', 'Revenue ($)', 'COGS ($)', 'Gross Profit ($)'],
  ['JAN', '46023', '2026', 'SHRC', 'Division', '202973.7', '145988.71', '56984.99'],
  ['JAN', '46023', '2026', 'Claims', 'Division', '105840', '72442.98', '33397.02'],
  ['JAN', '46023', '2026', 'ARG Total', 'Total', '469640', '313252.74', '156387.26'],
  ['FEB', '46054', '2026', 'SHRC', 'Division', '210000', '150000', '60000'],
];

/** The headcount tab: same shape, a Headcount (FTE) column instead. */
const ARG_HEADCOUNT: string[][] = [
  ['Month', 'Month Start', 'Year', 'Division', 'Row Type', 'Headcount (FTE)', 'New Hires'],
  ['JAN', '46023', '2026', 'SHRC', 'Division', '32526.12', '3'],
  ['JAN', '46023', '2026', 'ARG Total', 'Total', '0', '0'],
];

describe('the long-format detector', () => {
  it('finds the real header row, not the first row containing "Division"', () => {
    const table = findLongSheetTable(ARG_BUDGET);

    expect(table).not.toBeNull();
    // Row 0, the words. NOT row 1, where "Division" is a Row Type value.
    expect(table!.headerIndex).toBe(0);
    expect(table!.divisionColumn).toBe(3);
    expect(table!.monthColumn).toBe(0);
    expect(table!.yearColumn).toBe(2);
    expect(table!.rowTypeColumn).toBe(4);
  });

  it('locates the figure columns by their headings', () => {
    const table = findLongSheetTable(ARG_BUDGET)!;
    const byLine = new Map(table.valueColumns.map((column) => [column.line, column.index]));

    expect(byLine.get('revenue')).toBe(5);
    expect(byLine.get('cogs')).toBe(6);
    // "Gross Profit" is derived, never loaded — it must not be taken as a line.
    expect(byLine.has('opex')).toBe(false);
  });

  it('finds the headcount column on the headcount tab', () => {
    const table = findLongSheetTable(ARG_HEADCOUNT)!;
    expect(table.headcountColumn).toBe(5);
  });
});

describe('the wide-format detector', () => {
  it('refuses to treat a data row as a header', () => {
    // This is the bug, reproduced exactly. Given ARG's sheet, the old detector
    // matched row 1 on the Row Type value and read 46023 — and, on the headcount
    // tab, 32526.12 — as month columns.
    expect(findSheetTable(ARG_BUDGET)).toBeNull();
    expect(findSheetTable(ARG_HEADCOUNT)).toBeNull();
  });

  it('still reads a genuine month-per-column grid', () => {
    const grid: string[][] = [
      ['Division', 'Line Item', '2026-01', '2026-02', '2026-03'],
      ['SHRC', 'Revenue', '100', '110', '120'],
    ];

    const table = findSheetTable(grid);
    expect(table).not.toBeNull();
    expect(table!.headerIndex).toBe(0);
    expect(table!.months.map((month) => month.month)).toEqual([
      '2026-01-01',
      '2026-02-01',
      '2026-03-01',
    ]);
  });

  it('will not call a single stray date column a month grid', () => {
    // One "month" in a header row is far more often a year or an id. Two is a
    // grid. This is what stops a lone serial being read as a month layout.
    const strays: string[][] = [['Division', 'Row Type', '46023'], ['SHRC', 'Division', '1']];
    expect(findSheetTable(strays)).toBeNull();
  });
});

describe('pairing a month name with its year column', () => {
  it('reads JAN + 2026 as January 2026', () => {
    expect(monthFromNameAndYear('JAN', '2026')).toBe('2026-01-01');
    expect(monthFromNameAndYear('December', '2027')).toBe('2027-12-01');
    expect(monthFromNameAndYear(' feb ', '2026')).toBe('2026-02-01');
  });

  it('refuses to invent a year', () => {
    // A 2026 budget silently loading against the current calendar year is worse
    // than one that does not load.
    expect(monthFromNameAndYear('JAN', '')).toBeNull();
    expect(monthFromNameAndYear('JAN', null)).toBeNull();
    expect(monthFromNameAndYear('not a month', '2026')).toBeNull();
  });

  it('does not read a revenue figure as a date', () => {
    // 32526.12 is a headcount figure that sits squarely in the serial-date
    // range. Nothing about it says "month", and the long reader never asks.
    expect(monthFromNameAndYear('32526.12', '2026')).toBeNull();
    // parseMonthHeader WILL convert it, which is exactly why it is no longer
    // pointed at value columns.
    expect(parseMonthHeader(32526.12)).not.toBeNull();
  });
});
