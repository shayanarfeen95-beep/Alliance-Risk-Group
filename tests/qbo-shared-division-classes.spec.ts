/**
 * Two QuickBooks classes that belong to one division.
 *
 * ARG maps several classes to a single division — PS-APS, PS-Other and PS-TP to
 * LITS, CA and INV to Claims, BGI to SHRC. The P&L import wrote one GL row per
 * class column, so an account posted under both LITS and PS-TP in a month put
 * (month, LITS, account) into fact_gl_balance twice and the primary key refused
 * the whole month. That is how September 2026 stopped refreshing from
 * 26 October, after its month-end allocation was posted: the dashboard kept the
 * pre-close September, Z Alloc and all, while QuickBooks showed it allocated.
 *
 * The amounts of every class mapped to a division are that division's, so
 * they are added together — and the tie-out to QuickBooks' Total column, which
 * is exact, would fail if anything were counted twice.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { and, eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from './helpers/db';
import { seedDatabase } from '@/lib/seed/load';
import { conformBatch } from '@/lib/etl/conform';
import { describeLoadError } from '@/lib/etl/ingest';
import { checkPlTiesToQuickBooks } from '@/lib/recon/checks';
import * as t from '@/lib/db/schema';
import type { RawBatch } from '@/lib/connectors/types';

const MONTH = '2026-09-01';

let harness: TestDb;

beforeAll(async () => {
  harness = await createTestDb();
  await seedDatabase(harness.db);
  // As in production: PS-TP is a legacy class assigned to LITS.
  await harness.db.insert(t.dimClassMap).values({
    classKey: '1000000012',
    classId: '1000000012',
    className: 'PS-TP',
    decision: 'MAPPED',
    divisionCode: 'LITS',
  });
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

const cells = (id: string, name: string, values: string[]) => [{ value: name, id }, ...values.map((value) => ({ value }))];
const data = (id: string, name: string, values: string[]) => ({ type: 'Data', ColData: cells(id, name, values) });
const group = (groupName: string, title: string, rows: unknown[]) => ({
  type: 'Section',
  group: groupName,
  Header: { ColData: [{ value: title }, { value: '' }, { value: '' }, { value: '' }, { value: '' }] },
  Rows: { Row: rows },
  Summary: { ColData: [{ value: `Total ${title}` }] },
});

/** [CLAIMS, LITS, PS-TP, TOTAL] */
const REPORT = {
  Header: { ReportName: 'ProfitAndLoss', StartPeriod: MONTH, EndPeriod: '2026-09-30', SummarizeColumnsBy: 'Classes' },
  Columns: {
    Column: [
      { ColTitle: '', ColType: 'Account', MetaData: [{ Name: 'ColKey', Value: 'account' }] },
      { ColTitle: 'CLAIMS', ColType: 'Money', MetaData: [{ Name: 'ColKey', Value: '1193433' }] },
      { ColTitle: 'LITS', ColType: 'Money', MetaData: [{ Name: 'ColKey', Value: '1193430' }] },
      { ColTitle: 'PS-TP', ColType: 'Money', MetaData: [{ Name: 'ColKey', Value: '1000000012' }] },
      { ColTitle: 'TOTAL', ColType: 'Money', MetaData: [{ Name: 'ColKey', Value: 'total' }] },
    ],
  },
  Rows: {
    Row: [
      group('Income', 'Income', [
        // The same account under two classes that are both LITS.
        data('S901', 'Litigation Support Income', ['', '113522.39', '905.00', '114427.39']),
        data('S902', 'Claims', ['99861.24', '', '', '99861.24']),
      ]),
      group('Expenses', 'Expenses', [
        data('S910', 'Contractors', ['-558.34', '-592.26', '-30.00', '-1180.60']),
      ]),
    ],
  },
};

const batch = (payload: unknown): RawBatch => ({
  sourceSystem: 'QBO',
  entity: 'profit_and_loss',
  window: { start: MONTH, end: MONTH },
  records: [{ entity: 'profit_and_loss', key: MONTH, payload }],
  fetchedAt: new Date(),
});

describe('classes that map to the same division', () => {
  it('loads the month instead of refusing it on a duplicate key', async () => {
    await expect(conformBatch(harness.db, null as never, batch(REPORT))).resolves.toBeDefined();
  });

  it('adds their amounts into one row for the division', async () => {
    const rows = await harness.db
      .select()
      .from(t.factGlBalance)
      .where(and(eq(t.factGlBalance.periodMonth, MONTH), eq(t.factGlBalance.divisionCode, 'LITS'), eq(t.factGlBalance.accountId, 'S901')));
    expect(rows).toHaveLength(1);
    expect(new Decimal(rows[0]!.amount).toFixed(2)).toBe('114427.39');

    const [lits] = await harness.db
      .select()
      .from(t.factPlActual)
      .where(and(eq(t.factPlActual.periodMonth, MONTH), eq(t.factPlActual.divisionCode, 'LITS')));
    expect(new Decimal(lits!.revenue).toFixed(2)).toBe('114427.39');
    expect(new Decimal(lits!.opex).toFixed(2)).toBe('-622.26');
  });

  it('still ties to QuickBooks exactly, so nothing was counted twice', async () => {
    const findings = await checkPlTiesToQuickBooks(harness.db, { fromMonth: MONTH, toMonth: MONTH });
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((finding) => finding.status === 'PASS')).toBe(true);
  });
});

describe('a failed load', () => {
  it('records the database’s reason, not only the statement it was running', async () => {
    let caught: unknown;
    try {
      // The same row twice: the primary key refuses it, exactly as September did.
      await harness.db.insert(t.factGlBalance).values([
        { periodMonth: MONTH, divisionCode: 'LITS', accountId: 'S901', amount: '1' },
        { periodMonth: MONTH, divisionCode: 'LITS', accountId: 'S901', amount: '1' },
      ]);
    } catch (error) {
      caught = error;
    }
    const message = describeLoadError(caught);
    expect(message).toMatch(/duplicate key/i);
    expect(message).toMatch(/fact_gl_balance/);
    // The statement is named, but its parameter list is not stored.
    expect(message).not.toMatch(/\$1/);
  });
});
