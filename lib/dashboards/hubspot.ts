import 'server-only';
import Decimal from 'decimal.js';
import { resolveKpi, CONSOLIDATED_CODE, type SemanticSession } from '@/lib/semantic/resolve';
import { monthBounds, formatMonthShort, type MonthKey } from '@/lib/semantic/periods';
import type { KpiTileProps } from '@/components/dashboard/kpi-tile';
import type { DateRange } from './range';

/**
 * The HubSpot Leadership Dashboard — the punch-list item from the 13 August
 * meeting: "Hubspot Leadership Dashboard 2026 — build in vercel app."
 *
 * The brief was that this should read the way HubSpot reads, and that is a
 * statement about *shape*, not decoration. HubSpot's reporting answers a
 * pipeline question in four particular forms, and sales leaders read them
 * fluently:
 *
 *   - a **funnel** by deal stage, with the conversion between each pair;
 *   - a **board**, one column per stage, deals as cards inside it;
 *   - a **leaderboard** by owner;
 *   - **attribution** by original source.
 *
 * So those are the four, in that order, under one filter strip.
 *
 * What does *not* come from HubSpot's conventions is any number: every figure
 * here is either resolved through `resolveKpi` or counted from the same deal
 * records the Sales dashboard counts. A HubSpot-shaped view that computed its
 * own totals would be exactly the second definition of a metric the whole
 * architecture exists to prevent — and the fact that it looked authoritative
 * would make it worse, not better.
 */

export interface FunnelStage {
  stage: string;
  label: string;
  /** Deals that ever ENTERED this stage, from stage history. */
  count: number;
  value: number;
  /** Share of the deals that entered the first stage. */
  ofTotalPct: number | null;
  /** Conversion from the stage immediately above. Null on the first stage. */
  fromPreviousPct: number | null;
}

export interface BoardCard {
  dealId: string;
  dealName: string;
  amount: number;
  owner: string;
  closedate: string | null;
  ageDays: number | null;
  divisionCode: string | null;
}

export interface BoardColumn {
  stage: string;
  label: string;
  count: number;
  value: number;
  cards: BoardCard[];
  /** Cards beyond the ones shown, so the column can say so. */
  hidden: number;
}

export interface OwnerRow {
  owner: string;
  won: number;
  wonValue: number;
  open: number;
  openValue: number;
  lost: number;
  winRate: number | null;
  averageDealSize: number | null;
}

export interface SourceRow {
  source: string;
  leads: number;
  customers: number;
  conversionPct: number | null;
}

export interface HubspotViewModel {
  tiles: KpiTileProps[];
  funnel: FunnelStage[];
  board: BoardColumn[];
  owners: OwnerRow[];
  sources: SourceRow[];
  bookingsTrend: Array<{ x: string; xLabel: string } & Record<string, number | null | string>>;
  bookingsTrendSeries: Array<{ id: string; label: string; color: string }>;
  pipelines: string[];
  /** What the whole page is scoped to, stated rather than assumed. */
  scope: {
    rangeLabel: string;
    pipeline: string | null;
    ownerName: string | null;
    divisionLabel: string;
    dealsInScope: number;
  };
  /** Set when HubSpot cannot be attributed to the selected division. */
  unavailable?: string;
  /** Set when there is no stage history, so the funnel cannot be computed. */
  funnelUnavailable?: string;
  /** True when no deals have loaded at all — a different thing from an empty filter. */
  noData: boolean;
}

/**
 * Stage labels and their order.
 *
 * HubSpot's default deal pipeline, in pipeline order — which is the order a
 * funnel has to be drawn in and cannot be derived from the data, because a
 * stage with no deals in it still belongs in its place. An unrecognised stage
 * is shown under its raw id rather than dropped: a custom stage nobody told us
 * about is ARG's data, and hiding it would understate the pipeline.
 */
const STAGE_ORDER = [
  'appointmentscheduled',
  'qualifiedtobuy',
  'presentationscheduled',
  'proposalsent',
  'decisionmakerboughtin',
  'contractsent',
  'closedwon',
  'closedlost',
];

