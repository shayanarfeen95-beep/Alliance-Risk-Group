/**
 * The conform layer, against payloads shaped the way the providers really
 * shape them.
 *
 * These tests are the reason the load path can be trusted at all. Everything
 * upstream of here is a network call, and everything downstream is arithmetic
 * that has its own suite — this is the one place where a provider's peculiar
 * JSON becomes ARG's numbers, and every failure mode it has is silent:
 *
 *   • Section totals read as data rows double every figure. The P&L still
 *     balances, the margin still looks plausible, and revenue is twice reality.
 *   • The TOTAL column read as a division stores an ARG Total row, which is the
 *     drift §3 exists to prevent.
 *   • An unmapped class quietly attributed to "other" moves money between
 *     divisional P&Ls and nets to zero at the consolidated level, where nobody
 *     would ever see it.
 *
 * So each is asserted against by name, on the wrong answer as well as the
 * right one.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as t from '@/lib/db/schema';
import { createTestDb, type TestDb } from './helpers/db';
import { conformBatch, ConformBlockedError, parseBudgetGrid } from '@/lib/etl/conform';
import { parseQboReport, parseQboAmount } from '@/lib/etl/qbo-report';
import { buildAliasMap } from '@/lib/divisions';
import { DIVISION_SEED } from '@/lib/divisions';
import { ALL_ACCOUNTS } from '@/lib/seed/accounts';
import type { RawBatch } from '@/lib/connectors/types';

let harness: TestDb;

beforeEach(async () => {
  harness = await createTestDb();

  await harness.db.insert(t.dimDivision).values(
    DIVISION_SEED.map((division) => ({
      divisionCode: division.divisionCode,
      divisionName: division.divisionName,
      lineOfBusiness: division.lineOfBusiness,
      legacyCodes: division.legacyCodes,
      qboClassIds: division.qboClassIds,
      primaryOperationalSystem: division.primaryOperationalSystem,
      sortOrder: division.sortOrder,
    })),
  );

  await harness.db.insert(t.dimAccount).values(
    ALL_ACCOUNTS.map((account) => ({
      accountId: account.accountId,
      accountNumber: account.accountNumber,
      accountName: account.accountName,
      accountType: account.accountType,
      reportingLine: account.reportingLine,
      balanceSheetLine: account.balanceSheetLine,
    })),
  );
});

afterEach(async () => {
  await harness.close();
});

/**
 * A real load run to attribute rows to.
 *
 * Every fact carries the run that wrote it, by foreign key, so provenance
 * cannot be dropped by an insert that forgot it. Tests open a genuine run for
 * the same reason production does.
 */
async function newLoadRun(sourceSystem: 'QBO' | 'HUBSPOT' | 'SHEETS', entity: string): Promise<string> {
  const [run] = await harness.db
    .insert(t.loadRun)
    .values({ sourceSystem, entity, status: 'RUNNING' })
    .returning();
  return run!.id;
}

// ---------------------------------------------------------------------------
// The QuickBooks report tree
// ---------------------------------------------------------------------------

/**
 * A ProfitAndLoss the way QBO returns it: sections that contain their own
 * account rows AND restate them in a Summary, plus a TOTAL column.
 */
