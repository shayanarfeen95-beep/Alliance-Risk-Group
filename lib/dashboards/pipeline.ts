import 'server-only';
import Decimal from 'decimal.js';
import { resolveKpi, CONSOLIDATED_CODE, type SemanticSession } from '@/lib/semantic/resolve';
import { monthBounds } from '@/lib/semantic/periods';
import type { KpiTileProps } from '@/components/dashboard/kpi-tile';
import type { DateRange } from './range';
import { buildKpiTiles } from './tiles';
import { boxState, type BoxScopeResolver } from './context';
import type { BoxFilterState } from './box-filter';

/**
 * The leadership pipeline view — the HubSpot board, inside this app.
 *
 * ARG's leadership read their pipeline in HubSpot and asked for the same thing
 * here. The point is not to imitate HubSpot's chrome; it is that a board is the
 * right shape for the question they actually ask, which is "where is everything
 * and what is stuck". A table sorted by amount cannot answer that.
 *
 * Two things this does that HubSpot's own board does not:
 *
 *   - It states the **weighted** value beside the raw one. A board of open deals
 *     footed at face value is a number nobody should plan against, and the
 *     probability is the stage's, not a guess per deal.
 *   - It shows **age in stage**, from stage history rather than the current
 *     stage. A deal that entered Proposal in January and is still there is the
 *     single most useful thing on this screen, and the current-stage field
 *     cannot tell you.
 */

/**
 * Stage order and the probability each carries.
 *
 * These are HubSpot's default deal stages and their default probabilities. Where
 * ARG uses a custom pipeline the stages arrive with their own ids and are shown
 * in the order they are first seen, with no probability — a weighted figure
 * against an invented probability would be worse than none, so the column says
 * "unweighted" instead.
 */
const DEFAULT_STAGES: Array<{ id: string; label: string; probability: number | null }> = [
  { id: 'appointmentscheduled', label: 'Appointment scheduled', probability: 0.2 },
  { id: 'qualifiedtobuy', label: 'Qualified to buy', probability: 0.4 },
  { id: 'presentationscheduled', label: 'Presentation scheduled', probability: 0.6 },
  { id: 'decisionmakerboughtin', label: 'Decision maker bought in', probability: 0.8 },
  { id: 'proposalsent', label: 'Proposal sent', probability: 0.75 },
  { id: 'contractsent', label: 'Contract sent', probability: 0.9 },
  { id: 'closedwon', label: 'Closed won', probability: 1 },
  { id: 'closedlost', label: 'Closed lost', probability: 0 },
];

const STAGE_INDEX = new Map(DEFAULT_STAGES.map((stage, index) => [stage.id, index]));

export interface PipelineDealCard {
  dealId: string;
  name: string;
  amount: number;
  owner: string;
  divisionCode: string | null;
  /** Days since the deal entered this stage, from stage history. */
  daysInStage: number | null;
  /** Days since it was created. */
  ageDays: number | null;
  closedate: string | null;
  /** True when it has sat in this stage longer than the stage's median. */
  isStalled: boolean;
}

export interface PipelineStage {
  id: string;
  label: string;
  probability: number | null;
  count: number;
  value: number;
  weightedValue: number | null;
  /** Median days deals currently in this stage have been here. */
  medianDaysInStage: number | null;
  deals: PipelineDealCard[];
}

export interface OwnerRow {
  owner: string;
  open: number;
  openValue: number;
  weighted: number | null;
  won: number;
  wonValue: number;
  lost: number;
  winRate: number | null;
}

export interface PipelineViewModel {
  tiles: KpiTileProps[];
  boxes: { board: BoxFilterState; owners: BoxFilterState; movement: BoxFilterState };
  stages: PipelineStage[];
  /** Face value and weighted value of everything open, in scope. */
  totals: { open: number; openValue: number; weighted: number | null; unattributed: number };
  owners: OwnerRow[];
  /** Deals that entered a stage in the range, by stage — what moved. */
  movement: Array<{ stage: string; label: string; entered: number; value: number }>;
  scopeLabel: string;
  /** Set when HubSpot cannot be broken down by division. */
  unavailable?: string;
}

export interface PipelineOptions {
  range: DateRange;
  ownerName: string | null;
  boxScope: BoxScopeResolver;
  /** Stage entries in the window, read from fact_deal_stage_history. */
  stageEntries: Array<{ dealId: string; stage: string; enteredAt: Date }>;
}

