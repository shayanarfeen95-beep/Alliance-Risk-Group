/**
 * Standing goals and monthly close commentary.
 *
 * These are the two places where the agent produces text that a human then
 * signs, so both are held to the same bar as a dashboard figure: a finding
 * quotes only what `resolveKpi` returned, and a narrative quotes only what was
 * resolved before the model was called. The verifier is the load-bearing part —
 * it is what makes it safe to let a model write prose about money at all.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { createTestDb, loadSeededUser, type TestDb } from './helpers/db';
import type { SessionUser } from '@/lib/auth/session';
import { seedDatabase } from '@/lib/seed/load';
import { openSemanticSession, resolveKpi, CONSOLIDATED_CODE, type SemanticSession } from '@/lib/semantic/resolve';
import {
  DEFAULT_GOALS,
  EVALUATORS,
  evaluateGoalsForUser,
  evaluatorById,
  openFindings,
  persistFindings,
  type Finding,
} from '@/lib/ai/goals';
import {
  buildFactPack,
  accountMovers,
  deterministicDraft,
  verifyDraft,
  generateCommentary,
} from '@/lib/ai/commentary';
import { TIE_OUT_MONTH, MARCH_2026 } from '@/lib/seed/reference';
import * as t from '@/lib/db/schema';

let harness: TestDb;
let session: SemanticSession;
let CFO_USER: SessionUser;
let CLAIMS_MANAGER_USER: SessionUser;
let cfoFindings: Finding[];

beforeAll(async () => {
  harness = await createTestDb();
  await seedDatabase(harness.db, { quiet: true });
  CFO_USER = await loadSeededUser(harness.db, 'cfo@westportfinancial.com');
  CLAIMS_MANAGER_USER = await loadSeededUser(harness.db, 'claims.lead@alliancerisk.com');
  session = await openSemanticSession(harness.db, CFO_USER, TIE_OUT_MONTH);
  cfoFindings = await evaluateGoalsForUser(harness.db, CFO_USER, TIE_OUT_MONTH);
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

// ---------------------------------------------------------------------------

describe('goals evaluate deterministically', () => {
  it('every default goal names an evaluator that exists', () => {
    for (const goal of DEFAULT_GOALS) {
      expect(evaluatorById(goal.evaluator), `${goal.name} → ${goal.evaluator}`).toBeDefined();
    }
  });

  it('produces the same findings on a second run', async () => {
    const again = await evaluateGoalsForUser(harness.db, CFO_USER, TIE_OUT_MONTH);
    expect(again.map((f) => f.headline).sort()).toEqual(cfoFindings.map((f) => f.headline).sort());
    expect(again.map((f) => f.detail).sort()).toEqual(cfoFindings.map((f) => f.detail).sort());
  });

  it('finds something in the seeded month — an empty panel would prove nothing', () => {
    expect(cfoFindings.length).toBeGreaterThan(0);
  });
});

describe('a finding quotes only resolved figures', () => {
  it('every currency figure in a threshold finding matches the resolved KPI', async () => {
    const goal = {
      id: null as unknown as string,
      name: 'test',
      instruction: 'Flag operating expense above $20,000.',
      evaluator: 'KPI_THRESHOLD',
      params: { kpi: 'opex', threshold: 20_000, divisions: ['SHRC'] },
      cadence: 'ON_REFRESH',
      isActive: true,
    };

    const findings = await evaluatorById('KPI_THRESHOLD')!.run({ db: harness.db, session, goal });
    expect(findings).toHaveLength(1);

    const resolved = resolveKpi(session, 'opex', 'SHRC');
    expect(findings[0]!.detail).toContain(resolved.formatted);
  });

  it('does not fire on a metric that has no value — "no data" is not "on target"', async () => {
    // Customer onboarding time is deferred to Phase 2 and resolves unavailable.
    // A threshold goal over it must produce nothing at all, rather than reading
    // the absent figure as zero and reporting a breach.
    const unavailable = resolveKpi(session, 'customer_onboarding_time', CONSOLIDATED_CODE);
    expect(unavailable.value).toBeNull();

    const findings = await evaluatorById('KPI_THRESHOLD')!.run({
      db: harness.db,
      session,
      goal: {
        id: null as unknown as string,
        name: 'test',
        instruction: 'Flag onboarding over 5 days.',
        evaluator: 'KPI_THRESHOLD',
        params: { kpi: 'customer_onboarding_time', threshold: 5 },
        cadence: 'ON_REFRESH',
        isActive: true,
      },
    });

    expect(findings).toHaveLength(0);
  });

  it('reads the direction flag rather than assuming higher is worse', async () => {
    // The same evaluator, the same threshold shape, two metrics with opposite
    // direction flags. Revenue breaches by falling; OpEx breaches by rising.
    const run = (kpi: string, threshold: number) =>
      evaluatorById('KPI_THRESHOLD')!.run({
        db: harness.db,
        session,
        goal: {
          id: null as unknown as string,
          name: 'test',
          instruction: 'x',
          evaluator: 'KPI_THRESHOLD',
          params: { kpi, threshold, divisions: ['SHRC'] },
          cadence: 'ON_REFRESH',
          isActive: true,
        },
      });

    // SHRC March revenue is $195,519 and OpEx is $26,198.
    expect(await run('revenue', 500_000)).toHaveLength(1); // below → breach
    expect(await run('revenue', 10_000)).toHaveLength(0); // above → fine
    expect(await run('opex', 10_000)).toHaveLength(1); // above → breach
    expect(await run('opex', 500_000)).toHaveLength(0); // below → fine
  });

  it('separates budget attainment from the dollar variance', async () => {
    const findings = await evaluatorById('BUDGET_ATTAINMENT')!.run({
      db: harness.db,
      session,
      goal: {
        id: null as unknown as string,
        name: 'test',
        instruction: 'x',
        evaluator: 'BUDGET_ATTAINMENT',
        // A floor of 200% guarantees every division reports, so the assertion
        // is about wording rather than about which divisions missed.
        params: { lineItem: 'revenue', minAttainment: 2 },
        cadence: 'ON_REFRESH',
        isActive: true,
      },
    });

    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      // §7: a reader seeing "−36,773" beside "84%" reasonably assumes both are
      // variances. The two must never be adjacent and unlabelled.
      expect(finding.detail).toMatch(/Attainment \d+% of/);
      expect(finding.detail).toMatch(/Variance .* on .* actual against .* budgeted/);
    }
  });

  it('never renders a breach as equal to its own threshold', async () => {
    // A gross margin of 34.99% against a 35% threshold must not read as
    // "35% against a threshold of 35%".
    const findings = await evaluateGoalsForUser(harness.db, CFO_USER, TIE_OUT_MONTH);
    for (const finding of findings) {
      const match = finding.detail.match(/^([\d.,()$%]+) against a threshold of ([\d.,()$%]+)\./);
      if (match) expect(match[1]).not.toEqual(match[2]);
    }
  });
});

describe('findings respect entitlements', () => {
  it('a division manager’s goals never produce a finding about another division', async () => {
    const findings = await evaluateGoalsForUser(harness.db, CLAIMS_MANAGER_USER, TIE_OUT_MONTH);
    for (const finding of findings) {
      if (finding.divisionCode === null) continue;
      expect(finding.divisionCode).toBe('CLAIMS');
    }
  });

  it('the exception panel filters a finding whose division was later revoked', async () => {
    await persistFindings(harness.db, cfoFindings);

    const narrowed: SessionUser = { ...CFO_USER, canViewConsolidated: false, divisionCodes: ['SHRC'] };
    const visible = await openFindings(harness.db, narrowed, TIE_OUT_MONTH);

    for (const row of visible) {
      if (row.divisionCode === null) continue;
      expect(row.divisionCode).toBe('SHRC');
    }
  });

  it('collapses a repeated finding instead of stacking it', async () => {
    await persistFindings(harness.db, cfoFindings);
    const [before] = await harness.db
      .select({ count: t.agentFinding.id })
      .from(t.agentFinding)
      .limit(1);
    expect(before).toBeDefined();

    const countRows = async () => {
      const rows = await harness.db.select({ id: t.agentFinding.id }).from(t.agentFinding);
      return rows.length;
    };

    const first = await countRows();
    await persistFindings(harness.db, cfoFindings);
    await persistFindings(harness.db, cfoFindings);
    expect(await countRows()).toBe(first);
  });
});

describe('a goal that breaks is visible, not silent', () => {
  it('reports an unevaluable goal as a finding rather than dropping it', async () => {
    const [user] = await harness.db
      .select()
      .from(t.users)
      .where(eq(t.users.email, 'ceo@alliancerisk.com'))
      .limit(1);

    await harness.db.insert(t.agentGoal).values({
      userId: user!.id,
      name: 'Broken goal',
      instruction: 'Watch a metric that does not exist.',
      evaluator: 'RECON_FAILING',
      params: null,
      cadence: 'ON_REFRESH',
    });

    // Force the evaluator to throw by pointing it at a dropped table.
    await harness.db.execute('alter table recon_result rename to recon_result_moved');
    try {
      const ceo = await loadSeededUser(harness.db, 'ceo@alliancerisk.com');
      const findings = await evaluateGoalsForUser(harness.db, ceo, TIE_OUT_MONTH);
      expect(findings.some((f) => f.headline.includes('could not be evaluated'))).toBe(true);
    } finally {
      await harness.db.execute('alter table recon_result_moved rename to recon_result');
    }
  });
});

// ---------------------------------------------------------------------------

describe('close commentary is grounded in resolved figures', () => {
  it('assembles a fact pack of finished strings, never raw numbers', () => {
    const facts = buildFactPack(session, cfoFindings);
    expect(facts.length).toBeGreaterThan(10);
    for (const fact of facts) {
      expect(typeof fact.value).toBe('string');
    }
  });

  it('the fact pack’s headline figures match the dashboards exactly', () => {
    const facts = buildFactPack(session, cfoFindings);
    const revenue = resolveKpi(session, 'revenue', CONSOLIDATED_CODE);
    const netProfit = resolveKpi(session, 'net_profit', CONSOLIDATED_CODE);

    expect(facts.find((f) => f.label === 'Revenue')?.value).toBe(revenue.formatted);
    expect(facts.find((f) => f.label === 'Net Profit')?.value).toBe(netProfit.formatted);
    // And the dashboard figure is the spec's published figure.
    expect(revenue.value!.toNumber()).toBeCloseTo(MARCH_2026.ARG_TOTAL!.revenue, 0);
  });

  it('labels a movement favourable or unfavourable from the direction flag', () => {
    const facts = buildFactPack(session, cfoFindings);
    const opexMove = facts.find((f) => f.label === 'Operating Expense, movement on prior month');
    expect(opexMove).toBeDefined();

    const current = resolveKpi(session, 'opex', CONSOLIDATED_CODE);
    const prior = resolveKpi(session, 'opex', CONSOLIDATED_CODE, {
      month: session.period.priorMonth,
    });
    const rose = current.value!.greaterThan(prior.value!);
    // OpEx is higherIsBetter: false, so a rise is unfavourable.
    expect(opexMove!.note).toContain(rose ? 'unfavourable' : 'favourable');
  });

  it('names the accounts that drove the movement', () => {
    const movers = accountMovers(session, session.visibleDivisions);
    expect(movers.length).toBeGreaterThan(0);
    for (const mover of movers) {
      expect(mover.label.startsWith('Account movement: ')).toBe(true);
    }
  });

  it('the deterministic draft is publishable on its own', () => {
    const facts = [...buildFactPack(session, cfoFindings), ...accountMovers(session, session.visibleDivisions)];
    const draft = deterministicDraft(session, facts, cfoFindings);

    expect(draft.length).toBeGreaterThan(200);
    expect(draft).toContain('March 2026');
    // It must pass its own verifier — a fallback that fails the check would be
    // worse than no fallback.
    expect(verifyDraft(draft, facts)).toEqual({ ok: true });
  });
});

describe('the commentary verifier rejects invented figures', () => {
  let facts: ReturnType<typeof buildFactPack>;

  beforeAll(() => {
    facts = [...buildFactPack(session, cfoFindings), ...accountMovers(session, session.visibleDivisions)];
  });

  it('accepts a draft that quotes the pack verbatim', () => {
    const revenue = facts.find((f) => f.label === 'Revenue')!.value;
    expect(verifyDraft(`Revenue came in at ${revenue} for the month.`, facts)).toEqual({ ok: true });
  });

  it('rejects a figure that appears nowhere in the pack', () => {
    const result = verifyDraft('Revenue came in at $999,111 for the month.', facts);
    expect(result.ok).toBe(false);
  });

  it('rejects a percentage the model worked out itself', () => {
    // The pack carries movements as dollars and formatted percentages; a model
    // computing "improved 3.7%" has done arithmetic it is not permitted to do.
    const result = verifyDraft('Gross margin improved 3.71% on the month.', facts);
    expect(result.ok).toBe(false);
  });

  it('rejects a rounded restatement of a real figure', () => {
    // "$544,844" in the pack must not become "$545,000" in the prose.
    const result = verifyDraft('ARG Total revenue was about $545,000 in March.', facts);
    expect(result.ok).toBe(false);
  });

  it('accepts prose with no figures at all', () => {
    expect(
      verifyDraft('Claims carried the month while Trial Prep lagged its budget.', facts),
    ).toEqual({ ok: true });
  });
});

describe('commentary falls back rather than failing', () => {
  it('ships the deterministic draft when no model is configured', async () => {
    const key = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const commentary = await generateCommentary(session, cfoFindings);
      expect(commentary.modelWritten).toBe(false);
      expect(commentary.body.length).toBeGreaterThan(200);
      expect(commentary.periodState).toBe('CLOSED');
      expect(verifyDraft(commentary.body, commentary.facts)).toEqual({ ok: true });
    } finally {
      if (key !== undefined) process.env.ANTHROPIC_API_KEY = key;
    }
  });

  it('labels an open month as preliminary in the narrative itself', async () => {
    const openSession = await openSemanticSession(harness.db, CFO_USER, '2026-04-01');
    const facts = buildFactPack(openSession, []);
    const draft = deterministicDraft(openSession, facts, []);
    expect(draft).toMatch(/open period/i);
  });
});

describe('the seed leaves a drafted, unsigned narrative', () => {
  it('stores one draft for the last closed month', async () => {
    const rows = await harness.db.select().from(t.monthlyCommentary);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.periodMonth).toBe(TIE_OUT_MONTH);
    // Unsigned: Westport signs it, the system does not.
    expect(rows[0]!.signedAt).toBeNull();
    expect(rows[0]!.draft.length).toBeGreaterThan(200);
  });
});
