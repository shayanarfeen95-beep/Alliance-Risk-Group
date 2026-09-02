/**
 * Budget comparisons through the agent's tool surface.
 *
 * These exist because of a specific defect. `compare_periods` accepted any
 * metric for an against:'budget' comparison and, for anything that was not
 * literally revenue, COGS or OpEx, silently compared REVENUE instead while
 * labelling the result with the metric that was asked for.
 *
 * Asked for LITS gross profit against budget in March 2026, it returned revenue
 * of $203,363 against the revenue plan of $124,620, titled "Gross Profit", at
 * 163% attainment. Gross profit was $123,919 against a plan of $44,425. The
 * model repeated it faithfully, because nothing in the response suggested the
 * figures belonged to a different line.
 *
 * That is the failure mode §2 warns about by name — a confident label over a
 * wrong number — so the assertions below are about the figures being the
 * metric's own, and about the tool refusing when it has no plan to compare to.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, loadSeededUser, type TestDb } from './helpers/db';
import { seedDatabase } from '@/lib/seed/load';
import { openSemanticSession, resolveKpi, type SemanticSession } from '@/lib/semantic/resolve';
import { toolByName, type ToolContext } from '@/lib/ai/tools';

let harness: TestDb;
let context: ToolContext;
let session: SemanticSession;

beforeAll(async () => {
  harness = await createTestDb();
  await seedDatabase(harness.db);
  const user = await loadSeededUser(harness.db, 'cfo@westportfinancial.com');
  session = await openSemanticSession(harness.db, user, '2026-03-01');
  context = { db: harness.db, user, session, conversationId: null };
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

const compare = (input: Record<string, unknown>) =>
  toolByName('compare_periods')!.run(input, context).then((outcome) => outcome.result as Record<string, unknown>);

describe('compare_periods against budget', () => {
  it('reports the metric’s own actual, not the revenue it was derived from', async () => {
    const result = await compare({ metric: 'gross_profit', division: 'LITS', against: 'budget' });

    const grossProfit = resolveKpi(session, 'gross_profit', 'LITS');
    const revenue = resolveKpi(session, 'revenue', 'LITS');

    expect(result.actual).toBeCloseTo(grossProfit.value!.toNumber(), 2);
    // The specific regression: actual must not be revenue.
    expect(result.actual).not.toBeCloseTo(revenue.value!.toNumber(), 2);
  });

  it('derives the plan from the same identity the rest of the system uses', async () => {
    const gross = await compare({ metric: 'gross_profit', division: 'LITS', against: 'budget' });
    const revenue = await compare({ metric: 'revenue', division: 'LITS', against: 'budget' });
    const cogs = await compare({ metric: 'cogs', division: 'LITS', against: 'budget' });

    // Budgeted gross profit is budgeted revenue less budgeted COGS. Nothing is
    // imported as its own figure, so the identity cannot drift.
    expect(gross.plan as number).toBeCloseTo((revenue.plan as number) - (cogs.plan as number), 2);
    expect(gross.derivedFrom).toBe('+revenue −cogs');
  });

  it('nets opex out of the net profit plan', async () => {
    const net = await compare({ metric: 'net_profit', division: 'LITS', against: 'budget' });
    const revenue = await compare({ metric: 'revenue', division: 'LITS', against: 'budget' });
    const cogs = await compare({ metric: 'cogs', division: 'LITS', against: 'budget' });
    const opex = await compare({ metric: 'opex', division: 'LITS', against: 'budget' });

    expect(net.plan as number).toBeCloseTo(
      (revenue.plan as number) - (cogs.plan as number) - (opex.plan as number),
      2,
    );
    expect(net.actual).toBeCloseTo(resolveKpi(session, 'net_profit', 'LITS').value!.toNumber(), 2);
  });

  it('judges an overspend on a lower-is-better line as unfavourable', async () => {
    const result = await compare({ metric: 'opex', division: 'LITS', against: 'budget' });
    const over = (result.varianceDollars as number) > 0;
    expect(result.assessment).toBe(over ? 'unfavourable' : 'favourable');
  });

  it('refuses a metric the budget does not carry rather than substituting one', async () => {
    const result = await compare({
      metric: 'budget_attainment',
      division: 'LITS',
      against: 'budget',
    });

    expect(result.available).toBe(false);
    expect(result.reason).toBe('NO_BUDGET_FOR_METRIC');
    expect(result.actual).toBeUndefined();
    expect(result.plan).toBeUndefined();
  });
});