function profitAndLossPayload() {
  return {
    Header: { ReportName: 'ProfitAndLoss', StartPeriod: '2026-03-01', EndPeriod: '2026-03-31' },
    Columns: {
      Column: [
        { ColTitle: '', ColType: 'Account' },
        {
          ColTitle: 'SHRC',
          ColType: 'Money',
          MetaData: [{ Name: 'ClassRef', Value: 'CLASS_SHRC' }],
        },
        {
          ColTitle: 'Claims',
          ColType: 'Money',
          MetaData: [{ Name: 'ClassRef', Value: 'CLASS_CLAIMS' }],
        },
        { ColTitle: 'TOTAL', ColType: 'Money' },
      ],
    },
    Rows: {
      Row: [
        {
          type: 'Section',
          group: 'Income',
          Header: { ColData: [{ value: 'Income' }] },
          Rows: {
            Row: [
              {
                type: 'Data',
                ColData: [
                  { value: 'Service Revenue', id: '4000' },
                  { value: '100000.00' },
                  { value: '60000.00' },
                  { value: '160000.00' },
                ],
              },
              {
                type: 'Data',
                ColData: [
                  { value: 'Recurring Program Revenue', id: '4010' },
                  { value: '20000.00' },
                  { value: '10000.00' },
                  { value: '30000.00' },
                ],
              },
            ],
          },
          Summary: {
            ColData: [
              { value: 'Total Income' },
              { value: '120000.00' },
              { value: '70000.00' },
              { value: '190000.00' },
            ],
          },
        },
        {
          type: 'Section',
          group: 'COGS',
          Header: { ColData: [{ value: 'Cost of Goods Sold' }] },
          Rows: {
            Row: [
              {
                type: 'Data',
                ColData: [
                  { value: 'Direct Labor — Payroll', id: '5000' },
                  { value: '30000.00' },
                  { value: '18000.00' },
                  { value: '48000.00' },
                ],
              },
              {
                type: 'Data',
                ColData: [
                  { value: 'Vendor & Data Costs', id: '5020' },
                  { value: '25000.00' },
                  { value: '12000.00' },
                  { value: '37000.00' },
                ],
              },
            ],
          },
          Summary: {
            ColData: [
              { value: 'Total Cost of Goods Sold' },
              { value: '55000.00' },
              { value: '30000.00' },
              { value: '85000.00' },
            ],
          },
        },
        {
          type: 'Section',
          group: 'Expenses',
          Header: { ColData: [{ value: 'Expenses' }] },
          Rows: {
            Row: [
              {
                type: 'Data',
                ColData: [
                  { value: 'Salaries & Wages — Administrative', id: '6000' },
                  { value: '20000.00' },
                  { value: '9000.00' },
                  { value: '29000.00' },
                ],
              },
              {
                type: 'Data',
                ColData: [
                  { value: 'Rent & Occupancy', id: '6100' },
                  { value: '5000.00' },
                  { value: '3000.00' },
                  { value: '8000.00' },
                ],
              },
            ],
          },
          Summary: {
            ColData: [
              { value: 'Total Expenses' },
              { value: '25000.00' },
              { value: '12000.00' },
              { value: '37000.00' },
            ],
          },
        },
      ],
    },
  };
}

const qboBatch = (payload: unknown, entity = 'profit_and_loss'): RawBatch => ({
  sourceSystem: 'QBO',
  entity,
  window: { start: '2026-03-01', end: '2026-03-01' },
  records: [{ entity, key: '2026-03-01', payload }],
  fetchedAt: new Date(),
});

describe('parsing a QuickBooks report', () => {
  it('reads each account row exactly once and never reads a section summary', () => {
    const report = parseQboReport(profitAndLossPayload());

    expect(report.rows).toHaveLength(6);
    expect(report.rows.map((row) => row.accountId)).toEqual([
      '4000',
      '4010',
      '5000',
      '5020',
      '6000',
      '6100',
    ]);

    // The wrong answer, asserted by name: reading the three Summary rows too
    // would give nine rows and exactly double every division's figures.
    expect(report.rows.map((row) => row.accountName)).not.toContain('Total Income');
  });

  it('drops the TOTAL column, because ARG Total is a rollup and never a row', () => {
    const report = parseQboReport(profitAndLossPayload());
    expect(report.classColumns.map((column) => column.title)).toEqual(['SHRC', 'Claims']);
  });

  it('reads a blank cell as zero and a parenthesised figure as negative', () => {
    expect(parseQboAmount('', 'test')).toBe(0);
    expect(parseQboAmount(undefined, 'test')).toBe(0);
    expect(parseQboAmount('(1,234.56)', 'test')).toBe(-1234.56);
    expect(parseQboAmount('$1,000.00', 'test')).toBe(1000);
  });
});

