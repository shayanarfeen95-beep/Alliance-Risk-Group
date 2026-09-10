/**
 * Pulling a source that is bigger than one request.
 *
 * The Pull button used to fetch every entity of every connected source inside a
 * single HTTP call. On a real HubSpot portal that is hundreds of paginated round
 * trips, and it ended the only way it could: the platform killed the function at
 * its timeout, the browser got a gateway error instead of JSON, and the panel
 * said "The request did not complete." Nothing was written and nothing said what
 * had happened.
 *
 * The fix is that a load run may now stop on a budget and resume from a cursor.
 * That makes correctness of resumption load-bearing, so these are the assertions
 * that matter: a sliced pull writes every record exactly once, keeps ONE
 * load_run for the entity however many slices it took, and does not report
 * success until the source says there is no more. A resumed run that skipped a
 * page or double-counted one would produce figures that are wrong and confident,
 * which is the failure mode this whole codebase is built to refuse.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, loadSeededUser, type TestDb } from './helpers/db';
import { seedDatabase } from '@/lib/seed/load';
import * as t from '@/lib/db/schema';
import { budgetSpent } from '@/lib/connectors/types';
import type { FetchOptions, FetchWindow, RawBatch, SourceConnector } from '@/lib/connectors/types';
import type { SessionUser } from '@/lib/auth/session';

/**
 * A source that hands back three pages and only admits to being finished on the
 * third — the shape every paginated connector has, without the network.
 */
const PAGES = [
  [{ id: 'c1' }, { id: 'c2' }],
  [{ id: 'c3' }, { id: 'c4' }],
  [{ id: 'c5' }],
];

let fetchCalls: Array<string | null | undefined> = [];

const pagedConnector: SourceConnector = {
  sourceSystem: 'HUBSPOT',
  label: 'HubSpot',
  entities: () => [
    { entity: 'contacts', label: 'Contacts', cadence: 'DAILY', description: 'Paged.' },
  ],
  isConfigured: async () => true,
  async fetch(entity: string, window: FetchWindow, options?: FetchOptions): Promise<RawBatch> {
    fetchCalls.push(options?.cursor);

    // The same loop every real connector runs: keep taking pages until either
    // the source runs out or the budget does, then hand back where to resume.
    const records: RawBatch['records'] = [];
    let index = options?.cursor ? Number(options.cursor) : 0;
    let nextCursor: string | null = null;

    for (;;) {
      for (const payload of PAGES[index] ?? []) {
        records.push({
          entity: '/crm/v3/objects/contacts',
          key: payload.id,
          payload: { id: payload.id, properties: {} },
        });
      }

      index += 1;
      if (index >= PAGES.length) break;
      if (budgetSpent(options, records.length)) {
        nextCursor = String(index);
        break;
      }
    }

    return {
      sourceSystem: 'HUBSPOT',
      entity,
      window,
      fetchedAt: new Date(),
      records,
      nextCursor,
    };
  },
};

vi.mock('@/lib/connectors', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/connectors')>();
  return {
    ...original,
    CONNECTORS: [pagedConnector],
    getConnector: () => pagedConnector,
  };
});

let harness: TestDb;
let user: SessionUser;

