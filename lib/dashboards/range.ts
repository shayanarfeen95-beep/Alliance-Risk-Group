import type { MonthKey } from '@/lib/semantic/periods';

/**
 * The beginning/end date filter ARG's leadership asked for.
 *
 * This sits *alongside* the global reporting month rather than replacing it,
 * and the distinction is the whole design:
 *
 *   - The **reporting month** is §7's single global parameter. It anchors the
 *     P&L, and every prior-month, prior-year, year-to-date and budget lookup
 *     hangs off it. It is what the tie-out reproduces. A range cannot replace
 *     it: "gross margin for 1 Feb to 15 Apr" is not a figure the Excel has, and
 *     inventing one would put a number on screen that reconciles to nothing.
 *
 *   - The **range** scopes the things that genuinely are lists of dated events:
 *     deals, meetings, leads, trends. Those are the views where "show me
 *     January through March" is an ordinary question, and today it cannot be
 *     asked.
 *
 * So the range defaults to something consistent with the selected month, and
 * changing the month moves it — but a range the user has set explicitly is
 * respected, and every view that honours it says which dates it is showing.
 */

export type RangePreset =
  | 'this_month'
  | 'last_month'
  | 'last_3_months'
  | 'last_6_months'
  | 'ytd'
  | 'last_year'
  | 'last_12_months'
  | 'custom';

export interface DateRange {
  /** First day of the first month touched, inclusive. */
  from: MonthKey;
  /** First day of the last month touched, inclusive. */
  to: MonthKey;
  /** The first day, inclusive: YYYY-MM-DD. */
  fromDay: string;
  /** The last day, inclusive: YYYY-MM-DD. */
  toDay: string;
  /** Midnight UTC of fromDay — for comparing a dated event. */
  start: Date;
  /** Midnight UTC of the day after toDay. */
  endExclusive: Date;
  preset: RangePreset;
  /** What the control shows, e.g. "Jan 1 – Oct 31, 2026". */
  label: string;
  /** True when both ends fall on month boundaries — the P&L can show it exactly. */
  wholeMonths: boolean;
}

/**
 * Westport, November 2026: "calendar-based start and end dates supporting
 * custom daily ranges, rather than limiting reporting to individual months or
 * year-to-date. Retain useful preset ranges such as current and previous
 * month" — and "if we do year to date, it should not be including November".
 * Presets are relative to today; year to date ends with the last COMPLETE month.
 */
export const RANGE_PRESETS: Array<{ id: RangePreset; label: string; hint: string }> = [
  { id: 'this_month', label: 'This month', hint: 'The first of this month to today' },
  { id: 'last_month', label: 'Last month', hint: 'The whole of last month' },
  { id: 'last_3_months', label: 'Last 3 months', hint: 'The three complete months to the end of last month' },
  { id: 'last_6_months', label: 'Last 6 months', hint: 'Six complete months to the end of last month' },
  { id: 'ytd', label: 'Year to date', hint: 'January 1 to the end of the last complete month' },
  { id: 'last_12_months', label: 'Last 12 months', hint: 'Twelve complete months to the end of last month' },
  { id: 'last_year', label: 'Last year', hint: 'The whole of last calendar year' },
  { id: 'custom', label: 'Custom dates', hint: 'Pick any start and end day' },
];

function shift(month: MonthKey, months: number): MonthKey {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const total = y * 12 + (m - 1) + months;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}-01`;
}

export function formatMonthLabel(month: MonthKey): string {
  return new Date(`${month}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * The rest of this calendar year after the current month, newest first.
 *
 * Westport, November 2026: "Month also ends in November, we should have
 * December listed there as well." The months that have happened are the ones
 * with figures; these are offered beside them, marked as upcoming, so the year
 * can be read to its end — pipeline, bookings so far, budget — without an
 * empty month passing for a month of results.
 */
