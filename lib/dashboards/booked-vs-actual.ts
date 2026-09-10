import 'server-only';
import Decimal from 'decimal.js';
import { CONSOLIDATED_CODE, type SemanticSession } from '@/lib/semantic/resolve';
import { formatMonthShort, monthRange, type MonthKey } from '@/lib/semantic/periods';
import { key as plKey } from '@/lib/semantic/facts';

/**
 * Booked versus billed — the link between the two systems.
 *
 * HubSpot knows what was SOLD: a deal closes won on a date, for an amount.
 * QuickBooks knows what was BILLED: revenue recognised in a month, on the
 * accrual basis. Every dashboard in this application reads one or the other, and
 * nothing until now read both together — so nobody could answer the question
 * leadership actually asks, which is whether what sales books turns into
 * revenue, and how fast.
 *
 * Three things have to be said plainly for this comparison to be honest, because
 * every one of them is a way to read it wrongly:
 *
 *   **They are not the same money on the same date.** A deal booked in March
 *   may bill across April to September, or never. Booked above billed is not a
 *   shortfall and billed above booked is not an overachievement — it is timing,
 *   and on a multi-month contract it is timing by design. The variance is shown
 *   as a ratio and described as conversion, never as a gap to be closed.
 *
 *   **Booked is a HubSpot figure and billed is a QuickBooks figure.** If either
 *   source has not loaded, the comparison is refused rather than drawn against a
 *   zero. A conversion rate computed against an unloaded QuickBooks is a number
 *   that looks like a catastrophe and means nothing.
 *
 *   **New business is a different question from renewal.** A new logo's booking
 *   should convert to first revenue within the year; an existing account's
 *   renewal was already billing before it was rebooked. Mixing them produces a
 *   conversion rate that describes neither, which is why the filter exists.
 *
 * What this CANNOT do yet is answer it per customer. QuickBooks revenue is
 * landed by class — division — and not by customer, and nothing maps a HubSpot
 * company onto a QuickBooks customer. Both are stated in `perCustomerBlocked`
 * rather than approximated, because a per-customer table built on a name match
 * would be wrong in exactly the cases anybody would look at it for.
 */

export type NewBusinessFilter = 'all' | 'new' | 'existing';

export interface BookedVsActualRow {
  month: MonthKey;
  label: string;
  /** HubSpot: deals closed won with this close month. */
  booked: number;
  /** QuickBooks: revenue recognised in this month, accrual basis. */
  billed: number;
  /** QuickBooks: the same month one year earlier. */
  priorYearBilled: number;
}

export interface BookedVsActual {
  rows: BookedVsActualRow[];
  ytd: {
    booked: number;
    billed: number;
    priorYearBilled: number;
    /** Billed ÷ booked, as a percentage. Null when nothing was booked. */
    conversionPct: number | null;
    /** Billed against the same months last year. Null when there is no prior year. */
    vsPriorYearPct: number | null;
    /**
     * Where the full year lands if the rest of it runs at the year-to-date rate.
     * Stated as a projection, never as a figure.
     */
    pacedFullYear: number;
    priorYearFull: number;
    monthsElapsed: number;
  };
  filter: NewBusinessFilter;
  /** Set when the comparison cannot be drawn, naming which side is missing. */
  unavailable: string | null;
  /** Why a per-customer version is not offered. */
  perCustomerBlocked: string;
  /** True when no deal carries a type, so the New Business filter does nothing. */
  dealTypeMissing: boolean;
}

