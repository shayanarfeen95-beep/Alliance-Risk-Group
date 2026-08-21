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
import { formatMonth, type MonthKey } from '@/lib/semantic/periods';
import { resolveRange, type DateRange } from './range';
import {
  readBoxOverrides,
  MAX_OVERRIDE_MONTHS,
  type BoxFilterOptions,
  type BoxFilterState,
  type BoxOverride,
} from './box-filter';

export type SearchParams = Record<string, string | string[] | undefined>;

export type { BoxFilterOptions, BoxFilterState } from './box-filter';

/**
 * One box's resolved scope.
 *
 * Carries its own semantic session, because a box pointed at a month outside
 * the page's window needs facts the page never loaded. Resolving a KPI against
 * the wrong session would return "no data" for a month that has plenty — an
 * empty tile that looks like a data problem and is actually a plumbing one.
 */
export interface BoxScope {
  boxId: string;
  session: SemanticSession;
  divisionCode: string;
  month: MonthKey;
  divisionOverridden: boolean;
  monthOverridden: boolean;
  isOverridden: boolean;
  /** What the chip on the box says, e.g. "LITS · Feb 2026". Null when inherited. */
  overrideLabel: string | null;
}

export type BoxScopeResolver = (boxId: string) => BoxScope;

/** The dashboards a box can be pinned to. */
export type PinnablePageName = 'executive' | 'finance' | 'sales' | 'marketing' | 'pipeline';

/** The part of a scope a client component may hold. */
export function boxState(scope: BoxScope): BoxFilterState {
  return {
    boxId: scope.boxId,
    divisionCode: scope.divisionCode,
    month: scope.month,
    divisionOverridden: scope.divisionOverridden,
    monthOverridden: scope.monthOverridden,
    overrideLabel: scope.overrideLabel,
  };
}

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
  /**
   * The scope for one box — its own division and month when it has been given
   * one, the page's otherwise. Every tile, chart and table on every dashboard
   * resolves through this rather than reading `divisionCode` directly.
   */
  boxScope: BoxScopeResolver;
  /** Everything the per-box filter control needs to render its choices. */
  boxFilterOptions: BoxFilterOptions;
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
  const owners = [
    ...new Set(
      session.bundle.deals
        .map((deal) => deal.ownerName)
        .filter((name): name is string => Boolean(name)),
    ),
  ].sort();

  const requestedOwner = first(searchParams.owner);
  const ownerName = requestedOwner && owners.includes(requestedOwner) ? requestedOwner : null;

  // --- Per-box filters ----------------------------------------------------
  // Entitlements are applied here and nowhere else: an override naming a
  // division this reader may not see, or a month with no data, is dropped and
  // the box falls back to the page filter. A hand-edited URL cannot widen what
  // somebody is allowed to look at.
  const validated = new Map<string, BoxOverride>();
  for (const [boxId, override] of readBoxOverrides(searchParams)) {
    const requestedBoxDivision = override.divisionCode;
    const permittedDivision =
      requestedBoxDivision === CONSOLIDATED_CODE
        ? session.consolidatedAvailable
          ? CONSOLIDATED_CODE
          : undefined
        : requestedBoxDivision && session.visibleDivisions.includes(requestedBoxDivision)
          ? requestedBoxDivision
          : undefined;

    const permittedMonth =
      override.month && availableMonths.includes(override.month) ? override.month : undefined;

    if (permittedDivision || permittedMonth) {
      validated.set(boxId, {
        ...(permittedDivision ? { divisionCode: permittedDivision } : {}),
        ...(permittedMonth ? { month: permittedMonth } : {}),
      });
    }
  }

  // A box on another month needs facts from that month's window. One extra
  // bundle per distinct month, capped — the page stays fast whatever the URL
  // asks for, and a month beyond the cap reads the page month rather than
  // rendering an empty box.
  const sessionsByMonth = new Map<MonthKey, SemanticSession>([[month, session]]);
  const extraMonths = [
    ...new Set(
      [...validated.values()]
        .map((override) => override.month)
        .filter((value): value is MonthKey => Boolean(value) && value !== month),
    ),
  ].slice(0, MAX_OVERRIDE_MONTHS);

  for (const extra of extraMonths) {
    sessionsByMonth.set(extra, await openSemanticSession(db, user, extra));
  }

  const divisionName = (code: string): string =>
    code === CONSOLIDATED_CODE
      ? 'ARG Total'
      : (session.bundle.divisions.find((d) => d.divisionCode === code)?.divisionName ?? code);

  const boxScope: BoxScopeResolver = (boxId: string): BoxScope => {
    const override = validated.get(boxId);
    const boxMonth = (override?.month && sessionsByMonth.has(override.month) ? override.month : month);
    const boxDivision = override?.divisionCode ?? divisionCode;
    const divisionOverridden = boxDivision !== divisionCode;
    const monthOverridden = boxMonth !== month;

    return {
      boxId,
      session: sessionsByMonth.get(boxMonth) ?? session,
      divisionCode: boxDivision,
      month: boxMonth,
      divisionOverridden,
      monthOverridden,
      isOverridden: divisionOverridden || monthOverridden,
      overrideLabel:
        divisionOverridden || monthOverridden
          ? [
              divisionOverridden ? divisionName(boxDivision) : null,
              monthOverridden ? formatMonth(boxMonth) : null,
            ]
              .filter(Boolean)
              .join(' · ')
          : null,
    };
  };

  const boxFilterOptions: BoxFilterOptions = {
    divisions: session.bundle.divisions.map((d) => ({
      divisionCode: d.divisionCode,
      divisionName: d.divisionName,
    })),
    months: availableMonths,
    consolidatedAvailable: session.consolidatedAvailable,
    pageDivisionCode: divisionCode,
    pageDivisionLabel: divisionName(divisionCode),
    pageMonth: month,
  };

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
    boxScope,
    boxFilterOptions,
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
