/**
 * Telling the three empty dashboards apart.
 *
 * "Nothing on the dashboard works" was never one fault. It was three, and no
 * screen in the application could distinguish them:
 *
 *   nothing was fetched         — the source is not connected, or was never pulled
 *   it was fetched and refused  — a class maps to no division, so the month was rejected
 *   it loaded into other months — the figures exist, on a month the view is not on
 *
 * All three render as a blank panel, and the operator is left guessing which.
 * Guessing wrong costs an afternoon: re-pulling data that is already there, or
 * hunting a connection that is fine. So what is asserted here is that each state
 * is reported as itself.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db';
import { seedDatabase } from '@/lib/seed/load';
import { loadDataHealth } from '@/lib/etl/health';
import { reclaimRawPayloads } from '@/lib/etl/ingest';
import * as t from '@/lib/db/schema';

let harness: TestDb;
let runId: string;

beforeAll(async () => {
  harness = await createTestDb();
  await seedDatabase(harness.db);
  const [run] = await harness.db.select({ id: t.loadRun.id }).from(t.loadRun).limit(1);
  runId = run!.id;
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

describe('data health', () => {
  it('reports an unconnected source as unconnected, not as empty', async () => {
    const health = await loadDataHealth(harness.db);

    // Nothing is signed in on a fresh warehouse. "Not connected" and "connected
    // but empty" are different problems with different fixes, and reporting the
    // second when it is the first sends somebody re-pulling for no reason.
    expect(health.entities.length).toBeGreaterThan(0);
    expect(health.entities.every((entity) => entity.state === 'NOT_CONNECTED')).toBe(true);
    expect(health.entities[0]!.detail).toMatch(/not signed in/i);
  });

  it('names the classes that are blocking a load', async () => {
    await harness.db.insert(t.dimClassMap).values({
      classKey: 'z alloc',
      className: 'Z Alloc',
      decision: 'UNMAPPED',
    });

    const health = await loadDataHealth(harness.db);
    expect(health.unmappedClasses).toContain('Z Alloc');
  });

  it('reports which months carry figures, so an empty view can be explained', async () => {
    const health = await loadDataHealth(harness.db);

    // The seed fills months; a dashboard sitting on a month outside this list is
    // the third failure mode, and this is what makes it visible.
    expect(health.monthsWithData.length).toBeGreaterThan(0);
  });

  it('counts stored payloads so growth is visible rather than discovered', async () => {
    const before = await loadDataHealth(harness.db);

    await harness.db.insert(t.rawPayload).values([
      { loadRunId: runId, sourceSystem: 'HUBSPOT', entity: '/crm/v3/objects/contacts', payload: { id: '1' } },
      { loadRunId: runId, sourceSystem: 'HUBSPOT', entity: '/crm/v3/owners', payload: { id: '2' } },
    ]);

    const after = await loadDataHealth(harness.db);
    expect(after.storedPayloads).toBe(before.storedPayloads + 2);
  });

  it('reclaims payloads nothing reads, and keeps the ones something does', async () => {
    const { deleted } = await reclaimRawPayloads(harness.db);
    expect(deleted).toBeGreaterThan(0);

    const remaining = await harness.db.select().from(t.rawPayload);

    // Owners survive because conform's owner-name lookup genuinely reads them.
    // Everything else was stored and never read again — which is what filled the
    // database when a large import ran twice.
    expect(remaining.every((row) => row.entity.includes('owners'))).toBe(true);
    expect(remaining.length).toBeGreaterThan(0);
  });
});
