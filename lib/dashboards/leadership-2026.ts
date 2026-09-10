import 'server-only';
import Decimal from 'decimal.js';
import { CONSOLIDATED_CODE, type SemanticSession } from '@/lib/semantic/resolve';
import { monthBounds, formatMonthShort, addMonths, monthRange, type MonthKey } from '@/lib/semantic/periods';
import { SERIES_SLOTS } from '@/lib/charts/colors';

/**
 * Leadership 2026 — the panels ARG asked for by name.
 *
 * Every one of these is counted from the same records the rest of the app
 * counts. What is new is not arithmetic, it is that three of these questions
 * could not previously be ASKED, because the fields they depend on were never
 * landed:
 *
 *   MQLs and SQLs by month need the date a contact reached that stage. HubSpot's
 *   documented `hs_lifecyclestage_*_date` fields are empty in ARG's portal, so
 *   this reads the transition out of the property's history instead.
 *
 *   Proposals need to know which stage IS the proposal stage. Stage ids are
 *   opaque — ARG's is `presentationscheduled` — so the labels are loaded as
 *   reference data and matched on.
 *
 *   Compliance reviews are the same problem: the stage id is `1383067404`.
 *
 * Where a field has not been loaded, the panel says so rather than reporting
 * zero. That distinction is the whole reason these are worth building: a
 * leadership review that cannot tell "none happened" from "we never fetched it"
 * is worse than no review.
 */

/** A point on a monthly axis, in the shape ChartCard reads directly. */
export type MonthPoint = { x: string; xLabel: string; value: number } & Record<
  string,
  string | number | null
>;

export interface Breakdown {
  key: string;
  label: string;
  count: number;
  amount: number;
}

export interface Leadership2026 {
  /** Trailing months the whole panel is drawn over. */
  monthsLabel: string;
  mqlsByMonth: MonthPoint[];
  sqlsByMonth: MonthPoint[];
  dealsCreatedByMonth: MonthPoint[];
  pipelineAddedByMonth: MonthPoint[];
  closedWonByMonth: MonthPoint[];
  avgDealSizeByMonth: MonthPoint[];
  /** Average deal size by month, one series per ICP tier. */
  avgDealSizeByIcp: {
    data: Array<{ x: string; xLabel: string } & Record<string, string | number | null>>;
    series: Array<{ id: string; label: string; color: string }>;
  };
  complianceReviews: { deals: number; meetings: number; byMonth: MonthPoint[] };
  complianceReviewsBySource: Breakdown[];
  proposalsThisYear: { count: number; amount: number; byMonth: MonthPoint[] };
  dealsWonBySource: Breakdown[];
  /** Which inputs are missing, named, so a zero is never mistaken for a fact. */
  gaps: string[];
}

/** Stage names, matched on the label rather than the portal-specific id. */
const PROPOSAL_STAGE = /proposal|quote/i;
const COMPLIANCE_STAGE = /compliance/i;
const COMPLIANCE_MEETING = /compliance/i;

const UNRECORDED = 'Not recorded';
const NO_TIER = 'No tier set';

