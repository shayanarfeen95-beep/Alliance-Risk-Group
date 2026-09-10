import 'server-only';
import Decimal from 'decimal.js';
import { CONSOLIDATED_CODE, type SemanticSession } from '@/lib/semantic/resolve';
import { monthBounds } from '@/lib/semantic/periods';
import { SERIES_SLOTS } from '@/lib/charts/colors';
import type { DateRange } from './range';

/**
 * The leadership review, in the shape ARG already runs it.
 *
 * ARG's own HubSpot dashboard — "Leadership EOS Dashboard Monthly" — answers
 * five questions in a fixed order, and the team reads them fluently because they
 * have read them every month for years:
 *
 *   How much activity happened, and of what kind?   (meetings by type)
 *   How many discovery calls and demos?             (two counts)
 *   How much pipeline did we add, and close?        (two amounts)
 *   Where did the pipeline come from?               (by source)
 *   And all of the above, per rep.                  (the same, split by owner)
 *
 * Reproducing that shape here is the point: a second dashboard that answers the
 * same questions differently is not a second opinion, it is an argument. So the
 * layout is theirs and the arithmetic is this system's — every figure is counted
 * from the same scoped deal and meeting records the rest of the app counts, and
 * the scope predicate is passed in rather than re-derived, so this panel cannot
 * disagree with the funnel above it about which deals are in play.
 *
 * Two definitions are stated here rather than assumed, because they are the ones
 * a reader would otherwise have to guess at:
 *
 *   **Pipeline added** is deal amount by CREATE date in range — new pipeline
 *   that came into existence, regardless of whether it has closed since.
 *   **Closed** is won amount by CLOSE date in range.
 *
 * Those are different denominators on purpose, and the UI says so.
 */

export interface CategoryCount {
  key: string;
  label: string;
  count: number;
}

export interface RepCount {
  rep: string;
  count: number;
}

export interface RepAmount {
  rep: string;
  amount: number;
}

export interface SourceAmount {
  source: string;
  amount: number;
  deals: number;
  /** Share of the pipeline added in range. */
  sharePct: number;
}

export interface EosViewModel {
  /** Meetings by "Call and meeting type", largest first. */
  meetingsByType: CategoryCount[];
  meetingsTotal: number;
  /** Meetings by type, split per rep — the grouped bar. */
  meetingsByTypeByRep: {
    data: Array<{ x: string; xLabel: string } & Record<string, string | number | null>>;
    series: Array<{ id: string; label: string; color: string }>;
  };
  discoveryCalls: { total: number; byRep: RepCount[] };
  demos: { total: number; byRep: RepCount[] };
  pipelineAdded: { total: number; deals: number; byRep: RepAmount[]; bySource: SourceAmount[] };
  closed: { total: number; deals: number; byRep: RepAmount[] };
  /** True when meetings loaded but none carries a type. */
  typesUnavailable: boolean;
  /** True when deals loaded but none carries a source. */
  sourcesUnavailable: boolean;
  /** How discovery calls and demos were identified, stated on the face of it. */
  classification: { discovery: string; demo: string };
}

/**
 * Which activity types count as a discovery call and which as a demo.
 *
 * HubSpot does not mark either — they are values of a free-form-ish enumeration
 * that each portal names for itself. ARG's portal uses "Call - Intro" and
 * "Meeting - Demo"; another would use "Discovery" and "Product Demo". Matching
 * on the words rather than on an exact string is what makes this work on a
 * portal nobody has configured this app for.
 *
 * The rule is deliberately visible in the UI. A tile that says "4" over an
 * unstated definition is how two people leave the same meeting with different
 * numbers.
 */
const DISCOVERY_PATTERN = /discovery|intro|qualif/i;
const DEMO_PATTERN = /demo/i;

export const CLASSIFICATION = {
  discovery: 'Meeting types containing “discovery”, “intro” or “qualif”',
  demo: 'Meeting types containing “demo”',
};