describe('conforming a QuickBooks P&L', () => {
  it('writes account detail and a P&L that agrees with it', async () => {
    const outcome = await conformBatch(harness.db, await newLoadRun('QBO', 'report'), qboBatch(profitAndLossPayload()));

    expect(outcome.tables).toContain('fact_gl_balance');
    expect(outcome.tables).toContain('fact_pl_actual');

    const [shrc] = await harness.db
      .select()
      .from(t.factPlActual)
      .where(eq(t.factPlActual.divisionCode, 'SHRC'));

    expect(Number(shrc!.revenue)).toBe(120000);

    // §4.2, the whole reason rollUpGl exists. Direct labour is a MEMO line
    // inside COGS: COGS is 30,000 + 25,000, and gross profit does not subtract
    // the memo a second time.
    expect(Number(shrc!.cogs)).toBe(55000);
    expect(Number(shrc!.payrollDirect)).toBe(30000);
    expect(Number(shrc!.revenue) - Number(shrc!.cogs)).toBe(65000);
    // The wrong answer: subtracting the memo separately gives 35,000.
    expect(Number(shrc!.revenue) - Number(shrc!.cogs) - Number(shrc!.payrollDirect)).toBe(35000);

    expect(Number(shrc!.opex)).toBe(25000);
    expect(Number(shrc!.payrollExpense)).toBe(20000);
  });

  it('stores no ARG_TOTAL row, so the consolidated figure cannot drift', async () => {
    await conformBatch(harness.db, await newLoadRun('QBO', 'report'), qboBatch(profitAndLossPayload()));

    const rows = await harness.db.select().from(t.factPlActual);
    expect(rows.map((row) => row.divisionCode).sort()).toEqual(['CLAIMS', 'SHRC']);
  });

  it('stops the load when a class maps to no division, and writes nothing', async () => {
    const payload = profitAndLossPayload();
    payload.Columns.Column[2] = {
      ColTitle: 'Special Projects',
      ColType: 'Money',
      MetaData: [{ Name: 'ClassRef', Value: 'CLASS_UNKNOWN' }],
    };

    await expect(
      conformBatch(harness.db, await newLoadRun('QBO', 'report'), qboBatch(payload)),
    ).rejects.toBeInstanceOf(ConformBlockedError);

    // Nothing partial: a load that stops must leave the warehouse untouched,
    // or the next reader sees one division loaded and one missing.
    expect(await harness.db.select().from(t.factPlActual)).toHaveLength(0);
  });

  it('stops the load on an account nobody has mapped', async () => {
    const payload = profitAndLossPayload();
    payload.Rows.Row[0]!.Rows!.Row![0]!.ColData[0] = { value: 'Brand New Revenue', id: '4999' };

    let error: unknown;
    try {
      await conformBatch(harness.db, await newLoadRun('QBO', 'report'), qboBatch(payload));
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ConformBlockedError);
    const blocked = error as ConformBlockedError;
    expect(blocked.blockers[0]!.kind).toBe('UNMAPPED_ACCOUNT');
    // Named, so somebody can act without reading a stack trace.
    expect(blocked.message).toContain('4999');
  });

  it('refuses an unclassed report rather than storing it against a division', async () => {
    const payload = profitAndLossPayload();
    payload.Columns.Column = [
      { ColTitle: '', ColType: 'Account' },
      { ColTitle: 'TOTAL', ColType: 'Money' },
    ];

    await expect(
      conformBatch(harness.db, await newLoadRun('QBO', 'report'), qboBatch(payload)),
    ).rejects.toThrow(/no class columns/i);
  });

  it('leaves a closed month exactly as it was', async () => {
    await harness.db.insert(t.dimPeriod).values({
      periodMonth: '2026-03-01',
      fiscalYear: 2026,
      monthOfYear: 3,
      daysInMonth: 31,
      isClosed: true,
    });

    const outcome = await conformBatch(harness.db, await newLoadRun('QBO', 'report'), qboBatch(profitAndLossPayload()),
    );

    expect(outcome.skippedClosedMonths).toEqual(['2026-03-01']);
    expect(outcome.rowsWritten).toBe(0);
    expect(await harness.db.select().from(t.factPlActual)).toHaveLength(0);
  });

  it('is idempotent — running the same load twice does not double anything', async () => {
    await conformBatch(harness.db, await newLoadRun('QBO', 'report'), qboBatch(profitAndLossPayload()));
    await conformBatch(harness.db, await newLoadRun('QBO', 'report'), qboBatch(profitAndLossPayload()));

    const rows = await harness.db.select().from(t.factPlActual);
    expect(rows).toHaveLength(2);
    const shrc = rows.find((row) => row.divisionCode === 'SHRC')!;
    expect(Number(shrc.revenue)).toBe(120000);
  });
});

