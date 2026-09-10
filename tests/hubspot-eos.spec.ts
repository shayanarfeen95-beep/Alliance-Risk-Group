/**
 * The leadership review panel.
 *
 * ARG runs a monthly "Leadership EOS" review out of HubSpot, and it answers its
 * questions on axes this warehouse could not previously express: how many
 * discovery calls and demos, run by whom, and where new pipeline came from.
 * Rebuilding that panel here is only worth doing if it agrees with the HubSpot
 * report it replaces — a second dashboard that answers the same question
 * differently is not a second opinion, it is an argument.
 *
 * So these assertions are about the definitions, which is where the two could
 * drift. Pipeline added and closed are counted on DIFFERENT dates over DIFFERENT
 * deals; discovery calls and demos are identified from a field HubSpot does not
 * standardise; and a meeting logged without a type has to keep counting in the
 * total. Each of those is a way to be quietly wrong.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, loadSeededUser, type TestDb } from './helpers/db';
import { seedDatabase } from '@/lib/seed/load';
import { conformBatch } from '@/lib/etl/conform';
import { openSemanticSession, CONSOLIDATED_CODE } from '@/lib/semantic/resolve';
import { loadEosPanel } from '@/lib/dashboards/hubspot-eos';
import * as t from '@/lib/db/schema';
import type { RawBatch } from '@/lib/connectors/types';
import type { SessionUser } from '@/lib/auth/session';

let harness: TestDb;
let user: SessionUser;
let runId: string;

/**
 * A month past the end of the seeded history.
 *
 * The seed fills every month through April 2026 with its own deals and
 * meetings, so a fixture placed inside it would be asserting against the sum of
 * two datasets and would break whenever the seed changed. August is empty until
 * this file puts something in it — and reaching it at all depends on HubSpot
 * conform creating the period, which is the behaviour a live portal needs too.
 */
const MONTH = '2026-08-01';

const RANGE = { from: '2026-08-01', to: '2026-08-01', preset: 'this_month' as const, label: 'Aug 2026' };

