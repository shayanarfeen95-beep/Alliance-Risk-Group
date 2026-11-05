/**
 * The whole path, through a real load run: a second pull of an unchanged tab
 * imports nothing and says so; an edit is imported; "Re-import everything"
 * imports regardless.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, loadSeededUser, type TestDb } from './helpers/db';
import { seedDatabase } from '@/lib/seed/load';
import * as t from '@/lib/db/schema';
import type { FetchWindow, RawBatch, SourceConnector } from '@/lib/connectors/types';
import type { SessionUser } from '@/lib/auth/session';
import { ARG_MONTHLY_BUDGET } from './fixtures/arg-sheets';

let sheet: unknown[][] = ARG_MONTHLY_BUDGET;
let fetches = 0;

const sheetsConnector: SourceConnector = {
  sourceSystem: 'SHEETS',
  label: 'Google Sheets',
  entities: () => [{ entity: 'monthly_budget', label: 'Monthly Budget', cadence: 'MONTHLY', description: '' }],
  isConfigured: async () => true,
  async fetch(entity: string, window: FetchWindow): Promise<RawBatch> {
    fetches += 1;
    return {
      sourceSystem: 'SHEETS',
      entity,
      window,
      fetchedAt: new Date(),
      records: [{ entity, key: 'range', payload: { range: 'range', values: sheet } }],
      nextCursor: null,
    };
  },
};

vi.mock('@/lib/connectors', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/connectors')>();
  return { ...original, CONNECTORS: [sheetsConnector], getConnector: () => sheetsConnector };
});

let harness: TestDb;
let user: SessionUser;
const INPUT = { source: 'SHEETS' as const, entity: 'monthly_budget', windowStart: '2026-01-01', windowEnd: '2026-09-01' };

beforeAll(async () => {
  harness = await createTestDb();
  await seedDatabase(harness.db, { quiet: true });
  user = await loadSeededUser(harness.db, 'cfo@westportfinancial.com');
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

describe('pulling the same tab twice', () => {
  it('imports it the first time', async () => {
    const { runSlice } = await import('@/lib/etl/ingest');
    const outcome = await runSlice(harness.db, user, INPUT);
    expect(outcome.ok).toBe(true);
    expect(outcome.rowsWritten).toBe(144);
  });

  it('checks it, finds it unchanged, and imports nothing — with the reason in the log', async () => {
    const { runSlice } = await import('@/lib/etl/ingest');
    const outcome = await runSlice(harness.db, user, INPUT);
    expect(outcome.rowsWritten).toBe(0);
    expect(outcome.notes.join(' ')).toMatch(/Unchanged since it was last imported/);

    const [run] = await harness.db.select().from(t.loadRun).where(eq(t.loadRun.id, outcome.loadRunId));
    expect(run!.status).toBe('SUCCEEDED');
    expect((run!.plan as { notes: string[] }).notes.join(' ')).toMatch(/Unchanged/);
  });

  it('imports it again once a cell changes', async () => {
    const { runSlice } = await import('@/lib/etl/ingest');
    sheet = ARG_MONTHLY_BUDGET.map((row) => (row[1] === 'TP' ? ['', 'TP', 60000, ...row.slice(3)] : row));
    const outcome = await runSlice(harness.db, user, INPUT);
    expect(outcome.rowsWritten).toBeGreaterThan(0);
    expect(outcome.notes.join(' ')).toMatch(/Changed since the last import/);
  });

  it('imports regardless when asked to re-import everything', async () => {
    const { runSlice } = await import('@/lib/etl/ingest');
    const before = fetches;
    const outcome = await runSlice(harness.db, user, INPUT, { fullRefresh: true });
    expect(fetches).toBe(before + 1);
    expect(outcome.rowsWritten).toBe(144);
    expect(outcome.notes[0]).toMatch(/Re-import everything/);
  });
});
