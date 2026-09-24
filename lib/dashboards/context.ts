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
import { chooseDefaultMonth, resolveRange, type DateRange } from './range';

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
  /**
   * The beginning/end filter. Scopes dated event lists and trends; it never
   * moves the P&L, which stays anchored on the reporting month.
   */
  range: DateRange;
  /** Salespeople with at least one deal, for the Sales owner filter. */
  owners: string[];
  /** The selected salesperson, or null for everyone. */
  ownerName: string | null;
  /** HubSpot pipelines present in the visible deals. */
  pipelines: string[];
  /** The selected pipeline, or null for all of them. */
  pipeline: string | null;
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


/**
 * Every month that has anything loaded into it, newest first.
 *
 * This drives the month selector and, through it, what every dashboard is
 * anchored on. It used to ask `fact_pl_actual` alone — the QuickBooks profit and
 * loss — which quietly made QuickBooks a prerequisite for the whole application:
 * with only HubSpot connected the list came back empty, every view fell through
 * to a configured month nothing had loaded into, and tens of thousands of landed
 * contacts, deals and meetings had no month to be displayed under. Every figure
 * read zero, and the reason was invisible.
 *
 * A month is available when ANY source has put something in it. A dashboard that
 * has no figure for the month it lands on still says so per figure — that part
 * was already right — but it now lands somewhere the data actually is.
 */
async function monthsWithData(db: Awaited<ReturnType<typeof getDb>>): Promise<MonthKey[]> {
  const rows = await db.execute(sql`
    select period_month from (
      select period_month from ${t.factPlActual}
      union select period_month from ${t.factBsActual}
      union select date_trunc('month', closedate)::date  from ${t.factDeal}    where closedate is not null
      union select date_trunc('month', createdate)::date from ${t.factDeal}    where createdate is not null
      union select date_trunc('month', createdate)::date from ${t.factContact} where createdate is not null
      union select date_trunc('month', meeting_date)::date from ${t.factMeeting} where meeting_date is not null
    ) months
    where period_month in (select period_month from ${t.dimPeriod})
    order by period_month desc
  `);

  const list = (Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])) as Array<{
    period_month: string | Date;
  }>;

  return list.map((row) =>
    typeof row.period_month === 'string'
      ? (row.period_month.slice(0, 10) as MonthKey)
      : (row.period_month.toISOString().slice(0, 10) as MonthKey),
  );
}

/** The month before this one: the latest a set of books can be complete for. */
export function lastCompletedMonth(today: Date = new Date()): MonthKey {
  const month = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
  return `${month.toISOString().slice(0, 7)}-01` as MonthKey;
}

/**
 * The month a view opens on when nobody has chosen one — shared by every
 * dashboard and the assistant, so they can never disagree.
 *
 * The assistant used to take DEFAULT_REPORTING_MONTH straight, which sat at its
 * seeded 2026-03: asked "how did we do?" from a page with no month in its URL,
 * it answered about March while the dashboard beside it showed August.
 */
export async function defaultReportingMonth(db: Awaited<ReturnType<typeof getDb>>): Promise<MonthKey> {
  const thisMonth = `${new Date().toISOString().slice(0, 7)}-01`;
  const availableMonths = (await monthsWithData(db)).filter((month) => month <= thisMonth);
  const [configured] = await db
    .select({ value: t.appConfig.value })
    .from(t.appConfig)
    .where(eq(t.appConfig.key, 'DEFAULT_REPORTING_MONTH'))
    .limit(1);
  return (
    chooseDefaultMonth(availableMonths, normaliseMonth(configured?.value ?? undefined)) ??
    lastCompletedMonth()
  );
}

export async function loadDashboardContext(
  searchParams: SearchParams,
): Promise<DashboardContext> {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  const db = await getDb();

  // Months that have happened: a month ahead of the calendar can only hold
  // future-dated entries, and offering it reads as a month of real results.
  const thisMonth = `${new Date().toISOString().slice(0, 7)}-01`;
  const availableMonths = (await monthsWithData(db)).filter((month) => month <= thisMonth);

  const defaultMonthRow = await db
    .select({ value: t.appConfig.value })
    .from(t.appConfig)
    .where(eq(t.appConfig.key, 'DEFAULT_REPORTING_MONTH'))
    .limit(1);
  const configuredMonth = normaliseMonth(defaultMonthRow[0]?.value ?? undefined);

  const requested = normaliseMonth(first(searchParams.month));
  const month =
    // What the URL asks for, if there is anything there to show.
    (requested && availableMonths.includes(requested) ? requested : null) ??
    // Then the last completed month with figures (see chooseDefaultMonth: the
    // configured month only wins when it is later, and only while it holds data).
    chooseDefaultMonth(availableMonths, configuredMonth) ??
    lastCompletedMonth();

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

  const range = resolveRange(
    {
      from: first(searchParams.from),
      to: first(searchParams.to),
      range: first(searchParams.range),
    },
    month,
    availableMonths,
  );

  // The owner list comes from the deals this user can actually see, so a
  // division manager's filter does not name reps working other divisions.
  const named = [
    ...new Set(
      session.bundle.deals
        .map((deal) => deal.ownerName)
        .filter((name): name is string => Boolean(name)),
    ),
  ].sort();

  // An unowned deal is a real state, and one worth being able to filter *to*:
  // "who is sitting on the unassigned pipeline" is a question leadership asks.
  // Offering the option only when such a deal exists keeps the list honest.
  const hasUnassigned = session.bundle.deals.some((deal) => !deal.ownerName);
  const owners = hasUnassigned ? [...named, 'Unassigned'] : named;

  const requestedOwner = first(searchParams.owner);
  const ownerName = requestedOwner && owners.includes(requestedOwner) ? requestedOwner : null;

  const pipelines = [
    ...new Set(
      session.bundle.deals
        .map((deal) => deal.pipeline)
        .filter((value): value is string => Boolean(value)),
    ),
  ].sort();

  const requestedPipeline = first(searchParams.pipeline);
  const pipeline =
    requestedPipeline && pipelines.includes(requestedPipeline) ? requestedPipeline : null;

  return {
    user,
    session,
    divisionCode,
    availableMonths,
    divisions: session.bundle.divisions,
    recon: { failed: reconRow?.failed ?? 0, total: reconRow?.total ?? 0 },
    range,
    owners,
    ownerName,
    pipelines,
    pipeline,
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
