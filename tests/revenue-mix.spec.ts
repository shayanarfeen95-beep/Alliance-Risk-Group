/**
 * Existing customers against net-new revenue, by business line.
 *
 * Westport, November 2026, for the 2027 budget: "how much revenue will come
 * from existing clients vs. net new … by business line." The rules pinned here:
 * existing means billing in that line before the period; at ARG Total, in any
 * line; jobs count as their parent; revenue on no class is not lost.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db';
import * as t from '@/lib/db/schema';
import { loadRevenueMix } from '@/lib/billing/revenue-mix';
import { conformCustomerIncome } from '@/lib/etl/conform';
import type { SemanticSession } from '@/lib/semantic/resolve';

let harness: TestDb;
const session = {
  bundle: {
    divisions: [
      { divisionCode: 'SHRC', divisionName: 'SHRC' },
      { divisionCode: 'LITS', divisionName: 'LITS' },
    ],
  },
} as unknown as SemanticSession;

const row = (month: string, classKey: string, divisionCode: string | null, customerId: string, income: number) => ({
  periodMonth: month,
  classKey,
  className: classKey,
  divisionCode,
  customerId,
  customerName: customerId,
  income: income.toFixed(4),
});

beforeAll(async () => {
  harness = await createTestDb();
  await harness.db.insert(t.dimQboCustomer).values([
    { customerId: 'A', displayName: 'Acme', active: true },
    { customerId: 'A-job', displayName: 'Acme:Plant 2', parentId: 'A', active: true },
    { customerId: 'B', displayName: 'Beta', active: true },
    { customerId: 'C', displayName: 'Gamma', active: true },
  ]);
  await harness.db.insert(t.factCustomerRevenue).values([
    // Acme: an SHRC customer since 2025, through its job; new to LITS in 2026.
    row('2025-03-01', 'c1', 'SHRC', 'A-job', 1000),
    row('2026-02-01', 'c1', 'SHRC', 'A', 3000),
    row('2026-02-01', 'c2', 'LITS', 'A', 500),
    // Beta: brand new in 2026.
    row('2026-01-01', 'c1', 'SHRC', 'B', 2000),
    // Gamma: billed with no class at all.
    row('2026-01-01', 'ALL', null, 'C', 700),
    // The company reports (class ALL) carry every customer.
    row('2025-03-01', 'ALL', null, 'A-job', 1000),
    row('2026-02-01', 'ALL', null, 'A', 3500),
    row('2026-01-01', 'ALL', null, 'B', 2000),
  ]);
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

const months = ['2026-01-01', '2026-02-01'] as never[];

describe('revenue mix', () => {
  it('splits each business line into existing and net new', async () => {
    const mix = await loadRevenueMix(harness.db, session, { months });
    const shrc = mix.lines.find((line) => line.key === 'SHRC')!;
    expect(shrc).toMatchObject({ total: 5000, existing: 3000, netNew: 2000, existingCustomers: 1, newCustomers: 1 });
    // Acme is new to LITS.
    expect(mix.lines.find((line) => line.key === 'LITS')).toMatchObject({ total: 500, netNew: 500 });
    // Revenue on no class still counts.
    expect(mix.lines.find((line) => line.key === 'NO_CLASS')).toMatchObject({ total: 700 });
  });

  it('counts cross-sell as existing at ARG Total, and growth against last year', async () => {
    const mix = await loadRevenueMix(harness.db, session, { months });
    expect(mix.total).toMatchObject({ total: 6200, existing: 3500, netNew: 2700 });
    expect(mix.total.existingPriorYear).toBe(0);
    expect(mix.topNew.map((c) => c.name)).toContain('Beta');
    expect(mix.historyFrom).toBe('2025-03-01');
  });

  it('narrows to one business line', async () => {
    const mix = await loadRevenueMix(harness.db, session, { months, divisionCode: 'SHRC' });
    expect(mix.lines.map((line) => line.key)).toEqual(['SHRC']);
    expect(mix.byMonth).toEqual([
      { month: '2026-01-01', existing: 0, netNew: 2000 },
      { month: '2026-02-01', existing: 3000, netNew: 0 },
    ]);
  });

  it('reads QuickBooks’ Income by Customer report', async () => {
    const notes: string[] = [];
    const written = await conformCustomerIncome(
      harness.db,
      null as never,
      {
        month: '2026-03-01',
        classId: 'ALL',
        className: 'All',
        report: {
          Columns: { Column: [{ ColTitle: '', ColType: 'Customer' }, { ColTitle: 'Income', ColType: 'Money' }, { ColTitle: 'Expenses', ColType: 'Money' }] },
          Rows: {
            Row: [
              { ColData: [{ value: 'Beta', id: 'B' }, { value: '1,250.00' }, { value: '0' }] },
              {
                Header: { ColData: [{ value: 'Acme', id: 'A' }] },
                Rows: { Row: [{ ColData: [{ value: 'Plant 2', id: 'A-job' }, { value: '400' }, { value: '' }] }] },
                Summary: { ColData: [{ value: 'Total Acme' }, { value: '400' }] },
              },
              { Summary: { ColData: [{ value: 'TOTAL' }, { value: '1650' }] } },
            ],
          },
        },
      },
      { divisions: new Map(), excluded: new Set() } as never,
      notes,
    );
    expect(written).toBe(2);
    expect(notes[0]).toMatch(/2 customers billed \$1650/);
  });
});
