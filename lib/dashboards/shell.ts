import 'server-only';
import { desc, eq, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import { chooseDefaultMonth } from './range';

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
  recon: {
    failed: number;
    total: number;
    /** The failing checks themselves, in words, so the header can explain itself. */
    failures: Array<{ name: string; month: string | null; detail: string }>;
  };
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

  const [allMonthRows, divisionRows, configRows, reconRows, failureRows, lastRun] = await Promise.all([
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
      .select({
        name: t.reconResult.checkName,
        month: t.reconResult.periodMonth,
        detail: t.reconResult.detail,
      })
      .from(t.reconResult)
      .where(sql`ran_at = (select max(ran_at) from recon_result) and status = 'FAIL'`)
      .orderBy(desc(t.reconResult.periodMonth))
      .limit(12),
    db
      .select({ finishedAt: t.loadRun.finishedAt })
      .from(t.loadRun)
      .where(eq(t.loadRun.status, 'SUCCEEDED'))
      .orderBy(sql`${t.loadRun.finishedAt} desc nulls last`)
      .limit(1),
  ]);

  const config = new Map(configRows.map((row) => [row.key, row]));
  const reconRow = reconRows[0];

  // Months that have happened. A month ahead of the calendar can only hold
  // future-dated entries, and offering it reads as a month of real results.
  const thisMonth = `${new Date().toISOString().slice(0, 7)}-01`;
  const monthRows = allMonthRows.filter((row) => row.periodMonth <= thisMonth);

  const defaultMonth =
    chooseDefaultMonth(
      monthRows.map((row) => row.periodMonth),
      config.get('DEFAULT_REPORTING_MONTH')?.value ?? null,
    ) ?? `${new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 1)).toISOString().slice(0, 7)}-01`;

  return {
    months: monthRows,
    divisions: divisionRows.filter((row) => visibleDivisions.includes(row.divisionCode)),
    consolidatedAvailable,
    defaultMonth,
    accountingBasis: config.get('ACCOUNTING_BASIS')?.value ?? 'accrual',
    lastRefreshedAt: lastRun[0]?.finishedAt?.toISOString() ?? null,
    recon: {
      failed: reconRow?.failed ?? 0,
      total: reconRow?.total ?? 0,
      failures: failureRows.map((row) => ({ name: row.name, month: row.month, detail: row.detail ?? '' })),
    },
    unconfirmedConfigCount: configRows.filter((row) => !row.isConfirmed).length,
  };
}
