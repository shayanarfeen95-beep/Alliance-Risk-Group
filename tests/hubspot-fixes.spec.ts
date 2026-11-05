/**
 * Three HubSpot figures that read wrong on live data.
 *
 *   1. New Proposals Sent was 0 for every month from April 2026. It counted
 *      only the stage id `proposalsent` — HubSpot's default, and the seed's —
 *      while ARG's pipelines carry their own stage ids. The Proposal stage is
 *      now recognised by its name, as the deal import and the Leadership view
 *      already do.
 *   2. Deals owned by people who have left showed as "Unassigned". HubSpot's
 *      owners endpoint returns only active users unless asked for archived ones.
 *   3. The stored owner list was deleted by the 30-day storage sweep, so deals
 *      imported afterwards had no owner name either.
 *
 * And one message: Average Close Time said "no deals were won" when deals had
 * been won but none carried a create date.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, loadSeededUser, type TestDb } from './helpers/db';
import { seedDatabase } from '@/lib/seed/load';
import { openSemanticSession, resolveKpi, CONSOLIDATED_CODE } from '@/lib/semantic/resolve';
import * as t from '@/lib/db/schema';
import type { SessionUser } from '@/lib/auth/session';

// --- The owners request, answered by a fake HubSpot -------------------------

const requests: Array<Record<string, string>> = [];

vi.mock('@/lib/connectors/credentials', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/connectors/credentials')>()),
  isConnected: async () => true,
  loadCredential: async () => ({ authMethod: 'COMPOSIO', data: { connectedAccountId: 'ca_test' } }),
}));

vi.mock('@/lib/connectors/composio', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/connectors/composio')>()),
  proxy: async ({ query }: { query: Record<string, string> }) => {
    requests.push(query);
    return query.archived === 'true'
      ? { results: [{ id: '90', firstName: 'Former', lastName: 'Employee', archived: true }] }
      : { results: [{ id: '77', firstName: 'Dana', lastName: 'Whitfield' }] };
  },
}));

const { hubspotConnector } = await import('@/lib/connectors/hubspot');
const { sweepRawPayloads } = await import('@/lib/etl/ingest');

// --- The warehouse ----------------------------------------------------------

/** After the seeded history, so these are the only deals in the month. */
const MONTH = '2026-08-01';

let harness: TestDb;
let cfo: SessionUser;