beforeAll(async () => {
  harness = await createTestDb();
  await seedDatabase(harness.db);
  user = await loadSeededUser(harness.db, 'cfo@westportfinancial.com');
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

const WINDOW = { windowStart: '2026-05-01', windowEnd: '2026-05-01' };

describe('a pull that does not fit in one request', () => {
  it('lands every page exactly once across slices, under one load run', async () => {
    const { runSlice } = await import('@/lib/etl/ingest');
    fetchCalls = [];

    // A deadline already in the past forces the fetcher to stop after the page
    // it is holding — the same thing a slow portal does to a real slice.
    const expired = { deadline: Date.now() - 1 };

    let outcome = await runSlice(
      harness.db,
      user,
      { source: 'HUBSPOT', entity: 'contacts', ...WINDOW },
      expired,
    );

    expect(outcome.ok).toBe(true);
    // Unfinished is not failed. The records this slice read are already written.
    expect(outcome.done).toBe(false);

    const loadRunId = outcome.loadRunId;
    let guard = 0;
    while (!outcome.done && guard++ < 10) {
      outcome = await runSlice(
        harness.db,
        user,
        { source: 'HUBSPOT', entity: 'contacts', ...WINDOW, loadRunId },
        expired,
      );
      // Resumption must stay on the same run, or provenance fragments by
      // network conditions rather than by what was pulled.
      expect(outcome.loadRunId).toBe(loadRunId);
    }

    expect(outcome.done).toBe(true);
    expect(outcome.slices).toBe(PAGES.length);

    // Each slice resumed from the cursor the previous one handed back — no page
    // fetched twice, none skipped.
    expect(fetchCalls).toEqual([null, '1', '2']);

    // Every record reached the warehouse, exactly once.
    //
    // Asserted on the fact table rather than on raw_payload: bulk entities no
    // longer keep a copy of every record, because nothing ever read it back and
    // storing sixty thousand contacts twice per pull is what filled the
    // database. The conformed row is the evidence that matters anyway — it is
    // what the dashboards read.
    const total = PAGES.reduce((sum, page) => sum + page.length, 0);
    const conformed = await harness.db
      .select()
      .from(t.factContact)
      .where(eq(t.factContact.loadRunId, loadRunId));

    expect(conformed).toHaveLength(total);
    expect(new Set(conformed.map((row) => row.contactId)).size).toBe(total);
  });

  it('does not store a copy of every record it pulls', async () => {
    const { runSlice } = await import('@/lib/etl/ingest');
    fetchCalls = [];

    const outcome = await runSlice(harness.db, user, {
      source: 'HUBSPOT',
      entity: 'contacts',
      ...WINDOW,
    });

    const landed = await harness.db
      .select()
      .from(t.rawPayload)
      .where(eq(t.rawPayload.loadRunId, outcome.loadRunId));

    // raw_payload is written for exactly one entity — owners, which conform
    // reads back to put a salesperson's name on a deal. Contacts had no reader
    // at all, so every stored payload was pure cost, paid again on every pull.
    expect(landed).toHaveLength(0);
  });

  it('keeps the run RUNNING until the source says it is finished', async () => {
    const { runSlice, resumeLoadRun } = await import('@/lib/etl/ingest');
    fetchCalls = [];

    const first = await runSlice(
      harness.db,
      user,
      { source: 'HUBSPOT', entity: 'contacts', ...WINDOW },
      { deadline: Date.now() - 1 },
    );

    const [midRun] = await harness.db
      .select()
      .from(t.loadRun)
      .where(eq(t.loadRun.id, first.loadRunId))
      .limit(1);

    // A run reported as SUCCEEDED while a cursor is still outstanding is how a
    // half-loaded month would come to be read as complete.
    expect(midRun!.status).toBe('RUNNING');
    expect(midRun!.finishedAt).toBeNull();

    // No deadline: the connector runs to the end of its data in one slice.
    const last = await resumeLoadRun(harness.db, user, first.loadRunId);
    expect(last.done).toBe(true);

    const [finished] = await harness.db
      .select()
      .from(t.loadRun)
      .where(eq(t.loadRun.id, first.loadRunId))
      .limit(1);

    expect(finished!.status).toBe('SUCCEEDED');
    expect(finished!.finishedAt).not.toBeNull();
    // Row counts accumulate across slices rather than being overwritten by the
    // last one, which would report five contacts as one.
    expect(finished!.rowsRead).toBe(PAGES.reduce((sum, page) => sum + page.length, 0));

    // One entity pulled, one audit row — written by the finishing slice only.
    const audits = await harness.db
      .select()
      .from(t.auditEvent)
      .where(eq(t.auditEvent.entityId, first.loadRunId));
    expect(audits).toHaveLength(1);
  });

  it('refuses to resume a run that already finished', async () => {
    const { runSlice, resumeLoadRun } = await import('@/lib/etl/ingest');
    fetchCalls = [];

    const outcome = await runSlice(harness.db, user, {
      source: 'HUBSPOT',
      entity: 'contacts',
      ...WINDOW,
    });
    expect(outcome.done).toBe(true);

    // Resuming a SUCCEEDED run would re-land records the warehouse already holds
    // under a run that has been reported complete.
    await expect(resumeLoadRun(harness.db, user, outcome.loadRunId)).rejects.toThrow(/succeeded/i);
  });

  it('stops on the record cap even when there is time left', async () => {
    const { runSlice } = await import('@/lib/etl/ingest');
    fetchCalls = [];

    // Time is not the only bound that matters. Fetching is fast and conforming
    // is not, so a slice that spent its whole time budget fetching would hand
    // the write step more than the rest of the invocation can absorb — and be
    // killed after the network calls rather than before them.
    const outcome = await runSlice(
      harness.db,
      user,
      { source: 'HUBSPOT', entity: 'contacts', ...WINDOW },
      { deadline: Date.now() + 60_000, maxRecords: 2 },
    );

    expect(outcome.done).toBe(false);
    expect(outcome.recordsRead).toBe(2);
  });

  it('plans one step per entity of every connected source', async () => {
    const { syncPlan } = await import('@/lib/etl/ingest');
    const steps = await syncPlan();

    expect(steps).toEqual([
      { source: 'HUBSPOT', sourceLabel: 'HubSpot', entity: 'contacts', label: 'Contacts' },
    ]);

    // A source that is not asked for is not planned, so a per-source button
    // pulls only that source.
    expect(await syncPlan(['QBO'])).toEqual([]);
  });
});