describe('conforming a QuickBooks balance sheet', () => {
  it('maps accounts to balance-sheet lines and loads equity as its own figure', async () => {
    const payload = {
      Header: { ReportName: 'BalanceSheet', StartPeriod: '2026-03-01', EndPeriod: '2026-03-31' },
      Columns: {
        Column: [
          { ColTitle: '', ColType: 'Account' },
          { ColTitle: 'SHRC', ColType: 'Money', MetaData: [{ Name: 'ClassRef', Value: 'CLASS_SHRC' }] },
          { ColTitle: 'TOTAL', ColType: 'Money' },
        ],
      },
      Rows: {
        Row: [
          {
            type: 'Section',
            group: 'Assets',
            Header: { ColData: [{ value: 'Assets' }] },
            Rows: {
              Row: [
                { type: 'Data', ColData: [{ value: 'Operating Cash', id: '1000' }, { value: '50000.00' }, { value: '50000.00' }] },
                { type: 'Data', ColData: [{ value: 'Accounts Receivable', id: '1100' }, { value: '80000.00' }, { value: '80000.00' }] },
              ],
            },
          },
          {
            type: 'Section',
            group: 'Liabilities',
            Header: { ColData: [{ value: 'Liabilities' }] },
            Rows: {
              Row: [
                { type: 'Data', ColData: [{ value: 'Accounts Payable', id: '2000' }, { value: '20000.00' }, { value: '20000.00' }] },
              ],
            },
          },
          {
            type: 'Section',
            group: 'Equity',
            Header: { ColData: [{ value: 'Equity' }] },
            Rows: {
              Row: [
                { type: 'Data', ColData: [{ value: "Shareholders' Equity", id: '3000' }, { value: '110000.00' }, { value: '110000.00' }] },
              ],
            },
          },
        ],
      },
    };

    await conformBatch(harness.db, await newLoadRun('QBO', 'report'), qboBatch(payload, 'balance_sheet'));

    const [row] = await harness.db.select().from(t.factBsActual);
    expect(Number(row!.cash)).toBe(50000);
    expect(Number(row!.accountsReceivable)).toBe(80000);
    expect(Number(row!.accountsPayable)).toBe(20000);
    // Defect 3: equity comes from QBO, never plugged as assets minus
    // liabilities. That is what lets the balance check assert anything.
    expect(Number(row!.shareholderEquity)).toBe(110000);
  });
});

// ---------------------------------------------------------------------------
// HubSpot
// ---------------------------------------------------------------------------

const hubspotBatch = (entity: string, records: unknown[]): RawBatch => ({
  sourceSystem: 'HUBSPOT',
  entity,
  window: { start: '2026-01-01', end: '2026-03-01' },
  records: records.map((payload, index) => ({ entity, key: String(index), payload })),
  fetchedAt: new Date(),
});

