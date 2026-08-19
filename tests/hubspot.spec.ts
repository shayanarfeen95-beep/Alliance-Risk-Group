/**
 * HubSpot: mapping, conform, and what happens to a deal nobody has mapped.
 *
 * The two failure modes this suite exists to prevent:
 *
 *   1. A load that reports success and moves no figure — payloads landed in
 *      `raw_payload` and never conformed into the fact tables.
 *   2. A deal attributed to a division by a rule nobody agreed to. An invented
 *      attribution moves revenue between divisional P&Ls and is invisible at ARG
 *      Total, so the only acceptable behaviour for an unmapped value is to leave
 *      it unattributed and say how many there are.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, loadSeededUser, type TestDb } from './helpers/db';
import type { SessionUser } from '@/lib/auth/session';
import { seedDatabase } from '@/lib/seed/load';
import {
  divisionForDeal,
  loadHubspotMapping,
  observedAttributionValues,
  saveHubspotMapping,
} from '@/lib/connectors/hubspot-mapping';
import { conformHubspot, reconformLandedHubspot } from '@/lib/etl/hubspot';
import * as t from '@/lib/db/schema';

let harness: TestDb;
let cfo: SessionUser;
let loadRunId: string;

/** Three deals: one on a value that will be mapped, one on a value nobody maps. */
const DEALS = [
  {
    id: 'hs-test-deal-1',
    properties: {
      dealname: 'Litigation retainer',
      amount: '12000',
      dealstage: 'closedwon',
      pipeline: 'default',
      hs_is_closed_won: 'true',
      hs_is_closed: 'true',
      createdate: '2026-01-05T00:00:00Z',
      closedate: '2026-02-18T00:00:00Z',
      hubspot_owner_id: '77',
      division: 'Litigation Support',
    },
    propertiesWithHistory: {
      dealstage: [
        { value: 'qualifiedtobuy', timestamp: '2026-01-05T00:00:00Z' },
        { value: 'proposalsent', timestamp: '2026-01-20T00:00:00Z' },
        { value: 'closedwon', timestamp: '2026-02-18T00:00:00Z' },
      ],
    },
  },
  {
    id: 'hs-test-deal-2',
    properties: {
      dealname: 'Screening package',
      amount: '4500',
      dealstage: 'proposalsent',
      pipeline: 'default',
      hs_is_closed_won: 'false',
      hs_is_closed: 'false',
      createdate: '2026-02-01T00:00:00Z',
      hubspot_owner_id: '78',
      division: 'Litigation Support',
    },
    propertiesWithHistory: {
      dealstage: [{ value: 'proposalsent', timestamp: '2026-02-11T00:00:00Z' }],
    },
  },
  {
    id: 'hs-test-deal-3',
    properties: {
      dealname: 'Something new',
      amount: '9000',
      dealstage: 'qualifiedtobuy',
      pipeline: 'default',
      hs_is_closed_won: 'false',
      hs_is_closed: 'false',
      createdate: '2026-02-20T00:00:00Z',
      hubspot_owner_id: '79',
      // A division value that exists in HubSpot and has no mapping here.
      division: 'Emerging Services',
    },
  },
];

