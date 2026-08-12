/**
 * Page-level context for every dashboard.
 *
 * §7: "A single global parameter drives every view — in Excel it is one cell. In
 * your build it is one date selector at the top of the app that every dashboard
 * reads. Changing it re-anchors PM, PY, YTD and budget lookups everywhere at
 * once."
 *
 * That parameter lives in the URL, so a view is shareable, bookmarkable, and
 * reproducible — and the agent can hand a CEO a link that opens on exactly the
 * figure it just cited.
 */
import 'server-only';
import { redirect } from 'next/navigation';
import { desc, eq, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import { getSessionUser, type SessionUser } from '@/lib/auth/session';
import { openSemanticSession, CONSOLIDATED_CODE, type SemanticSession } from '@/lib/semantic/resolve';
import type { MonthKey } from '@/lib/semantic/periods';

export type SearchParams = Record<string, string | string[] | undefined>;

export interface DashboardContext {
  user: SessionUser;
  session: SemanticSession;
  /** The selected division, or ARG_TOTAL. */
  divisionCode: string;
  /** Every month with data, newest first — drives the month selector. */
  availableMonths: MonthKey[];
  divisions: Array<{ divisionCode: string; divisionName: string; sortOrder: number }>;
  recon: { failed: number; total: number };
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Accepts '2026-03' or '2026-03-01'. */
function normaliseMonth(value: string | undefined): MonthKey | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}$/.test(value)) return `${value}-01`;
  if (/^\d{4}-\d{2}-01$/.test(value)) return value;
  return null;
}

export async function loadDashboardContext(
  searchParams: SearchParams,
): Promise<DashboardContext> {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  const db = await getDb();

  const periodRows = await db
    .select({ periodMonth: t.dimPeriod.periodMonth })
    .from(t.dimPeriod)
    .innerJoin(t.factPlActual, eq(t.factPlActual.periodMonth, t.dimPeriod.periodMonth))
    .groupBy(t.dimPeriod.periodMonth)
    .orderBy(desc(t.dimPeriod.periodMonth));
  const availableMonths = periodRows.map((row) => row.periodMonth);

  const defaultMonthRow = await db
    .select({ value: t.appConfig.value })
    .from(t.appConfig)
    .where(eq(t.appConfig.key, 'DEFAULT_REPORTING_MONTH'))
    .limit(1);

  const requested = normaliseMonth(first(searchParams.month));
  const month =
    (requested && availableMonths.includes(requested) ? requested : null) ??
    defaultMonthRow[0]?.value ??
    availableMonths[0] ??
    '2026-03-01';

  const session = await openSemanticSession(db, user, month);

  // Fall back to a division the user can actually see rather than erroring on a
  // hand-edited URL.
  const requestedDivision = first(searchParams.division);
  const divisionCode =
    requestedDivision === CONSOLIDATED_CODE && session.consolidatedAvailable
      ? CONSOLIDATED_CODE
      : requestedDivision && session.visibleDivisions.includes(requestedDivision)
        ? requestedDivision
        : session.consolidatedAvailable
          ? CONSOLIDATED_CODE
          : (session.visibleDivisions[0] ?? CONSOLIDATED_CODE);

  const [reconRow] = await db
    .select({
      failed: sql<number>`count(*) filter (where status = 'FAIL')::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(t.reconResult)
    .where(
      sql`ran_at = (select max(ran_at) from recon_result)`,
    );

  return {
    user,
    session,
    divisionCode,
    availableMonths,
    divisions: session.bundle.divisions,
    recon: { failed: reconRow?.failed ?? 0, total: reconRow?.total ?? 0 },
  };
}

/** Builds a link that preserves the global parameters. */
export function dashboardHref(
  page: string,
  month: MonthKey,
  divisionCode: string,
  extra: Record<string, string> = {},
): string {
  const params = new URLSearchParams({
    month: month.slice(0, 7),
    division: divisionCode,
    ...extra,
  });
  return `${page}?${params.toString()}`;
}
