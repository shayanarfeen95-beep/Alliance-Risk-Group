/**
 * The Finance dashboard read $321,078 of revenue for August 2026. QuickBooks
 * said $482,405.
 *
 * The difference was money posted directly to PARENT accounts. QuickBooks draws
 * a parent with sub-accounts as a section, and puts the parent's own postings on
 * the section's HEADER row — not on a child row. The parser skipped every header,
 * so "Litigation Support Income" (LITS) and "Tampa Process Income" (TP) vanished,
 * TP read $0 revenue for seven straight months, COGS % read ~85% and net margin
 * read −47%. The same bug emptied bank, credit-card and equity balances out of
 * the balance sheet.
 *
 * The fixtures below are ARG's real March 2026 report, trimmed to the rows that
 * matter, with QuickBooks' own "Total Income" per column as the assertion. If the
 * warehouse and QuickBooks disagree by a cent, this fails.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { and, eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from './helpers/db';
import { seedDatabase } from '@/lib/seed/load';
import { conformBatch, isPayrollAccount } from '@/lib/etl/conform';
import { checkPlTiesToQuickBooks } from '@/lib/recon/checks';
import * as t from '@/lib/db/schema';
import type { RawBatch } from '@/lib/connectors/types';

const MONTH = '2026-08-01';

let harness: TestDb;

beforeAll(async () => {
  harness = await createTestDb();
  await seedDatabase(harness.db);
  // ARG's two non-division classes, decided exactly as they are in production.
  await harness.db.insert(t.dimClassMap).values([
    { classKey: 'not specified', className: 'Not Specified', decision: 'EXCLUDED' },
    { classKey: '1193434', classId: '1193434', className: 'Z Alloc', decision: 'EXCLUDED' },
  ]);
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

const COLUMNS = {
  Column: [
    { ColTitle: '', ColType: 'Account', MetaData: [{ Name: 'ColKey', Value: 'account' }] },
    { ColTitle: 'CLAIMS', ColType: 'Money', MetaData: [{ Name: 'ColKey', Value: '1193433' }] },
    { ColTitle: 'LITS', ColType: 'Money', MetaData: [{ Name: 'ColKey', Value: '1193430' }] },
    { ColTitle: 'SHRC', ColType: 'Money', MetaData: [{ Name: 'ColKey', Value: '1193432' }] },
    { ColTitle: 'TP', ColType: 'Money', MetaData: [{ Name: 'ColKey', Value: '1193435' }] },
    { ColTitle: 'Z Alloc', ColType: 'Money', MetaData: [{ Name: 'ColKey', Value: '1193434' }] },
    { ColTitle: 'Not Specified', ColType: 'Money', MetaData: [{ Name: 'ColKey', Value: 'not_specified' }] },
    { ColTitle: 'TOTAL', ColType: 'Money', MetaData: [{ Name: 'ColKey', Value: 'total' }] },
  ],
};

/** [CLAIMS, LITS, SHRC, TP, Z Alloc, Not Specified, TOTAL]; '' is a blank cell. */
type Cells = [string, string, string, string, string, string, string];

const cells = (id: string | undefined, name: string, values: Cells) => [
  id ? { value: name, id } : { value: name },
  ...values.map((value) => ({ value })),
];
const data = (id: string, name: string, values: Cells) => ({ type: 'Data', ColData: cells(id, name, values) });
const blank: Cells = ['', '', '', '', '', '', ''];

/** A parent account: its OWN postings on the header, sub-accounts beneath. */
const parent = (id: string, name: string, own: Cells, rows: unknown[]) => ({
  type: 'Section',
  Header: { ColData: cells(id, name, own) },
  Rows: { Row: rows },
  Summary: { ColData: [{ value: `Total ${name}` }] },
});

const group = (groupName: string, title: string, rows: unknown[]) => ({
  type: 'Section',
  group: groupName,
  Header: { ColData: cells(undefined, title, blank) },
  Rows: { Row: rows },
  Summary: { ColData: [{ value: `Total ${title}` }] },
});