describe('conforming HubSpot deals', () => {
  const deal = {
    id: '101',
    properties: {
      dealname: 'Regional carrier — claims program',
      amount: '48000',
      dealstage: 'closedwon',
      pipeline: 'default',
      hs_is_closed_won: 'true',
      hs_is_closed: 'true',
      createdate: '2026-01-08T14:00:00Z',
      closedate: '2026-03-19T10:30:00Z',
      hubspot_owner_id: '77',
    },
    propertiesWithHistory: {
      dealstage: [
        { value: 'qualifiedtobuy', timestamp: '2026-01-08T14:00:00Z' },
        { value: 'proposalsent', timestamp: '2026-02-02T09:00:00Z' },
        { value: 'closedwon', timestamp: '2026-03-19T10:30:00Z' },
      ],
    },
  };

  it('takes the proposal date from stage history, not the current stage', async () => {
    await conformBatch(harness.db, await newLoadRun('HUBSPOT', 'crm'), hubspotBatch('deals', [deal]));

    const [row] = await harness.db.select().from(t.factDeal);
    expect(row!.dealstage).toBe('closedwon');
    // The deal is closed now; it still entered Proposal on 2 February, and New
    // Proposals Sent for February depends on exactly that.
    expect(row!.enteredProposalAt?.toISOString()).toBe('2026-02-02T09:00:00.000Z');
    expect(Number(row!.amount)).toBe(48000);
    expect(row!.isClosedWon).toBe(true);
  });

  it('records every stage transition', async () => {
    await conformBatch(harness.db, await newLoadRun('HUBSPOT', 'crm'), hubspotBatch('deals', [deal]));
    const history = await harness.db.select().from(t.factDealStageHistory);
    expect(history).toHaveLength(3);
  });

  it('leaves the division null when no division property is configured', async () => {
    delete process.env.HUBSPOT_DIVISION_PROPERTY;
    const outcome = await conformBatch(harness.db, await newLoadRun('HUBSPOT', 'crm'), hubspotBatch('deals', [deal]));

    const [row] = await harness.db.select().from(t.factDeal);
    expect(row!.divisionCode).toBeNull();
    // Open item 2 says so out loud rather than the reader wondering why sales
    // shows nothing at division level.
    expect(outcome.warnings.join(' ')).toMatch(/ARG Total only/i);
  });

  it('resolves a configured division property, including a legacy code', async () => {
    process.env.HUBSPOT_DIVISION_PROPERTY = 'arg_division';
    try {
      await conformBatch(harness.db, await newLoadRun('HUBSPOT', 'crm'), hubspotBatch('deals', [
          { ...deal, properties: { ...deal.properties, arg_division: 'CA' } },
        ]),
      );
      const [row] = await harness.db.select().from(t.factDeal);
      // 'CA' is Claims' legacy code, carried in dim_division.
      expect(row!.divisionCode).toBe('CLAIMS');
    } finally {
      delete process.env.HUBSPOT_DIVISION_PROPERTY;
    }
  });

  it('stops rather than guessing when the division value matches nothing', async () => {
    process.env.HUBSPOT_DIVISION_PROPERTY = 'arg_division';
    try {
      await expect(
        conformBatch(harness.db, await newLoadRun('HUBSPOT', 'crm'), hubspotBatch('deals', [
            { ...deal, properties: { ...deal.properties, arg_division: 'Process Service' } },
          ]),
        ),
      ).rejects.toBeInstanceOf(ConformBlockedError);
    } finally {
      delete process.env.HUBSPOT_DIVISION_PROPERTY;
    }
  });

  it('names deals from a later owners pull, so one load fixes the whole history', async () => {
    await conformBatch(harness.db, await newLoadRun('HUBSPOT', 'crm'), hubspotBatch('deals', [deal]));
    let [before] = await harness.db.select().from(t.factDeal);
    expect(before!.ownerName).toBeNull();

    await conformBatch(harness.db, await newLoadRun('HUBSPOT', 'crm'), hubspotBatch('owners', [{ id: '77', firstName: 'Scott', lastName: 'Moore' }]),
    );

    const [after] = await harness.db.select().from(t.factDeal);
    expect(after!.ownerName).toBe('Scott Moore');
  });
});