const STAGE_LABELS: Record<string, string> = {
  appointmentscheduled: 'Appointment scheduled',
  qualifiedtobuy: 'Qualified to buy',
  presentationscheduled: 'Presentation scheduled',
  proposalsent: 'Proposal sent',
  decisionmakerboughtin: 'Decision maker bought in',
  contractsent: 'Contract sent',
  closedwon: 'Closed won',
  closedlost: 'Closed lost',
};

function labelFor(stage: string): string {
  return (
    STAGE_LABELS[stage] ??
    stage.replace(/[_-]/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase())
  );
}

function stageRank(stage: string): number {
  const index = STAGE_ORDER.indexOf(stage);
  return index === -1 ? STAGE_ORDER.length : index;
}

const LEADERSHIP_TILES: Array<{ id: string; hint: string }> = [
  { id: 'dollars_booked', hint: 'SUM(amount) where closed-won and closedate in the reporting month' },
  { id: 'count_of_bookings', hint: 'COUNT(deals) where closed-won and closedate in the month' },
  { id: 'pipeline_value', hint: 'SUM(amount) of deals still open, as of the reporting date' },
  { id: 'booking_rate_pct', hint: 'Closed-won ÷ deals CLOSED in the period. Not a share of open pipeline.' },
  { id: 'new_proposals_sent', hint: 'Deals ENTERING the Proposal stage — from stage history, not current stage' },
  { id: 'meetings_completed', hint: 'COUNT(meetings) by meeting date in the period' },
  { id: 'average_booking_value', hint: 'Dollars booked ÷ count of bookings' },
  { id: 'average_close_time', hint: 'AVG(closedate − createdate) for deals won in the period' },
];

export interface HubspotOptions {
  range: DateRange;
  ownerName: string | null;
  /** Narrows to one HubSpot pipeline. Null shows all of them. */
  pipeline: string | null;
  /** Cards rendered per board column before it starts counting instead. */
  cardsPerColumn?: number;
}

const num = (result: { value: Decimal | null }): number | null =>
  result.value ? result.value.toNumber() : null;

