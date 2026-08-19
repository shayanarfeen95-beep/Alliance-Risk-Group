/**
 * Boxes the assistant builds, and the proposals it cannot apply on its own.
 *
 * A box is a stored specification, never stored numbers — that is what keeps a
 * box somebody asked for in conversation identical to one that shipped with the
 * app. The entitlement checks matter here as much as anywhere: "add a tile for
 * SHRC" from someone who may only see Claims must fail, and fail before
 * anything is written.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createTestDb, loadSeededUser, type TestDb } from './helpers/db';
import type { SessionUser } from '@/lib/auth/session';
import { seedDatabase } from '@/lib/seed/load';
import { openSemanticSession, type SemanticSession } from '@/lib/semantic/resolve';
import { TIE_OUT_MONTH } from '@/lib/seed/reference';
import { BoxError, createBox, listBoxes, removeBox, validateBoxInput } from '@/lib/ai/boxes';
import { confirmPendingAction, toolByName, type ToolContext } from '@/lib/ai/tools';
import { loadHubspotMapping } from '@/lib/connectors/hubspot-mapping';
import * as t from '@/lib/db/schema';

let harness: TestDb;
let cfo: SessionUser;
let claimsManager: SessionUser;
let cfoSession: SemanticSession;
let claimsSession: SemanticSession;
let cfoContext: ToolContext;
let claimsContext: ToolContext;

beforeAll(async () => {
  harness = await createTestDb();
  await seedDatabase(harness.db, { quiet: true });
  cfo = await loadSeededUser(harness.db, 'cfo@westportfinancial.com');
  claimsManager = await loadSeededUser(harness.db, 'claims.lead@alliancerisk.com');
  cfoSession = await openSemanticSession(harness.db, cfo, TIE_OUT_MONTH);
  claimsSession = await openSemanticSession(harness.db, claimsManager, TIE_OUT_MONTH);
  cfoContext = { db: harness.db, user: cfo, session: cfoSession, conversationId: null };
  claimsContext = {
    db: harness.db,
    user: claimsManager,
    session: claimsSession,
    conversationId: null,
  };
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

describe('creating a box', () => {
  it('stores a specification, not a figure', async () => {
    const { page, title, spec } = validateBoxInput(cfoSession, {
      page: 'executive',
      title: 'Claims cash',
      kind: 'tile',
      metric: 'cash_position',
      division: 'CLAIMS',
    });

    const box = await createBox(harness.db, cfo, null, page, title, spec);

    const [row] = await harness.db.select().from(t.generatedView);
    expect(row!.id).toBe(box.id);
    expect(row!.pinnedTo).toBe('executive');
    // The stored spec names the metric. It holds no resolved value, so the box
    // cannot disagree with the dashboards it sits on.
    expect(JSON.stringify(row!.spec)).toContain('cash_position');
    expect(JSON.stringify(row!.spec)).not.toMatch(/\d{4,}/);
  });

  it('refuses a metric that is not in the registry', () => {
    expect(() =>
      validateBoxInput(cfoSession, {
        page: 'executive',
        title: 'Made up',
        kind: 'tile',
        metric: 'ebitda_adjusted_vibes',
      }),
    ).toThrow(BoxError);
  });

  it('refuses a division the reader is not entitled to', () => {
    expect(() =>
      validateBoxInput(claimsSession, {
        page: 'sales',
        title: 'SHRC bookings',
        kind: 'tile',
        metric: 'dollars_booked',
        division: 'SHRC',
      }),
    ).toThrow(/Not entitled/);
  });

  it('refuses the consolidated view for a division-scoped reader', () => {
    expect(() =>
      validateBoxInput(claimsSession, {
        page: 'executive',
        title: 'Everything',
        kind: 'tile',
        metric: 'revenue',
        division: 'ARG_TOTAL',
      }),
    ).toThrow(/consolidated/i);
  });

  it('validates a chart box through the same spec compiler as a chat chart', () => {
    expect(() =>
      validateBoxInput(cfoSession, {
        page: 'finance',
        title: 'Revenue and margin together',
        kind: 'chart',
        // Dollars and a percentage on one axis is rejected there, so it is
        // rejected here — there is one rule, not two.
        chart: { form: 'line', kpis: ['revenue', 'gross_profit_pct'], dimension: 'month' },
      }),
    ).toThrow(/different units/);
  });

  it('is listed and removed only for its owner', async () => {
    const { page, title, spec } = validateBoxInput(cfoSession, {
      page: 'sales',
      title: 'Pipeline',
      kind: 'tile',
      metric: 'pipeline_value',
    });
    const box = await createBox(harness.db, cfo, null, page, title, spec);

    expect((await listBoxes(harness.db, cfo, 'sales')).map((b) => b.id)).toContain(box.id);
    expect(await listBoxes(harness.db, claimsManager, 'sales')).toHaveLength(0);

    // Somebody else cannot remove it, and the box survives the attempt.
    expect(await removeBox(harness.db, claimsManager, box.id)).toBe(false);
    expect(await removeBox(harness.db, cfo, box.id)).toBe(true);
  });
});

describe('a proposal the agent made', () => {
  it('applies only when the person confirming may change mappings', async () => {
    const [proposal] = await harness.db
      .insert(t.agentPendingAction)
      .values({
        userId: claimsManager.id,
        kind: 'HUBSPOT_MAPPING',
        label: 'Apply the HubSpot division mapping',
        detail: 'One value mapped.',
        payload: {
          rule: 'deal_property',
          property: 'division',
          values: { 'claims desk': 'CLAIMS' },
          isConfirmed: true,
        },
        status: 'PENDING',
      })
      .returning();

    // A division manager cannot change how revenue is attributed.
    const refused = await confirmPendingAction(harness.db, claimsManager, proposal!.id);
    expect(refused.handled).toBe(true);
    expect(refused.ok).toBe(false);

    const untouched = await loadHubspotMapping(harness.db);
    expect(untouched.values['claims desk']).toBeUndefined();
  });

  it('is applied from the stored payload, and only once', async () => {
    const [proposal] = await harness.db
      .insert(t.agentPendingAction)
      .values({
        userId: cfo.id,
        kind: 'HUBSPOT_MAPPING',
        label: 'Apply the HubSpot division mapping',
        detail: 'One value mapped.',
        payload: {
          rule: 'deal_property',
          property: 'division',
          values: { 'claims desk': 'CLAIMS' },
          isConfirmed: true,
        },
        status: 'PENDING',
      })
      .returning();

    const applied = await confirmPendingAction(harness.db, cfo, proposal!.id);
    expect(applied.ok).toBe(true);

    const mapping = await loadHubspotMapping(harness.db);
    expect(mapping.values['claims desk']).toBe('CLAIMS');

    // A second click finds nothing pending rather than re-applying.
    const again = await confirmPendingAction(harness.db, cfo, proposal!.id);
    expect(again.handled).toBe(false);
  });

  it('cannot be confirmed by a different user', async () => {
    const [proposal] = await harness.db
      .insert(t.agentPendingAction)
      .values({
        userId: cfo.id,
        kind: 'HUBSPOT_MAPPING',
        label: 'Apply the HubSpot division mapping',
        detail: 'Attribution set to none.',
        payload: { rule: 'none', property: null, values: {}, isConfirmed: false },
        status: 'PENDING',
      })
      .returning();

    const outcome = await confirmPendingAction(harness.db, claimsManager, proposal!.id);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/someone else/i);
  });
});

describe('the tools behind the four jobs', () => {
  it('builds a box on a dashboard and hands back a way to see it', async () => {
    const outcome = await toolByName('create_box')!.run(
      {
        page: 'marketing',
        title: 'Leads received',
        kind: 'tile',
        metric: 'leads_received',
      },
      cfoContext,
    );

    const result = outcome.result as { created: boolean; page: string };
    expect(result.created).toBe(true);
    expect(result.page).toBe('marketing');
    // A link the user clicks, not a URL pasted into prose.
    expect(outcome.links?.[0]?.href).toContain('/marketing');

    const listed = (await toolByName('list_boxes')!.run({ page: 'marketing' }, cfoContext))
      .result as { count: number };
    expect(listed.count).toBe(1);
  });

  it('reports the mapping state, including what is unattributed', async () => {
    const outcome = await toolByName('inspect_division_mapping')!.run({}, cfoContext);
    const result = outcome.result as {
      rule: string;
      unmappedValues: unknown[];
      instruction: string;
      consequence: string;
    };

    expect(result.rule).toBeDefined();
    expect(Array.isArray(result.unmappedValues)).toBe(true);
    // The tool result itself carries the rule against guessing, so it holds
    // whether or not the system prompt is read closely.
    expect(result.instruction).toMatch(/never propose a mapping/i);
  });

  it('will not let a division manager propose a mapping change', async () => {
    const outcome = await toolByName('propose_division_mapping')!.run(
      { rule: 'none' },
      claimsContext,
    );
    expect((outcome.result as { permitted: boolean }).permitted).toBe(false);
    expect(outcome.pendingAction).toBeUndefined();
  });

  it('describes the app from its live state rather than from memory', async () => {
    const outcome = await toolByName('guide_me')!.run({}, cfoContext);
    const guide = outcome.result as {
      pages: Array<{ page: string }>;
      liveState: { hubspotMapping: { consequence: string } };
      youMay: string[];
    };

    expect(guide.pages.map((p) => p.page)).toContain('Finance');
    expect(guide.liveState.hubspotMapping.consequence).toBeTruthy();
    // The CFO closes the books and signs the commentary; the guide says so
    // rather than describing capabilities this reader does not have.
    expect(guide.youMay).toContain('sign the monthly commentary');
  });

  it('refuses to open a view for a division the reader may not see', async () => {
    const outcome = await toolByName('open_view')!.run(
      { page: 'finance', division: 'SHRC' },
      claimsContext,
    );
    expect((outcome.result as { error?: string }).error).toMatch(/Not entitled/);
    expect(outcome.links).toBeUndefined();
  });
});