export function remainingMonthsOfYear(today: Date = new Date()): MonthKey[] {
  const months: MonthKey[] = [];
  for (let m = 11; m > today.getUTCMonth(); m -= 1) {
    months.push(`${today.getUTCFullYear()}-${String(m + 1).padStart(2, '0')}-01` as MonthKey);
  }
  return months;
}

/** Accepts '2026-03' or '2026-03-01'. */
export function normaliseRangeMonth(value: string | undefined): MonthKey | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}$/.test(value)) return `${value}-01`;
  if (/^\d{4}-\d{2}-01$/.test(value)) return value;
  return null;
}

const dayKey = (date: Date) => date.toISOString().slice(0, 10);
const monthOfDay = (day: string): MonthKey => `${day.slice(0, 7)}-01` as MonthKey;
function lastDayOf(month: MonthKey): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return dayKey(new Date(Date.UTC(y, m, 0)));
}

/** A preset's first and last day, relative to today. */
export function daysForPreset(preset: RangePreset, today: Date = new Date()): { fromDay: string; toDay: string } {
  const thisMonth = `${dayKey(today).slice(0, 7)}-01` as MonthKey;
  const lastMonth = shift(thisMonth, -1);
  switch (preset) {
    case 'this_month':
    case 'custom':
      return { fromDay: thisMonth, toDay: dayKey(today) };
    case 'last_month':
      return { fromDay: lastMonth, toDay: lastDayOf(lastMonth) };
    case 'last_3_months':
      return { fromDay: shift(lastMonth, -2), toDay: lastDayOf(lastMonth) };
    case 'last_6_months':
      return { fromDay: shift(lastMonth, -5), toDay: lastDayOf(lastMonth) };
    case 'last_12_months':
      return { fromDay: shift(lastMonth, -11), toDay: lastDayOf(lastMonth) };
    case 'last_year': {
      const year = today.getUTCFullYear() - 1;
      return { fromDay: `${year}-01-01`, toDay: `${year}-12-31` };
    }
    case 'ytd': {
      // In January nothing is complete yet: January so far.
      if (today.getUTCMonth() === 0) return { fromDay: thisMonth, toDay: dayKey(today) };
      return { fromDay: `${today.getUTCFullYear()}-01-01`, toDay: lastDayOf(lastMonth) };
    }
  }
}

/** Kept for callers that think in months: the months a preset covers. */
export function rangeForPreset(preset: RangePreset, _month?: MonthKey, today: Date = new Date()): { from: MonthKey; to: MonthKey } {
  const days = daysForPreset(preset, today);
  return { from: monthOfDay(days.fromDay), to: monthOfDay(days.toDay) };
}

/** "2026-03", "2026-03-01" or "2026-03-17" → a day. A bare month is its first day, or its last as an end. */
function normaliseDay(value: string | undefined, end: boolean): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}$/.test(value)) return end ? lastDayOf(`${value}-01` as MonthKey) : `${value}-01`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))) return value;
  return null;
}

export function formatDayLabel(day: string, withYear = true): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  });
}

/**
 * Resolves the range from the URL.
 *
 * An explicit from/to (days or months) wins; otherwise a named preset (relative
 * to today); otherwise, for an old link that names only a month, January to the
 * end of that month; otherwise year to date. Reversed dates are swapped rather
 * than rejected. Clamped to the history loaded and to the end of this year.
 */
