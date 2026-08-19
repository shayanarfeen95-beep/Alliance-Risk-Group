import 'server-only';
import Decimal from 'decimal.js';
import { resolveKpi, CONSOLIDATED_CODE, type SemanticSession } from '@/lib/semantic/resolve';
import { monthBounds, formatMonthShort } from '@/lib/semantic/periods';
import type { KpiTileProps } from '@/components/dashboard/kpi-tile';
import type { DateRange } from './range';

/**
 * §9.3 — Sales dashboard, HubSpot driven.
 *
 * "Deal-level table behind every tile — sales leadership will not trust an
 * aggregate they cannot open."
 */

const SALES_TILES: Array<{ id: string; hint: string }> = [
  { id: 'dollars_booked', hint: 'SUM(amount) where closed-won and closedate in period' },
  { id: 'count_of_bookings', hint: 'COUNT(deals) where closed-won and closedate in period' },
  { id: 'average_booking_value', hint: 'Dollars booked ÷ count of bookings' },
  {
    id: 'booking_rate_pct',
    hint: 'Closed-won ÷ deals CLOSED in the period (won + lost). The denominator is deals closed, not all open deals.',
  },
  { id: 'pipeline_value', hint: 'SUM(amount) where the deal is still open, as of the reporting date' },
  { id: 'meetings_completed', hint: 'COUNT(meetings) by meeting date in period' },
  { id: 'new_proposals_sent', hint: 'Deals ENTERING the Proposal stage in period — from stage history, not current stage' },
  { id: 'average_close_time', hint: 'AVG(closedate − createdate) for deals won in the period' },
];

export interface PipelineStageRow {
  stage: string;
  label: string;
  count: number;
  value: number;
}

export interface DealRow {
  dealId: string;
  dealName: string;
  divisionCode: string | null;
  amount: number;
  dealstage: string;
  owner: string;
  createdate: string | null;
  closedate: string | null;
  status: 'Won' | 'Lost' | 'Open';
  daysToClose: number | null;
}

/** One row of the salesperson leaderboard. */
export interface SalespersonRow {
  owner: string;
  won: number;
  wonValue: number;
  lost: number;
  open: number;
  openValue: number;
  /** Won ÷ (won + lost) closed in the range. Null when nothing closed. */
  winRate: number | null;
}

export interface SalesViewModel {
  tiles: KpiTileProps[];
  bookingRateDenominator: { won: number; closed: number } | null;
  pipelineByStage: PipelineStageRow[];
  bookedVsBudget: Array<{ x: string; xLabel: string } & Record<string, number | null | string>>;
  bookedVsBudgetSeries: Array<{ id: string; label: string; color: string }>;
  bookingsTrend: Array<{ x: string; xLabel: string } & Record<string, number | null | string>>;
  bookingsTrendSeries: Array<{ id: string; label: string; color: string }>;
  deals: DealRow[];
  /** What the deal table is showing, stated on the card rather than assumed. */
  dealScope: { rangeLabel: string; ownerName: string | null; shown: number; total: number };
  bySalesperson: SalespersonRow[];
  unavailable?: string;
}

const STAGE_LABELS: Record<string, string> = {
  qualifiedtobuy: 'Qualified to buy',
  presentationscheduled: 'Presentation scheduled',
  proposalsent: 'Proposal sent',
  decisionmakerboughtin: 'Decision maker bought in',
  closedwon: 'Closed won',
  closedlost: 'Closed lost',
};

const num = (result: { value: Decimal | null }): number | null =>
  result.value ? result.value.toNumber() : null;

export interface SalesOptions {
  /** Scopes the deal table and the salesperson leaderboard. */
  range: DateRange;
  /** Narrows the deal table to one salesperson. Null shows everyone. */
  ownerName: string | null;
}