export function loadBookedVsActual(
  session: SemanticSession,
  divisionCode: string,
  options: { newBusiness?: NewBusinessFilter } = {},
): BookedVsActual {
  const { bundle, period } = session;
  const filter = options.newBusiness ?? 'all';
  const isConsolidated = divisionCode === CONSOLIDATED_CODE;
  const inScope = (code: string | null) =>
    isConsolidated || (code !== null && code === divisionCode);

  const year = period.month.slice(0, 4);
  const months = monthRange(`${year}-01-01` as MonthKey, period.month);
  const divisions = isConsolidated
    ? session.visibleDivisions
    : [divisionCode];

  // --- Booked, from HubSpot ------------------------------------------------
  const deals = bundle.deals.filter((deal) => {
    if (!deal.isClosedWon || !deal.closedate) return false;
    if (!inScope(deal.divisionCode)) return false;
    if (filter === 'new' && deal.dealType !== 'newbusiness') return false;
    if (filter === 'existing' && deal.dealType !== 'existingbusiness') return false;
    return true;
  });

  const bookedByMonth = new Map<string, Decimal>();
  for (const deal of deals) {
    const month = monthKeyOf(deal.closedate!);
    bookedByMonth.set(month, (bookedByMonth.get(month) ?? new Decimal(0)).plus(deal.amount));
  }

  // --- Billed, from QuickBooks ---------------------------------------------
  const revenueIn = (month: MonthKey): Decimal =>
    divisions.reduce(
      (sum, code) => sum.plus(bundle.pl.get(plKey(month, code))?.revenue ?? 0),
      new Decimal(0),
    );

  const rows: BookedVsActualRow[] = months.map((month) => ({
    month,
    label: formatMonthShort(month),
    booked: (bookedByMonth.get(month) ?? new Decimal(0)).toNumber(),
    billed: revenueIn(month).toNumber(),
    priorYearBilled: revenueIn(priorYear(month)).toNumber(),
  }));

  const sum = (pick: (row: BookedVsActualRow) => number) =>
    rows.reduce((total, row) => total + pick(row), 0);

  const booked = sum((row) => row.booked);
  const billed = sum((row) => row.billed);
  const priorYearBilled = sum((row) => row.priorYearBilled);
  const monthsElapsed = rows.length;

  // The full prior year, for a pace that compares like with like: eight months
  // of this year against eight of last, then projected onto twelve.
  const priorYearFull = monthRange(`${Number(year) - 1}-01-01` as MonthKey, `${Number(year) - 1}-12-01` as MonthKey)
    .reduce((total, month) => total + revenueIn(month).toNumber(), 0);

  // --- Is the comparison drawable at all? ----------------------------------
  const hubspotLoaded = bundle.deals.length > 0;
  const qboLoaded = billed > 0 || bundle.pl.size > 0;

  const unavailable = !hubspotLoaded
    ? 'No HubSpot deals have loaded, so there is nothing booked to compare against revenue.'
    : !qboLoaded
      ? 'QuickBooks has not loaded, so there is no billed revenue to compare bookings against. ' +
        'A conversion rate computed against an unloaded QuickBooks would read as a total ' +
        'collapse and would mean nothing — so none is shown.'
      : null;

  return {
    rows,
    ytd: {
      booked,
      billed,
      priorYearBilled,
      conversionPct: booked === 0 ? null : (billed / booked) * 100,
      vsPriorYearPct:
        priorYearBilled === 0 ? null : ((billed - priorYearBilled) / priorYearBilled) * 100,
      pacedFullYear: monthsElapsed === 0 ? 0 : (billed / monthsElapsed) * 12,
      priorYearFull,
      monthsElapsed,
    },
    filter,
    unavailable,
    perCustomerBlocked:
      'Per customer needs two things this warehouse does not hold: QuickBooks revenue by ' +
      'customer — it is landed by class, which is division — and a rule mapping a HubSpot ' +
      'company onto a QuickBooks customer. Matching them on name would be wrong in exactly the ' +
      'cases anybody would check, so the comparison is shown by division until Westport confirms ' +
      'the mapping.',
    dealTypeMissing:
      bundle.deals.length > 0 && bundle.deals.every((deal) => deal.dealType === null),
  };
}

function monthKeyOf(date: Date): MonthKey {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

function priorYear(month: MonthKey): MonthKey {
  return `${Number(month.slice(0, 4)) - 1}${month.slice(4)}` as MonthKey;
}