/** ARG's March 2026 P&L structure, with the parent-account postings that were lost. */
const PROFIT_AND_LOSS = {
  Header: { ReportName: 'ProfitAndLoss', StartPeriod: MONTH, EndPeriod: '2026-08-31', SummarizeColumnsBy: 'Classes' },
  Columns: COLUMNS,
  Rows: {
    Row: [
      group('Income', 'Income', [
        data('287', 'Background', ['', '', '132137.69', '', '', '', '132137.69']),
        data('434', 'Claims', ['102963.26', '', '', '', '', '', '102963.26']),
        // $162,462.70 of LITS revenue lives on this HEADER.
        parent('197', 'Litigation Support Income', ['', '162462.70', '', '', '', '', '162462.70'], [
          // …and TP's entire month on this nested one.
          parent('457', 'Tampa Process Income', ['', '', '', '42998.95', '', '', '42998.95'], [
            data('400', 'Sales', ['', '', '', '0.00', '', '', '0.00']),
          ]),
        ]),
        data('373', 'Reimbursed Fees', ['', '40900.00', '63380.93', '', '', '', '104280.93']),
      ]),
      group('COGS', 'Cost of Goods Sold', [
        parent('356', 'Payroll-Direct', ['', '', '', '', '', '', '0.00'], [
          data('360', 'Gross Wages-Direct', ['51164.37', '10779.92', '35201.13', '15394.31', '', '', '112539.73']),
          parent('357', 'Employee Benefits-Direct', ['', '', '', '', '', '', '0.00'], [
            data('358', '401K Contribution-Direct', ['594.20', '132.00', '537.16', '71.08', '', '', '1334.44']),
          ]),
        ]),
        // SHRC's pass-through cost is on the parent header too.
        parent('453', 'Pass Throughs', ['', '', '11342.93', '', '', '', '11342.93'], [
          data('454', 'Research Vendor Fees', ['', '', '23646.90', '', '', '', '23646.90']),
        ]),
        data('367', 'Process Servers', ['', '33861.13', '', '14929.76', '', '', '48790.89']),
      ]),
      group('Expenses', 'Expenses', [
        parent('600', 'Payroll Expenses', ['', '', '', '', '', '', ''], [
          data('601', 'Gross Salaries', ['20000.00', '5000.00', '20000.00', '7244.00', '', '', '52244.00']),
        ]),
        parent('610', 'Fees', ['', '', '', '', '', '', ''], [
          data('611', 'Payroll Services Fee', ['1000.00', '500.00', '800.00', '243.14', '', '', '2543.14']),
        ]),
        data('620', 'Rent', ['', '', '', '', '-52.26', '1.76', '-50.50']),
      ]),
    ],
  },
};

// QuickBooks' own "Total Income" row for each column of that report.
const QUICKBOOKS_TOTAL_INCOME = {
  CLAIMS: '102963.26',
  LITS: '203362.70',
  SHRC: '195518.62',
  TP: '42998.95',
};

function batch(entity: string, payload: unknown, key = MONTH): RawBatch {
  return {
    sourceSystem: 'QBO',
    entity,
    window: { start: MONTH, end: MONTH },
    records: [{ entity, key, payload }],
    fetchedAt: new Date(),
  };
}

async function plRow(divisionCode: string) {
  const [row] = await harness.db
    .select()
    .from(t.factPlActual)
    .where(and(eq(t.factPlActual.periodMonth, MONTH), eq(t.factPlActual.divisionCode, divisionCode)));
  return row!;
}

