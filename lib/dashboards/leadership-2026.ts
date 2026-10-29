import 'server-only';
import Decimal from 'decimal.js';
import type { SemanticSession } from '@/lib/semantic/resolve';
import type { DealRecord } from '@/lib/semantic/facts';
import { formatMonthShort, addMonths, monthRange, type MonthKey } from '@/lib/semantic/periods';
import { SERIES_SLOTS } from '@/lib/charts/colors';
import { hasOption } from '@/lib/connectors/hubspot-fields';
import { LEADERSHIP_SCOPE, sameName, type LeadershipScope } from './leadership-scope';

/**
 * Leadership 2026 — the review, chart by chart, as Westport defined it.
 *
 * Every chart here is written against Westport's own definition (October 2026
 * corrections), quoted beside it in `definition` so the page can show what each
 * one counts. All of them read the deals `scopeLeadership` narrowed to — Line
 * of Business is Background Checks, Sales Pipeline — so none of them has to
 * repeat the filter, and none can forget it.
 *
 * Three kinds of time axis, because the definitions use three:
 *   - "This year": January to the reporting month, on the date the definition
 *     names (most often Date Compliance Review Completed).
 *   - Monthly trends with no year in the definition: the trailing twelve months.
 *   - Proposals: entered the Proposal stage this year.
 *
 * Where a field a chart is defined on has not loaded, the chart says so rather
 * than drawing zeros. "None happened" and "we never fetched it" are opposite
 * findings and look identical as a row of empty bars.
 */

/** A point on a monthly axis, in the shape ChartCard reads directly. */
export type MonthPoint = { x: string; xLabel: string; value: number | null; deals: number } & Record<
  string,
  string | number | null
>;

export interface Breakdown {
  key: string;
  label: string;
  count: number;
  amount: number;
}

/** A chart's monthly series together with the deals behind each bar. */
export interface MonthlySeries {
  points: MonthPoint[];
  /** Deal ids behind each month, keyed by the point's `x`. */
  drill: Record<string, string[]>;
  total: number;
  dealCount: number;
}

/** Totals and month-by-month for one breakdown, so a page can switch between them. */
export interface SourceBreakdown {
  ytd: Breakdown[];
  /** Deal ids per source, for the year-to-date rows. */
  idsBySource: Record<string, string[]>;
  monthly: {
    data: Array<{ x: string; xLabel: string } & Record<string, string | number | null>>;
    series: Array<{ id: string; label: string; color: string }>;
    /** Deal ids per bar segment, keyed `${x}|${seriesId}`, and per month by `x`. */
    drill: Record<string, string[]>;
  };
}

export interface Leadership2026 {
  /** "Jan 26 – Sep 26": the "this year" axis. */
  yearLabel: string;
  /** "Oct 25 – Sep 26": the trailing axis. */
  trailingLabel: string;
  mqlsByMonth: MonthlySeries;
  sqlsByMonth: MonthlySeries;
  dealsCreatedByMonth: MonthlySeries;
  pipelineAddedByMonth: MonthlySeries;
  pipelineLessLostByMonth: MonthlySeries;
  closedWonByMonth: MonthlySeries;
  closedLostByMonth: MonthlySeries;
  avgDealSizeByMonth: MonthlySeries;
  avgDealSizeIcpByMonth: MonthlySeries;
  complianceReviewsByMonth: MonthlySeries;
  complianceReviewsBySource: SourceBreakdown;
  dealsWonBySource: SourceBreakdown;
  proposalsThisYear: MonthlySeries;
  /** Each chart's definition, in Westport's words, keyed like the fields above. */
  definitions: Record<DefinedChart, string>;
  /** Which inputs are missing, named, so a zero is never mistaken for a fact. */
  gaps: string[];
}