export function loadHubspotDashboard(
  session: SemanticSession,
  divisionCode: string,
  divisionColors: Record<string, string>,
  options: HubspotOptions,
): HubspotViewModel {
  const { period, bundle } = session;
  const isConsolidated = divisionCode === CONSOLIDATED_CODE;
  const cardsPerColumn = options.cardsPerColumn ?? 6;

  const divisionLabel = isConsolidated
    ? 'ARG Total'
    : (bundle.divisions.find((division) => division.divisionCode === divisionCode)?.divisionName ??
      divisionCode);

  const tiles: KpiTileProps[] = LEADERSHIP_TILES.map(({ id, hint }) => {
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

  const inScope = (code: string | null) =>
    isConsolidated || (code !== null && code === divisionCode);

  const rangeStart = monthBounds(options.range.from).start;
  // Exclusive, so the last month of the range is included whole. A `<=` against
  // the first of the month would silently drop everything after midnight on the
  // 1st — a month of deals, on the month a reader is most likely looking at.
  const rangeEnd = monthBounds(options.range.to).endExclusive;

  const pipelines = [
    ...new Set(bundle.deals.map((deal) => deal.pipeline).filter((value): value is string => Boolean(value))),
  ].sort();

  // One filter predicate for every panel below. Four panels each applying the
  // filters in their own way is four chances for the board to disagree with the
  // funnel about which deals are in scope — and a leadership dashboard whose
  // panels disagree is worse than no dashboard.
  const matches = (deal: (typeof bundle.deals)[number]): boolean => {
    if (!inScope(deal.divisionCode)) return false;
    if (options.pipeline && deal.pipeline !== options.pipeline) return false;
    if (options.ownerName && (deal.ownerName ?? 'Unassigned') !== options.ownerName) return false;
    return true;
  };

  // Deals the range applies to: closed inside it, or still open. An open deal
  // has no date to filter on and dropping it would empty the pipeline board
  // whenever anybody narrowed the dates.
  const inRange = (deal: (typeof bundle.deals)[number]): boolean => {
    if (!deal.isClosed) return true;
    if (!deal.closedate) return false;
    return deal.closedate >= rangeStart && deal.closedate < rangeEnd;
  };

  const scoped = bundle.deals.filter((deal) => matches(deal) && inRange(deal));

  // --- Current stage distribution ----------------------------------------
  // Used by the board, where "which stage is this deal in now" is the question.
  const stageTotals = new Map<string, { count: number; value: Decimal }>();
  for (const deal of scoped) {
    const stage = deal.dealstage ?? 'unknown';
    const entry = stageTotals.get(stage) ?? { count: 0, value: new Decimal(0) };
    entry.count += 1;
    entry.value = entry.value.plus(deal.amount);
    stageTotals.set(stage, entry);
  }

  const orderedStages = [...stageTotals.entries()].sort(
    ([a], [b]) => stageRank(a) - stageRank(b) || a.localeCompare(b),
  );

  // --- Funnel ------------------------------------------------------------
  //
  // Counted from stage history: deals that EVER reached each stage, not deals
  // sitting in it now. The distinction is the difference between a funnel and a
  // nonsense chart. A deal closed-won last week occupies exactly one stage
  // today, so a current-stage "funnel" shows more deals in Closed Won than in
  // Proposal Sent and reports conversions above 100% — which is what this page
  // did before, and it is the kind of number that costs a dashboard its
  // credibility on first read.
  const scopedIds = new Set(scoped.map((deal) => deal.dealId));
  const amountById = new Map(scoped.map((deal) => [deal.dealId, deal.amount]));

  const reachedByStage = new Map<string, Set<string>>();
  for (const entry of bundle.stageEntries) {
    if (!scopedIds.has(entry.dealId)) continue;
    const reached = reachedByStage.get(entry.stage) ?? new Set<string>();
    reached.add(entry.dealId);
    reachedByStage.set(entry.stage, reached);
  }

  // Closed-lost is excluded from the funnel and shown on the board. A funnel
  // that counts losses as a stage reads as though deals progress into losing.
  const funnelStages = [...reachedByStage.entries()]
    .filter(([stage]) => stage !== 'closedlost')
    .sort(([a], [b]) => stageRank(a) - stageRank(b) || a.localeCompare(b));

  const entryCount = funnelStages[0]?.[1].size ?? 0;

  const funnel: FunnelStage[] = funnelStages.map(([stage, reached], index) => {
    const previous = index > 0 ? funnelStages[index - 1]![1].size : null;
    const value = [...reached].reduce(
      (sum, dealId) => sum.plus(amountById.get(dealId) ?? 0),
      new Decimal(0),
    );

    return {
      stage,
      label: labelFor(stage),
      count: reached.size,
      value: value.toNumber(),
      ofTotalPct: entryCount > 0 ? (reached.size / entryCount) * 100 : null,
      fromPreviousPct: previous && previous > 0 ? (reached.size / previous) * 100 : null,
    };
  });

  // --- Board -------------------------------------------------------------
  const asOf = monthBounds(period.month).endExclusive;

  const board: BoardColumn[] = orderedStages.map(([stage, totals]) => {
    const cards = scoped
      .filter((deal) => (deal.dealstage ?? 'unknown') === stage)
      .sort((a, b) => b.amount.comparedTo(a.amount))
      .map((deal) => ({
        dealId: deal.dealId,
        dealName: deal.dealName ?? `Deal ${deal.dealId}`,
        amount: deal.amount.toNumber(),
        // An unassigned deal is a real state and must stay visible under a
        // name a person can filter on, not vanish.
        owner: deal.ownerName ?? 'Unassigned',
        closedate: deal.closedate ? deal.closedate.toISOString().slice(0, 10) : null,
        ageDays: deal.createdate
          ? Math.max(0, Math.round((asOf.getTime() - deal.createdate.getTime()) / 86_400_000))
          : null,
        divisionCode: deal.divisionCode,
      }));

    return {
      stage,
      label: labelFor(stage),
      count: totals.count,
      value: totals.value.toNumber(),
      cards: cards.slice(0, cardsPerColumn),
      hidden: Math.max(0, cards.length - cardsPerColumn),
    };
  });

  // --- Owner leaderboard -------------------------------------------------
  const ownerTotals = new Map<
    string,
    { won: number; wonValue: Decimal; open: number; openValue: Decimal; lost: number }
  >();

  for (const deal of scoped) {
    const owner = deal.ownerName ?? 'Unassigned';
    const entry =
      ownerTotals.get(owner) ??
      { won: 0, wonValue: new Decimal(0), open: 0, openValue: new Decimal(0), lost: 0 };

    if (deal.isClosedWon) {
      entry.won += 1;
      entry.wonValue = entry.wonValue.plus(deal.amount);
    } else if (deal.isClosed) {
      entry.lost += 1;
    } else {
      entry.open += 1;
      entry.openValue = entry.openValue.plus(deal.amount);
    }
    ownerTotals.set(owner, entry);
  }

  const owners: OwnerRow[] = [...ownerTotals.entries()]
    .map(([owner, totals]) => {
      const closed = totals.won + totals.lost;
      return {
        owner,
        won: totals.won,
        wonValue: totals.wonValue.toNumber(),
        open: totals.open,
        openValue: totals.openValue.toNumber(),
        lost: totals.lost,
        // Same denominator as the Booking Rate KPI: deals closed, not deals
        // touched. Two win rates on two pages would be the drift in miniature.
        winRate: closed > 0 ? (totals.won / closed) * 100 : null,
        averageDealSize: totals.won > 0 ? totals.wonValue.dividedBy(totals.won).toNumber() : null,
      };
    })
    .sort((a, b) => b.wonValue - a.wonValue);

  // --- Source attribution ------------------------------------------------
  const sourceTotals = new Map<string, { leads: number; customers: number }>();
  for (const contact of bundle.contacts) {
    if (!inScope(contact.divisionCode)) continue;
    const leadDate = contact.becameLeadDate;
    if (!leadDate || leadDate < rangeStart || leadDate >= rangeEnd) continue;

    const source = contact.originalSource ?? 'Unknown';
    const entry = sourceTotals.get(source) ?? { leads: 0, customers: 0 };
    entry.leads += 1;
    if (contact.becameCustomerDate) entry.customers += 1;
    sourceTotals.set(source, entry);
  }

  const sources: SourceRow[] = [...sourceTotals.entries()]
    .map(([source, totals]) => ({
      source: source
        .replace(/_/g, ' ')
        .toLowerCase()
        .replace(/\b\w/g, (character) => character.toUpperCase()),
      leads: totals.leads,
      customers: totals.customers,
      conversionPct: totals.leads > 0 ? (totals.customers / totals.leads) * 100 : null,
    }))
    .sort((a, b) => b.leads - a.leads);

  // --- Bookings trend ----------------------------------------------------
  // Through resolveKpi, month by month, so this line and the Dollars Booked
  // tile above it cannot disagree.
  const trendMonths: MonthKey[] = period.trailingTwelveMonths;
  const bookingsTrend = trendMonths.map((month) => {
    const booked = resolveKpi(session, 'dollars_booked', divisionCode, { month });
    const pipeline = resolveKpi(session, 'pipeline_value', divisionCode, { month });
    return {
      x: month,
      xLabel: formatMonthShort(month),
      booked: num(booked),
      pipeline: num(pipeline),
    };
  });

  const bookingsTrendSeries = [
    { id: 'booked', label: 'Dollars booked', color: divisionColors[divisionCode] ?? 'var(--series-1)' },
    { id: 'pipeline', label: 'Open pipeline', color: 'var(--series-3)' },
  ];

  const unavailable = resolveKpi(session, 'dollars_booked', divisionCode).unavailable?.detail;

  // A funnel with no stage history behind it is not an empty funnel — it is an
  // unanswerable question, and it has to read as one.
  const funnelUnavailable =
    scoped.length > 0 && bundle.stageEntries.length === 0
      ? 'No deal stage history has loaded, so the funnel cannot be built. It counts deals that ' +
        'entered each stage, which the current stage cannot tell you. Pull HubSpot deals — stage ' +
        'history comes with them.'
      : undefined;

  return {
    tiles,
    funnel,
    board,
    owners,
    sources,
    bookingsTrend,
    bookingsTrendSeries,
    pipelines,
    scope: {
      rangeLabel: options.range.label,
      pipeline: options.pipeline,
      ownerName: options.ownerName,
      divisionLabel,
      dealsInScope: scoped.length,
    },
    unavailable,
    funnelUnavailable,
    noData: bundle.deals.length === 0,
  };
}