beforeAll(async () => {
  harness = await createTestDb();
  await seedDatabase(harness.db, { quiet: true });
  cfo = await loadSeededUser(harness.db, 'cfo@westportfinancial.com');

  const [run] = await harness.db
    .insert(t.loadRun)
    .values({
      sourceSystem: 'HUBSPOT',
      entity: 'deals',
      status: 'SUCCEEDED',
      requestedByUserId: cfo.id,
    })
    .returning();
  loadRunId = run!.id;

  await harness.db.insert(t.rawPayload).values(
    DEALS.map((deal) => ({
      loadRunId,
      sourceSystem: 'HUBSPOT' as const,
      entity: 'deals',
      payload: deal as object,
    })),
  );
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

describe('the division mapping', () => {
  it('reads the values HubSpot actually sent, with their deal counts', async () => {
    const mapping = await saveHubspotMapping(harness.db, cfo, {
      rule: 'deal_property',
      property: 'division',
      values: {},
      isConfirmed: true,
    });

    const observed = await observedAttributionValues(harness.db, mapping, ['LITS', 'SHRC']);
    const values = Object.fromEntries(observed.values.map((row) => [row.value, row.deals]));

    expect(values['Litigation Support']).toBe(2);
    expect(values['Emerging Services']).toBe(1);
  });

  it('leaves an unmapped value unattributed rather than guessing', async () => {
    const mapping = await saveHubspotMapping(harness.db, cfo, {
      rule: 'deal_property',
      property: 'division',
      values: { 'litigation support': 'LITS' },
      isConfirmed: true,
    });

    expect(divisionForDeal(mapping, DEALS[0]!, ['LITS', 'SHRC'])).toBe('LITS');
    // "Emerging Services" resembles nothing. It must not become "other", and it
    // must not be dropped — it is simply unattributed.
    expect(divisionForDeal(mapping, DEALS[2]!, ['LITS', 'SHRC'])).toBeNull();
  });

  it('accepts a value that is exactly a division code, and nothing looser', async () => {
    const mapping = await loadHubspotMapping(harness.db);
    const exact = { properties: { division: 'LITS' } };
    const nearly = { properties: { division: 'LITS - Litigation' } };

    expect(divisionForDeal(mapping, exact, ['LITS'])).toBe('LITS');
    expect(divisionForDeal(mapping, nearly, ['LITS'])).toBeNull();
  });

  it('records who changed it', async () => {
    const events = await harness.db
      .select()
      .from(t.auditEvent)
      .where(eq(t.auditEvent.action, 'HUBSPOT_MAPPING_UPDATED'));

    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.userId).toBe(cfo.id);
  });
});

describe('conform', () => {
  it('writes landed payloads into the fact tables', async () => {
    const result = await conformHubspot(
      harness.db,
      loadRunId,
      'deals',
      DEALS.map((deal) => ({ payload: deal })),
    );

    expect(result.written).toBe(3);
    expect(result.unattributed).toBe(1);
    expect(result.unmappedValues.join()).toContain('Emerging Services');

    const [deal] = await harness.db
      .select()
      .from(t.factDeal)
      .where(eq(t.factDeal.dealId, 'hs-test-deal-1'));

    expect(deal!.divisionCode).toBe('LITS');
    expect(deal!.isClosedWon).toBe(true);
    expect(Number(deal!.amount)).toBe(12000);
    // §5.2: the proposal timestamp comes from stage history, not current stage.
    expect(deal!.enteredProposalAt?.toISOString().slice(0, 10)).toBe('2026-01-20');

    const unmappedDeal = await harness.db
      .select()
      .from(t.factDeal)
      .where(eq(t.factDeal.dealId, 'hs-test-deal-3'));
    expect(unmappedDeal[0]!.divisionCode).toBeNull();
  });

  it('re-applies a corrected mapping to deals already landed, without a re-fetch', async () => {
    await saveHubspotMapping(harness.db, cfo, {
      rule: 'deal_property',
      property: 'division',
      values: { 'litigation support': 'LITS', 'emerging services': 'SHRC' },
      isConfirmed: true,
    });

    const result = await reconformLandedHubspot(harness.db, 'deals');
    expect(result.unattributed).toBe(0);

    const [corrected] = await harness.db
      .select()
      .from(t.factDeal)
      .where(eq(t.factDeal.dealId, 'hs-test-deal-3'));
    expect(corrected!.divisionCode).toBe('SHRC');
  });

  it('keeps stage history at its own grain', async () => {
    const history = await harness.db
      .select()
      .from(t.factDealStageHistory)
      .where(eq(t.factDealStageHistory.dealId, 'hs-test-deal-1'));

    expect(history.length).toBe(3);
    expect(history.map((row) => row.stage).sort()).toEqual([
      'closedwon',
      'proposalsent',
      'qualifiedtobuy',
    ]);
  });

  it('never dates a meeting it cannot date', async () => {
    const result = await conformHubspot(harness.db, loadRunId, 'meetings', [
      { payload: { id: 'hs-test-meeting-1', properties: { hs_meeting_start_time: '2026-02-10T15:00:00Z' } } },
      // No start time. Counting this in the current month forever is worse than
      // not counting it at all.
      { payload: { id: 'hs-test-meeting-2', properties: { hs_meeting_outcome: 'COMPLETED' } } },
    ]);

    expect(result.written).toBe(1);
    const rows = await harness.db.select().from(t.factMeeting);
    expect(rows.some((row) => row.meetingId === 'hs-test-meeting-2')).toBe(false);
  });
});