export function resolveRange(
  params: { from?: string; to?: string; range?: string; month?: string },
  month: MonthKey,
  availableMonths: MonthKey[],
  today: Date = new Date(),
): DateRange {
  const earliest = availableMonths.length ? availableMonths[availableMonths.length - 1]! : month;

  const requestedPreset = RANGE_PRESETS.some((p) => p.id === params.range)
    ? (params.range as RangePreset)
    : null;

  let fromDay = normaliseDay(params.from, false);
  let toDay = normaliseDay(params.to, true);
  let preset: RangePreset;

  if (fromDay || toDay) {
    preset = requestedPreset === 'custom' || (fromDay && toDay) ? 'custom' : (requestedPreset ?? 'custom');
    fromDay ??= `${toDay!.slice(0, 7)}-01`;
    toDay ??= lastDayOf(monthOfDay(fromDay));
    // Explicit dates that match a preset exactly keep the preset's name.
    if (requestedPreset && requestedPreset !== 'custom') {
      const days = daysForPreset(requestedPreset, today);
      if (days.fromDay === fromDay && days.toDay === toDay) preset = requestedPreset;
    }
  } else if (requestedPreset) {
    preset = requestedPreset;
    ({ fromDay, toDay } = daysForPreset(preset, today));
  } else if (params.month && /^\d{4}-\d{2}/.test(params.month)) {
    preset = 'custom';
    fromDay = `${params.month.slice(0, 4)}-01-01`;
    toDay = lastDayOf(`${params.month.slice(0, 7)}-01` as MonthKey);
  } else {
    preset = 'ytd';
    ({ fromDay, toDay } = daysForPreset('ytd', today));
  }

  if (fromDay > toDay) [fromDay, toDay] = [toDay, fromDay];

  // Clamp to periods that exist: nothing before the history loaded, nothing
  // past the end of this year (the rest of the year is offered as upcoming).
  if (fromDay < earliest) fromDay = earliest;
  const yearEnd = `${today.getUTCFullYear()}-12-31`;
  if (toDay > yearEnd) toDay = yearEnd;
  if (fromDay > toDay) fromDay = `${toDay.slice(0, 7)}-01`;

  const from = monthOfDay(fromDay);
  const to = monthOfDay(toDay);
  const start = new Date(`${fromDay}T00:00:00Z`);
  const endExclusive = new Date(new Date(`${toDay}T00:00:00Z`).getTime() + 24 * 60 * 60 * 1000);
  const wholeMonths = fromDay.endsWith('-01') && toDay === lastDayOf(to);
  const sameYear = fromDay.slice(0, 4) === toDay.slice(0, 4);
  const label =
    fromDay === toDay
      ? formatDayLabel(fromDay)
      : `${formatDayLabel(fromDay, !sameYear)} – ${formatDayLabel(toDay)}`;

  return { from, to, fromDay, toDay, start, endExclusive, preset, label, wholeMonths };
}

/** Every first-of-month between from and to, inclusive. */
export function monthsInRange(range: DateRange): MonthKey[] {
  const months: MonthKey[] = [];
  let cursor = range.from;
  while (cursor <= range.to) {
    months.push(cursor);
    cursor = shift(cursor, 1);
  }
  return months;
}

/** True when a dated event falls inside the range. */
export function withinRange(date: Date | null, range: DateRange): boolean {
  if (!date) return false;
  return date >= range.start && date < range.endExclusive;
}

/**
 * The month a dashboard opens on when the URL names none.
 *
 * The last COMPLETED month that holds figures — in September, August. The
 * configured DEFAULT_REPORTING_MONTH only wins when it is later than that (a
 * deployment deliberately pinned ahead); it was seeded at 2026-03 and never
 * moved, so honouring it first opened every dashboard on March, six months
 * stale, with nothing saying why.
 *
 * `monthsDescending` must be newest first. Months after `today` are ignored.
 */
export function chooseDefaultMonth(
  monthsDescending: MonthKey[],
  configured: MonthKey | null,
  today: Date = new Date(),
): MonthKey | null {
  const thisMonth = `${today.toISOString().slice(0, 7)}-01`;
  const happened = monthsDescending.filter((month) => month <= thisMonth);
  const lastComplete = happened.find((month) => month < thisMonth) ?? happened[0] ?? null;
  if (configured && lastComplete && configured > lastComplete && monthsDescending.includes(configured)) {
    return configured;
  }
  return lastComplete ?? configured;
}
