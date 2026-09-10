/**
 * Pulling only what changed.
 *
 * Every pull previously re-read every record a source had ever held. Nothing was
 * duplicated — conform upserts by id — but sixty-four thousand contacts were
 * walked to find the hundred that had moved, and a refresh took long enough that
 * people stopped running it. A sync too slow to run is a sync that does not
 * happen.
 *
 * The rule that makes this safe is narrow and easy to get wrong in the direction
 * nobody notices: the watermark advances ONLY when an entity finishes. Advancing
 * it per slice is faster and loses records permanently the first time a slice
 * fails — the run stops, the watermark has already moved past records that were
 * never conformed, and the next pull asks for changes after them. The figures
 * would be quietly wrong forever, with nothing anywhere saying so.
 *
 * So these tests are mostly about the failure paths.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDb, loadSeededUser, type TestDb } from './helpers/db';
import { seedDatabase } from '@/lib/seed/load';
import * as t from '@/lib/db/schema';
import { budgetSpent } from '@/lib/connectors/types';
import type { FetchOptions, FetchWindow, RawBatch, SourceConnector } from '@/lib/connectors/types';
import type { SessionUser } from '@/lib/auth/session';

/** Records the source holds, each with the moment it last changed. */
const SOURCE = [
  { id: 'a', modified: '2026-08-01T00:00:00Z' },
  { id: 'b', modified: '2026-08-02T00:00:00Z' },
  { id: 'c', modified: '2026-08-03T00:00:00Z' },
];

let asked: Array<Date | null | undefined> = [];
let failNextConform = false;

const connector: SourceConnector = {
  sourceSystem: 'HUBSPOT',
  label: 'HubSpot',
  entities: () => [
    { entity: 'contacts', label: 'Contacts', cadence: 'DAILY', description: 'Incremental.' },
  ],
  isConfigured: async () => true,
  async fetch(entity: string, window: FetchWindow, options?: FetchOptions): Promise<RawBatch> {
    asked.push(options?.since);

    // Only what changed after the watermark — the source does the filtering,
    // which is the whole point.
    const since = options?.since?.getTime() ?? 0;
    const changed = SOURCE.filter((row) => new Date(row.modified).getTime() > since);

    const cursorAt = options?.cursor ? Number(options.cursor) : 0;
    const slice = changed.slice(cursorAt);
    const taken: typeof slice = [];

    for (const row of slice) {
      taken.push(row);
      if (budgetSpent(options, taken.length)) break;
    }

    const consumed = cursorAt + taken.length;
    const watermark = taken.length
      ? new Date(taken[taken.length - 1]!.modified)
      : null;

    return {
      sourceSystem: 'HUBSPOT',
      entity,
      window,
      fetchedAt: new Date(),
      records: taken.map((row) => ({
        entity: '/crm/v3/objects/contacts',
        key: row.id,
        payload: { id: row.id, properties: {} },
      })),
      nextCursor: consumed < changed.length ? String(consumed) : null,
      watermark,
    };
  },
};

vi.mock('@/lib/connectors', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/connectors')>();
  return { ...original, CONNECTORS: [connector], getConnector: () => connector };
});

vi.mock('@/lib/etl/conform', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/etl/conform')>();
  return {
    ...original,
    conformBatch: async (...args: Parameters<typeof original.conformBatch>) => {
      if (failNextConform) {
        failNextConform = false;
        throw new Error('conform failed partway');
      }
      return original.conformBatch(...args);
    },
  };
});

let harness: TestDb;
let user: SessionUser;

const WINDOW = { windowStart: '2026-08-01', windowEnd: '2026-08-01' };

beforeAll(async () => {
  harness = await createTestDb();
  await seedDatabase(harness.db);
  user = await loadSeededUser(harness.db, 'cfo@westportfinancial.com');
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  asked = [];
  failNextConform = false;
  await harness.db.delete(t.syncState);

  // Runs are resumable ACROSS runs now, so an unfinished one left by the
  // previous test would be picked up by the next. They cannot be deleted —
  // conformed rows reference them, which is the point of provenance — so they
  // are closed instead, which is also what a finished run looks like.
  await harness.db
    .update(t.loadRun)
    .set({ status: 'SUCCEEDED', plan: { startedFrom: 'test-reset' } })
    .where(eq(t.loadRun.entity, 'contacts'));
});

async function watermark(): Promise<Date | null> {
  const [row] = await harness.db
    .select()
    .from(t.syncState)
    .where(and(eq(t.syncState.sourceSystem, 'HUBSPOT'), eq(t.syncState.entity, 'contacts')))
    .limit(1);
  return row?.watermark ?? null;
}