beforeAll(async () => {
  harness = await createTestDb();
  await seedDatabase(harness.db);
  cfo = await loadSeededUser(harness.db, 'cfo@westportfinancial.com');

  // ARG's pipeline: stage ids that say nothing, names that say everything.
  await harness.db.insert(t.dimDealStage).values([
    { stageId: '1103388412', label: 'Discovery', pipelineId: 'p1', pipelineLabel: 'Sales', displayOrder: 1, isClosed: false, isWon: false },
    { stageId: '1103388413', label: 'Proposal Sent', pipelineId: 'p1', pipelineLabel: 'Sales', displayOrder: 2, isClosed: false, isWon: false },
    { stageId: 'presentationscheduled', label: 'Quote Delivered', pipelineId: 'p2', pipelineLabel: 'Renewals', displayOrder: 2, isClosed: false, isWon: false },
  ]);

  const deal = (dealId: string, extra: Partial<typeof t.factDeal.$inferInsert> = {}) => ({
    dealId,
    dealName: dealId,
    amount: '1000',
    isClosedWon: false,
    isClosed: false,
    createdate: new Date('2026-07-01T00:00:00Z'),
    ...extra,
  });
  await harness.db.insert(t.factDeal).values([
    deal('d-proposal'),
    deal('d-quote'),
    deal('d-twice'),
    deal('d-discovery'),
    // Won in August with no create date in HubSpot.
    deal('d-won-undated', {
      isClosedWon: true,
      isClosed: true,
      createdate: null,
      closedate: new Date('2026-08-20T00:00:00Z'),
    }),
  ]);
  const at = (day: string) => new Date(`2026-08-${day}T12:00:00Z`);
  await harness.db.insert(t.factDealStageHistory).values([
    { dealId: 'd-proposal', stage: '1103388413', enteredAt: at('05') },
    { dealId: 'd-quote', stage: 'presentationscheduled', enteredAt: at('09') },
    // Entered Proposal, went back, entered it again: still one proposal.
    { dealId: 'd-twice', stage: '1103388413', enteredAt: at('10') },
    { dealId: 'd-twice', stage: '1103388412', enteredAt: at('12') },
    { dealId: 'd-twice', stage: '1103388413', enteredAt: at('15') },
    { dealId: 'd-discovery', stage: '1103388412', enteredAt: at('03') },
  ]);
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(() => {
  requests.length = 0;
});

describe('New Proposals Sent', () => {
  it('counts deals entering any stage named as a proposal, whatever its id', async () => {
    const session = await openSemanticSession(harness.db, cfo, MONTH);
    const result = resolveKpi(session, 'new_proposals_sent', CONSOLIDATED_CODE);
    // d-proposal, d-quote and d-twice — not the Discovery-only deal.
    expect(result.value?.toNumber()).toBe(3);
  });

  it('counts a deal that re-entered Proposal once', async () => {
    const session = await openSemanticSession(harness.db, cfo, MONTH);
    const entries = session.bundle.proposalEntries.filter((entry) => entry.dealId === 'd-twice');
    expect(entries).toHaveLength(2);
    expect(resolveKpi(session, 'new_proposals_sent', CONSOLIDATED_CODE).value?.toNumber()).toBe(3);
  });

  it('still counts HubSpot’s default proposal stage, as the seeded history uses', async () => {
    // Seeded March deals enter `proposalsent`; the count must not fall to zero.
    const session = await openSemanticSession(harness.db, cfo, '2026-03-01');
    expect(resolveKpi(session, 'new_proposals_sent', CONSOLIDATED_CODE).value?.toNumber()).toBeGreaterThan(0);
  });
});

describe('Average Close Time', () => {
  it('says deals were won but none has a create date, rather than that none were won', async () => {
    const session = await openSemanticSession(harness.db, cfo, MONTH);
    const result = resolveKpi(session, 'average_close_time', CONSOLIDATED_CODE);
    expect(result.value).toBeNull();
    expect(result.unavailable?.detail).toMatch(/1 deal was won in this period, but none has a create date/);
  });
});

describe('HubSpot owners', () => {
  it('reads archived owners as well as active ones', async () => {
    const batch = await hubspotConnector.fetch('owners', { start: MONTH, end: MONTH });
    expect(batch.records.map((record) => record.key).sort()).toEqual(['77', '90']);
    expect(requests.map((query) => query.archived)).toEqual(['false', 'true']);
    expect(batch.nextCursor).toBeNull();
  });
});

describe('the storage sweep', () => {
  it('keeps the latest owner list however old it is, and removes older copies', async () => {
    const run = async () =>
      (
        await harness.db
          .insert(t.loadRun)
          .values({ sourceSystem: 'HUBSPOT', entity: 'owners', status: 'SUCCEEDED' })
          .returning()
      )[0]!.id;
    const older = await run();
    const latest = await run();
    const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);

    await harness.db.insert(t.rawPayload).values([
      { loadRunId: older, sourceSystem: 'HUBSPOT', entity: '/crm/v3/owners', payload: { id: '77' }, fetchedAt: daysAgo(90) },
      { loadRunId: latest, sourceSystem: 'HUBSPOT', entity: '/crm/v3/owners', payload: { id: '77' }, fetchedAt: daysAgo(45) },
      { loadRunId: latest, sourceSystem: 'HUBSPOT', entity: '/crm/v3/owners', payload: { id: '90' }, fetchedAt: daysAgo(45) },
    ]);

    await sweepRawPayloads(harness.db);

    const left = await harness.db
      .select({ loadRunId: t.rawPayload.loadRunId })
      .from(t.rawPayload)
      .where(eq(t.rawPayload.entity, '/crm/v3/owners'));
    expect(left).toHaveLength(2);
    expect(left.every((row) => row.loadRunId === latest)).toBe(true);
  });
});
