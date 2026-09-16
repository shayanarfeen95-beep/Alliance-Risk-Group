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
import {
  balanceSheetLineFor,
  bucketForDaysPastDue,
  conformBatch,
  findSheetTable,
  parseMonthHeader,
} from '@/lib/etl/conform';
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

/**
 * The aging DETAIL report: one row per open transaction, each carrying its own
 * class and day count. The SUMMARY report ARG was pulling before is by customer
 * or vendor and carries neither, which is why fact_aging stayed empty and
 * conform declined to touch it.
 */
function agingDetailReport(rows: Array<{ klass: string; pastDue: string; balance: string }>) {
  return {
    Header: { ReportName: 'AgedReceivableDetail', StartPeriod: MONTH, EndPeriod: '2026-05-31' },
    Columns: {
      Column: [
        { ColTitle: 'Transaction Type', ColType: 'String' },
        { ColTitle: 'Class', ColType: 'String' },
        { ColTitle: 'Past Due', ColType: 'String' },
        { ColTitle: 'Open Balance', ColType: 'Money' },
      ],
    },
    Rows: {
      Row: rows.map((row) => ({
        type: 'Data',
        ColData: [
          { value: 'Invoice' },
          { value: row.klass },
          { value: row.pastDue },
          { value: row.balance },
        ],
      })),
    },
  };
}

describe('the chart of accounts', () => {
  /**
   * The balance sheet was blocked for months, and this is why.
   *
   * Every asset, liability and equity account loaded with a NULL
   * balance_sheet_line, on the principle that the grouping was a Westport
   * decision. But the P&L side of this very function has always derived its
   * reporting line from QuickBooks' own Classification — so the balance sheet
   * was being held to a stricter standard, and the cost was an empty Finance
   * dashboard and a reconciliation control listing 150 unmapped account ids.
   *
   * QuickBooks makes every account declare exactly one AccountType, and each has
   * a single sensible home. Deriving it is reading the source, not guessing.
   */
  it('maps every QuickBooks balance-sheet type to a line', () => {
    expect(balanceSheetLineFor('Bank')).toBe('cash');
    expect(balanceSheetLineFor('Accounts Receivable')).toBe('accounts_receivable');
    expect(balanceSheetLineFor('Other Current Asset')).toBe('other_current_assets');
    expect(balanceSheetLineFor('Fixed Asset')).toBe('fixed_assets');
    expect(balanceSheetLineFor('Accounts Payable')).toBe('accounts_payable');
    expect(balanceSheetLineFor('Credit Card')).toBe('cc_liability');
    expect(balanceSheetLineFor('Other Current Liability')).toBe('other_current_liabilities');
    expect(balanceSheetLineFor('Long Term Liability')).toBe('lt_liabilities');
    expect(balanceSheetLineFor('Equity')).toBe('shareholder_equity');
  });

  it('leaves profit-and-loss types without a balance-sheet line', () => {
    // A revenue account on the balance sheet would be a real problem, and
    // silently giving it a line is how that problem would stay hidden.
    expect(balanceSheetLineFor('Income')).toBeNull();
    expect(balanceSheetLineFor('Expense')).toBeNull();
    expect(balanceSheetLineFor('Cost of Goods Sold')).toBeNull();
    expect(balanceSheetLineFor(undefined)).toBeNull();
    expect(balanceSheetLineFor('Something QuickBooks Invented Later')).toBeNull();
  });

  it('loads deleted accounts and fills a line they never had', async () => {
    // A deleted account still carries every balance it ever held on prior
    // balance sheets. Omitting it does not remove it from the report — it only
    // removes our ability to read one, which is what
    // "27 balance-sheet accounts … (deleted)" was.
    const payload = {
      QueryResponse: {
        Account: [
          {
            Id: 'TEST-BANK-1',
            Name: 'Avvocato Checking - 6544 (deleted)',
            AcctNum: '1099',
            Classification: 'Asset',
            AccountType: 'Bank',
            Active: false,
          },
          {
            Id: 'TEST-CC-1',
            Name: 'PS American Express (deleted)',
            Classification: 'Liability',
            AccountType: 'Credit Card',
            Active: false,
          },
        ],
      },
    };

    await conformBatch(harness.db, null as never, batch('accounts', payload, 'all'));

    const rows = await harness.db
      .select()
      .from(t.dimAccount)
      .where(eq(t.dimAccount.accountId, 'TEST-BANK-1'));

    expect(rows[0]?.balanceSheetLine).toBe('cash');
    expect(rows[0]?.accountType).toBe('ASSET');
    expect(rows[0]?.isActive).toBe(false);

    const card = await harness.db
      .select()
      .from(t.dimAccount)
      .where(eq(t.dimAccount.accountId, 'TEST-CC-1'));
    expect(card[0]?.balanceSheetLine).toBe('cc_liability');
  });

  it('backfills a line on an account already loaded without one', async () => {
    // The warehouse is full of accounts loaded before this mapping existed.
    // They have to heal on the next pull, or the fix only helps a fresh install.
    await harness.db.insert(t.dimAccount).values({
      accountId: 'TEST-STALE-1',
      accountName: 'Operating Cash (loaded earlier)',
      accountType: 'ASSET',
      reportingLine: null,
      balanceSheetLine: null,
    });

    await conformBatch(
      harness.db,
      null as never,
      batch(
        'accounts',
        {
          QueryResponse: {
            Account: [
              {
                Id: 'TEST-STALE-1',
                Name: 'Operating Cash (loaded earlier)',
                Classification: 'Asset',
                AccountType: 'Bank',
              },
            ],
          },
        },
        'all',
      ),
    );

    const [row] = await harness.db
      .select()
      .from(t.dimAccount)
      .where(eq(t.dimAccount.accountId, 'TEST-STALE-1'));
    expect(row?.balanceSheetLine).toBe('cash');
  });

  it('never overwrites a mapping somebody made', async () => {
    // An account Westport deliberately regrouped must survive every later pull.
    // A backfill that overwrites is worse than one that never runs.
    await harness.db.insert(t.dimAccount).values({
      accountId: 'TEST-DECIDED-1',
      accountName: 'Escrow Holdings',
      accountType: 'ASSET',
      balanceSheetLine: 'other_current_assets',
    });

    await conformBatch(
      harness.db,
      null as never,
      batch(
        'accounts',
        {
          QueryResponse: {
            Account: [
              {
                Id: 'TEST-DECIDED-1',
                Name: 'Escrow Holdings',
                Classification: 'Asset',
                // QuickBooks says Bank; a person said otherwise, and wins.
                AccountType: 'Bank',
              },
            ],
          },
        },
        'all',
      ),
    );

    const [row] = await harness.db
      .select()
      .from(t.dimAccount)
      .where(eq(t.dimAccount.accountId, 'TEST-DECIDED-1'));
    expect(row?.balanceSheetLine).toBe('other_current_assets');
  });
});