export function loadLeadership2026(
  session: SemanticSession,
  divisionCode: string,
  options: { trailingMonths?: number } = {},
): Leadership2026 {
  const { bundle, period } = session;
  const months = options.trailingMonths ?? 12;
  const axis = monthRange(addMonths(period.month, -(months - 1)), period.month);
  const isConsolidated = divisionCode === CONSOLIDATED_CODE;
  const inScope = (code: string | null) =>
    isConsolidated || (code !== null && code === divisionCode);

  const gaps: string[] = [];

  // Stage labels. Without them, "reached the Proposal stage" is unanswerable
  // rather than zero — and saying zero would be a lie the review would act on.
  const stageLabel = new Map(bundle.dealStages.map((stage) => [stage.stageId, stage.label]));
  if (bundle.dealStages.length === 0) {
    gaps.push(
      'Deal stage names have not been loaded, so proposals and compliance reviews cannot be ' +
        'identified — their stage ids carry no words. Pull HubSpot to load them.',
    );
  }

  const labelOf = (stageId: string | null): string =>
    stageId ? (stageLabel.get(stageId) ?? stageId) : UNRECORDED;

  const deals = bundle.deals.filter((deal) => inScope(deal.divisionCode));
  const contacts = bundle.contacts.filter((contact) => inScope(contact.divisionCode));

  // --- Monthly series ------------------------------------------------------
  const bucket = (
    rows: Array<{ date: Date | null; amount?: Decimal }>,
    measure: 'count' | 'amount',
  ): MonthPoint[] => {
    const totals = new Map<string, Decimal>();
    for (const row of rows) {
      if (!row.date) continue;
      const key = monthKeyOf(row.date);
      const add = measure === 'amount' ? (row.amount ?? new Decimal(0)) : new Decimal(1);
      totals.set(key, (totals.get(key) ?? new Decimal(0)).plus(add));
    }
    // Empty months are kept: a month nothing happened in is a finding, and
    // dropping it draws a continuous line straight over the gap.
    return axis.map((month) => ({
      x: month,
      xLabel: formatMonthShort(month),
      value: (totals.get(month) ?? new Decimal(0)).toNumber(),
    }));
  };

  const mqlsByMonth = bucket(contacts.map((c) => ({ date: c.becameMqlDate })), 'count');
  const sqlsByMonth = bucket(contacts.map((c) => ({ date: c.becameSqlDate })), 'count');

  if (contacts.length > 0 && contacts.every((contact) => contact.becameMqlDate === null)) {
    gaps.push(
      'No contact carries a date for reaching Marketing Qualified Lead, so MQLs by month cannot ' +
        'be counted. HubSpot records the transition only in lifecycle-stage history — pull ' +
        'contacts again to read it.',
    );
  }

  const dealsCreatedByMonth = bucket(deals.map((d) => ({ date: d.createdate })), 'count');
  const pipelineAddedByMonth = bucket(
    deals.map((d) => ({ date: d.createdate, amount: d.amount })),
    'amount',
  );

  // Won deals inside the window the whole panel is drawn over. Without the
  // window the attribution tables would silently cover all of history while the
  // charts beside them covered twelve months, and the two would disagree.
  const windowStart = monthBounds(axis[0]!).start;
  const windowEnd = monthBounds(axis[axis.length - 1]!).endExclusive;
  const inWindow = (date: Date | null) =>
    date !== null && date >= windowStart && date < windowEnd;

  const won = deals.filter((deal) => deal.isClosedWon && inWindow(deal.closedate));
  const closedWonByMonth = bucket(
    won.map((d) => ({ date: d.closedate, amount: d.amount })),
    'amount',
  );

  // Average deal size: won value divided by won COUNT, per month. Dividing the
  // year's value by the year's count instead would weight big months twice.
  const wonCountByMonth = bucket(won.map((d) => ({ date: d.closedate })), 'count');
  const avgDealSizeByMonth = closedWonByMonth.map((point, index) => {
    const count = wonCountByMonth[index]?.value ?? 0;
    return { ...point, value: count === 0 ? 0 : point.value / count };
  });

  // --- Average deal size by ICP tier --------------------------------------
  const icpOf = new Map(bundle.companies.map((company) => [company.companyId, company.icpTier]));
  const tiers = [
    ...new Set(
      won.map((deal) => (deal.companyId ? (icpOf.get(deal.companyId) ?? NO_TIER) : NO_TIER)),
    ),
  ].sort();

  if (bundle.companies.length === 0) {
    gaps.push(
      'Companies have not been loaded, so no deal has an Ideal Customer Profile tier and average ' +
        'deal size by ICP reads as one undifferentiated series. ICP tier is a company property, ' +
        'not a deal one.',
    );
  }

  const avgDealSizeByIcp = {
    series: tiers.map((tier, index) => ({
      id: tier,
      label: tier,
      color: SERIES_SLOTS[index % SERIES_SLOTS.length]!,
    })),
    data: axis.map((month) => {
      const row: { x: string; xLabel: string } & Record<string, string | number | null> = {
        x: month,
        xLabel: formatMonthShort(month),
      };
      for (const tier of tiers) {
        const inMonth = won.filter(
          (deal) =>
            deal.closedate !== null &&
            monthKeyOf(deal.closedate) === month &&
            (deal.companyId ? (icpOf.get(deal.companyId) ?? NO_TIER) : NO_TIER) === tier,
        );
        row[tier] = inMonth.length
          ? inMonth.reduce((sum, deal) => sum.plus(deal.amount), new Decimal(0))
              .div(inMonth.length)
              .toNumber()
          : null;
      }
      return row;
    }),
  };

  // --- Compliance reviews ---------------------------------------------------
  //
  // Two different things share the name and both are asked about: a deal that
  // reached the Compliance Review STAGE, and a meeting logged as a compliance
  // review. They are reported separately rather than added — adding them would
  // double-count a deal whose review was also logged as a meeting.
  const complianceStageIds = new Set(
    bundle.dealStages.filter((stage) => COMPLIANCE_STAGE.test(stage.label)).map((s) => s.stageId),
  );
  const complianceEntries = bundle.stageEntries.filter(
    (entry) => complianceStageIds.has(entry.stage) && inScope(entry.divisionCode),
  );
  const complianceDealIds = new Set(complianceEntries.map((entry) => entry.dealId));

  const complianceMeetings = bundle.meetings.filter(
    (meeting) =>
      inScope(meeting.divisionCode) &&
      meeting.activityType !== null &&
      COMPLIANCE_MEETING.test(meeting.activityType),
  );

  const complianceReviews = {
    deals: complianceDealIds.size,
    meetings: complianceMeetings.length,
    byMonth: bucket(
      complianceEntries.map((entry) => ({ date: entry.enteredAt })),
      'count',
    ),
  };

  // Compliance reviews by lead source: the SOURCE is on the deal, so this is
  // deals that reached the stage, grouped by where the deal came from.
  const sourceOf = new Map(deals.map((deal) => [deal.dealId, deal.sourceLabel ?? UNRECORDED]));
  const complianceReviewsBySource = tallyDeals(
    [...complianceDealIds].map((dealId) => ({
      key: sourceOf.get(dealId) ?? UNRECORDED,
      amount: deals.find((deal) => deal.dealId === dealId)?.amount ?? new Decimal(0),
    })),
  );

  // --- Proposals this year ---------------------------------------------------
  const proposalStageIds = new Set(
    bundle.dealStages.filter((stage) => PROPOSAL_STAGE.test(stage.label)).map((s) => s.stageId),
  );
  const yearStart = `${period.month.slice(0, 4)}-01-01`;
  const proposalEntries = bundle.stageEntries.filter(
    (entry) =>
      proposalStageIds.has(entry.stage) &&
      inScope(entry.divisionCode) &&
      entry.enteredAt >= new Date(`${yearStart}T00:00:00Z`),
  );
  const proposalDealIds = new Set(proposalEntries.map((entry) => entry.dealId));
  const proposalAmount = [...proposalDealIds].reduce(
    (sum, dealId) => sum.plus(deals.find((deal) => deal.dealId === dealId)?.amount ?? 0),
    new Decimal(0),
  );

  const proposalsThisYear = {
    count: proposalDealIds.size,
    amount: proposalAmount.toNumber(),
    byMonth: bucket(proposalEntries.map((entry) => ({ date: entry.enteredAt })), 'count'),
  };

  if (bundle.dealStages.length > 0 && proposalStageIds.size === 0) {
    gaps.push(
      'No deal stage in this portal has a name mentioning “proposal”, so proposals sent cannot be ' +
        'counted from stage history. The stages here are: ' +
        bundle.dealStages.map((stage) => stage.label).join(', ') +
        '.',
    );
  }

  // --- Deals won by lead source ----------------------------------------------
  const dealsWonBySource = tallyDeals(
    won.map((deal) => ({ key: deal.sourceLabel ?? UNRECORDED, amount: deal.amount })),
  );

  return {
    monthsLabel: `${formatMonthShort(axis[0]!)} – ${formatMonthShort(axis[axis.length - 1]!)}`,
    mqlsByMonth,
    sqlsByMonth,
    dealsCreatedByMonth,
    pipelineAddedByMonth,
    closedWonByMonth,
    avgDealSizeByMonth,
    avgDealSizeByIcp,
    complianceReviews,
    complianceReviewsBySource,
    proposalsThisYear,
    dealsWonBySource,
    gaps,
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
    .sort((a, b) => b.amount - a.amount || a.label.localeCompare(b.label));
}
