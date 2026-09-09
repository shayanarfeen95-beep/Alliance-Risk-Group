/**
 * The salesperson leaderboard, on live HubSpot data.
 *
 * The Sales dashboard groups deals by `fact_deal.owner_name`. HubSpot does not
 * put a name on a deal — it puts `hubspot_owner_id` — so without a separate load
 * of the owners endpoint every row groups under "Unassigned" and the leaderboard
 * is a single meaningless line.
 *
 * That is exactly what would have happened: the connector had no owners entity
 * at all, and the conform step looked owner names up from deals already in the
 * warehouse, which on a first live load is nothing. The seeded dataset hid it,
 * because the seed writes owner names directly.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from './helpers/db';
import { seedDatabase } from '@/lib/seed/load';
import { conformBatch } from '@/lib/etl/conform';
import { hubspotConnector } from '@/lib/connectors/hubspot';
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

const OWNERS = [
  { id: '77', firstName: 'Dana', lastName: 'Whitfield', email: 'dana@alliancerisk.com' },
  { id: '81', firstName: '', lastName: '', email: 'rob@alliancerisk.com' },
];

function batch(entity: string, payloads: unknown[], key = (i: number) => String(i)): RawBatch {
  return {
    sourceSystem: 'HUBSPOT',
    entity,
    window: { start: '2026-05-01', end: '2026-05-01' },
    fetchedAt: new Date(),
    records: payloads.map((payload, index) => ({
      entity: entity === 'owners' ? '/crm/v3/owners' : entity,
      key: key(index),
      payload,
    })),
  };
}

/** Lands raw payloads the way a real load does, before conforming. */
async function land(loadRunId: string, b: RawBatch) {
  await harness.db.insert(t.rawPayload).values(
    b.records.map((record) => ({
      loadRunId,
      sourceSystem: b.sourceSystem,
      entity: record.entity,
      payload: record.payload as object,
    })),
  );
}

async function newRun(entity: string) {
  const [run] = await harness.db
    .insert(t.loadRun)
    .values({ sourceSystem: 'HUBSPOT', entity, status: 'RUNNING' })
    .returning();
  return run!.id;
}

describe('HubSpot owners', () => {
  it('is offered as something the connector can actually pull', () => {
    const entities = hubspotConnector.entities().map((entity) => entity.entity);
    expect(entities).toContain('owners');
  });

  it('names the salespeople a deal is assigned to', async () => {
    // A deal arrives first, carrying only an owner id — the realistic order.
    const dealsRun = await newRun('deals');
    const deals = batch('deals', [
      {
        id: '5001',
        properties: {
          dealname: 'Screening programme',
          amount: '31000',
          dealstage: 'closedwon',
          hs_is_closed_won: 'true',
          hs_is_closed: 'true',
          closedate: '2026-05-12T09:00:00Z',
          hubspot_owner_id: '77',
        },
      },
    ]);
    await land(dealsRun, deals);
    await conformBatch(harness.db, dealsRun, deals);

    const [beforeOwners] = await harness.db
      .select()
      .from(t.factDeal)
      .where(eq(t.factDeal.dealId, '5001'));

    // Before the owners load there is genuinely no name to show.
    expect(beforeOwners!.ownerId).toBe('77');
    expect(beforeOwners!.ownerName).toBeNull();

    // Then the owners load runs and attaches the names.
    const ownersRun = await newRun('owners');
    const owners = batch('owners', OWNERS, (i) => OWNERS[i]!.id);
    await land(ownersRun, owners);
    const outcome = await conformBatch(harness.db, ownersRun, owners);

    // Both HubSpot owners are named, alongside any already attributed to deals
    // by an earlier load — the count is the size of the resulting map, not of
    // this batch.
    expect(outcome.rowsWritten).toBeGreaterThanOrEqual(OWNERS.length);
    expect(outcome.notes.join(' ')).toMatch(/salespeople named/);

    const [afterOwners] = await harness.db
      .select()
      .from(t.factDeal)
      .where(eq(t.factDeal.dealId, '5001'));

    expect(afterOwners!.ownerName).toBe('Dana Whitfield');
  });

  it('falls back to the email when HubSpot holds no name', async () => {
    const run = await newRun('deals');
    const deals = batch('deals', [
      { id: '5002', properties: { dealname: 'Field services', amount: '12000', hubspot_owner_id: '81' } },
    ]);
    await land(run, deals);
    await conformBatch(harness.db, run, deals);

    const [deal] = await harness.db.select().from(t.factDeal).where(eq(t.factDeal.dealId, '5002'));
    expect(deal!.ownerName).toBe('rob@alliancerisk.com');
  });

  it('does not blank a name when a later deals-only refresh runs', async () => {
    const run = await newRun('deals');
    const deals = batch('deals', [
      {
        id: '5001',
        properties: { dealname: 'Screening programme', amount: '33000', hubspot_owner_id: '77' },
      },
    ]);
    await land(run, deals);
    await conformBatch(harness.db, run, deals);

    const [deal] = await harness.db.select().from(t.factDeal).where(eq(t.factDeal.dealId, '5001'));
    expect(deal!.ownerName).toBe('Dana Whitfield');
  });
});