describe('QuickBooks aging', () => {
  it('buckets open transactions by days past due, per division', async () => {
    const outcome = await conformBatch(
      harness.db,
      null as never,
      batch(
        'ar_aging',
        agingDetailReport([
          { klass: 'SHRC', pastDue: '0', balance: '10000.00' },
          { klass: 'SHRC', pastDue: '15', balance: '4000.00' },
          { klass: 'SHRC', pastDue: '95', balance: '2500.00' },
          { klass: 'Claims', pastDue: '45', balance: '7000.00' },
        ]),
      ),
    );

    // Five buckets for each of two divisions.
    expect(outcome.rowsWritten).toBe(10);

    const rows = await harness.db
      .select()
      .from(t.factAging)
      .where(and(eq(t.factAging.periodMonth, MONTH), eq(t.factAging.kind, 'AR')));

    const shrc = new Map(
      rows.filter((row) => row.divisionCode === 'SHRC').map((row) => [row.bucket, row.amount]),
    );
    expect(new Decimal(shrc.get('current')!).toFixed(2)).toBe('10000.00');
    expect(new Decimal(shrc.get('1_30')!).toFixed(2)).toBe('4000.00');
    expect(new Decimal(shrc.get('over_90')!).toFixed(2)).toBe('2500.00');

    // Written as an explicit zero. Omitting the row would leave whatever the
    // previous pull wrote standing, which reads as ageing debt that is gone.
    expect(new Decimal(shrc.get('61_90')!).toFixed(2)).toBe('0.00');

    const claims = rows.filter((row) => row.divisionCode === 'CLAIMS');
    expect(new Decimal(claims.find((row) => row.bucket === '31_60')!.amount).toFixed(2)).toBe(
      '7000.00',
    );
  });

  it('reports unclassed A/R as a gap rather than spreading it across divisions', async () => {
    const outcome = await conformBatch(
      harness.db,
      null as never,
      batch(
        'ar_aging',
        agingDetailReport([
          { klass: 'SHRC', pastDue: '10', balance: '5000.00' },
          { klass: '', pastDue: '20', balance: '3300.00' },
        ]),
      ),
    );

    const rows = await harness.db
      .select()
      .from(t.factAging)
      .where(and(eq(t.factAging.periodMonth, MONTH), eq(t.factAging.kind, 'AR')));

    const total = rows.reduce((acc, row) => acc.plus(row.amount), new Decimal(0));
    expect(total.toFixed(2)).toBe('5000.00');
    expect(outcome.notes.some((note) => note.includes('3300.00'))).toBe(true);
  });

  it('refuses a class that maps to no division rather than dropping its balance', async () => {
    await expect(
      conformBatch(
        harness.db,
        null as never,
        batch('ar_aging', agingDetailReport([{ klass: 'Marine Salvage', pastDue: '5', balance: '900.00' }])),
      ),
    ).rejects.toThrow(/Marine Salvage/);
  });

  it('replaces a month wholesale, so a bucket that emptied reads as zero', async () => {
    await conformBatch(
      harness.db,
      null as never,
      batch('ar_aging', agingDetailReport([{ klass: 'SHRC', pastDue: '95', balance: '8000.00' }])),
    );
    await conformBatch(
      harness.db,
      null as never,
      batch('ar_aging', agingDetailReport([{ klass: 'SHRC', pastDue: '5', balance: '1000.00' }])),
    );

    const rows = await harness.db
      .select()
      .from(t.factAging)
      .where(and(eq(t.factAging.periodMonth, MONTH), eq(t.factAging.kind, 'AR')));

    const byBucket = new Map(rows.map((row) => [row.bucket, row.amount]));
    expect(new Decimal(byBucket.get('over_90')!).toFixed(2)).toBe('0.00');
    expect(new Decimal(byBucket.get('1_30')!).toFixed(2)).toBe('1000.00');
  });

  it('puts each day count in the bucket a person would expect', () => {
    expect(bucketForDaysPastDue(0)).toBe('current');
    expect(bucketForDaysPastDue(-3)).toBe('current');
    expect(bucketForDaysPastDue(1)).toBe('1_30');
    expect(bucketForDaysPastDue(30)).toBe('1_30');
    expect(bucketForDaysPastDue(31)).toBe('31_60');
    expect(bucketForDaysPastDue(90)).toBe('61_90');
    expect(bucketForDaysPastDue(91)).toBe('over_90');
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
