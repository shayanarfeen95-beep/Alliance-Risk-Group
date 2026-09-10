/**
 * The Leadership 2026 review, and the link between booked and billed.
 *
 * Three of these panels ask questions the warehouse could not previously answer,
 * and each was blocked by the same class of problem: a field that HubSpot
 * documents but this portal leaves empty, or an identifier that carries no
 * meaning on its own. Both fail silently — they produce a zero, and a zero on a
 * leadership dashboard is indistinguishable from a fact.
 *
 *   Stage ids are opaque. ARG's Proposal stage is `presentationscheduled` and
 *   its Compliance Review stage is `1383067404`. Matching stage names against
 *   the id — which is what the code did — finds nothing on a real portal while
 *   working perfectly on seeded data, where ids happen to read like words.
 *
 *   Lifecycle dates are absent. Every `hs_lifecyclestage_*_date` property in
 *   ARG's portal is empty, so the month a contact became an MQL exists only
 *   inside the property's history.
 *
 * So what is asserted here is mostly that these count the right thing and say so
 * when they cannot count at all.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, loadSeededUser, type TestDb } from './helpers/db';
import { seedDatabase } from '@/lib/seed/load';
import { conformBatch } from '@/lib/etl/conform';
import { openSemanticSession, CONSOLIDATED_CODE } from '@/lib/semantic/resolve';
import { loadLeadership2026 } from '@/lib/dashboards/leadership-2026';
import { loadBookedVsActual } from '@/lib/dashboards/booked-vs-actual';
import * as t from '@/lib/db/schema';
import type { RawBatch } from '@/lib/connectors/types';
import type { SessionUser } from '@/lib/auth/session';

let harness: TestDb;
let user: SessionUser;
let runId: string;

/** Past the seeded history, so the fixture is the only data in these months. */
const MONTH = '2026-08-01';

function batch(entity: string, payloads: unknown[]): RawBatch {
  return {
    sourceSystem: 'HUBSPOT',
    entity,
    window: { start: MONTH, end: MONTH },
    fetchedAt: new Date(),
    records: payloads.map((payload, index) => ({
      entity: entity === 'deal_stages' ? '/crm/v3/pipelines/deals' : `/crm/v3/objects/${entity}`,
      key: String(index),
      payload,
    })),
  };
}

