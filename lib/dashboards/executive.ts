import 'server-only';
import { desc, eq, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import { resolveKpi, CONSOLIDATED_CODE, type SemanticSession } from '@/lib/semantic/resolve';
import { formatMonthShort, type MonthKey } from '@/lib/semantic/periods';
import { safeDiv } from '@/lib/money';
import type { KpiTileProps } from '@/components/dashboard/kpi-tile';
import { openFindings } from '@/lib/ai/goals';

/** §9.1 — the eight headline tiles. */
const EXECUTIVE_TILES: Array<{ id: string; hint: string }> = [
  { id: 'revenue_run_rate', hint: '(YTD revenue ÷ months elapsed) × 12 — never single month × 12' },
  { id: 'gross_profit_run_rate', hint: '(YTD gross profit ÷ months elapsed) × 12' },
  { id: 'net_profit_run_rate', hint: '(YTD net profit ÷ months elapsed) × 12' },
  { id: 'ytd_gross_margin_pct', hint: 'YTD gross profit ÷ YTD revenue' },
  { id: 'ytd_net_margin_pct', hint: 'YTD net profit ÷ YTD revenue' },
  { id: 'cash_position', hint: 'Cash and equivalents at month end' },
  { id: 'cash_runway', hint: 'Cash ÷ monthly OpEx. OpEx-only denominator, confirmed by Westport' },
  { id: 'pipeline_value', hint: 'Open deal value as of the reporting date' },
];

export interface DivisionContribution {
  divisionCode: string;
  divisionName: string;
  revenue: number | null;
  revenueContribution: number | null;
  netProfit: number | null;
  netProfitContribution: number | null;
  ytdRevenue: number | null;
  ytdNetProfit: number | null;
}

export interface BaselineRow {
  label: string;
  scenario: string;
  actual: number | null;
  budget: number | null;
  attainment: number | null;
  varianceDollars: number | null;
  higherIsBetter: boolean;
  unavailable?: string;
}

export interface ExceptionRow {
  severity: 'critical' | 'warning';
  headline: string;
  detail: string;
}

export interface ExecutiveViewModel {
  tiles: KpiTileProps[];
  contributions: DivisionContribution[];
  baselines: BaselineRow[];
  exceptions: ExceptionRow[];
  trend: Array<{ x: string; xLabel: string } & Record<string, number | null | string>>;
  trendSeries: Array<{ id: string; label: string; color: string }>;
  commentary: { draft: string; signedAt: string | null } | null;
}

function numberOrNull(value: { value: { toNumber(): number } | null }): number | null {
  return value.value ? value.value.toNumber() : null;
}

export async function loadExecutive(
  session: SemanticSession,
  divisionCode: string,
  divisionColors: Record<string, string>,
): Promise<ExecutiveViewModel> {
  const db = await getDb();
  const { period } = session;

  // --- Tiles -------------------------------------------------------------
  const tiles: KpiTileProps[] = EXECUTIVE_TILES.map(({ id, hint }) => {
    const current = resolveKpi(session, id, divisionCode);
    const priorMonth = resolveKpi(session, id, divisionCode, { month: period.priorMonth });
    const priorYear = resolveKpi(session, id, divisionCode, { month: period.priorYearMonth });

    const currentValue = numberOrNull(current);
    const pmValue = numberOrNull(priorMonth);
    const pyValue = numberOrNull(priorYear);

    return {
      name: current.name,
      formatted: current.formatted,
      unavailable: current.unavailable,
      higherIsBetter: current.higherIsBetter,
      format: current.format,
      deltaPriorMonth: currentValue !== null && pmValue !== null ? currentValue - pmValue : null,
      deltaPriorYear: currentValue !== null && pyValue !== null ? currentValue - pyValue : null,
      sparkline: period.trailingTwelveMonths.map((month) =>
        numberOrNull(resolveKpi(session, id, divisionCode, { month })),
      ),
      href: current.verifyHref,
      hint,
    };
  });

  // --- Division contribution --------------------------------------------
  // §7: "Division contribution % = division revenue ÷ ARG Total revenue. Net
  // profit contribution uses the ABSOLUTE VALUE of ARG Total net profit in the
  // denominator so the sign stays readable in a loss month."
  const totalRevenue = session.consolidatedAvailable
    ? numberOrNull(resolveKpi(session, 'revenue', CONSOLIDATED_CODE))
    : null;
  const totalNetProfit = session.consolidatedAvailable
    ? numberOrNull(resolveKpi(session, 'net_profit', CONSOLIDATED_CODE))
    : null;
  const totalNetProfitAbs = totalNetProfit === null ? null : Math.abs(totalNetProfit);

  const contributions: DivisionContribution[] = session.bundle.divisions.map((division) => {
    const revenue = numberOrNull(resolveKpi(session, 'revenue', division.divisionCode));
    const netProfit = numberOrNull(resolveKpi(session, 'net_profit', division.divisionCode));

    const ytdRevenue = period.ytdMonths.reduce<number | null>((sum, month) => {
      const value = numberOrNull(resolveKpi(session, 'revenue', division.divisionCode, { month }));
      return value === null ? sum : (sum ?? 0) + value;
    }, null);
    const ytdNetProfit = period.ytdMonths.reduce<number | null>((sum, month) => {
      const value = numberOrNull(resolveKpi(session, 'net_profit', division.divisionCode, { month }));
      return value === null ? sum : (sum ?? 0) + value;
    }, null);

    return {
      divisionCode: division.divisionCode,
      divisionName: division.divisionName,
      revenue,
      revenueContribution:
        revenue !== null && totalRevenue ? safeDiv(revenue, totalRevenue).toNumber() : null,
      netProfit,
      netProfitContribution:
        netProfit !== null && totalNetProfitAbs
          ? safeDiv(netProfit, totalNetProfitAbs).toNumber()
          : null,
      ytdRevenue,
      ytdNetProfit,
    };
  });

  // --- Actual vs Monthly Budget vs 10X, YTD ------------------------------
  // §9.1: shown as attainment ratios WITH dollar variance, in two distinctly
  // labelled columns. §7 warns that a reader seeing "−36,773" beside "84%"
  // reasonably assumes both are variances.
  const baselines: BaselineRow[] = (
    [
      ['Monthly Budget', 'MONTHLY_BUDGET'],
      ['10X Plan', 'TENX'],
    ] as const
  ).map(([label, scenario]) => {
    const result = resolveKpi(session, 'budget_attainment', divisionCode, {
      options: { scenario, lineItem: 'revenue', scope: 'ytd' },
    });
    return {
      label,
      scenario,
      actual: result.components?.actual?.toNumber() ?? null,
      budget: result.components?.budget?.toNumber() ?? null,
      attainment: numberOrNull(result),
      varianceDollars: result.components?.varianceDollars?.toNumber() ?? null,
      higherIsBetter: result.higherIsBetter,
      unavailable: result.unavailable?.detail,
    };
  });

  // --- Exception panel ---------------------------------------------------
  // §9.1: "every reconciliation check that is currently failing, and every KPI
  // outside its threshold."
  const failingChecks = await db
    .select({
      checkName: t.reconResult.checkName,
      periodMonth: t.reconResult.periodMonth,
      divisionCode: t.reconResult.divisionCode,
      detail: t.reconResult.detail,
    })
    .from(t.reconResult)
    .where(sql`status = 'FAIL' and ran_at = (select max(ran_at) from recon_result)`)
    .limit(20);

  const exceptions: ExceptionRow[] = failingChecks.map((row) => ({
    severity: 'critical',
    headline: `${row.checkName}${row.divisionCode ? ` — ${row.divisionCode}` : ''}${
      row.periodMonth ? ` (${row.periodMonth.slice(0, 7)})` : ''
    }`,
    detail: row.detail ?? 'No detail recorded.',
  }));

  // A division running a net loss is an exception a CEO wants on the front page.
  for (const contribution of contributions) {
    if (contribution.netProfit !== null && contribution.netProfit < 0) {
      exceptions.push({
        severity: 'warning',
        headline: `${contribution.divisionName} is running a net loss`,
        detail: `Net profit of ${contribution.netProfit.toLocaleString('en-US', {
          style: 'currency',
          currency: 'USD',
          maximumFractionDigits: 0,
        })} for the month.`,
      });
    }
  }

  // Standing-goal findings, scoped to this reader. `openFindings` filters on
  // both goal ownership and current division entitlements — a finding about a
  // division the reader may no longer see must not appear here even though the
  // goal that produced it was theirs.
  for (const finding of (await openFindings(db, session.user, period.month)).slice(0, 10)) {
    exceptions.push({
      severity: finding.severity === 'critical' || finding.severity === 'serious' ? 'critical' : 'warning',
      headline: finding.headline,
      detail: finding.detail ?? '',
    });
  }

  // --- Trend -------------------------------------------------------------
  const trendMonths = period.trailingTwelveMonths;
  const trendDivisions = session.bundle.divisions;
  const trendSeries = trendDivisions.map((division) => ({
    id: division.divisionCode,
    label: division.divisionName,
    color: divisionColors[division.divisionCode] ?? 'var(--series-1)',
  }));

  const trend = trendMonths.map((month) => {
    const row: { x: string; xLabel: string } & Record<string, number | null | string> = {
      x: month,
      xLabel: formatMonthShort(month),
    };
    for (const division of trendDivisions) {
      row[division.divisionCode] = numberOrNull(
        resolveKpi(session, 'revenue', division.divisionCode, { month }),
      );
    }
    return row;
  });

  // --- AI monthly summary ------------------------------------------------
  const [commentaryRow] = await db
    .select()
    .from(t.monthlyCommentary)
    .where(eq(t.monthlyCommentary.periodMonth, period.month))
    .limit(1);

  return {
    tiles,
    contributions,
    baselines,
    exceptions,
    trend,
    trendSeries,
    commentary: commentaryRow
      ? {
          draft: commentaryRow.edited ?? commentaryRow.draft,
          signedAt: commentaryRow.signedAt?.toISOString() ?? null,
        }
      : null,
  };
}

export function trailingMonths(period: { trailingTwelveMonths: MonthKey[] }): MonthKey[] {
  return period.trailingTwelveMonths;
}
