import { eq, sql } from 'drizzle-orm';
import * as t from '@/lib/db/schema';
import type { Database } from '@/lib/db/client';

/**
 * Demonstration data, or ARG's own books.
 *
 * The warehouse ships seeded so that every dashboard, control and export can be
 * exercised before a single source is connected. That is genuinely useful and
 * genuinely dangerous: a reader who believes seeded figures are their own books
 * will act on them, and nothing about a plausible number announces itself as
 * fabricated.
 *
 * So the two states are explicit and named, and switching is a recorded act:
 *
 *   DEMONSTRATION — the default. Seeded figures are visible, and every page says
 *                   so. This is the state a fresh deployment is in.
 *   LIVE          — seeded rows are excluded from every read. Only figures
 *                   loaded from QuickBooks, HubSpot or Sheets are shown. A month
 *                   with no load reads as unavailable, which is the truth.
 *
 * LIVE is a filter rather than a deletion, deliberately. Switching back is a
 * click, nothing is destroyed by a misclick, and the seeded rows remain in the
 * audit trail as what they always were — a labelled load run. Deleting them is
 * offered separately, because "hidden" and "gone" are different promises and the
 * operator should choose which one they are making.
 */

export type DataMode = 'DEMONSTRATION' | 'LIVE';

export const DATA_MODE_KEY = 'DATA_MODE';

export const DATA_MODE_DESCRIPTION =
  'Which figures the dashboards read. DEMONSTRATION shows the seeded dataset so every view can be ' +
  'exercised before a source is connected, and says so on every page. LIVE excludes every seeded ' +
  'row, so only data loaded from QuickBooks, HubSpot or Google Sheets is shown and an unloaded ' +
  'month reads as unavailable rather than as a figure.';

export async function getDataMode(db: Database): Promise<DataMode> {
  try {
    const [row] = await db
      .select({ value: t.appConfig.value })
      .from(t.appConfig)
      .where(eq(t.appConfig.key, DATA_MODE_KEY))
      .limit(1);

    return row?.value === 'LIVE' ? 'LIVE' : 'DEMONSTRATION';
  } catch {
    // The config table may not exist yet on a cold first request.
    return 'DEMONSTRATION';
  }
}

export async function setDataMode(
  db: Database,
  mode: DataMode,
  userId: string | null,
): Promise<void> {
  await db
    .insert(t.appConfig)
    .values({
      key: DATA_MODE_KEY,
      value: mode,
      description: DATA_MODE_DESCRIPTION,
      isConfirmed: true,
      updatedBy: userId,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: t.appConfig.key,
      set: { value: mode, isConfirmed: true, updatedBy: userId, updatedAt: new Date() },
    });
}

/**
 * The load runs that produced seeded data.
 *
 * Every seeded fact row carries the id of the one SEED load run, including the
 * tables that have no source_system column of their own — deals, contacts,
 * meetings, aging and the account-level GL. Filtering on the run id therefore
 * covers all of them uniformly, and cannot drift as tables are added.
 */
export async function seedLoadRunIds(db: Database): Promise<string[]> {
  try {
    const rows = await db
      .select({ id: t.loadRun.id })
      .from(t.loadRun)
      .where(eq(t.loadRun.sourceSystem, 'SEED'));
    return rows.map((row) => row.id);
  } catch {
    return [];
  }
}

export interface SeedFootprint {
  runIds: string[];
  plRows: number;
  glRows: number;
  dealRows: number;
  budgetRows: number;
}

/** What is actually seeded, so the operator sees the size of what they are hiding or deleting. */
export async function seedFootprint(db: Database): Promise<SeedFootprint> {
  const runIds = await seedLoadRunIds(db);
  if (runIds.length === 0) {
    return { runIds, plRows: 0, glRows: 0, dealRows: 0, budgetRows: 0 };
  }

  const count = async (table: 'fact_pl_actual' | 'fact_gl_balance' | 'fact_deal' | 'fact_budget') => {
    const result = await db.execute(
      sql`select count(*)::int as n from ${sql.identifier(table)} where load_run_id = any(${sql.raw(
        `ARRAY[${runIds.map((id) => `'${id}'`).join(',')}]::uuid[]`,
      )})`,
    );
    const rows = (result as unknown as { rows?: Array<{ n: number }> }).rows ?? (result as unknown as Array<{ n: number }>);
    return Number(rows?.[0]?.n ?? 0);
  };

  return {
    runIds,
    plRows: await count('fact_pl_actual'),
    glRows: await count('fact_gl_balance'),
    dealRows: await count('fact_deal'),
    budgetRows: await count('fact_budget'),
  };
}