const TILES: Array<{ id: string; hint: string }> = [
  { id: 'pipeline_value', hint: 'SUM(amount) where the deal is still open, as of the reporting date' },
  { id: 'dollars_booked', hint: 'SUM(amount) where closed-won and closedate in period' },
  { id: 'count_of_bookings', hint: 'COUNT(deals) where closed-won and closedate in period' },
  { id: 'average_booking_value', hint: 'Dollars booked ÷ count of bookings' },
  {
    id: 'booking_rate_pct',
    hint: 'Closed-won ÷ deals CLOSED in the period (won + lost) — not a share of open pipeline',
  },
  { id: 'average_close_time', hint: 'AVG(closedate − createdate) for deals won in the period' },
];

function label(stageId: string): string {
  const known = DEFAULT_STAGES.find((stage) => stage.id === stageId);
  if (known) return known.label;
  // A custom stage id, made readable without pretending to know its meaning.
  return stageId
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (character) => character.toUpperCase());
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  // Whole days: "207.5 days here, typically" reads like false precision on a
  // figure whose input is a date.
  return Math.round(
    sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!,
  );
}

export function loadPipeline(
  session: SemanticSession,
  divisionCode: string,
  options: PipelineOptions,
): PipelineViewModel {
  const { boxScope } = options;
  const tiles = buildKpiTiles(boxScope, TILES, 'pipeline');

  const boardScope = boxScope('pipeline_board');
  const ownersScope = boxScope('pipeline_owners');
  const movementScope = boxScope('pipeline_movement');

  const inScope = (boxDivision: string) => (code: string | null) =>
    boxDivision === CONSOLIDATED_CODE || (code !== null && code === boxDivision);

  const unavailable = resolveKpi(session, 'pipeline_value', divisionCode).unavailable?.detail;

  // --- The board ----------------------------------------------------------
  const boardInScope = inScope(boardScope.divisionCode);
  const asOf = monthBounds(boardScope.month).endExclusive;

  const openDeals = boardScope.session.bundle.deals.filter(
    (deal) => !deal.isClosed && boardInScope(deal.divisionCode),
  );

  // When a deal entered its current stage. Stage history is the only honest
  // source: the deal's own fields say what stage it is in, never since when.
  const enteredStageAt = new Map<string, Date>();
  for (const entry of options.stageEntries) {
    const existing = enteredStageAt.get(`${entry.dealId}|${entry.stage}`);
    if (!existing || entry.enteredAt > existing) {
      enteredStageAt.set(`${entry.dealId}|${entry.stage}`, entry.enteredAt);
    }
  }

  const days = (from: Date | null | undefined): number | null =>
    from ? Math.max(0, Math.round((asOf.getTime() - from.getTime()) / 86_400_000)) : null;

  const byStage = new Map<string, PipelineDealCard[]>();
  for (const deal of openDeals) {
    const stageId = deal.dealstage ?? 'unknown';
    const entered = enteredStageAt.get(`${deal.dealId}|${stageId}`) ?? null;

    const card: PipelineDealCard = {
      dealId: deal.dealId,
      name: deal.dealName ?? deal.dealId,
      amount: deal.amount.toNumber(),
      owner: deal.ownerName ?? 'Unassigned',
      divisionCode: deal.divisionCode,
      daysInStage: days(entered),
      ageDays: days(deal.createdate),
      closedate: deal.closedate?.toISOString().slice(0, 10) ?? null,
      isStalled: false,
    };

    const bucket = byStage.get(stageId) ?? [];
    bucket.push(card);
    byStage.set(stageId, bucket);
  }

  const stages: PipelineStage[] = [...byStage.entries()]
    .map(([id, cards]) => {
      const known = DEFAULT_STAGES.find((stage) => stage.id === id);
      const probability = known?.probability ?? null;
      const value = cards.reduce((sum, card) => sum + card.amount, 0);
      const medianDays = median(
        cards.map((card) => card.daysInStage).filter((value): value is number => value !== null),
      );

      // Stalled is relative to this stage's own median, not a fixed number of
      // days: a proposal sitting three weeks is normal, a contract sitting three
      // weeks is not.
      const withStall = cards
        .map((card) => ({
          ...card,
          isStalled:
            medianDays !== null && card.daysInStage !== null && card.daysInStage > medianDays * 2,
        }))
        .sort((a, b) => b.amount - a.amount);

      return {
        id,
        label: label(id),
        probability,
        count: cards.length,
        value,
        weightedValue: probability === null ? null : value * probability,
        medianDaysInStage: medianDays,
        deals: withStall.slice(0, 25),
      };
    })
    .sort((a, b) => (STAGE_INDEX.get(a.id) ?? 99) - (STAGE_INDEX.get(b.id) ?? 99));

  const openValue = stages.reduce((sum, stage) => sum + stage.value, 0);
  const anyWeighted = stages.some((stage) => stage.weightedValue !== null);
  const weighted = anyWeighted
    ? stages.reduce((sum, stage) => sum + (stage.weightedValue ?? 0), 0)
    : null;

  // --- Owners -------------------------------------------------------------
  const ownersInScope = inScope(ownersScope.divisionCode);
  const rangeStart = new Date(`${options.range.from}T00:00:00Z`);
  const rangeEnd = monthBounds(options.range.to).endExclusive;

  const ownerMap = new Map<string, OwnerRow>();
  for (const deal of ownersScope.session.bundle.deals) {
    if (!ownersInScope(deal.divisionCode)) continue;

    const closedInRange =
      deal.closedate && deal.closedate >= rangeStart && deal.closedate < rangeEnd;
    if (deal.isClosed && !closedInRange) continue;

    const owner = deal.ownerName ?? 'Unassigned';
    const row =
      ownerMap.get(owner) ??
      ({ owner, open: 0, openValue: 0, weighted: 0, won: 0, wonValue: 0, lost: 0, winRate: null } as OwnerRow);

    if (deal.isClosedWon) {
      row.won += 1;
      row.wonValue += deal.amount.toNumber();
    } else if (deal.isClosed) {
      row.lost += 1;
    } else {
      row.open += 1;
      row.openValue += deal.amount.toNumber();
      const probability =
        DEFAULT_STAGES.find((stage) => stage.id === deal.dealstage)?.probability ?? null;
      if (probability !== null && row.weighted !== null) {
        row.weighted += deal.amount.toNumber() * probability;
      }
    }
    ownerMap.set(owner, row);
  }

  const owners = [...ownerMap.values()]
    .map((row) => ({
      ...row,
      // The same denominator the Booking Rate KPI uses: deals closed, won plus
      // lost. Never a share of open pipeline.
      winRate: row.won + row.lost > 0 ? row.won / (row.won + row.lost) : null,
    }))
    .filter((row) => !options.ownerName || row.owner === options.ownerName)
    .sort((a, b) => b.openValue - a.openValue);

  // --- What moved ---------------------------------------------------------
  const movementInScope = inScope(movementScope.divisionCode);
  const dealsById = new Map(
    movementScope.session.bundle.deals.map((deal) => [deal.dealId, deal] as const),
  );

  const movementTotals = new Map<string, { entered: number; value: Decimal }>();
  for (const entry of options.stageEntries) {
    if (entry.enteredAt < rangeStart || entry.enteredAt >= rangeEnd) continue;
    const deal = dealsById.get(entry.dealId);
    if (!deal || !movementInScope(deal.divisionCode)) continue;

    const bucket = movementTotals.get(entry.stage) ?? { entered: 0, value: new Decimal(0) };
    bucket.entered += 1;
    bucket.value = bucket.value.plus(deal.amount);
    movementTotals.set(entry.stage, bucket);
  }

  const movement = [...movementTotals.entries()]
    .map(([stage, totals]) => ({
      stage,
      label: label(stage),
      entered: totals.entered,
      value: totals.value.toNumber(),
    }))
    .sort((a, b) => (STAGE_INDEX.get(a.stage) ?? 99) - (STAGE_INDEX.get(b.stage) ?? 99));

  return {
    tiles,
    boxes: {
      board: boxState(boardScope),
      owners: boxState(ownersScope),
      movement: boxState(movementScope),
    },
    stages,
    totals: {
      open: openDeals.length,
      openValue,
      weighted,
      unattributed: openDeals.filter((deal) => deal.divisionCode === null).length,
    },
    owners,
    movement,
    scopeLabel: options.range.label,
    unavailable,
  };
}
