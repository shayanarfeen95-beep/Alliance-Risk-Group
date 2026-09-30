/**
 * The analyst tools: the whole Finance picture, trends, and division rankings.
 *
 * What matters is not that they return something but that what they return is
 * the SAME number the dashboards show. Every assertion here checks a tool
 * against resolveKpi or the spec's reference figures — never against itself.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, loadSeededUser, type TestDb } from './helpers/db';
import { seedDatabase } from '@/lib/seed/load';
import { openSemanticSession, resolveKpi } from '@/lib/semantic/resolve';
import { toolByName, type ToolContext } from '@/lib/ai/tools';
import { MARCH_2026, TIE_OUT_MONTH, YTD_MARCH_2026 } from '@/lib/seed/reference';
import { formatNumber } from '@/lib/format';
import type { SessionUser } from '@/lib/auth/session';

let harness: TestDb;
let context: ToolContext;
let cfo: SessionUser;

const money = (value: number) => formatNumber(value, 'currency');
/** "$544,844" → 544844; "($25,717)" → -25717. */
const parse = (text: string) => {
  const negative = /^\(.*\)$/.test(text) || text.startsWith('−') || text.startsWith('-');
  const n = Number(text.replace(/[^0-9.]/g, ''));
  return negative ? -n : n;
};

beforeAll(async () => {
  harness = await createTestDb();
  await seedDatabase(harness.db, { quiet: true });
  cfo = await loadSeededUser(harness.db, 'cfo@westportfinancial.com');
  const session = await openSemanticSession(harness.db, cfo, TIE_OUT_MONTH);
  context = { db: harness.db, user: cfo, session, conversationId: null };
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

describe('get_finance_overview', () => {
  it('returns the Finance page figures, tying to the specification for March 2026', async () => {
    const outcome = await toolByName('get_finance_overview')!.run({ division: 'ARG_TOTAL' }, context);
    const result = outcome.result as {
      profitAndLoss: Array<{ line: string; month: { actual: string }; yearToDate: { actual: string }; note?: string }>;
    };
    const line = (name: string) => result.profitAndLoss.find((row) => row.line === name)!;

    expect(Math.abs(parse(line('Revenue').month.actual) - MARCH_2026.ARG_TOTAL!.revenue)).toBeLessThanOrEqual(1);
    expect(Math.abs(parse(line('Gross profit').month.actual) - MARCH_2026.ARG_TOTAL!.grossProfit)).toBeLessThanOrEqual(1);
    expect(Math.abs(parse(line('Net profit').month.actual) - MARCH_2026.ARG_TOTAL!.netProfit)).toBeLessThanOrEqual(1);
    expect(Math.abs(parse(line('Revenue').yearToDate.actual) - YTD_MARCH_2026.ARG_TOTAL!.revenue)).toBeLessThanOrEqual(1);
    // The memo line is labelled so it is never subtracted again.
    expect(line('of which direct payroll').note).toMatch(/never subtract/i);
  });

  it('agrees with resolveKpi for a division, to the formatted dollar', async () => {
    const outcome = await toolByName('get_finance_overview')!.run({ division: 'CLAIMS' }, context);
    const result = outcome.result as { profitAndLoss: Array<{ line: string; month: { actual: string } }> };
    const netProfit = result.profitAndLoss.find((row) => row.line === 'Net profit')!.month.actual;
    expect(netProfit).toBe(resolveKpi(context.session, 'net_profit', 'CLAIMS').formatted);
  });

  it('opens a session of its own for another month rather than reporting it empty', async () => {
    const outcome = await toolByName('get_finance_overview')!.run({ division: 'SHRC', month: '2025-06' }, context);
    const result = outcome.result as { scope: string; profitAndLoss: Array<{ line: string; month: { actual: string } }> };
    const june = await openSemanticSession(harness.db, cfo, '2025-06-01');
    expect(result.scope).toMatch(/June 2025/);
    expect(result.profitAndLoss[0]!.month.actual).toBe(resolveKpi(june, 'revenue', 'SHRC').formatted);
  });
});

describe('get_trend', () => {
  it('returns each month through resolveKpi, and picks the best month by direction', async () => {
    const outcome = await toolByName('get_trend')!.run({ metric: 'revenue', division: 'LITS', months: 6 }, context);
    const result = outcome.result as { months: Array<{ month: string; value: string }>; summary: { bestMonth: string } };

    expect(result.months).toHaveLength(6);
    const march = result.months.find((m) => m.month === 'March 2026')!;
    expect(march.value).toBe(money(resolveKpi(context.session, 'revenue', 'LITS').value!.toNumber()));

    const values = result.months.map((m) => parse(m.value));
    expect(parse(result.summary.bestMonth.split(': ')[1]!)).toBe(Math.max(...values));
  });

  it('caps a request at fifteen months', async () => {
    const outcome = await toolByName('get_trend')!.run({ metric: 'revenue', months: 40 }, context);
    expect((outcome.result as { months: unknown[] }).months).toHaveLength(15);
  });

  it('treats lower as better for a cost', async () => {
    const outcome = await toolByName('get_trend')!.run({ metric: 'opex', division: 'SHRC', months: 6 }, context);
    const result = outcome.result as { months: Array<{ value: string }>; summary: { bestMonth: string } };
    const values = result.months.map((m) => parse(m.value));
    expect(parse(result.summary.bestMonth.split(': ')[1]!)).toBe(Math.min(...values));
  });
});

describe('compare_divisions', () => {
  it('ranks the divisions, and their shares add up to ARG Total', async () => {
    const outcome = await toolByName('compare_divisions')!.run({ metric: 'revenue' }, context);
    const result = outcome.result as {
      ranking: Array<{ rank: number; division: string; value: string; shareOfTotal: string }>;
      argTotal: string;
    };

    expect(result.ranking[0]!.division).toBe('LITS'); // $203,363, the largest in March 2026
    const shares = result.ranking.reduce((sum, row) => sum + parse(row.shareOfTotal), 0);
    expect(Math.abs(shares - 100)).toBeLessThan(0.5);
    expect(Math.abs(parse(result.argTotal) - MARCH_2026.ARG_TOTAL!.revenue)).toBeLessThanOrEqual(1);
  });

  it('shows a division manager only their own division, and no ARG Total', async () => {
    const manager = await loadSeededUser(harness.db, 'claims.lead@alliancerisk.com');
    const session = await openSemanticSession(harness.db, manager, TIE_OUT_MONTH);
    const outcome = await toolByName('compare_divisions')!.run(
      { metric: 'revenue' },
      { db: harness.db, user: manager, session, conversationId: null },
    );
    const result = outcome.result as { ranking: Array<{ division: string }>; argTotal: string };
    expect(result.ranking.map((row) => row.division)).toEqual(['Claims']);
    expect(result.argTotal).toMatch(/not visible/i);
  });
});

describe('plan_extraction', () => {
  it('never plans a pull past the current month', async () => {
    const outcome = await toolByName('plan_extraction')!.run(
      { source: 'QBO', entity: 'profit_and_loss', fromMonth: '2026-01', toMonth: '2099-12' },
      context,
    );
    const window = String((outcome.result as { window?: string }).window ?? '');
    const thisMonth = new Date().toISOString().slice(0, 7);
    expect(window.split(' → ')[1]! <= thisMonth).toBe(true);
  });
});
