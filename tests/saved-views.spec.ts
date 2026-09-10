/**
 * Views built from filters, and by the assistant.
 *
 * A saved view is a standing answer: somebody builds it once and reads it every
 * month without rebuilding it. That makes two properties load-bearing in a way
 * an ad-hoc chart's are not.
 *
 * First, entitlements have to be enforced at RENDER time rather than at build
 * time. A view is shared, and the person reading it next month is not
 * necessarily the person who built it — so a view built by the CFO across every
 * division must not show a division manager anything they could not otherwise
 * see. Checking only on save would leak the moment a view is shared.
 *
 * Second, what is stored is a specification and never a result. A view that kept
 * its figures would keep them after a restatement, and would disagree with the
 * dashboard beside it while looking equally authoritative.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, loadSeededUser, type TestDb } from './helpers/db';
import { seedDatabase } from '@/lib/seed/load';
import { openSemanticSession, CONSOLIDATED_CODE } from '@/lib/semantic/resolve';
import { executeSavedView, ViewSpecError } from '@/lib/views/spec';
import { saveView, listViews, deleteView } from '@/lib/views/store';
import type { SessionUser } from '@/lib/auth/session';

let harness: TestDb;
let cfo: SessionUser;
let manager: SessionUser;

const MONTH = '2026-03-01';

beforeAll(async () => {
  harness = await createTestDb();
  await seedDatabase(harness.db);
  cfo = await loadSeededUser(harness.db, 'cfo@westportfinancial.com');
  manager = await loadSeededUser(harness.db, 'claims.lead@alliancerisk.com');
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

const PIPELINE_BY_OWNER = {
  kind: 'pipeline' as const,
  title: 'Closed-won by rep',
  form: 'horizontalBar' as const,
  groupBy: 'owner' as const,
  measure: 'amount' as const,
  filters: { status: 'won' as const, trailingMonths: 12 },
};

describe('a pipeline view', () => {
  it('groups and filters the real deal table', async () => {
    const session = await openSemanticSession(harness.db, cfo, MONTH);
    const executed = executeSavedView(session, PIPELINE_BY_OWNER);

    expect(executed.chart.data.length).toBeGreaterThan(0);
    expect(executed.chart.valueFormat).toBe('currency');
    // Every bar is a real owner with real money against it.
    expect(executed.chart.data.every((row) => Number(row.value) > 0)).toBe(true);
  });

  it('says what it filtered, on the face of the chart', async () => {
    const session = await openSemanticSession(harness.db, cfo, MONTH);
    const executed = executeSavedView(session, PIPELINE_BY_OWNER);

    // A filtered chart that does not say so will be read as the whole picture.
    expect(executed.chart.note).toMatch(/Closed-won deals/);
    expect(executed.chart.note).toMatch(/last 12 months/);
  });

  it('keeps empty months on a time axis', async () => {
    const session = await openSemanticSession(harness.db, cfo, MONTH);
    const executed = executeSavedView(session, {
      ...PIPELINE_BY_OWNER,
      groupBy: 'month',
      form: 'line',
      filters: { status: 'won', trailingMonths: 6 },
    });

    // Six months means six points. Dropping a month nothing closed in draws a
    // continuous line across a gap that is itself the finding.
    expect(executed.chart.data).toHaveLength(6);
  });

  it('refuses a division the reader is not entitled to', async () => {
    const session = await openSemanticSession(harness.db, manager, MONTH);

    expect(() =>
      executeSavedView(session, {
        ...PIPELINE_BY_OWNER,
        filters: { status: 'won', divisions: ['SHRC'] },
      }),
    ).toThrow(ViewSpecError);
  });

  it('rejects a malformed specification rather than rendering something near it', async () => {
    const session = await openSemanticSession(harness.db, cfo, MONTH);

    expect(() =>
      executeSavedView(session, { ...PIPELINE_BY_OWNER, groupBy: 'colour' }),
    ).toThrow(ViewSpecError);
  });
});

describe('saving a view', () => {
  it('stores a specification, never figures', async () => {
    const saved = await saveView(harness.db, cfo, {
      name: 'Closed-won by rep',
      spec: PIPELINE_BY_OWNER,
    });

    const stored = JSON.stringify(saved.spec);
    // If any figure were in here, the view would keep showing it after a
    // restatement while the dashboard beside it moved.
    expect(stored).not.toMatch(/\d{4,}/);
    expect(saved.spec.kind).toBe('pipeline');
  });

  it('re-checks entitlements when a shared view is opened by someone else', async () => {
    await saveView(harness.db, cfo, {
      name: 'SHRC won',
      spec: { ...PIPELINE_BY_OWNER, filters: { status: 'won', divisions: ['SHRC'] } },
    });

    const views = await listViews(harness.db, manager);
    const shared = views.find((view) => view.name === 'SHRC won');
    expect(shared).toBeDefined();

    // The manager can SEE that the view exists and still cannot read SHRC
    // through it. Checking only on save would have leaked the division the
    // moment the CFO shared it.
    const session = await openSemanticSession(harness.db, manager, MONTH);
    expect(() => executeSavedView(session, shared!.spec)).toThrow(/Not entitled/);
  });

  it('refuses a spec that cannot be saved at all', async () => {
    await expect(
      saveView(harness.db, cfo, { name: 'Broken', spec: { kind: 'pipeline', title: 'x' } }),
    ).rejects.toThrow(/cannot be saved/);
  });

  it('lets an author remove their own view', async () => {
    const saved = await saveView(harness.db, cfo, {
      name: 'Temporary',
      spec: PIPELINE_BY_OWNER,
    });

    await deleteView(harness.db, cfo, saved.id);
    const remaining = await listViews(harness.db, cfo);
    expect(remaining.find((view) => view.id === saved.id)).toBeUndefined();
  });

  it('stops one person deleting a view the team relies on', async () => {
    const saved = await saveView(harness.db, cfo, {
      name: 'Board pipeline',
      spec: PIPELINE_BY_OWNER,
    });

    await expect(deleteView(harness.db, manager, saved.id)).rejects.toThrow(/administrator/);
  });
});