describe('parent accounts in a QuickBooks P&L', () => {
  it('ties every division’s revenue to QuickBooks’ Total Income, to the cent', async () => {
    await conformBatch(harness.db, null as never, batch('profit_and_loss', PROFIT_AND_LOSS));

    for (const [division, total] of Object.entries(QUICKBOOKS_TOTAL_INCOME)) {
      const row = await plRow(division);
      expect(new Decimal(row.revenue).toFixed(2), division).toBe(total);
    }
  });

  it('keeps the parent-account cost in COGS', async () => {
    const shrc = await plRow('SHRC');
    // 35,201.13 wages + 537.16 401K + 11,342.93 on the Pass Throughs header + 23,646.90
    expect(new Decimal(shrc.cogs).toFixed(2)).toBe('70728.12');
  });

  it('fills the payroll memo rows from the payroll parent accounts, without moving totals', async () => {
    const claims = await plRow('CLAIMS');
    expect(new Decimal(claims.payrollDirect).toFixed(2)).toBe('51758.57');
    expect(new Decimal(claims.cogs).toFixed(2)).toBe('51758.57');
    // Gross Salaries is payroll; the payroll-service FEE is not.
    expect(new Decimal(claims.payrollExpense).toFixed(2)).toBe('20000.00');
    expect(new Decimal(claims.opex).toFixed(2)).toBe('21000.00');
  });

  it('holds QuickBooks’ company total, excluded classes included, as the tie-out', async () => {
    const rows = await harness.db
      .select()
      .from(t.factCompanyTotal)
      .where(and(eq(t.factCompanyTotal.periodMonth, MONTH), eq(t.factCompanyTotal.statement, 'PL')));
    const byLine = Object.fromEntries(rows.map((row) => [row.line, new Decimal(row.amount).toFixed(2)]));

    expect(byLine.revenue).toBe('544843.53');
    // Rent's −52.26 on Z Alloc and 1.76 on Not Specified are in QuickBooks' total
    // and in no division: the tie-out is what makes that visible.
    const divisionOpex = await Promise.all(['CLAIMS', 'LITS', 'SHRC', 'TP'].map(plRow));
    const sum = divisionOpex.reduce((total, row) => total.plus(row.opex), new Decimal(0));
    expect(new Decimal(byLine.opex!).minus(sum).toFixed(2)).toBe('-50.50');
  });
});

describe('what sits on classes that are not a division', () => {
  it('is recorded per class, so the tie-out can name it', async () => {
    const rows = await harness.db
      .select()
      .from(t.factCompanyTotal)
      .where(and(eq(t.factCompanyTotal.periodMonth, MONTH), eq(t.factCompanyTotal.statement, 'PL_UNASSIGNED')));
    const byLine = Object.fromEntries(rows.map((row) => [row.line, new Decimal(row.amount).toFixed(2)]));
    expect(byLine.opex).toBe('-50.50');
    expect(byLine['opex|Z Alloc']).toBe('-52.26');
    expect(byLine['opex|Not Specified']).toBe('1.76');
  });

  it('lets the check pass when the divisions plus those classes equal QuickBooks, and say so', async () => {
    const divisions = (await Promise.all(['CLAIMS', 'LITS', 'SHRC', 'TP'].map(plRow))).reduce(
      (total, row) => total.plus(row.opex),
      new Decimal(0),
    );
    // QuickBooks = divisions + 50,000 on Not Specified: far outside 0.1%, fully explained.
    await harness.db
      .update(t.factCompanyTotal)
      .set({ amount: divisions.plus(50000).toFixed(2) })
      .where(and(eq(t.factCompanyTotal.periodMonth, MONTH), eq(t.factCompanyTotal.statement, 'PL'), eq(t.factCompanyTotal.line, 'opex')));
    await harness.db
      .update(t.factCompanyTotal)
      .set({ amount: '50000.00' })
      .where(
        and(
          eq(t.factCompanyTotal.periodMonth, MONTH),
          eq(t.factCompanyTotal.statement, 'PL_UNASSIGNED'),
          eq(t.factCompanyTotal.line, 'opex'),
        ),
      );
    const explained = (await checkPlTiesToQuickBooks(harness.db, { fromMonth: MONTH, toMonth: MONTH })).find(
      (finding) => finding.checkName.startsWith('Operating expense'),
    )!;
    expect(explained.status).toBe('PASS');
    expect(explained.detail).toMatch(/50000\.00 on classes that are not a division/);

    // And an amount nothing explains still fails.
    await harness.db
      .update(t.factCompanyTotal)
      .set({ amount: '10000.00' })
      .where(
        and(
          eq(t.factCompanyTotal.periodMonth, MONTH),
          eq(t.factCompanyTotal.statement, 'PL_UNASSIGNED'),
          eq(t.factCompanyTotal.line, 'opex'),
        ),
      );
    const failing = (await checkPlTiesToQuickBooks(harness.db, { fromMonth: MONTH, toMonth: MONTH })).find(
      (finding) => finding.checkName.startsWith('Operating expense'),
    )!;
    expect(failing.status).toBe('FAIL');

    // Leave the month as QuickBooks reported it for the tests that follow.
    await conformBatch(harness.db, null as never, batch('profit_and_loss', PROFIT_AND_LOSS));
  });
});

