/**
 * The budget ARG keeps in QuickBooks, measured against.
 *
 * Mario: "We should probably pull the Budget that is from Quickbooks." Until now
 * the only budget source was a Google Sheets tab that never loaded, so Budget,
 * Variance and Attainment were blank on every row of the Finance page.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { and, eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from './helpers/db';
import { seedDatabase } from '@/lib/seed/load';
import { conformBatch, currentBudgets } from '@/lib/etl/conform';
import * as t from '@/lib/db/schema';
import type { RawBatch } from '@/lib/connectors/types';

let harness: TestDb;

beforeAll(async () => {
  harness = await createTestDb();
  await seedDatabase(harness.db);
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

const detail = (month: string, accountId: string, amount: number, classId?: string, className?: string) => ({
  BudgetDate: `${month}-01`,
  Amount: amount,
  AccountRef: { value: accountId },
  ...(classId ? { ClassRef: { value: classId, name: className } } : {}),
});

const budgets = [
  {
    Id: '1',
    Name: 'FY2026 Budget (original)',
    StartDate: '2026-01-01',
    BudgetType: 'ProfitAndLoss',
    BudgetEntryType: 'Monthly',
    Active: true,
    MetaData: { LastUpdatedTime: '2026-01-05T10:00:00-07:00' },
    BudgetDetail: [detail('2026-08', '4000', 999_999, 'CLASS_SHRC', 'SHRC')],
  },
  {
    Id: '2',
    Name: 'FY2026 Budget',
    StartDate: '2026-01-01',
    BudgetType: 'ProfitAndLoss',
    BudgetEntryType: 'Monthly',
    Active: true,
    MetaData: { LastUpdatedTime: '2026-06-20T10:00:00-07:00' },
    BudgetDetail: [
      detail('2026-08', '4000', 300_000, 'CLASS_SHRC', 'SHRC'),
      detail('2026-08', '4000', 150_000, 'CLASS_CLAIMS', 'Claims'),
      // Not split by class: part of the company plan, in no division.
      detail('2026-08', '4000', 50_000),
      detail('2026-08', '5010', 200_000, 'CLASS_SHRC', 'SHRC'),
      detail('2026-08', '6100', 80_000),
    ],
  },
  {
    Id: '3',
    Name: 'FY2026 Reforecast Q3',
    StartDate: '2026-01-01',
    BudgetType: 'ProfitAndLoss',
    BudgetEntryType: 'Monthly',
    Active: true,
    MetaData: { LastUpdatedTime: '2026-09-01T10:00:00-07:00' },
    BudgetDetail: [detail('2026-10', '4000', 520_000, 'CLASS_SHRC', 'SHRC')],
  },
];

function batch(): RawBatch {
  return {
    sourceSystem: 'QBO',
    entity: 'budgets',
    window: { start: '2026-08-01', end: '2026-08-01' },
    records: [{ entity: 'budgets', key: 'page-1', payload: { QueryResponse: { Budget: budgets } } }],
    fetchedAt: new Date(),
  };
}

describe('choosing the budget', () => {
  it('takes the most recently edited budget per year, and the forecast by its name', () => {
    const chosen = currentBudgets(budgets);
    expect(chosen.map((entry) => `${entry.scenario}:${entry.budget.Name}`).sort()).toEqual([
      'FORECAST:FY2026 Reforecast Q3',
      'QBO_BUDGET:FY2026 Budget',
    ]);
  });
});

describe('loading the QuickBooks budget', () => {
  it('writes the budget by division, from the class on each line', async () => {
    const outcome = await conformBatch(harness.db, null as never, batch());
    expect(outcome.notes.join(' ')).toMatch(/FY2026 Budget/);

    const [shrcRevenue] = await harness.db
      .select()
      .from(t.factBudget)
      .where(
        and(
          eq(t.factBudget.scenarioCode, 'QBO_BUDGET'),
          eq(t.factBudget.periodMonth, '2026-08-01'),
          eq(t.factBudget.divisionCode, 'SHRC'),
          eq(t.factBudget.lineItem, 'revenue'),
        ),
      );
    // The newer budget, never the original's 999,999, and never both summed.
    expect(new Decimal(shrcRevenue!.amount).toNumber()).toBe(300_000);
  });

  it('holds the whole company plan, unclassed lines included, for ARG Total', async () => {
    const rows = await harness.db
      .select()
      .from(t.factCompanyTotal)
      .where(and(eq(t.factCompanyTotal.statement, 'QBO_BUDGET'), eq(t.factCompanyTotal.periodMonth, '2026-08-01')));
    const byLine = Object.fromEntries(rows.map((row) => [row.line, new Decimal(row.amount).toNumber()]));
    expect(byLine).toEqual({ revenue: 500_000, cogs: 200_000, opex: 80_000 });
  });

  it('loads a budget named as a forecast into the forecast scenario', async () => {
    const [row] = await harness.db
      .select()
      .from(t.factBudget)
      .where(and(eq(t.factBudget.scenarioCode, 'FORECAST'), eq(t.factBudget.periodMonth, '2026-10-01')));
    expect(new Decimal(row!.amount).toNumber()).toBe(520_000);
  });
});
