/**
 * The forecast lock — Acceptance Test 7.
 *
 * The 13 August notes ask for "a lock and save feature". Both were already
 * built; what was missing was any proof that the lock holds, and the lock is
 * the part with teeth. §10.3 requires immutability "at the database level, not
 * only in the interface", so these tests go around the application entirely and
 * attack the rows directly. If the trigger is the guarantee, then a test that
 * politely calls the service proves nothing — an UPDATE issued by anything at
 * all has to fail.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createTestDb, loadSeededUser, type TestDb } from './helpers/db';

/**
 * Drizzle wraps a driver error in its own, so the trigger's message lives on
 * the cause rather than on `message`. Asserting against the wrapper would pass
 * for *any* failed query, including a typo in the test.
 */
async function rejectionText(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    const parts: string[] = [];
    let current: unknown = error;
    while (current instanceof Error) {
      parts.push(current.message);
      current = (current as { cause?: unknown }).cause;
    }
    return parts.join(' | ');
  }
  throw new Error('Expected the write to be refused, but it succeeded.');
}
import type { SessionUser } from '@/lib/auth/session';
import { seedDatabase } from '@/lib/seed/load';
import { TIE_OUT_MONTH } from '@/lib/seed/reference';
import * as t from '@/lib/db/schema';

let harness: TestDb;
let CFO: SessionUser;

const MONTH = '2026-04-01'; // the open month — a forecast belongs to a future period

beforeAll(async () => {
  harness = await createTestDb();
  await seedDatabase(harness.db, { quiet: true });
  CFO = await loadSeededUser(harness.db, 'cfo@westportfinancial.com');
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  // Locked rows cannot be deleted, so each test builds its own version rather
  // than sharing one — which is itself a small demonstration of the guarantee.
  await harness.db.delete(t.factForecast).where(eq(t.factForecast.isLocked, false));
});

async function createVersion(options: { locked: boolean; official?: boolean; name?: string }) {
  const [version] = await harness.db
    .insert(t.forecastVersion)
    .values({
      periodMonth: MONTH,
      scenarioName: options.name ?? `scenario-${Math.random().toString(36).slice(2, 8)}`,
      isOfficial: options.official ?? false,
      isLocked: options.locked,
      lockedAt: options.locked ? new Date() : null,
      lockedBy: options.locked ? CFO.id : null,
      createdBy: CFO.id,
    })
    .returning();

  await harness.db.insert(t.factForecast).values({
    forecastVersionId: version!.id,
    periodMonth: MONTH,
    divisionCode: 'SHRC',
    assumRevenuePctOfBudget: '1.000000',
    assumPayrollDirectPct: '0.200000',
    assumCogsPct: '0.600000',
    assumPayrollExpenseAmt: '10000.0000',
    assumOpexAmt: '40000.0000',
    fcRevenue: '200000.0000',
    fcPayrollDirect: '40000.0000',
    fcCogs: '120000.0000',
    fcGrossProfit: '80000.0000',
    fcPayrollExpense: '10000.0000',
    fcOpex: '40000.0000',
    fcNetProfit: '40000.0000',
    isLocked: options.locked,
  });

  return version!.id;
}

describe('an unlocked forecast is an ordinary draft', () => {
  it('saves, and can be revised as many times as you like', async () => {
    const versionId = await createVersion({ locked: false });

    await harness.db
      .update(t.factForecast)
      .set({ fcRevenue: '210000.0000' })
      .where(eq(t.factForecast.forecastVersionId, versionId));

    const [row] = await harness.db
      .select({ revenue: t.factForecast.fcRevenue })
      .from(t.factForecast)
      .where(eq(t.factForecast.forecastVersionId, versionId));

    expect(Number(row!.revenue)).toBe(210_000);
  });

  it('can be deleted while it is still a draft', async () => {
    const versionId = await createVersion({ locked: false });
    await harness.db.delete(t.factForecast).where(eq(t.factForecast.forecastVersionId, versionId));

    const rows = await harness.db
      .select({ id: t.factForecast.forecastVersionId })
      .from(t.factForecast)
      .where(eq(t.factForecast.forecastVersionId, versionId));

    expect(rows).toHaveLength(0);
  });
});

describe('a locked forecast is immutable — §10.3, Acceptance Test 7', () => {
  it('refuses an UPDATE, issued directly against the table', async () => {
    const versionId = await createVersion({ locked: true });

    const message = await rejectionText(() =>
      harness.db
        .update(t.factForecast)
        .set({ fcRevenue: '999999.0000' })
        .where(eq(t.factForecast.forecastVersionId, versionId)),
    );
    expect(message).toMatch(/locked and cannot be modified/i);
  });

  it('refuses a DELETE, issued directly against the table', async () => {
    const versionId = await createVersion({ locked: true });

    const message = await rejectionText(() =>
      harness.db.delete(t.factForecast).where(eq(t.factForecast.forecastVersionId, versionId)),
    );
    expect(message).toMatch(/locked and cannot be deleted/i);
  });

  it('leaves the figure untouched after a refused write', async () => {
    const versionId = await createVersion({ locked: true });

    await rejectionText(() =>
      harness.db
        .update(t.factForecast)
        .set({ fcRevenue: '1.0000' })
        .where(eq(t.factForecast.forecastVersionId, versionId)),
    );

    // The point of a trigger over an application check: the row is unchanged
    // even though something tried, and tried from outside the app.
    const [row] = await harness.db
      .select({ revenue: t.factForecast.fcRevenue })
      .from(t.factForecast)
      .where(eq(t.factForecast.forecastVersionId, versionId));

    expect(Number(row!.revenue)).toBe(200_000);
  });

  it('refuses to delete the locked version header too', async () => {
    const versionId = await createVersion({ locked: true });

    const message = await rejectionText(() =>
      harness.db.delete(t.forecastVersion).where(eq(t.forecastVersion.id, versionId)),
    );
    expect(message).toMatch(/locked and cannot be deleted/i);
  });
});

describe('exactly one official forecast per month', () => {
  it('rejects a second official version for the same month', async () => {
    await createVersion({ locked: true, official: true, name: 'base' });

    // The partial unique index is what makes "the official forecast" a phrase
    // with one referent. Without it, two rows can both claim to be official and
    // forecast-vs-actual silently picks whichever the query returns first.
    await rejectionText(() => createVersion({ locked: true, official: true, name: 'upside' }));
  });

  it('allows any number of unofficial scenarios alongside it', async () => {
    await createVersion({ locked: false, official: false, name: 'downside' });
    await createVersion({ locked: false, official: false, name: 'stretch' });

    const [row] = await harness.db
      .select({ count: sql<number>`count(*)::int` })
      .from(t.forecastVersion)
      .where(and(eq(t.forecastVersion.periodMonth, MONTH), eq(t.forecastVersion.isOfficial, false)));

    expect(row!.count).toBeGreaterThanOrEqual(2);
  });
});