beforeAll(async () => {
  harness = await createTestDb();
  await seedDatabase(harness.db);
  user = await loadSeededUser(harness.db, 'cfo@westportfinancial.com');
  const [run] = await harness.db.select({ id: t.loadRun.id }).from(t.loadRun).limit(1);
  runId = run!.id;

  // Stages first — ARG's real ids, which carry no words at all.
  await conformBatch(
    harness.db,
    runId,
    batch('deal_stages', [
      {
        id: 'default',
        label: 'Sales Pipeline',
        stages: [
          { id: '1383067404', label: 'Compliance Review', displayOrder: 0 },
          { id: 'presentationscheduled', label: 'Proposal', displayOrder: 1 },
          { id: 'closedwon', label: 'Closed won', displayOrder: 2, metadata: { isClosed: 'true', probability: '1' } },
        ],
      },
    ]),
  );

  await conformBatch(
    harness.db,
    runId,
    batch('companies', [
      { id: 'co1', properties: { name: 'Tier one co', hs_ideal_customer_profile: 'Tier 1' } },
      { id: 'co2', properties: { name: 'Tier three co', hs_ideal_customer_profile: 'Tier 3' } },
    ]),
  );

  await conformBatch(
    harness.db,
    runId,
    batch('contacts', [
      // No hs_lifecyclestage_* dates at all — exactly as ARG's portal returns.
      lifecycle('c1', [
        { value: 'lead', timestamp: '2026-08-02T00:00:00Z' },
        { value: 'marketingqualifiedlead', timestamp: '2026-08-05T00:00:00Z' },
        { value: 'salesqualifiedlead', timestamp: '2026-08-20T00:00:00Z' },
      ]),
      lifecycle('c2', [{ value: 'marketingqualifiedlead', timestamp: '2026-08-11T00:00:00Z' }]),
      lifecycle('c3', [{ value: 'subscriber', timestamp: '2026-08-01T00:00:00Z' }]),
    ]),
  );

  await conformBatch(
    harness.db,
    runId,
    batch('deals', [
      deal('d1', {
        amount: '100000',
        won: true,
        company: 'co1',
        source: 'Employee Referral',
        type: 'newbusiness',
        history: [
          { value: '1383067404', timestamp: '2026-08-03T00:00:00Z' },
          { value: 'presentationscheduled', timestamp: '2026-08-09T00:00:00Z' },
          { value: 'closedwon', timestamp: '2026-08-25T00:00:00Z' },
        ],
      }),
      deal('d2', {
        amount: '300000',
        won: true,
        company: 'co2',
        source: 'Trade Show/Conference',
        type: 'existingbusiness',
        history: [{ value: 'closedwon', timestamp: '2026-08-26T00:00:00Z' }],
      }),
    ]),
  );
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

function lifecycle(id: string, history: Array<{ value: string; timestamp: string }>) {
  return {
    id,
    properties: {
      lifecyclestage: history[history.length - 1]!.value,
      createdate: '2026-08-01T00:00:00Z',
    },
    propertiesWithHistory: { lifecyclestage: history },
  };
}

function deal(
  id: string,
  o: {
    amount: string;
    won: boolean;
    company: string;
    source: string;
    type: string;
    history: Array<{ value: string; timestamp: string }>;
  },
) {
  return {
    id,
    properties: {
      dealname: id,
      amount: o.amount,
      dealstage: o.history[o.history.length - 1]!.value,
      pipeline: 'default',
      hs_is_closed_won: o.won ? 'true' : 'false',
      hs_is_closed: o.won ? 'true' : 'false',
      createdate: '2026-08-01T00:00:00Z',
      closedate: '2026-08-26T00:00:00Z',
      zoho_lead_source: o.source,
      dealtype: o.type,
    },
    propertiesWithHistory: { dealstage: o.history },
    associations: { companies: { results: [{ id: o.company }] } },
  };
}

async function panel() {
  const session = await openSemanticSession(harness.db, user, MONTH);
  return loadLeadership2026(session, CONSOLIDATED_CODE, { trailingMonths: 3 });
}

describe('Leadership 2026', () => {
  it('counts MQLs and SQLs from lifecycle history, not from the empty dated fields', async () => {
    const model = await panel();
    const august = (points: Array<{ x: string; value: number }>) =>
      points.find((point) => point.x === MONTH)?.value;

    // c1 and c2 became MQLs in August; c1 alone went on to SQL. None of them
    // carries an hs_lifecyclestage_*_date — that is the point.
    expect(august(model.mqlsByMonth)).toBe(2);
    expect(august(model.sqlsByMonth)).toBe(1);
  });

  it('finds the proposal stage by its NAME, not by its id', async () => {
    const model = await panel();

    // The id is `presentationscheduled`. Matching /proposal/ against the id —
    // which is what this used to do — finds nothing, and the review reports no
    // proposals while looking perfectly healthy.
    expect(model.proposalsThisYear.count).toBe(1);
    expect(model.proposalsThisYear.amount).toBe(100_000);
  });

  it('finds compliance reviews behind a numeric stage id', async () => {
    const model = await panel();
    expect(model.complianceReviews.deals).toBe(1);
  });

  it('keeps stage-based and meeting-based compliance reviews apart', async () => {
    const model = await panel();

    // Two different things share the name: a deal that reached the Compliance
    // Review stage, and a meeting logged as one. A deal whose review was also
    // logged as a meeting would be counted twice if these were added, so they
    // stay two figures. This fixture has the stage and no such meeting.
    expect(model.complianceReviews.deals).toBe(1);
    expect(model.complianceReviews.meetings).toBe(0);
  });

  it('attributes compliance reviews and wins to the lead source', async () => {
    const model = await panel();

    expect(model.complianceReviewsBySource).toEqual([
      { key: 'Employee Referral', label: 'Employee Referral', count: 1, amount: 100_000 },
    ]);
    // Largest first. The seeded dataset contributes its own unattributed wins,
    // so the assertion is on the two this fixture added and their order.
    const keys = model.dealsWonBySource.map((row) => row.key);
    expect(keys.indexOf('Trade Show/Conference')).toBeLessThan(keys.indexOf('Employee Referral'));
    expect(model.dealsWonBySource.find((row) => row.key === 'Employee Referral')?.amount).toBe(
      100_000,
    );
  });

  it('averages deal size within each month, and splits it by ICP tier', async () => {
    const model = await panel();
    const august = model.avgDealSizeByMonth.find((point) => point.x === MONTH);

    // Two deals, 100k and 300k, both closing in August.
    expect(august?.value).toBe(200_000);

    const row = model.avgDealSizeByIcp.data.find((entry) => entry.x === MONTH);
    expect(row?.['Tier 1']).toBe(100_000);
    expect(row?.['Tier 3']).toBe(300_000);
  });

  it('leaves a tier with no wins empty rather than plotting zero', async () => {
    const model = await panel();
    const earlier = model.avgDealSizeByIcp.data.find((entry) => entry.x !== MONTH);

    // An average of no deals is not zero, and drawing it as zero would put a
    // collapse on the chart that never happened.
    expect(earlier?.['Tier 1']).toBeNull();
  });
});

describe('booked versus billed', () => {
  it('separates new business from existing', async () => {
    const session = await openSemanticSession(harness.db, user, MONTH);

    const all = loadBookedVsActual(session, CONSOLIDATED_CODE, { newBusiness: 'all' });
    const isNew = loadBookedVsActual(session, CONSOLIDATED_CODE, { newBusiness: 'new' });
    const existing = loadBookedVsActual(session, CONSOLIDATED_CODE, { newBusiness: 'existing' });

    // Seeded deals carry no deal type, so they fall into neither filtered set —
    // which is the behaviour that matters: an untyped deal must not be silently
    // counted as new business.
    expect(isNew.ytd.booked).toBe(100_000);
    expect(existing.ytd.booked).toBe(300_000);
    expect(all.ytd.booked).toBeGreaterThan(isNew.ytd.booked + existing.ytd.booked);
  });

  it('compares against the same months of last year, not the whole of it', async () => {
    const session = await openSemanticSession(harness.db, user, MONTH);
    const model = loadBookedVsActual(session, CONSOLIDATED_CODE);

    // Eight months elapsed in 2026, so the prior-year figure covers eight
    // months of 2025. Comparing eight months against twelve would report a
    // collapse every year until December.
    expect(model.ytd.monthsElapsed).toBe(8);
    expect(model.rows).toHaveLength(8);
  });

  it('refuses the comparison when one side has not loaded', async () => {
    const session = await openSemanticSession(harness.db, user, MONTH);
    const model = loadBookedVsActual(
      { ...session, bundle: { ...session.bundle, deals: [] } },
      CONSOLIDATED_CODE,
    );

    // A conversion rate against a missing source reads as a catastrophe and
    // means nothing, so none is drawn.
    expect(model.unavailable).toMatch(/no hubspot deals/i);
  });

  it('says why there is no per-customer view instead of approximating one', async () => {
    const session = await openSemanticSession(harness.db, user, MONTH);
    const model = loadBookedVsActual(session, CONSOLIDATED_CODE);

    expect(model.perCustomerBlocked).toMatch(/by customer/i);
    expect(model.perCustomerBlocked).toMatch(/mapping/i);
  });
});
