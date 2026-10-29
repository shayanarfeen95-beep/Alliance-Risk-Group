/**
 * The Leadership 2026 review, on Westport's definitions, and booked against billed.
 *
 * Westport's October 2026 corrections define every chart on HubSpot fields:
 * Line of Business is any of Background Checks, in the Sales Pipeline; Date
 * Compliance Review Completed is this year; Created by is none of Sarah Roy;
 * SQLs are contacts with a date entered MQL and one of four lead sources.
 *
 * The fixture deliberately gives the custom fields internal names that are NOT
 * the obvious ones (`lob_custom`, `compliance_done__c`, `lead_src`), the way a
 * real portal does, so these tests also prove the fields are found by their
 * LABEL. Guessing the internal name fails silently — HubSpot returns nothing
 * for a field it does not have — and the page would show zeros.
 *
 * And, as before: stage ids carry no words (ARG's Proposal stage is
 * `presentationscheduled`), so stages are matched by name.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, loadSeededUser, type TestDb } from './helpers/db';
import { seedDatabase } from '@/lib/seed/load';
import { conformBatch } from '@/lib/etl/conform';
import { openSemanticSession, CONSOLIDATED_CODE } from '@/lib/semantic/resolve';
import { loadLeadership2026, type MonthlySeries } from '@/lib/dashboards/leadership-2026';
import { scopeLeadership } from '@/lib/dashboards/leadership-scope';
import { loadBookedVsActual } from '@/lib/dashboards/booked-vs-actual';
import * as t from '@/lib/db/schema';
import type { RawBatch } from '@/lib/connectors/types';
import type { SessionUser } from '@/lib/auth/session';

let harness: TestDb;
let user: SessionUser;
let runId: string;

/** Past the seeded history, so the fixture is the only data in these months. */
const MONTH = '2026-08-01';
const JULY = '2026-07-01';