function batch(entity: string, payloads: unknown[]): RawBatch {
  return {
    sourceSystem: 'HUBSPOT',
    entity,
    window: { start: MONTH, end: MONTH },
    fetchedAt: new Date(),
    records: payloads.map((payload, index) => ({
      entity: entity === 'owners' ? '/crm/v3/owners' : `/crm/v3/objects/${entity}`,
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

  // Owners first, exactly as a real pull orders them. They are landed in
  // raw_payload the way executeLoadRun lands them, because that is where conform
  // reads names from.
  const owners = batch('owners', [
    { id: '1', firstName: 'Jeff', lastName: 'Heminway' },
    { id: '2', firstName: 'Mario', lastName: 'Pecoraro' },
  ]);
  await harness.db.insert(t.rawPayload).values(
    owners.records.map((record) => ({
      loadRunId: runId,
      sourceSystem: 'HUBSPOT' as const,
      entity: record.entity,
      payload: record.payload as object,
    })),
  );
  await conformBatch(harness.db, runId, owners);

  await conformBatch(
    harness.db,
    runId,
    batch('meetings', [
      // Two discovery-shaped types, spelled differently on purpose.
      m('m1', '2026-08-02', 'Call - Intro', '1'),
      m('m2', '2026-08-03', 'Discovery Call', '1'),
      m('m3', '2026-08-04', 'Meeting - Demo', '2'),
      m('m4', '2026-08-05', 'Meeting - Compliance Review', '2'),
      // Logged without a type. Must still count in the total.
      m('m5', '2026-08-06', null, '1'),
      // Outside the range entirely.
      m('m6', '2026-07-02', 'Meeting - Demo', '1'),
    ]),
  );

  await conformBatch(
    harness.db,
    runId,
    batch('deals', [
      // Created in range, still open — pipeline added, not closed.
      d('d1', { created: '2026-08-02', amount: '100000', source: 'Employee Referral', owner: '1' }),
      // Created in range AND won in range — counts in both, on purpose.
      d('d2', {
        created: '2026-08-03',
        closed: '2026-08-20',
        amount: '250000',
        won: true,
        source: 'Trade Show/Conference',
        owner: '2',
      }),
      // Won in range but created BEFORE it — closed only.
      d('d3', {
        created: '2026-06-01',
        closed: '2026-08-25',
        amount: '400000',
        won: true,
        source: 'Employee Referral',
        owner: '1',
      }),
      // Created in range with no source recorded.
      d('d4', { created: '2026-08-10', amount: '50000', owner: '2' }),
      // Closed LOST in range — in neither figure.
      d('d5', { created: '2026-08-11', closed: '2026-08-28', amount: '900000', owner: '1', lost: true }),
    ]),
  );
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

function m(id: string, day: string, type: string | null, owner: string) {
  return {
    id,
    properties: {
      hs_meeting_start_time: `${day}T15:00:00Z`,
      hs_activity_type: type,
      hubspot_owner_id: owner,
    },
  };
}

function d(
  id: string,
  o: {
    created: string;
    closed?: string;
    amount: string;
    won?: boolean;
    lost?: boolean;
    source?: string;
    owner: string;
  },
) {
  return {
    id,
    properties: {
      dealname: `Deal ${id}`,
      amount: o.amount,
      dealstage: o.won ? 'closedwon' : o.lost ? 'closedlost' : 'qualifiedtobuy',
      pipeline: 'default',
      hs_is_closed_won: o.won ? 'true' : 'false',
      hs_is_closed: o.won || o.lost ? 'true' : 'false',
      createdate: `${o.created}T09:00:00Z`,
      ...(o.closed ? { closedate: `${o.closed}T09:00:00Z` } : {}),
      hubspot_owner_id: o.owner,
      ...(o.source ? { zoho_lead_source: o.source } : {}),
    },
  };
}

async function panel() {
  const session = await openSemanticSession(harness.db, user, MONTH);
  return loadEosPanel(session, CONSOLIDATED_CODE, {
    range: RANGE,
    ownerName: null,
    pipeline: null,
  });
}

describe('the leadership review panel', () => {
  it('counts every meeting in the range, typed or not', async () => {
    const eos = await panel();

    // Five in August; the July one is out of range. The untyped meeting is in
    // the total — dropping it would understate activity, and folding it into a
    // named type would overstate that type.
    expect(eos.meetingsTotal).toBe(5);
    expect(eos.meetingsByType.find((row) => row.key === 'Not recorded')?.count).toBe(1);
    expect(eos.meetingsByType.reduce((sum, row) => sum + row.count, 0)).toBe(5);
  });

  it('identifies discovery calls and demos across portal-specific spellings', async () => {
    const eos = await panel();

    // "Call - Intro" and "Discovery Call" are the same thing to leadership and
    // are spelled differently in every portal, so matching is on the words.
    expect(eos.discoveryCalls.total).toBe(2);
    expect(eos.demos.total).toBe(1);

    // And the rule is carried to the UI rather than left implicit.
    expect(eos.classification.discovery).toMatch(/discovery/i);
  });

  it('splits activity by the rep who ran it', async () => {
    const eos = await panel();

    expect(eos.discoveryCalls.byRep).toEqual([{ rep: 'Jeff Heminway', count: 2 }]);
    expect(eos.demos.byRep).toEqual([{ rep: 'Mario Pecoraro', count: 1 }]);
  });

  it('counts pipeline added on the create date and closed on the close date', async () => {
    const eos = await panel();

    // Added: d1 100k + d2 250k + d4 50k + d5 900k = 1,300,000. d3 was created
    // in February, so it is not new pipeline however it closed.
    expect(eos.pipelineAdded.total).toBe(1_300_000);
    expect(eos.pipelineAdded.deals).toBe(4);

    // Closed: d2 250k + d3 400k. d5 closed LOST and is in neither figure —
    // counting it would turn a loss into revenue.
    expect(eos.closed.total).toBe(650_000);
    expect(eos.closed.deals).toBe(2);

    // The two overlap by design (d2 is in both) and so must never be subtracted.
    // This assertion exists to make that overlap deliberate rather than a bug
    // somebody later "fixes".
    expect(eos.pipelineAdded.total - eos.closed.total).not.toBe(0);
  });

  it('attributes pipeline to the deal source, and shows what has none', async () => {
    const eos = await panel();
    const bySource = Object.fromEntries(
      eos.pipelineAdded.bySource.map((row) => [row.source, row.amount]),
    );

    expect(bySource['Employee Referral']).toBe(100_000);
    expect(bySource['Trade Show/Conference']).toBe(250_000);
    // d5 has no source either, so unattributed pipeline is 50k + 900k.
    expect(bySource['Not recorded']).toBe(950_000);

    // Shares are of pipeline added, and they account for all of it.
    const share = eos.pipelineAdded.bySource.reduce((sum, row) => sum + row.sharePct, 0);
    expect(share).toBeCloseTo(100, 6);
  });

  it('says when a field is absent rather than reporting zero', async () => {
    const eos = await panel();

    // Types and sources both exist in this fixture, so neither flag is set.
    // The flags are what stop "0 demos" being shown for a portal that simply
    // does not fill the field in — a different fact entirely.
    expect(eos.typesUnavailable).toBe(false);
    expect(eos.sourcesUnavailable).toBe(false);
  });

  it('narrows every panel when a rep is selected', async () => {
    const session = await openSemanticSession(harness.db, user, MONTH);
    const eos = loadEosPanel(session, CONSOLIDATED_CODE, {
      range: RANGE,
      ownerName: 'Mario Pecoraro',
      pipeline: null,
    });

    // A filter that applies to some panels and not others is worse than none.
    expect(eos.demos.total).toBe(1);
    expect(eos.discoveryCalls.total).toBe(0);
    expect(eos.pipelineAdded.total).toBe(300_000);
    expect(eos.closed.total).toBe(250_000);
  });
});