describe('incremental sync', () => {
  it('reads everything the first time, then only what changed', async () => {
    const { runSlice } = await import('@/lib/etl/ingest');

    const first = await runSlice(harness.db, user, {
      source: 'HUBSPOT',
      entity: 'contacts',
      ...WINDOW,
    });
    expect(first.done).toBe(true);
    expect(first.recordsRead).toBe(3);
    // Nothing was known, so nothing was asked for.
    expect(asked[0]).toBeNull();

    const second = await runSlice(harness.db, user, {
      source: 'HUBSPOT',
      entity: 'contacts',
      ...WINDOW,
    });

    // The second pass asks the source for changes after the newest record it
    // has already conformed, and gets nothing back because nothing moved.
    expect(asked[1]).toEqual(new Date('2026-08-03T00:00:00Z'));
    expect(second.recordsRead).toBe(0);
    expect(second.done).toBe(true);
  });

  it('advances the watermark to the newest record it conformed', async () => {
    const { runSlice } = await import('@/lib/etl/ingest');

    await runSlice(harness.db, user, { source: 'HUBSPOT', entity: 'contacts', ...WINDOW });
    expect(await watermark()).toEqual(new Date('2026-08-03T00:00:00Z'));
  });

  it('does NOT advance it while an entity is still unfinished', async () => {
    const { runSlice } = await import('@/lib/etl/ingest');

    const partial = await runSlice(
      harness.db,
      user,
      { source: 'HUBSPOT', entity: 'contacts', ...WINDOW },
      { maxRecords: 1 },
    );

    expect(partial.done).toBe(false);
    expect(partial.recordsRead).toBe(1);

    // This is the assertion that matters. Moving the watermark here would put
    // it past records this pass never reached, and the next pull would ask for
    // changes after them — losing b and c permanently, silently.
    expect(await watermark()).toBeNull();
  });

  it('carries the newest timestamp across slices and commits it at the end', async () => {
    const { runSlice } = await import('@/lib/etl/ingest');

    let outcome = await runSlice(
      harness.db,
      user,
      { source: 'HUBSPOT', entity: 'contacts', ...WINDOW },
      { maxRecords: 1 },
    );
    let guard = 0;
    while (!outcome.done && guard++ < 10) {
      outcome = await runSlice(
        harness.db,
        user,
        { source: 'HUBSPOT', entity: 'contacts', ...WINDOW, loadRunId: outcome.loadRunId },
        { maxRecords: 1 },
      );
    }

    expect(outcome.done).toBe(true);
    // The finishing slice saw only 'c', but the run as a whole saw all three —
    // and the watermark has to describe the run, not the last page of it.
    expect(await watermark()).toEqual(new Date('2026-08-03T00:00:00Z'));
  });

  it('leaves the watermark alone when a run fails', async () => {
    const { runSlice } = await import('@/lib/etl/ingest');
    failNextConform = true;

    const outcome = await runSlice(harness.db, user, {
      source: 'HUBSPOT',
      entity: 'contacts',
      ...WINDOW,
    });

    expect(outcome.ok).toBe(false);
    // A failed pull must be safe to simply run again.
    expect(await watermark()).toBeNull();
  });

  it('continues an interrupted entity instead of starting it again', async () => {
    const { runSlice } = await import('@/lib/etl/ingest');

    // A pull that stops partway — the tab closed, the connection went. The run
    // is left RUNNING with a cursor and no watermark.
    const partial = await runSlice(
      harness.db,
      user,
      { source: 'HUBSPOT', entity: 'contacts', ...WINDOW },
      { maxRecords: 1 },
    );
    expect(partial.done).toBe(false);
    expect(await watermark()).toBeNull();

    // Now somebody presses Pull again. WITHOUT passing a run id — which is what
    // the button does, and what used to throw the position away and restart at
    // record one. For an entity of sixty thousand contacts that meant it could
    // never finish, and so could never become incremental.
    const resumed = await runSlice(
      harness.db,
      user,
      { source: 'HUBSPOT', entity: 'contacts', ...WINDOW },
      { maxRecords: 1 },
    );

    expect(resumed.loadRunId).toBe(partial.loadRunId);
    expect(resumed.slices).toBe(2);
    expect(resumed.notes.join(' ')).toMatch(/continued from where the last pull stopped/i);
  });

  it('carries the position out of a run that failed partway', async () => {
    const { runSlice } = await import('@/lib/etl/ingest');

    const partial = await runSlice(
      harness.db,
      user,
      { source: 'HUBSPOT', entity: 'contacts', ...WINDOW },
      { maxRecords: 1 },
    );
    expect(partial.done).toBe(false);

    // The next slice dies. Its run is closed as FAILED — but everything before
    // the cursor was landed and conformed, so the position is still good.
    failNextConform = true;
    const failed = await runSlice(
      harness.db,
      user,
      { source: 'HUBSPOT', entity: 'contacts', ...WINDOW, loadRunId: partial.loadRunId },
      { maxRecords: 1 },
    );
    expect(failed.ok).toBe(false);

    // A fresh pull picks the position up rather than paying for it twice.
    const next = await runSlice(harness.db, user, {
      source: 'HUBSPOT',
      entity: 'contacts',
      ...WINDOW,
    });

    expect(next.loadRunId).not.toBe(partial.loadRunId);
    expect(next.notes.join(' ')).toMatch(/continued from where the last pull stopped/i);
    // It finished the remaining two rather than re-reading all three.
    expect(next.recordsRead).toBe(2);
    expect(next.done).toBe(true);
    expect(await watermark()).toEqual(new Date('2026-08-03T00:00:00Z'));
  });

  it('re-reads everything when asked for a full refresh', async () => {
    const { runSlice, resetWatermarks } = await import('@/lib/etl/ingest');

    await runSlice(harness.db, user, { source: 'HUBSPOT', entity: 'contacts', ...WINDOW });
    expect(await watermark()).not.toBeNull();

    await resetWatermarks(harness.db, ['HUBSPOT']);
    expect(await watermark()).toBeNull();

    asked = [];
    const again = await runSlice(harness.db, user, {
      source: 'HUBSPOT',
      entity: 'contacts',
      ...WINDOW,
    });

    expect(asked[0]).toBeNull();
    expect(again.recordsRead).toBe(3);
  });
});