describe('conforming HubSpot meetings', () => {
  it('will not place an undated meeting in the month the refresh happened to run', async () => {
    const outcome = await conformBatch(harness.db, await newLoadRun('HUBSPOT', 'crm'), hubspotBatch('meetings', [
        { id: '1', properties: { hs_meeting_start_time: '2026-03-04T15:00:00Z' } },
        { id: '2', properties: {} },
      ]),
    );

    expect(outcome.rowsWritten).toBe(1);
    expect(outcome.warnings.join(' ')).toMatch(/no start time/i);
  });
});

// ---------------------------------------------------------------------------
// Google Sheets
// ---------------------------------------------------------------------------

describe('parsing a budget grid', () => {
  const aliases = buildAliasMap();

  it('finds the header row wherever it sits and reads Excel serial dates', () => {
    const { rows, blockers } = parseBudgetGrid(
      [
        ['FY2026 Operating Budget'],
        [],
        // 46023 = 2026-01-01, 46054 = 2026-02-01 as Sheets serial numbers.
        ['', 46023, 46054],
        ['SHRC'],
        ['Revenue', 200000, 210000],
        ['COGS', 120000, 124000],
        ['OpEx', 60000, 61000],
        ['Gross Profit', 80000, 86000],
        ['Claims'],
        ['Revenue', 130000, 128000],
      ],
      aliases,
    );

    expect(blockers).toEqual([]);
    expect(rows).toContainEqual({
      divisionCode: 'SHRC',
      periodMonth: '2026-01-01',
      lineItem: 'revenue',
      amount: 200000,
    });
    expect(rows).toContainEqual({
      divisionCode: 'CLAIMS',
      periodMonth: '2026-02-01',
      lineItem: 'revenue',
      amount: 128000,
    });

    // Gross profit is recomputed from its components, never imported — an
    // imported total is a total that can disagree with its own parts.
    expect(rows.some((row) => (row.lineItem as string) === 'gross_profit')).toBe(false);
    expect(rows.filter((row) => row.divisionCode === 'SHRC')).toHaveLength(6);
  });

  it('says so rather than guessing when no row reads as months', () => {
    const { blockers } = parseBudgetGrid([['Revenue', 1, 2, 3]], aliases);
    expect(blockers[0]!.kind).toBe('UNSUPPORTED_SHAPE');
  });

  it('refuses line items that sit under no division heading', () => {
    const { blockers } = parseBudgetGrid(
      [['', 46023, 46054], ['Revenue', 1000, 2000]],
      aliases,
    );
    expect(blockers[0]!.kind).toBe('UNMAPPED_DIVISION');
  });
});

describe('conforming a Sheets budget', () => {
  it('writes budget rows and creates the scenario they belong to', async () => {
    const outcome = await conformBatch(harness.db, await newLoadRun('SHEETS', 'monthly_budget'), {
      sourceSystem: 'SHEETS',
      entity: 'monthly_budget',
      window: { start: '2026-01-01', end: '2026-02-01' },
      records: [
        {
          entity: 'monthly_budget',
          key: 'Monthly Budget!A1:Z200',
          payload: {
            range: 'Monthly Budget!A1:Z200',
            values: [
              ['', 46023, 46054],
              ['SHRC'],
              ['Revenue', 200000, 210000],
              ['COGS', 120000, 124000],
            ],
          },
        },
      ],
      fetchedAt: new Date(),
    });

    expect(outcome.rowsWritten).toBe(4);

    const scenarios = await harness.db.select().from(t.budgetScenario);
    expect(scenarios.map((scenario) => scenario.scenarioCode)).toEqual(['MONTHLY_BUDGET']);

    const budget = await harness.db.select().from(t.factBudget);
    expect(budget).toHaveLength(4);
  });
});