export type DefinedChart =
  | 'mqlsByMonth'
  | 'sqlsByMonth'
  | 'dealsCreatedByMonth'
  | 'avgDealSizeByMonth'
  | 'avgDealSizeIcpByMonth'
  | 'pipelineAddedByMonth'
  | 'pipelineLessLostByMonth'
  | 'closedWonByMonth'
  | 'closedLostByMonth'
  | 'complianceReviewsByMonth'
  | 'complianceReviewsBySource'
  | 'dealsWonBySource'
  | 'proposalsThisYear';

const UNRECORDED = 'Not recorded';

/** Stage names, matched on the label rather than the portal-specific id. */
const PROPOSAL_STAGE = /proposal|quote/i;

/** At most this many sources get their own colour; the rest are grouped. */
const MAX_SOURCES = 7;

export function loadLeadership2026(
  scope: LeadershipScope,
  options: { trailingMonths?: number } = {},
): Leadership2026 {
  const { session, deals } = scope;
  const { bundle, period } = session;
  const trailing = monthRange(addMonths(period.month, -((options.trailingMonths ?? 12) - 1)), period.month);
  const year = period.month.slice(0, 4);
  const thisYear = monthRange(`${year}-01-01` as MonthKey, period.month);
  const yearStart = new Date(`${year}-01-01T00:00:00Z`);
  const yearEnd = new Date(`${Number(year) + 1}-01-01T00:00:00Z`);
  const inYear = (value: Date | null): value is Date =>
    value !== null && value >= yearStart && value < yearEnd;

  const gaps: string[] = [...scope.gaps];

  // --- Fields the definitions depend on ------------------------------------
  const complianceKnown = bundle.deals.some((deal) => deal.complianceReviewCompletedAt !== null);
  if (!complianceKnown && bundle.deals.length > 0) {
    gaps.push(
      'No deal carries a Date Compliance Review Completed yet, so compliance reviews, average deal ' +
        'size and the pipeline charts read as not available. The next HubSpot pull reads every deal ' +
        'again to fetch it.',
    );
  }
  const createdByKnown = bundle.deals.some((deal) => deal.createdByName !== null);
  const contactsKnown = bundle.contacts.some((contact) => contact.mqlEnteredAt !== null);
  if (!contactsKnown) {
    gaps.push(
      'No contact carries a Date entered Marketing Qualified Lead yet, so SQLs per month cannot be ' +
        'counted. They load with the “Marketing qualified leads” step of the next HubSpot pull.',
    );
  }

  // --- The monthly series ------------------------------------------------------
  const monthly = (
    axis: MonthKey[],
    rows: Array<{ id: string; date: Date | null; amount?: Decimal }>,
    measure: 'count' | 'amount' | 'average',
    available = true,
  ): MonthlySeries => {
    const inAxis = new Set(axis);
    const totals = new Map<string, Decimal>();
    const counts = new Map<string, number>();
    const drill: Record<string, string[]> = {};
    for (const row of rows) {
      if (!row.date) continue;
      const month = monthKeyOf(row.date);
      if (!inAxis.has(month)) continue;
      const add = measure === 'count' ? new Decimal(1) : (row.amount ?? new Decimal(0));
      totals.set(month, (totals.get(month) ?? new Decimal(0)).plus(add));
      counts.set(month, (counts.get(month) ?? 0) + 1);
      (drill[month] ??= []).push(row.id);
    }
    // Empty months are kept: a month nothing happened in is a finding, and
    // dropping it draws a continuous line straight over the gap.
    const points = axis.map((month) => {
      const total = totals.get(month) ?? new Decimal(0);
      const count = counts.get(month) ?? 0;
      const value = !available
        ? null
        : measure === 'average'
          ? count === 0
            ? null // an average of no deals is not zero
            : total.div(count).toNumber()
          : total.toNumber();
      return { x: month, xLabel: formatMonthShort(month), value, deals: count };
    });
    const all = [...totals.values()].reduce((sum, value) => sum.plus(value), new Decimal(0));
    const dealCount = [...counts.values()].reduce((sum, value) => sum + value, 0);
    return {
      points,
      drill: available ? drill : {},
      total: !available
        ? 0
        : measure === 'average'
          ? dealCount === 0
            ? 0
            : all.div(dealCount).toNumber()
          : all.toNumber(),
      dealCount,
    };
  };

  const amountOf = (deal: DealRecord) => ({ id: deal.dealId, amount: deal.amount });

  // MQLs: unchanged — contacts entering the stage, from lifecycle history.
  const mqlsByMonth = monthly(
    trailing,
    bundle.contacts.map((contact) => ({ id: contact.contactId, date: contact.becameMqlDate })),
    'count',
  );
  // Drill-downs list deals, and these are contacts.
  mqlsByMonth.drill = {};

  // SQLs: "Date entered Marketing Qualified Lead (Lifecycle Stage Pipeline) is
  // known, and Lead Source is any of Website, SHRM RFQ, Webinar, Trade
  // Show/Conference."
  const sqlsByMonth = monthly(
    trailing,
    bundle.contacts
      .filter((contact) =>
        LEADERSHIP_SCOPE.sqlLeadSources.some((source) => hasOption(contact.leadSource, source)),
      )
      .map((contact) => ({ id: contact.contactId, date: contact.mqlEnteredAt })),
    'count',
    contactsKnown,
  );
  sqlsByMonth.drill = {};

  // Deals created: "Line of Business is any of Background Checks, and Created
  // by is none of Sarah Roy."
  const dealsCreatedByMonth = monthly(
    trailing,
    deals
      .filter(
        (deal) => !LEADERSHIP_SCOPE.excludedCreators.some((name) => sameName(deal.createdByName, name)),
      )
      .map((deal) => ({ id: deal.dealId, date: deal.createdate })),
    'count',
  );
  if (!createdByKnown && bundle.deals.length > 0) {
    gaps.push(
      'No deal carries who created it yet, so deals created by month cannot leave out ' +
        `${LEADERSHIP_SCOPE.excludedCreators.join(', ')}'s deals until the next HubSpot pull fetches the field.`,
    );
  }

  // Everything defined on "Date Compliance Review Completed is this year".
  const reviewed = deals.filter((deal) => inYear(deal.complianceReviewCompletedAt));
  const byReview = (rows: DealRecord[]) =>
    rows.map((deal) => ({ ...amountOf(deal), date: deal.complianceReviewCompletedAt }));

  const complianceReviewsByMonth = monthly(thisYear, byReview(reviewed), 'count', complianceKnown);
  const pipelineAddedByMonth = monthly(thisYear, byReview(reviewed), 'amount', complianceKnown);
  const avgDealSizeByMonth = monthly(thisYear, byReview(reviewed), 'average', complianceKnown);

  // "…and Deal stage is any of Compliance Review, Qualified Discovery, Solution
  // Alignment, Contracting, Proposal, or Closed won/Onboarding." Closed lost,
  // and anything else, is what "minus closed lost" leaves out.
  const openStage = (deal: DealRecord) =>
    LEADERSHIP_SCOPE.openPipelineStages.some((name) => sameName(scope.stageLabel(deal.dealstage), name));
  const pipelineLessLostByMonth = monthly(
    thisYear,
    byReview(reviewed.filter(openStage)),
    'amount',
    complianceKnown,
  );

  // ICP: "Line of Business is any of Background Checks, and Amount is greater
  // than 10,000." The definition names no date; the month a deal was created
  // is the one HubSpot reports group on by default, and is stated on the chart.
  const avgDealSizeIcpByMonth = monthly(
    thisYear,
    deals
      .filter((deal) => deal.amount.gt(LEADERSHIP_SCOPE.icpMinimumAmount))
      .map((deal) => ({ ...amountOf(deal), date: deal.createdate })),
    'average',
  );

  // Closed won and closed lost, by close date.
  const closedWonByMonth = monthly(
    trailing,
    deals.filter((deal) => deal.isClosedWon).map((deal) => ({ ...amountOf(deal), date: deal.closedate })),
    'amount',
  );
  const closedLostByMonth = monthly(
    trailing,
    deals
      .filter((deal) => deal.isClosed && !deal.isClosedWon)
      .map((deal) => ({ ...amountOf(deal), date: deal.closedate })),
    'amount',
  );

  // Proposals: "The date a deal entered the Deal stage Proposals is This Year."
  // One per deal — the first time it entered, this year.
  const proposalStageIds = new Set(
    bundle.dealStages.filter((stage) => PROPOSAL_STAGE.test(stage.label)).map((stage) => stage.stageId),
  );
  proposalStageIds.add('proposalsent');
  const firstProposal = new Map<string, Date>();
  for (const entry of bundle.stageEntries) {
    if (!proposalStageIds.has(entry.stage) || !inYear(entry.enteredAt)) continue;
    const seen = firstProposal.get(entry.dealId);
    if (!seen || entry.enteredAt < seen) firstProposal.set(entry.dealId, entry.enteredAt);
  }
  const dealById = new Map(deals.map((deal) => [deal.dealId, deal]));
  const proposalsThisYear = monthly(
    thisYear,
    [...firstProposal.entries()]
      .filter(([dealId]) => dealById.has(dealId))
      .map(([dealId, enteredAt]) => ({ id: dealId, date: enteredAt, amount: dealById.get(dealId)!.amount })),
    'count',
  );

  // --- By lead source --------------------------------------------------------
  const complianceReviewsBySource = bySource(thisYear, reviewed, (deal) => deal.complianceReviewCompletedAt);
  const dealsWonBySource = bySource(
    thisYear,
    deals.filter((deal) => deal.isClosedWon && inYear(deal.closedate)),
    (deal) => deal.closedate,
  );

  if (bundle.dealStages.length > 0 && proposalStageIds.size <= 1) {
    gaps.push(
      'No deal stage in this portal has a name mentioning “proposal”, so proposals cannot be ' +
        'counted from stage history.',
    );
  }

  const lob = LEADERSHIP_SCOPE.lineOfBusiness;
  const definitions: Record<DefinedChart, string> = {
    mqlsByMonth: 'Contacts by the month they entered Marketing Qualified Lead, from lifecycle-stage history.',
    sqlsByMonth: `Date entered “Marketing Qualified Lead (Lifecycle Stage Pipeline)” is known, and Lead Source is any of ${LEADERSHIP_SCOPE.sqlLeadSources.join(', ')}. Counted in the month the contact entered MQL.`,
    dealsCreatedByMonth: `Line of Business is any of ${lob}, and Created by is none of ${LEADERSHIP_SCOPE.excludedCreators.join(', ')}. By create date.`,
    avgDealSizeByMonth: `Date Compliance Review Completed is this year, and Line of Business is any of ${lob}. The average amount of every such deal, whatever its value or stage, by the month its review completed.`,
    avgDealSizeIcpByMonth: `Line of Business is any of ${lob}, and Amount is greater than ${LEADERSHIP_SCOPE.icpMinimumAmount.toLocaleString('en-US')}. Average amount, by the month the deal was created.`,
    pipelineAddedByMonth: `Line of Business is any of ${lob}, and Date Compliance Review Completed is this year. Deal amount, by the month the review completed.`,
    pipelineLessLostByMonth: `As total pipeline value, and Deal stage is any of ${LEADERSHIP_SCOPE.openPipelineStages.join(', ')} (${LEADERSHIP_SCOPE.pipeline}).`,
    closedWonByMonth: `Line of Business is any of ${lob}. Won amount, by close date.`,
    closedLostByMonth: `Line of Business is any of ${lob}. Amount of deals closed lost, by close date.`,
    complianceReviewsByMonth: `Line of Business is any of ${lob}, and Date Compliance Review Completed is this year. Deals, by the month the review completed.`,
    complianceReviewsBySource: `Line of Business is any of ${lob}, and Date Compliance Review Completed is this year. By the deal's lead source.`,
    dealsWonBySource: `Line of Business is any of ${lob}, closed won this year. By the deal's lead source.`,
    proposalsThisYear: `The date a deal entered the Proposal stage is this year, and Line of Business is any of ${lob}. Each deal once, in the month it first entered.`,
  };

  return {
    yearLabel: `${formatMonthShort(thisYear[0]!)} – ${formatMonthShort(thisYear[thisYear.length - 1]!)}`,
    trailingLabel: `${formatMonthShort(trailing[0]!)} – ${formatMonthShort(trailing[trailing.length - 1]!)}`,
    mqlsByMonth,
    sqlsByMonth,
    dealsCreatedByMonth,
    pipelineAddedByMonth,
    pipelineLessLostByMonth,
    closedWonByMonth,
    closedLostByMonth,
    avgDealSizeByMonth,
    avgDealSizeIcpByMonth,
    complianceReviewsByMonth,
    complianceReviewsBySource,
    dealsWonBySource,
    proposalsThisYear,
    definitions,
    gaps,
  };
}