function batch(entity: string, payloads: unknown[], path?: string): RawBatch {
  return {
    sourceSystem: 'HUBSPOT',
    entity,
    window: { start: MONTH, end: MONTH },
    fetchedAt: new Date(),
    records: payloads.map((payload, index) => ({
      entity: path ?? `/crm/v3/objects/${entity}`,
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

  // HubSpot's field list: the labels Westport wrote, behind generated names.
  await conformBatch(
    harness.db,
    runId,
    batch(
      'properties',
      [
        {
          objectType: 'deals',
          name: 'lob_custom',
          label: 'Line of Business',
          type: 'enumeration',
          options: [
            { label: 'Background Checks', value: 'bg_checks' },
            { label: 'Drug Testing', value: 'drug_testing' },
          ],
        },
        { objectType: 'deals', name: 'compliance_done__c', label: 'Date Compliance Review Completed', type: 'date' },
        {
          objectType: 'contacts',
          name: 'lead_src',
          label: 'Lead Source',
          type: 'enumeration',
          options: [
            { label: 'Website', value: 'web' },
            { label: 'Referral', value: 'referral' },
          ],
        },
      ],
      '/crm/v3/properties/deals',
    ),
  );

  // Owners carry both an owner id and the user id "Created by" records.
  await harness.db.insert(t.rawPayload).values([
    { loadRunId: runId, sourceSystem: 'HUBSPOT', entity: '/crm/v3/owners', payload: { id: '501', userId: 9001, firstName: 'Dana', lastName: 'Whitfield' } },
    { loadRunId: runId, sourceSystem: 'HUBSPOT', entity: '/crm/v3/owners', payload: { id: '502', userId: 9002, firstName: 'Sarah', lastName: 'Roy' } },
  ]);

  await conformBatch(
    harness.db,
    runId,
    batch(
      'deal_stages',
      [
        {
          id: 'default',
          label: 'Sales Pipeline',
          stages: [
            { id: '1383067404', label: 'Compliance Review', displayOrder: 0 },
            { id: 'presentationscheduled', label: 'Proposal', displayOrder: 1 },
            { id: 'closedwon', label: 'Closed won/Onboarding', displayOrder: 2, metadata: { isClosed: 'true', probability: '1' } },
            { id: 'closedlost', label: 'Closed lost', displayOrder: 3, metadata: { isClosed: 'true', probability: '0' } },
          ],
        },
        { id: 'renewals', label: 'Renewals', stages: [{ id: 'r1', label: 'Renewal due', displayOrder: 0 }] },
      ],
      '/crm/v3/pipelines/deals',
    ),
  );

  await conformBatch(
    harness.db,
    runId,
    batch('contacts', [
      contact('c1', { mql: '2026-08-05T00:00:00Z', source: 'web' }),
      contact('c2', { mql: '2026-08-11T00:00:00Z', source: 'referral' }),
      contact('c3', { source: 'web' }),
    ]),
  );

  await conformBatch(
    harness.db,
    runId,
    batch('deals', [
      deal('d1', {
        amount: '100000', status: 'won', lob: 'bg_checks', reviewed: '2026-08-03', creator: '9001',
        source: 'Employee Referral', type: 'newbusiness',
        history: [
          { value: '1383067404', timestamp: '2026-08-03T00:00:00Z' },
          { value: 'presentationscheduled', timestamp: '2026-08-09T00:00:00Z' },
          { value: 'closedwon', timestamp: '2026-08-25T00:00:00Z' },
        ],
      }),
      // Created by Sarah Roy: out of "deals created", in everything else.
      deal('d2', {
        amount: '300000', status: 'won', lob: 'bg_checks', reviewed: '2026-08-10', creator: '9002',
        source: 'Trade Show/Conference', type: 'existingbusiness',
        history: [{ value: 'closedwon', timestamp: '2026-08-26T00:00:00Z' }],
      }),
      // Another line of business: out of the page entirely.
      deal('d3', {
        amount: '50000', status: 'won', lob: 'drug_testing', reviewed: '2026-08-04', creator: '9001',
        source: 'Website', history: [{ value: 'closedwon', timestamp: '2026-08-26T00:00:00Z' }],
      }),
      // Background Checks, but another pipeline: out too.
      deal('d4', {
        amount: '70000', status: 'open', lob: 'bg_checks', reviewed: '2026-08-04', creator: '9001',
        source: 'Website', pipeline: 'renewals', history: [{ value: 'r1', timestamp: '2026-08-04T00:00:00Z' }],
      }),
      // Lost: counts in total pipeline, not in "minus closed lost".
      deal('d5', {
        amount: '20000', status: 'lost', lob: 'bg_checks', reviewed: '2026-08-12', creator: '9001',
        source: 'Website', history: [{ value: 'closedlost', timestamp: '2026-08-28T00:00:00Z' }],
      }),
      // Open in Proposal, reviewed and created in July, under the ICP floor.
      deal('d6', {
        amount: '8000', status: 'open', lob: 'bg_checks', reviewed: '2026-07-05', creator: '9001',
        source: 'Website', created: '2026-07-01T00:00:00Z',
        history: [{ value: 'presentationscheduled', timestamp: '2026-07-20T00:00:00Z' }],
      }),
    ]),
  );
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

function contact(id: string, o: { mql?: string; source: string }) {
  return {
    id,
    properties: {
      lifecyclestage: 'marketingqualifiedlead',
      createdate: '2026-08-01T00:00:00Z',
      lead_src: o.source,
      ...(o.mql ? { hs_v2_date_entered_marketingqualifiedlead: o.mql } : {}),
    },
    propertiesWithHistory: {
      lifecyclestage: [{ value: 'marketingqualifiedlead', timestamp: o.mql ?? '2026-08-01T00:00:00Z' }],
    },
  };
}

function deal(
  id: string,
  o: {
    amount: string;
    status: 'won' | 'lost' | 'open';
    lob: string;
    reviewed: string;
    creator: string;
    source: string;
    type?: string;
    pipeline?: string;
    created?: string;
    history: Array<{ value: string; timestamp: string }>;
  },
) {
  return {
    id,
    properties: {
      dealname: `Deal ${id}`,
      amount: o.amount,
      dealstage: o.history[o.history.length - 1]!.value,
      pipeline: o.pipeline ?? 'default',
      hs_is_closed_won: o.status === 'won' ? 'true' : 'false',
      hs_is_closed: o.status === 'open' ? 'false' : 'true',
      createdate: o.created ?? '2026-08-01T00:00:00Z',
      closedate: '2026-08-26T00:00:00Z',
      zoho_lead_source: o.source,
      dealtype: o.type ?? null,
      lob_custom: o.lob,
      compliance_done__c: o.reviewed,
      hs_created_by_user_id: o.creator,
    },
    propertiesWithHistory: { dealstage: o.history },
  };
}

async function scoped() {
  const session = await openSemanticSession(harness.db, user, MONTH);
  return scopeLeadership(session);
}

async function panel() {
  return loadLeadership2026(await scoped(), { trailingMonths: 3 });
}

const at = (series: MonthlySeries, month: string) => series.points.find((point) => point.x === month)?.value;

describe('the Leadership scope', () => {
  it('keeps only Background Checks deals in the Sales Pipeline', async () => {
    const scope = await scoped();
    // The seeded deals carry no Line of Business, so once real ones do, they
    // are out too — as are another line of business and another pipeline.
    expect(scope.deals.map((deal) => deal.dealId).sort()).toEqual(['d1', 'd2', 'd5', 'd6']);
    expect(scope.label).toBe('Background Checks · Sales Pipeline');
    expect(scope.gaps).toEqual([]);
  });

  it('reads Line of Business by its label and shows the option label, not its value', async () => {
    const [row] = await harness.db
      .select({ lob: t.factDeal.lineOfBusiness, reviewed: t.factDeal.complianceReviewCompletedAt, by: t.factDeal.createdByName })
      .from(t.factDeal)
      .where(eq(t.factDeal.dealId, 'd2'));
    expect(row?.lob).toBe('Background Checks');
    expect(row?.reviewed?.toISOString().slice(0, 10)).toBe('2026-08-10');
    // "Created by" is a user id; the name comes from the owner who has it.
    expect(row?.by).toBe('Sarah Roy');
  });

  it('says so, and narrows nothing, while no deal carries a Line of Business', async () => {
    const session = await openSemanticSession(harness.db, user, MONTH);
    const unloaded = scopeLeadership({
      ...session,
      bundle: { ...session.bundle, deals: session.bundle.deals.map((deal) => ({ ...deal, lineOfBusiness: null })) },
    });
    expect(unloaded.gaps.join(' ')).toMatch(/No deal carries a Line of Business yet/);
    expect(unloaded.label).toMatch(/^Every line of business/);
  });
});

describe('Leadership 2026, on Westport’s definitions', () => {
  it('counts compliance reviews by Date Compliance Review Completed, this year', async () => {
    const model = await panel();
    expect(at(model.complianceReviewsByMonth, MONTH)).toBe(3); // d1, d2, d5
    expect(at(model.complianceReviewsByMonth, JULY)).toBe(1); // d6
    expect(model.complianceReviewsByMonth.dealCount).toBe(4);
  });

  it('totals pipeline by review month, and leaves closed lost out of the second chart', async () => {
    const model = await panel();
    expect(at(model.pipelineAddedByMonth, MONTH)).toBe(420_000);
    expect(at(model.pipelineLessLostByMonth, MONTH)).toBe(400_000);
    // Proposal is one of the stages the definition names.
    expect(at(model.pipelineLessLostByMonth, JULY)).toBe(8_000);
  });

  it('averages every reviewed deal, whatever its value or stage', async () => {
    const model = await panel();
    expect(at(model.avgDealSizeByMonth, MONTH)).toBe(140_000);
  });

  it('averages only deals over $10,000 for ICP, and leaves a month with none empty', async () => {
    const model = await panel();
    expect(at(model.avgDealSizeIcpByMonth, MONTH)).toBe(140_000);
    // d6 is $8,000: under the floor. An average of no deals is not zero.
    expect(at(model.avgDealSizeIcpByMonth, JULY)).toBeNull();
  });

  it('leaves Sarah Roy’s deals out of deals created, and lists the deals behind a bar', async () => {
    const model = await panel();
    expect(at(model.dealsCreatedByMonth, MONTH)).toBe(2);
    expect(model.dealsCreatedByMonth.drill[MONTH]?.sort()).toEqual(['d1', 'd5']);
  });

  it('splits closed won from closed lost', async () => {
    const model = await panel();
    expect(at(model.closedWonByMonth, MONTH)).toBe(400_000);
    expect(at(model.closedLostByMonth, MONTH)).toBe(20_000);
  });

  it('counts proposals by the stage NAME, once per deal, this year', async () => {
    const model = await panel();
    expect(model.proposalsThisYear.dealCount).toBe(2);
    expect(at(model.proposalsThisYear, MONTH)).toBe(1);
    expect(at(model.proposalsThisYear, JULY)).toBe(1);
  });

  it('counts SQLs from date entered MQL and the four lead sources', async () => {
    const model = await panel();
    // c1: Website, entered MQL in August. c2: Referral. c3: never entered.
    expect(at(model.sqlsByMonth, MONTH)).toBe(1);
  });

  it('breaks wins and reviews down by lead source, as totals and by month', async () => {
    const model = await panel();
    expect(model.dealsWonBySource.ytd.map((row) => row.key).sort()).toEqual([
      'Employee Referral',
      'Trade Show/Conference',
    ]);
    expect(model.complianceReviewsBySource.idsBySource['Website']?.sort()).toEqual(['d5', 'd6']);
    const august = model.complianceReviewsBySource.monthly.data.find((row) => row.x === MONTH);
    expect(august?.['Website']).toBe(1);
    expect(model.complianceReviewsBySource.monthly.drill[`${MONTH}|Website`]).toEqual(['d5']);
  });

  it('states every definition it counts on', async () => {
    const model = await panel();
    expect(model.definitions.sqlsByMonth).toMatch(/Website, SHRM RFQ, Webinar, Trade Show\/Conference/);
    expect(model.definitions.dealsCreatedByMonth).toMatch(/none of Sarah Roy/);
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

  it('bills against the division named, and books only the scoped deals', async () => {
    const scope = await scoped();
    const model = loadBookedVsActual(scope.session, CONSOLIDATED_CODE, {
      billed: { codes: ['SHRC'], label: 'SHRC' },
    });
    const total = loadBookedVsActual(scope.session, CONSOLIDATED_CODE);
    expect(model.ytd.booked).toBe(400_000);
    expect(model.billedLabel).toBe('SHRC');
    expect(model.ytd.billed).toBeLessThan(total.ytd.billed);
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

describe('the assistant reads the same deals', () => {
  it('lists won Background Checks deals by name, with who closed them', async () => {
    const { toolByName } = await import('@/lib/ai/tools');
    const session = await openSemanticSession(harness.db, user, MONTH);
    const outcome = await toolByName('find_deals')!.run(
      { status: 'won', leadershipScope: true, closedFrom: '2026-08', closedTo: '2026-08' },
      { db: harness.db, user, session, conversationId: null },
    );
    const result = outcome.result as {
      matched: number;
      deals: Array<{ deal: string; owner: string; stage: string; lineOfBusiness: string }>;
    };
    expect(result.matched).toBe(2);
    expect(result.deals.map((row) => row.deal).sort()).toEqual(['Deal d1', 'Deal d2']);
    expect(result.deals.every((row) => row.stage === 'Closed won/Onboarding')).toBe(true);
    expect(result.deals.every((row) => row.lineOfBusiness === 'Background Checks')).toBe(true);
  });

  it('quotes the Leadership review with its definitions', async () => {
    const { toolByName } = await import('@/lib/ai/tools');
    const session = await openSemanticSession(harness.db, user, MONTH);
    const outcome = await toolByName('get_leadership_review')!.run(
      {},
      { db: harness.db, user, session, conversationId: null },
    );
    const result = outcome.result as {
      scope: string;
      figures: { complianceReviewsThisYear: number; closedLostByMonth: Record<string, string> };
      definitions: Record<string, string>;
    };
    expect(result.scope).toBe('Background Checks · Sales Pipeline');
    expect(result.figures.complianceReviewsThisYear).toBe(4);
    expect(result.figures.closedLostByMonth['August 2026']).toBe('$20,000');
    expect(result.definitions.complianceReviewsByMonth).toMatch(/Date Compliance Review Completed/);
  });
});