/** Meetings with no type recorded. Shown, never folded into a named category. */
const UNTYPED = 'Not recorded';
const UNASSIGNED = 'Unassigned';

export interface EosOptions {
  range: DateRange;
  ownerName: string | null;
  pipeline: string | null;
}

export function loadEosPanel(
  session: SemanticSession,
  divisionCode: string,
  options: EosOptions,
): EosViewModel {
  const { bundle } = session;
  const isConsolidated = divisionCode === CONSOLIDATED_CODE;
  const inScope = (code: string | null) =>
    isConsolidated || (code !== null && code === divisionCode);

  const rangeStart = monthBounds(options.range.from).start;
  // Exclusive, so the last month of the range is included whole.
  const rangeEnd = monthBounds(options.range.to).endExclusive;
  const within = (value: Date | null): boolean =>
    value !== null && value >= rangeStart && value < rangeEnd;

  // --- Meetings ----------------------------------------------------------
  const meetings = bundle.meetings.filter(
    (meeting) =>
      inScope(meeting.divisionCode) &&
      within(meeting.meetingDate) &&
      (!options.ownerName || (meeting.ownerName ?? UNASSIGNED) === options.ownerName),
  );

  const byType = new Map<string, number>();
  for (const meeting of meetings) {
    const key = meeting.activityType ?? UNTYPED;
    byType.set(key, (byType.get(key) ?? 0) + 1);
  }

  const meetingsByType: CategoryCount[] = [...byType.entries()]
    .map(([key, count]) => ({ key, label: key, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  const matchingTypes = (pattern: RegExp) =>
    meetings.filter((meeting) => meeting.activityType && pattern.test(meeting.activityType));

  // --- Reps --------------------------------------------------------------
  //
  // One rep list for every panel, ordered by name. Colour follows the rep, so
  // filtering one out never repaints the others — a reader comparing this month
  // to last must not see a rep change colour because somebody left.
  const repNames = [
    ...new Set([
      ...meetings.map((meeting) => meeting.ownerName ?? UNASSIGNED),
      ...bundle.deals
        .filter((deal) => inScope(deal.divisionCode))
        .map((deal) => deal.ownerName ?? UNASSIGNED),
    ]),
  ].sort((a, b) => (a === UNASSIGNED ? 1 : b === UNASSIGNED ? -1 : a.localeCompare(b)));

  const repColor = new Map<string, string>();
  repNames.forEach((rep, index) => {
    repColor.set(rep, SERIES_SLOTS[index % SERIES_SLOTS.length]!);
  });

  const countByRep = (rows: typeof meetings): RepCount[] => {
    const counts = new Map<string, number>();
    for (const row of rows) {
      const rep = row.ownerName ?? UNASSIGNED;
      counts.set(rep, (counts.get(rep) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([rep, count]) => ({ rep, count }))
      .sort((a, b) => b.count - a.count || a.rep.localeCompare(b.rep));
  };

  // --- Meetings by type, per rep (the grouped bar) ------------------------
  //
  // Capped at the eight busiest types. Past eight the answer is never a
  // generated ninth hue — the tail folds into a stated "Other" so the chart
  // stays readable and nothing is silently dropped from the total.
  const topTypes = meetingsByType.slice(0, 8);
  const topTypeKeys = new Set(topTypes.map((type) => type.key));
  const hasTail = meetingsByType.length > topTypes.length;

  const repsInMeetings = [...new Set(meetings.map((m) => m.ownerName ?? UNASSIGNED))].sort(
    (a, b) => (a === UNASSIGNED ? 1 : b === UNASSIGNED ? -1 : a.localeCompare(b)),
  );

  const groupedRows = [...topTypes.map((type) => type.key), ...(hasTail ? ['Other'] : [])].map(
    (typeKey) => {
      const row: { x: string; xLabel: string } & Record<string, string | number | null> = {
        x: typeKey,
        xLabel: typeKey,
      };
      for (const rep of repsInMeetings) {
        row[rep] = meetings.filter((meeting) => {
          if ((meeting.ownerName ?? UNASSIGNED) !== rep) return false;
          const key = meeting.activityType ?? UNTYPED;
          return typeKey === 'Other' ? !topTypeKeys.has(key) : key === typeKey;
        }).length;
      }
      return row;
    },
  );

  // --- Deals -------------------------------------------------------------
  const deals = bundle.deals.filter((deal) => {
    if (!inScope(deal.divisionCode)) return false;
    if (options.pipeline && deal.pipeline !== options.pipeline) return false;
    if (options.ownerName && (deal.ownerName ?? UNASSIGNED) !== options.ownerName) return false;
    return true;
  });

  // Pipeline added: by CREATE date. New pipeline that came into existence in
  // the range, whether or not it has since closed.
  const added = deals.filter((deal) => within(deal.createdate));
  // Closed: won amount by CLOSE date. A different denominator, deliberately.
  const won = deals.filter((deal) => deal.isClosedWon && within(deal.closedate));

  const sumBy = <T,>(rows: T[], key: (row: T) => string, amount: (row: T) => Decimal) => {
    const totals = new Map<string, { amount: Decimal; count: number }>();
    for (const row of rows) {
      const entry = totals.get(key(row)) ?? { amount: new Decimal(0), count: 0 };
      entry.amount = entry.amount.plus(amount(row));
      entry.count += 1;
      totals.set(key(row), entry);
    }
    return totals;
  };

  const addedTotal = added.reduce((sum, deal) => sum.plus(deal.amount), new Decimal(0));
  const wonTotal = won.reduce((sum, deal) => sum.plus(deal.amount), new Decimal(0));

  const bySource: SourceAmount[] = [
    ...sumBy(
      added,
      (deal) => deal.sourceLabel ?? UNTYPED,
      (deal) => deal.amount,
    ).entries(),
  ]
    .map(([source, entry]) => ({
      source,
      amount: entry.amount.toNumber(),
      deals: entry.count,
      sharePct: addedTotal.isZero() ? 0 : entry.amount.div(addedTotal).times(100).toNumber(),
    }))
    .sort((a, b) => b.amount - a.amount || a.source.localeCompare(b.source));

  const amountByRep = (rows: typeof deals): RepAmount[] =>
    [
      ...sumBy(
        rows,
        (deal) => deal.ownerName ?? UNASSIGNED,
        (deal) => deal.amount,
      ).entries(),
    ]
      .map(([rep, entry]) => ({ rep, amount: entry.amount.toNumber() }))
      .sort((a, b) => b.amount - a.amount || a.rep.localeCompare(b.rep));

  return {
    meetingsByType,
    meetingsTotal: meetings.length,
    meetingsByTypeByRep: {
      data: groupedRows,
      series: repsInMeetings.map((rep) => ({
        id: rep,
        label: rep,
        color: repColor.get(rep) ?? SERIES_SLOTS[0]!,
      })),
    },
    discoveryCalls: {
      total: matchingTypes(DISCOVERY_PATTERN).length,
      byRep: countByRep(matchingTypes(DISCOVERY_PATTERN)),
    },
    demos: {
      total: matchingTypes(DEMO_PATTERN).length,
      byRep: countByRep(matchingTypes(DEMO_PATTERN)),
    },
    pipelineAdded: {
      total: addedTotal.toNumber(),
      deals: added.length,
      byRep: amountByRep(added),
      bySource,
    },
    closed: {
      total: wonTotal.toNumber(),
      deals: won.length,
      byRep: amountByRep(won),
    },
    // "No meeting carries a type" and "no meetings loaded" are different facts
    // and must not render the same.
    typesUnavailable:
      meetings.length > 0 && meetings.every((meeting) => meeting.activityType === null),
    sourcesUnavailable: added.length > 0 && added.every((deal) => deal.sourceLabel === null),
    classification: CLASSIFICATION,
  };
}