/** One breakdown by the deal's lead source: year-to-date totals and month by month. */
function bySource(
  axis: MonthKey[],
  deals: DealRecord[],
  dateOf: (deal: DealRecord) => Date | null,
): SourceBreakdown {
  const sourceOf = (deal: DealRecord) => deal.sourceLabel ?? UNRECORDED;
  const inAxis = new Set(axis);
  const rows = deals.filter((deal) => {
    const value = dateOf(deal);
    return value !== null && inAxis.has(monthKeyOf(value));
  });

  const ytd = tallyDeals(rows.map((deal) => ({ key: sourceOf(deal), amount: deal.amount })));
  const idsBySource: Record<string, string[]> = {};
  for (const deal of rows) (idsBySource[sourceOf(deal)] ??= []).push(deal.dealId);

  // The largest sources keep their own colour; the rest are one stated group,
  // so the bars still add up to every deal.
  const top = ytd.slice(0, MAX_SOURCES).map((row) => row.key);
  const OTHER = 'Other sources';
  const seriesOf = (deal: DealRecord) => (top.includes(sourceOf(deal)) ? sourceOf(deal) : OTHER);
  const seriesIds = [...top, ...(ytd.length > MAX_SOURCES ? [OTHER] : [])];

  const drill: Record<string, string[]> = {};
  const data = axis.map((month) => {
    const row: { x: string; xLabel: string } & Record<string, string | number | null> = {
      x: month,
      xLabel: formatMonthShort(month),
    };
    for (const id of seriesIds) row[id] = 0;
    for (const deal of rows) {
      if (monthKeyOf(dateOf(deal)!) !== month) continue;
      const id = seriesOf(deal);
      row[id] = (row[id] as number) + 1;
      (drill[`${month}|${id}`] ??= []).push(deal.dealId);
      (drill[month] ??= []).push(deal.dealId);
    }
    return row;
  });

  return {
    ytd,
    idsBySource,
    monthly: {
      data,
      series: seriesIds.map((id, index) => ({
        id,
        label: id,
        color: SERIES_SLOTS[index % SERIES_SLOTS.length]!,
      })),
      drill,
    },
  };
}

function monthKeyOf(date: Date): MonthKey {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

function tallyDeals(rows: Array<{ key: string; amount: Decimal }>): Breakdown[] {
  const totals = new Map<string, { count: number; amount: Decimal }>();
  for (const row of rows) {
    const entry = totals.get(row.key) ?? { count: 0, amount: new Decimal(0) };
    entry.count += 1;
    entry.amount = entry.amount.plus(row.amount);
    totals.set(row.key, entry);
  }
  return [...totals.entries()]
    .map(([key, entry]) => ({
      key,
      label: key,
      count: entry.count,
      amount: entry.amount.toNumber(),
    }))
    .sort((a, b) => b.count - a.count || b.amount - a.amount || a.label.localeCompare(b.label));
}