export function loadSales(
  session: SemanticSession,
  divisionCode: string,
  divisionColors: Record<string, string>,
  options: SalesOptions,
): SalesViewModel {
  const { period, bundle } = session;
  const isConsolidated = divisionCode === CONSOLIDATED_CODE;

  const tiles: KpiTileProps[] = SALES_TILES.map(({ id, hint }) => {
    const current = resolveKpi(session, id, divisionCode);
    const priorMonth = resolveKpi(session, id, divisionCode, { month: period.priorMonth });
    const priorYear = resolveKpi(session, id, divisionCode, { month: period.priorYearMonth });

    const value = num(current);
    const pm = num(priorMonth);
    const py = num(priorYear);

    return {
      name: current.name,
      formatted: current.formatted,
      unavailable: current.unavailable,
      higherIsBetter: current.higherIsBetter,
      format: current.format,
      deltaPriorMonth: value !== null && pm !== null ? value - pm : null,
      deltaPriorYear: value !== null && py !== null ? value - py : null,
      sparkline: period.trailingTwelveMonths.map((month) =>
        num(resolveKpi(session, id, divisionCode, { month })),
      ),
      hint,
    };
  });

  const bookingRate = resolveKpi(session, 'booking_rate_pct', divisionCode);
  const bookingRateDenominator = bookingRate.components
    ? {
        won: bookingRate.components.won?.toNumber() ?? 0,
        closed: bookingRate.components.closed?.toNumber() ?? 0,
      }
    : null;

  // If HubSpot cannot be attributed to a division, everything below reports at
  // ARG Total only — the KPI layer says so rather than inventing a rule.
  const unavailable = resolveKpi(session, 'dollars_booked', divisionCode).unavailable?.detail;

  const inScope = (code: string | null) =>
    isConsolidated || (code !== null && code === divisionCode);

  // --- Pipeline by stage -------------------------------------------------
  const stageTotals = new Map<string, { count: number; value: Decimal }>();
  for (const deal of bundle.deals) {
    if (deal.isClosed || !inScope(deal.divisionCode)) continue;
    const stage = deal.dealstage ?? 'unknown';
    const entry = stageTotals.get(stage) ?? { count: 0, value: new Decimal(0) };
    entry.count += 1;
    entry.value = entry.value.plus(deal.amount);
    stageTotals.set(stage, entry);
  }

  const pipelineByStage: PipelineStageRow[] = [...stageTotals.entries()]
    .map(([stage, entry]) => ({
      stage,
      label: STAGE_LABELS[stage] ?? stage,
      count: entry.count,
      value: entry.value.toNumber(),
    }))
    .sort((a, b) => b.value - a.value);

  // --- Booked vs budgeted revenue by division ---------------------------
  const divisions = isConsolidated
    ? bundle.divisions
    : bundle.divisions.filter((d) => d.divisionCode === divisionCode);

  const bookedVsBudgetSeries = [
    { id: 'booked', label: 'Booked (HubSpot)', color: 'var(--series-1)' },
    { id: 'budget', label: 'Budgeted revenue', color: 'var(--series-4)' },
  ];

  const bookedVsBudget = divisions.map((division) => {
    const result = resolveKpi(session, 'budgeted_sales_vs_actual', division.divisionCode);
    return {
      x: division.divisionCode,
      xLabel: division.divisionName,
      booked: result.components?.booked?.toNumber() ?? null,
      budget: result.components?.budget?.toNumber() ?? null,
    };
  });

  // --- Bookings trend, trailing twelve months ---------------------------
  const bookingsTrendSeries = [
    { id: 'booked', label: 'Dollars booked', color: 'var(--series-1)' },
  ];
  const bookingsTrend = period.trailingTwelveMonths.map((month) => ({
    x: month,
    xLabel: formatMonthShort(month),
    booked: num(resolveKpi(session, 'dollars_booked', divisionCode, { month })),
  }));

  // --- Deal-level table --------------------------------------------------
  //
  // The tiles above stay anchored on the reporting month, because they are the
  // specification's KPIs and the tie-out depends on that anchor. The deal table
  // is a list of dated events, so it honours the range instead — which is the
  // filter leadership actually asked for. The card states which it is showing,
  // because a table scoped differently from the tiles above it is confusing
  // exactly until it is labelled.
  const rangeStart = new Date(`${options.range.from}T00:00:00Z`);
  const rangeEnd = monthBounds(options.range.to).endExclusive;

  const inRange = (deal: (typeof bundle.deals)[number]) => {
    if (deal.closedate) return deal.closedate >= rangeStart && deal.closedate < rangeEnd;
    return !deal.isClosed;
  };

  const scopedDeals = bundle.deals.filter((deal) => inScope(deal.divisionCode) && inRange(deal));

  // --- By salesperson ----------------------------------------------------
  // Built before the owner filter is applied, so selecting one rep still shows
  // where they sit against the others rather than collapsing to a single row.
  const bySalespersonMap = new Map<string, SalespersonRow>();
  for (const deal of scopedDeals) {
    const owner = deal.ownerName ?? 'Unassigned';
    const row =
      bySalespersonMap.get(owner) ??
      { owner, won: 0, wonValue: 0, lost: 0, open: 0, openValue: 0, winRate: null };

    if (deal.isClosedWon) {
      row.won += 1;
      row.wonValue += deal.amount.toNumber();
    } else if (deal.isClosed) {
      row.lost += 1;
    } else {
      row.open += 1;
      row.openValue += deal.amount.toNumber();
    }
    bySalespersonMap.set(owner, row);
  }

  const bySalesperson = [...bySalespersonMap.values()]
    .map((row) => ({
      ...row,
      // Same denominator convention as the Booking Rate KPI: deals *closed* in
      // the period, won plus lost — not every deal the rep touched.
      winRate: row.won + row.lost > 0 ? row.won / (row.won + row.lost) : null,
    }))
    .sort((a, b) => b.wonValue - a.wonValue);

  const ownerFiltered = options.ownerName
    ? scopedDeals.filter((deal) => (deal.ownerName ?? 'Unassigned') === options.ownerName)
    : scopedDeals;

  const deals: DealRow[] = ownerFiltered
    .map((deal) => ({
      dealId: deal.dealId,
      dealName: deal.dealName ?? deal.dealId,
      divisionCode: deal.divisionCode,
      amount: deal.amount.toNumber(),
      dealstage: STAGE_LABELS[deal.dealstage ?? ''] ?? deal.dealstage ?? '—',
      owner: deal.ownerName ?? 'Unassigned',
      createdate: deal.createdate?.toISOString().slice(0, 10) ?? null,
      closedate: deal.closedate?.toISOString().slice(0, 10) ?? null,
      status: (deal.isClosedWon ? 'Won' : deal.isClosed ? 'Lost' : 'Open') as DealRow['status'],
      daysToClose:
        deal.createdate && deal.closedate
          ? Math.round((deal.closedate.getTime() - deal.createdate.getTime()) / 86_400_000)
          : null,
    }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 200);

  return {
    tiles,
    bookingRateDenominator,
    pipelineByStage,
    bookedVsBudget,
    bookedVsBudgetSeries,
    bookingsTrend,
    bookingsTrendSeries,
    deals,
    dealScope: {
      rangeLabel: options.range.label,
      ownerName: options.ownerName,
      shown: Math.min(ownerFiltered.length, 200),
      total: ownerFiltered.length,
    },
    bySalesperson,
    unavailable,
  };
}
