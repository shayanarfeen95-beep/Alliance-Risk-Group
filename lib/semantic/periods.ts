/**
 * §7 — Calculation Conventions to Preserve.
 *
 * "These conventions came out of a multi-phase audit cycle Westport has already
 * completed with ARG. They are settled. Replicate them exactly — do not redesign
 * them, and do not 'fix' them because a different convention is more common
 * elsewhere."
 *
 * Implemented once, here, and shared by every dashboard, export and agent tool.
 * All arithmetic is on plain 'YYYY-MM-01' strings so no timezone can shift a
 * month boundary.
 */

export type MonthKey = string; // 'YYYY-MM-01'

export function parseMonth(month: MonthKey): { year: number; month: number } {
  const [year, monthNumber] = month.split('-').map(Number) as [number, number];
  return { year, month: monthNumber };
}

export function toMonthKey(year: number, month: number): MonthKey {
  let y = year;
  let m = month;
  while (m > 12) {
    m -= 12;
    y += 1;
  }
  while (m < 1) {
    m += 12;
    y -= 1;
  }
  return `${y}-${String(m).padStart(2, '0')}-01`;
}

export function addMonths(month: MonthKey, delta: number): MonthKey {
  const { year, month: m } = parseMonth(month);
  return toMonthKey(year, m + delta);
}

/** Actual calendar days. §6: "Days in month is actual calendar days, not 30." */
export function daysInMonth(month: MonthKey): number {
  const { year, month: m } = parseMonth(month);
  return new Date(Date.UTC(year, m, 0)).getUTCDate();
}

/** Inclusive range of month keys. */
export function monthRange(from: MonthKey, to: MonthKey): MonthKey[] {
  const months: MonthKey[] = [];
  let cursor = from;
  while (cursor <= to) {
    months.push(cursor);
    cursor = addMonths(cursor, 1);
  }
  return months;
}

/** First and last calendar dates of a month, for filtering timestamped records. */
export function monthBounds(month: MonthKey): { start: Date; endExclusive: Date } {
  const { year, month: m } = parseMonth(month);
  return {
    start: new Date(Date.UTC(year, m - 1, 1, 0, 0, 0)),
    endExclusive: new Date(Date.UTC(year, m, 1, 0, 0, 0)),
  };
}

/**
 * Everything a period-aware calculation needs, derived from the single global
 * reporting month.
 *
 * §7: "A single global parameter drives every view — in Excel it is one cell. In
 * your build it is one date selector at the top of the app that every dashboard
 * reads. Changing it re-anchors PM, PY, YTD and budget lookups everywhere at
 * once."
 */
export interface PeriodContext {
  /** The selected reporting month. */
  month: MonthKey;
  /** §7 Prior month: the selected month minus one month. */
  priorMonth: MonthKey;
  /**
   * §7 Prior year: "the selected month minus twelve months — the same calendar
   * month one year earlier, not a trailing-twelve figure."
   */
  priorYearMonth: MonthKey;
  /** §7 YTD Actual: January 1 of the selected year through the selected month, inclusive. */
  ytdMonths: MonthKey[];
  /**
   * §7 PY YTD: January of the prior year through the same month of the prior
   * year, inclusive. "Comparable periods only — never full prior year against
   * partial current year."
   */
  priorYearYtdMonths: MonthKey[];
  /**
   * §7 Run rate: "'Months elapsed' is the month number of the reporting month
   * (March = 3), matching the Excel."
   */
  monthsElapsed: number;
  daysInMonth: number;
  fiscalYear: number;
  /** Trailing three months ending at the reporting month — the Defect 6 variant. */
  trailingThreeMonths: MonthKey[];
  /** Trailing twelve months, for sparklines and trend blocks. */
  trailingTwelveMonths: MonthKey[];
  /** Trailing fifteen months — the Finance dashboard's P&L trend block. */
  trailingFifteenMonths: MonthKey[];
}

export function buildPeriodContext(month: MonthKey): PeriodContext {
  const { year, month: monthNumber } = parseMonth(month);
  const januaryThisYear = toMonthKey(year, 1);
  const priorYearMonth = addMonths(month, -12);
  const januaryPriorYear = toMonthKey(year - 1, 1);

  return {
    month,
    priorMonth: addMonths(month, -1),
    priorYearMonth,
    ytdMonths: monthRange(januaryThisYear, month),
    priorYearYtdMonths: monthRange(januaryPriorYear, priorYearMonth),
    monthsElapsed: monthNumber,
    daysInMonth: daysInMonth(month),
    fiscalYear: year, // §7: ARG's fiscal year equals the calendar year.
    trailingThreeMonths: monthRange(addMonths(month, -2), month),
    trailingTwelveMonths: monthRange(addMonths(month, -11), month),
    trailingFifteenMonths: monthRange(addMonths(month, -14), month),
  };
}

/**
 * §7 Run rate: "YTD ÷ months elapsed × 12. Never single month × 12 — ARG's
 * revenue is seasonal enough that single-month annualization is misleading."
 *
 * §13.1 names the failure explicitly: annualising March alone gives $6,538,128
 * where the right answer is $5,640,939.
 */
export function annualise(ytdValue: number, monthsElapsed: number): number {
  if (monthsElapsed <= 0) return 0;
  return (ytdValue / monthsElapsed) * 12;
}

/** Formats a month key for display: 'March 2026'. */
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function formatMonth(month: MonthKey): string {
  const { year, month: m } = parseMonth(month);
  return `${MONTH_NAMES[m - 1]} ${year}`;
}

export function formatMonthShort(month: MonthKey): string {
  const { year, month: m } = parseMonth(month);
  return `${MONTH_NAMES[m - 1]!.slice(0, 3)} ${String(year).slice(2)}`;
}
