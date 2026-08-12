import 'server-only';
import { desc, eq, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import * as t from '@/lib/db/schema';

export interface ShellMonth {
  periodMonth: string;
  isClosed: boolean;
}

export interface ShellData {
  months: ShellMonth[];
  divisions: Array<{ divisionCode: string; divisionName: string; sortOrder: number }>;
  consolidatedAvailable: boolean;
  defaultMonth: string;
  accountingBasis: string;
  lastRefreshedAt: string | null;
  recon: { failed: number; total: number };
  /** Open items still awaiting a Westport decision (§14.3). */
  unconfirmedConfigCount: number;
}

/**
 * Everything the persistent chrome needs, loaded once per navigation.
 *
 * Deliberately separate from the per-dashboard context: the shell must render
 * its refresh timestamp and reconciliation status even when the page beneath it
 * has nothing to show.
 */
export async function loadShellData(
  visibleDivisions: string[],
  consolidatedAvailable: boolean,
): Promise<ShellData> {
  const db = await getDb();

  const [monthRows, divisionRows, configRows, reconRows, lastRun] = await Promise.all([
    db
      .select({ periodMonth: t.dimPeriod.periodMonth, isClosed: t.dimPeriod.isClosed })
      .from(t.dimPeriod)
      .innerJoin(t.factPlActual, eq(t.factPlActual.periodMonth, t.dimPeriod.periodMonth))
      .groupBy(t.dimPeriod.periodMonth, t.dimPeriod.isClosed)
      .orderBy(desc(t.dimPeriod.periodMonth)),
    db
      .select({
        divisionCode: t.dimDivision.divisionCode,
        divisionName: t.dimDivision.divisionName,
        sortOrder: t.dimDivision.sortOrder,
      })
      .from(t.dimDivision)
      .where(eq(t.dimDivision.isActive, true))
      .orderBy(t.dimDivision.sortOrder),
    db.select().from(t.appConfig),
    db
      .select({
        failed: sql<number>`count(*) filter (where status = 'FAIL')::int`,
        total: sql<number>`count(*)::int`,
      })
      .from(t.reconResult)
      .where(sql`ran_at = (select max(ran_at) from recon_result)`),
    db
      .select({ finishedAt: t.loadRun.finishedAt })
      .from(t.loadRun)
      .where(eq(t.loadRun.status, 'SUCCEEDED'))
      .orderBy(sql`${t.loadRun.finishedAt} desc nulls last`)
      .limit(1),
  ]);

  const config = new Map(configRows.map((row) => [row.key, row]));
  const reconRow = reconRows[0];

  return {
    months: monthRows,
    divisions: divisionRows.filter((row) => visibleDivisions.includes(row.divisionCode)),
    consolidatedAvailable,
    defaultMonth:
      config.get('DEFAULT_REPORTING_MONTH')?.value ?? monthRows[0]?.periodMonth ?? '2026-03-01',
    accountingBasis: config.get('ACCOUNTING_BASIS')?.value ?? 'accrual',
    lastRefreshedAt: lastRun[0]?.finishedAt?.toISOString() ?? null,
    recon: { failed: reconRow?.failed ?? 0, total: reconRow?.total ?? 0 },
    unconfirmedConfigCount: configRows.filter((row) => !row.isConfirmed).length,
  };
}