describe('the payroll rule', () => {
  it('reads payroll from the parent, and never calls a fee payroll', () => {
    expect(isPayrollAccount('Gross Wages-Direct', ['Payroll-Direct'])).toBe(true);
    expect(isPayrollAccount('Payroll Taxes', [])).toBe(true);
    expect(isPayrollAccount('Payroll Services Fee', ['Fees'])).toBe(false);
    expect(isPayrollAccount('Rent', ['Occupancy'])).toBe(false);
  });
});

/** ARG's balance sheet: classed columns that do not balance, and a TOTAL that does. */
const BALANCE_SHEET = {
  Header: { ReportName: 'BalanceSheet', StartPeriod: MONTH, EndPeriod: '2026-08-31', SummarizeColumnsBy: 'Classes' },
  Columns: COLUMNS,
  Rows: {
    Row: [
      group('TotalAssets', 'ASSETS', [
        group('CurrentAssets', 'Current Assets', [
          group('BankAccounts', 'Bank Accounts', [
            // A parent bank account holding its own balance on the header.
            parent('35', 'Operating Account', ['', '', '', '', '', '250000.00', '250000.00'], [
              data('36', 'Payroll Account', ['', '', '', '', '', '10000.00', '10000.00']),
            ]),
          ]),
          group('AR', 'Accounts Receivable', [
            data('84', 'Accounts Receivable (A/R)', ['400000.00', '50000.00', '20000.00', '30000.00', '-30000.00', '300000.00', '770000.00']),
          ]),
        ]),
      ]),
      group('TotalLiabilitiesAndEquity', 'LIABILITIES AND EQUITY', [
        group('Liabilities', 'Liabilities', [
          group('CurrentLiabilities', 'Current Liabilities', [
            group('AP', 'Accounts Payable', [
              data('33', 'Accounts Payable (A/P)', ['', '', '', '', '', '63039.13', '63039.13']),
            ]),
            group('CreditCards', 'Credit Cards', [
              parent('41', 'Amex', ['', '', '', '', '', '12000.00', '12000.00'], []),
            ]),
          ]),
        ]),
        group('Equity', 'Equity', [
          data('2', 'Retained Earnings', ['', '', '', '', '', '900000.00', '900000.00']),
          // No account id: QuickBooks' current-year earnings line. This is the row
          // that failed every balance-sheet load with "not in the chart of accounts".
          { type: 'Data', group: 'NetIncome', ColData: cells(undefined, 'Net Income', ['', '', '', '', '', '54960.87', '54960.87']) },
        ]),
      ]),
    ],
  },
};

describe('the QuickBooks balance sheet', () => {
  it('loads the company balance sheet from the TOTAL column, and it balances', async () => {
    await harness.db
      .update(t.appConfig)
      .set({ value: 'false' })
      .where(eq(t.appConfig.key, 'BALANCE_SHEET_CLASSED'));

    const outcome = await conformBatch(harness.db, null as never, batch('balance_sheet', BALANCE_SHEET));
    expect(outcome.notes.join(' ')).not.toMatch(/out by/);

    const rows = await harness.db
      .select()
      .from(t.factCompanyTotal)
      .where(and(eq(t.factCompanyTotal.periodMonth, MONTH), eq(t.factCompanyTotal.statement, 'BS')));
    const byLine = Object.fromEntries(rows.map((row) => [row.line, new Decimal(row.amount).toFixed(2)]));

    expect(byLine.cash).toBe('260000.00');
    expect(byLine.accounts_receivable).toBe('770000.00');
    expect(byLine.cc_liability).toBe('12000.00');
    expect(byLine.shareholder_equity).toBe('954960.87');
  });

  it('writes no per-division balance sheet when ARG does not class it', async () => {
    const rows = await harness.db
      .select()
      .from(t.factBsActual)
      .where(eq(t.factBsActual.periodMonth, MONTH));
    expect(rows).toHaveLength(0);
  });
});
