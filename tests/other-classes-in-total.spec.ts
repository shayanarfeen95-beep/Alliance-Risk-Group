/**
 * ARG Total includes the QuickBooks classes that are not a division.
 *
 * Scott, reviewing September 2026 before close: QuickBooks' Profit and Loss by
 * Class said Total Income was $533,672.38; the dashboard said $533,674. The
 * dashboard was adding up the four divisions and dropping the two classes that
 * belong to none — "Z Alloc", which holds the shared costs allocated over the
 * business lines only at month end ($165,200 of September expenses), and "Not
 * Specified", posted with no class ($1.76 of negative income). "The classes
 * outside of the true business lines need to be factored into the dashboard."
 *
 * The income rows below are ARG's real September report, figure for figure, so
 * the totals asserted are QuickBooks' own. The expense rows are a subset of the
 * same report.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { and, eq } from 'drizzle-orm';
import { createTestDb, loadSeededUser, type TestDb } from './helpers/db';
import { seedDatabase } from '@/lib/seed/load';
import { conformBatch } from '@/lib/etl/conform';
import { checkPlTiesToQuickBooks } from '@/lib/recon/checks';
import { openSemanticSession, resolveKpi, CONSOLIDATED_CODE } from '@/lib/semantic/resolve';
import { key, sumPl, sumSpend } from '@/lib/semantic/facts';
import { loadFinance } from '@/lib/dashboards/finance';
import { ScopeError } from '@/lib/auth/scope';
import * as t from '@/lib/db/schema';
import type { RawBatch } from '@/lib/connectors/types';
import type { SessionUser } from '@/lib/auth/session';

const MONTH = '2026-09-01';

let harness: TestDb;
let cfo: SessionUser;
let claimsLead: SessionUser;
let runId: string;

beforeAll(async () => {
  harness = await createTestDb();
  await seedDatabase(harness.db);
  cfo = await loadSeededUser(harness.db, 'cfo@westportfinancial.com');
  claimsLead = await loadSeededUser(harness.db, 'claims.lead@alliancerisk.com');
  const [run] = await harness.db.select({ id: t.loadRun.id }).from(t.loadRun).limit(1);
  runId = run!.id;

  // Decided exactly as they are in production: neither is a division.
  await harness.db.insert(t.dimClassMap).values([
    { classKey: 'not specified', className: 'Not Specified', decision: 'EXCLUDED' },
    { classKey: '1193434', classId: '1193434', className: 'Z Alloc', decision: 'EXCLUDED' },
  ]);
  // The two marketing accounts in the fixture, so marketing spend can be checked.
  await harness.db
    .update(t.appConfig)
    .set({ value: 'T900,T901' })
    .where(eq(t.appConfig.key, 'MARKETING_SPEND_ACCOUNTS'));

  await conformBatch(harness.db, runId, batch(SEPTEMBER));
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

// --- The report ------------------------------------------------------------

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

const SEPTEMBER = {
  Header: { ReportName: 'ProfitAndLoss', StartPeriod: MONTH, EndPeriod: '2026-09-30', SummarizeColumnsBy: 'Classes' },
  Columns: COLUMNS,
  Rows: {
    Row: [
      group('Income', 'Income', [
        data('T801', 'Background', ['', '', '136013.28', '', '', '', '136013.28']),
        data('T802', 'Claims', ['99861.24', '', '', '', '', '', '99861.24']),
        data('T803', 'Investigative', ['1745.01', '100.00', '', '', '', '', '1845.01']),
        parent('T804', 'Litigation Support Income', ['', '113522.39', '', '', '', '', '113522.39'], [
          parent('T805', 'Tampa Process Income', ['', '905.00', '', '82743.10', '', '', '83648.10'], [
            data('T806', 'Sales', ['', '', '5929.65', '', '', '', '5929.65']),
          ]),
        ]),
        data('T807', 'Reimbursed Fees', ['', '18188.86', '74655.47', '', '', '', '92844.33']),
        data('T808', 'Uncategorized Income', ['', '', '', '-15.00', '', '', '-15.00']),
        data('T809', 'Vendor Collection Credit', ['', '', '25.14', '', '', '-1.76', '23.38']),
      ]),
      group('Expenses', 'Expenses', [
        parent('T899', 'Marketing', blank, [
          data('T900', 'Advertising and Promotion', ['', '', '', '', '910.00', '', '910.00']),
          data('T901', 'Contractors', ['-558.34', '-592.26', '-590.81', '-182.59', '14394.00', '', '12470.00']),
        ]),
        parent('T910', 'Payroll Expenses', blank, [
          data('T911', 'Gross Salaries', ['', '', '3500.00', '', '23888.69', '', '27388.69']),
          data('T912', 'Payroll Taxes', ['0.00', '', '3328.29', '513.64', '5739.55', '', '9581.48']),
        ]),
        data('T920', 'Rent', ['', '', '', '', '912.14', '', '912.14']),
      ]),
    ],
  },
};

function batch(payload: unknown): RawBatch {
  return {
    sourceSystem: 'QBO',
    entity: 'profit_and_loss',
    window: { start: MONTH, end: MONTH },
    records: [{ entity: 'profit_and_loss', key: MONTH, payload }],
    fetchedAt: new Date(),
  };
}

const money = (value: Decimal | number | string | null | undefined) =>
  value === null || value === undefined ? null : new Decimal(value).toFixed(2);

// --- The import --------------------------------------------------------------

describe('the September 2026 P&L, imported', () => {
  it('loads each division exactly as QuickBooks totals its column', async () => {
    const rows = await harness.db.select().from(t.factPlActual).where(eq(t.factPlActual.periodMonth, MONTH));
    const revenue = Object.fromEntries(rows.map((row) => [row.divisionCode, money(row.revenue)]));
    expect(revenue).toMatchObject({
      CLAIMS: '101606.25',
      LITS: '132716.25',
      SHRC: '216623.54',
      TP: '82728.10',
    });
  });

  it('records every line for each class outside the divisions, payroll included', async () => {
    const rows = await harness.db
      .select()
      .from(t.factCompanyTotal)
      .where(and(eq(t.factCompanyTotal.periodMonth, MONTH), eq(t.factCompanyTotal.statement, 'PL_UNASSIGNED')));
    const byLine = Object.fromEntries(rows.map((row) => [row.line, money(row.amount)]));

    expect(byLine['revenue|Not Specified']).toBe('-1.76');
    expect(byLine['opex|Z Alloc']).toBe('45844.38');
    // Payroll is a memo inside OpEx; without it, payroll at ARG Total would
    // leave out $29,628 of September salaries and taxes sitting on Z Alloc.
    expect(byLine['payroll_expense|Z Alloc']).toBe('29628.24');
  });

  it('records the accounts behind them', async () => {
    const rows = await harness.db
      .select()
      .from(t.factCompanyTotal)
      .where(and(eq(t.factCompanyTotal.periodMonth, MONTH), eq(t.factCompanyTotal.statement, 'GL_UNASSIGNED')));
    const byLine = Object.fromEntries(rows.map((row) => [row.line, money(row.amount)]));

    expect(byLine['Z Alloc|T901']).toBe('14394.00');
    expect(byLine['Z Alloc|T920']).toBe('912.14');
    expect(byLine['Not Specified|T809']).toBe('-1.76');
  });
});

// --- ARG Total ---------------------------------------------------------------

describe('ARG Total', () => {
  it('is QuickBooks’ Total Income to the cent, not the four divisions', async () => {
    const session = await openSemanticSession(harness.db, cfo, MONTH);
    const revenue = resolveKpi(session, 'revenue', CONSOLIDATED_CODE);

    // $533,674.14 is what the dashboard showed — the four divisions alone.
    expect(money(sumPl(session.bundle, MONTH, session.visibleDivisions).revenue)).toBe('533674.14');
    expect(money(revenue.value)).toBe('533672.38');
  });

  it('carries Z Alloc’s costs, so ARG Total profit is not overstated before close', async () => {
    const session = await openSemanticSession(harness.db, cfo, MONTH);
    const opex = resolveKpi(session, 'opex', CONSOLIDATED_CODE);
    // QuickBooks' Total column for the expense rows in the fixture.
    expect(money(opex.value)).toBe('51262.31');

    const pl = sumPl(session.bundle, MONTH, session.consolidatedScope);
    expect(money(pl.payrollExpense)).toBe('36970.17');
  });

  it('counts marketing spend posted to Z Alloc', async () => {
    const session = await openSemanticSession(harness.db, cfo, MONTH);
    expect(money(sumSpend(session.bundle.marketingSpend, [MONTH], session.consolidatedScope))).toBe('13380.00');
  });

  it('leaves every division’s own figures alone', async () => {
    const session = await openSemanticSession(harness.db, cfo, MONTH);
    expect(money(resolveKpi(session, 'revenue', 'SHRC').value)).toBe('216623.54');
    expect(money(resolveKpi(session, 'opex', 'SHRC').value)).toBe('6237.48');
  });

  it('is not reachable through a class by someone who cannot see ARG Total', async () => {
    const session = await openSemanticSession(harness.db, claimsLead, MONTH);
    expect(session.consolidatedAvailable).toBe(false);
    expect(session.bundle.otherClasses).toEqual([]);
    expect(session.consolidatedScope).toEqual(session.visibleDivisions);
    expect(() => resolveKpi(session, 'opex', 'CLASS:Z Alloc')).toThrow(ScopeError);
  });
});

// --- The Finance page ----------------------------------------------------------

describe('the Finance page at ARG Total', () => {
  it('ties to QuickBooks with no difference', async () => {
    const session = await openSemanticSession(harness.db, cfo, MONTH);
    const model = loadFinance(session, CONSOLIDATED_CODE, {});

    expect(model.tieOut?.allTie).toBe(true);
    const revenue = model.tieOut!.rows.find((row) => row.label === 'Revenue')!;
    expect(money(revenue.divisions)).toBe('533674.14');
    expect(money(revenue.otherClasses)).toBe('-1.76');
    expect(money(revenue.argTotal)).toBe('533672.38');
    expect(money(revenue.quickbooks)).toBe('533672.38');
    expect(money(revenue.difference)).toBe('0.00');
    expect(revenue.otherClassesDetail).toMatch(/Not Specified/);
  });

  it('lists Z Alloc and Not Specified beneath the divisions, and the rows add up to ARG Total', async () => {
    const session = await openSemanticSession(harness.db, cfo, MONTH);
    const rows = loadFinance(session, CONSOLIDATED_CODE, {}).divisionBreakdown!;

    expect(rows.map((row) => row.label).slice(-3)).toEqual(['Z Alloc', 'Not Specified', 'ARG Total']);
    const classes = rows.filter((row) => row.isOtherClass);
    expect(classes.every((row) => row.budgetAttainment === null && row.netMargin === null)).toBe(true);

    const total = rows.find((row) => row.isTotal)!;
    const parts = rows.filter((row) => !row.isTotal);
    const sum = (pick: (row: (typeof rows)[number]) => number | null) =>
      parts.reduce((acc, row) => acc.plus(pick(row) ?? 0), new Decimal(0)).toFixed(2);

    expect(sum((row) => row.revenue)).toBe(money(total.revenue));
    expect(sum((row) => row.opex)).toBe(money(total.opex));
    expect(sum((row) => row.netProfit)).toBe(money(total.netProfit));
    expect(money(total.revenue)).toBe('533672.38');
  });
});

// --- The reconciliation control ------------------------------------------------

describe('the P&L tie-out control', () => {
  it('passes when ARG Total equals QuickBooks, and names the classes', async () => {
    const findings = await checkPlTiesToQuickBooks(harness.db, { fromMonth: MONTH, toMonth: MONTH });
    const revenue = findings.find((finding) => finding.checkName.startsWith('Revenue'))!;
    expect(revenue.status).toBe('PASS');
    expect(money(revenue.variance)).toBe('0.00');
    expect(revenue.detail).toMatch(/-1\.76 on classes that are not a division \(Not Specified -1\.76\)/);
  });

  it('no longer waves a $1.76 gap through as "within tolerance"', async () => {
    // Pretend the Not Specified income had not been recorded.
    await harness.db
      .update(t.factCompanyTotal)
      .set({ amount: '0' })
      .where(
        and(
          eq(t.factCompanyTotal.periodMonth, MONTH),
          eq(t.factCompanyTotal.statement, 'PL_UNASSIGNED'),
          eq(t.factCompanyTotal.line, 'revenue'),
        ),
      );
    const findings = await checkPlTiesToQuickBooks(harness.db, { fromMonth: MONTH, toMonth: MONTH });
    expect(findings.find((finding) => finding.checkName.startsWith('Revenue'))!.status).toBe('FAIL');

    // Put the month back as QuickBooks reported it.
    await conformBatch(harness.db, runId, batch(SEPTEMBER));
    const again = await checkPlTiesToQuickBooks(harness.db, { fromMonth: MONTH, toMonth: MONTH });
    expect(again.every((finding) => finding.status === 'PASS')).toBe(true);
  });
});

// --- Where the class is not on the books this month ----------------------------

describe('a month with nothing outside the divisions', () => {
  it('adds no class rows and changes nothing', async () => {
    const session = await openSemanticSession(harness.db, cfo, '2026-03-01');
    const rows = loadFinance(session, CONSOLIDATED_CODE, {}).divisionBreakdown!;
    // Seeded March has no QuickBooks class outside the divisions.
    expect(rows.some((row) => row.isOtherClass)).toBe(false);
    expect(session.bundle.pl.has(key('2026-03-01', 'CLASS:Z Alloc'))).toBe(false);
  });
});
