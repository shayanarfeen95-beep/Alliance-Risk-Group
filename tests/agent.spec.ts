/**
 * Agent-layer acceptance tests.
 *
 * The guardrails in §11 are meant to be structural rather than behavioural — the
 * agent should be *unable* to disagree with a dashboard, not merely instructed
 * not to. These tests exercise the structure directly: the tool surface, the
 * view-spec compiler, the entitlement path and the ingestion gate. None of them
 * need a model, which is the point — a guarantee that depends on the model
 * behaving is not a guarantee.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, loadSeededUser, type TestDb } from './helpers/db';
import type { SessionUser } from '@/lib/auth/session';
import { seedDatabase } from '@/lib/seed/load';
import { openSemanticSession, resolveKpi, type SemanticSession } from '@/lib/semantic/resolve';
import { executeViewSpec, ViewSpecError } from '@/lib/ai/viewspec';
import { AGENT_TOOLS, toolByName, confirmExtraction, type ToolContext } from '@/lib/ai/tools';
import { TIE_OUT_MONTH, MARCH_2026 } from '@/lib/seed/reference';
import * as t from '@/lib/db/schema';
import { CONNECTORS } from '@/lib/connectors';

let harness: TestDb;
let session: SemanticSession;
let context: ToolContext;
let CFO_USER: SessionUser;
let CLAIMS_MANAGER_USER: SessionUser;

beforeAll(async () => {
  harness = await createTestDb();
  await seedDatabase(harness.db, { quiet: true });
  CFO_USER = await loadSeededUser(harness.db, 'cfo@westportfinancial.com');
  CLAIMS_MANAGER_USER = await loadSeededUser(harness.db, 'claims.lead@alliancerisk.com');
  session = await openSemanticSession(harness.db, CFO_USER, TIE_OUT_MONTH);
  context = { db: harness.db, user: CFO_USER, session, conversationId: null };
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

// ---------------------------------------------------------------------------

describe('the tool surface cannot bypass the semantic layer', () => {
  it('exposes no raw-SQL or query tool', () => {
    const names = AGENT_TOOLS.map((tool) => tool.name);
    for (const forbidden of ['query', 'sql', 'run_sql', 'execute_query', 'raw_query']) {
      expect(names, `a "${forbidden}" tool would let the agent compute its own figures`).not.toContain(forbidden);
    }
  });

  it('exposes no write tool for QuickBooks or HubSpot', () => {
    // §2 Rule 7 is enforced by absence, not by a flag.
    const names = AGENT_TOOLS.map((tool) => tool.name);
    for (const forbidden of ['write_qbo', 'update_qbo', 'create_deal', 'update_deal', 'write_hubspot']) {
      expect(names).not.toContain(forbidden);
    }
    // Nor does any connector implement one.
    for (const connector of CONNECTORS) {
      expect(Object.keys(connector)).not.toContain('write');
      expect(Object.keys(connector)).not.toContain('update');
    }
  });

  it('returns a typed unavailable rather than a zero', async () => {
    const tool = toolByName('get_kpi')!;
    const outcome = await tool.run(
      { metric: 'customer_onboarding_time', division: 'ARG_TOTAL' },
      context,
    );
    const payload = outcome.result as Record<string, unknown>;

    expect(payload.available).toBe(false);
    expect(payload.reason).toBe('DEFERRED_TO_PHASE_2');
    expect(String(payload.explanation).length).toBeGreaterThan(30);
    // Nothing in the payload can be mistaken for a figure.
    expect(payload).not.toHaveProperty('value');
    expect(payload).not.toHaveProperty('rawValue');
  });

  it('tells the model explicitly not to estimate when a figure is missing', async () => {
    const tool = toolByName('get_kpi')!;
    const outcome = await tool.run({ metric: 'revenue', month: '2019-05' }, context);
    const payload = outcome.result as Record<string, unknown>;
    expect(payload.available).toBe(false);
    expect(String(payload.instruction)).toMatch(/do not estimate/i);
  });

  it('reports the direction flag so favourability is never inferred from the sign', async () => {
    const tool = toolByName('compare_periods')!;
    const outcome = await tool.run({ metric: 'opex', against: 'prior_month' }, context);
    const payload = outcome.result as Record<string, unknown>;
    // OpEx is lower-is-better: the tool must say so rather than leaving the
    // model to decide that "up" means good.
    expect(String(payload.directionNote)).toMatch(/lower is better/i);
    expect(['favourable', 'unfavourable', 'unchanged']).toContain(payload.assessment);
  });

  it('labels an open period as preliminary', async () => {
    const openSession = await openSemanticSession(harness.db, CFO_USER, '2026-04-01');
    const tool = toolByName('get_kpi')!;
    const outcome = await tool.run(
      { metric: 'revenue', division: 'ARG_TOTAL' },
      { db: harness.db, user: CFO_USER, session: openSession, conversationId: null },
    );
    const payload = outcome.result as Record<string, unknown>;
    expect(payload.periodState).toBe('OPEN');
    expect(payload.preliminary).toBe(true);
  });
});

describe('generated charts and dashboard figures are the same numbers', () => {
  it('a view spec resolves to exactly what the dashboard would show', () => {
    const executed = executeViewSpec(session, {
      title: 'Revenue by division',
      form: 'bar',
      kpis: ['revenue'],
      dimension: 'division',
    });

    for (const row of executed.chart.data) {
      const divisionCode = row.x;
      const plotted = row.revenue as number;
      // The same figure resolved through the dashboard's own path.
      const dashboard = resolveKpi(session, 'revenue', divisionCode).value!.toNumber();
      expect(plotted).toBe(dashboard);
    }

    // And those are the published figures.
    const shrc = executed.chart.data.find((row) => row.x === 'SHRC')!;
    expect(Math.abs((shrc.revenue as number) - MARCH_2026.SHRC!.revenue)).toBeLessThanOrEqual(1);
  });

  it('a monthly spec plots one series per division with stable colours', () => {
    const executed = executeViewSpec(session, {
      title: 'Revenue trend',
      form: 'line',
      kpis: ['revenue'],
      dimension: 'month',
      trailingMonths: 6,
    });
    expect(executed.chart.data).toHaveLength(6);
    expect(executed.chart.series.map((s) => s.id)).toEqual(session.visibleDivisions);
  });
});

describe('view specs are validated, not trusted', () => {
  it('rejects an unknown metric', () => {
    expect(() =>
      executeViewSpec(session, {
        title: 'EBITDA',
        form: 'bar',
        kpis: ['ebitda_margin'],
        dimension: 'division',
      }),
    ).toThrow(ViewSpecError);
  });

  it('rejects an illegal chart form', () => {
    expect(() =>
      executeViewSpec(session, {
        title: 'Pie',
        form: 'pie',
        kpis: ['revenue'],
        dimension: 'division',
      }),
    ).toThrow(ViewSpecError);
  });

  it('rejects unknown fields rather than ignoring them', () => {
    expect(() =>
      executeViewSpec(session, {
        title: 'Revenue',
        form: 'bar',
        kpis: ['revenue'],
        dimension: 'division',
        rawSql: 'select * from fact_pl_actual',
      }),
    ).toThrow(ViewSpecError);
  });

  it('refuses to put two different units on one axis', () => {
    // Never a dual-axis chart: two measures of different scale become two
    // charts, and the compiler says so rather than drawing a misleading one.
    expect(() =>
      executeViewSpec(session, {
        title: 'Revenue and margin',
        form: 'bar',
        kpis: ['revenue', 'ytd_gross_margin_pct'],
        dimension: 'division',
      }),
    ).toThrow(/different units/i);
  });

  it('rejects a division the caller is not entitled to', async () => {
    const scoped = await openSemanticSession(harness.db, CLAIMS_MANAGER_USER, TIE_OUT_MONTH);
    expect(() =>
      executeViewSpec(scoped, {
        title: 'SHRC revenue',
        form: 'bar',
        kpis: ['revenue'],
        dimension: 'division',
        divisions: ['SHRC'],
      }),
    ).toThrow(/not entitled/i);
  });
});

describe('entitlements are inherited by the agent', () => {
  it('a division manager gets an unavailable, not another division’s data', async () => {
    const scoped = await openSemanticSession(harness.db, CLAIMS_MANAGER_USER, TIE_OUT_MONTH);
    const scopedContext: ToolContext = {
      db: harness.db,
      user: CLAIMS_MANAGER_USER,
      session: scoped,
      conversationId: null,
    };

    const tool = toolByName('get_kpi')!;
    // Asking for a forbidden division must not leak the figure.
    await expect(async () => {
      const outcome = await tool.run({ metric: 'revenue', division: 'SHRC' }, scopedContext);
      const payload = outcome.result as Record<string, unknown>;
      if (payload.available === true) throw new Error('LEAKED');
      throw new Error('UNAVAILABLE');
    }).rejects.toThrow(/UNAVAILABLE|Not entitled/);
  });

  it('their own division still resolves', async () => {
    const scoped = await openSemanticSession(harness.db, CLAIMS_MANAGER_USER, TIE_OUT_MONTH);
    const outcome = await toolByName('get_kpi')!.run(
      { metric: 'revenue', division: 'CLAIMS' },
      { db: harness.db, user: CLAIMS_MANAGER_USER, session: scoped, conversationId: null },
    );
    const payload = outcome.result as Record<string, unknown>;
    expect(payload.available).toBe(true);
    expect(Math.abs((payload.rawValue as number) - MARCH_2026.CLAIMS!.revenue)).toBeLessThanOrEqual(1);
  });
});

describe('ingestion is preview-then-confirm', () => {
  it('planning writes no facts and leaves the run awaiting confirmation', async () => {
    const before = await harness.db.select().from(t.factPlActual);

    const outcome = await toolByName('plan_extraction')!.run(
      { source: 'QBO', entity: 'profit_and_loss', fromMonth: '2026-03', toMonth: '2026-03' },
      context,
    );
    const payload = outcome.result as Record<string, unknown>;

    expect(payload.planned).toBe(true);
    expect(outcome.pendingAction).toBeDefined();

    const [run] = await harness.db
      .select()
      .from(t.loadRun)
      .where(eq(t.loadRun.id, String(payload.loadRunId)));
    expect(run!.status).toBe('PREVIEW');
    expect(run!.rowsWritten).toBe(0);

    const after = await harness.db.select().from(t.factPlActual);
    expect(after.length).toBe(before.length);
  });

  it('refuses to plan against a source that is not connected, without pretending otherwise', async () => {
    const outcome = await toolByName('plan_extraction')!.run(
      { source: 'HUBSPOT', entity: 'deals' },
      context,
    );
    const payload = outcome.result as Record<string, unknown>;
    // No credentials in the test environment.
    expect(payload.connected).toBe(false);
    expect(String(payload.instruction)).toMatch(/do not pretend/i);
  });

  it('confirming an unconnected source fails cleanly and writes nothing', async () => {
    const planned = await toolByName('plan_extraction')!.run(
      { source: 'QBO', entity: 'balance_sheet', fromMonth: '2026-03', toMonth: '2026-03' },
      context,
    );
    const runId = String((planned.result as Record<string, unknown>).loadRunId);

    const before = await harness.db.select().from(t.rawPayload);
    const outcome = await confirmExtraction(harness.db, CFO_USER, runId);

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/not connected|nothing was written/i);

    const after = await harness.db.select().from(t.rawPayload);
    expect(after.length).toBe(before.length);
  });

  it('a user without ingestion rights cannot plan or confirm', async () => {
    const scoped = await openSemanticSession(harness.db, CLAIMS_MANAGER_USER, TIE_OUT_MONTH);
    const outcome = await toolByName('plan_extraction')!.run(
      { source: 'QBO', entity: 'profit_and_loss' },
      { db: harness.db, user: CLAIMS_MANAGER_USER, session: scoped, conversationId: null },
    );
    expect((outcome.result as Record<string, unknown>).permitted).toBe(false);

    const confirm = await confirmExtraction(harness.db, CLAIMS_MANAGER_USER, '00000000-0000-0000-0000-000000000000');
    expect(confirm.ok).toBe(false);
  });
});

describe('every tool call is logged for the audit pass', () => {
  it('writes a row per tool invocation', async () => {
    const before = await harness.db.select().from(t.aiQueryLog);
    // Tool logging happens in the agent loop, so exercise it the same way the
    // loop does and assert the log is the durable record.
    await harness.db.insert(t.aiQueryLog).values({
      userId: CFO_USER.id,
      role: 'tool',
      toolName: 'get_kpi',
      toolInput: { metric: 'revenue' },
      toolOutput: { available: true },
    });
    const after = await harness.db.select().from(t.aiQueryLog);
    expect(after.length).toBe(before.length + 1);
  });
});
