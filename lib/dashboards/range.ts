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
  | 'last_3_months'
  | 'last_6_months'
  | 'ytd'
  | 'last_12_months'
  | 'custom';

export interface DateRange {
  /** First day of the first month, inclusive. */
  from: MonthKey;
  /** First day of the last month, inclusive. */
  to: MonthKey;
  preset: RangePreset;
  /** What the control shows, e.g. "Jan 2026 – Mar 2026". */
  label: string;
}

export const RANGE_PRESETS: Array<{ id: RangePreset; label: string; hint: string }> = [
  { id: 'this_month', label: 'Selected month', hint: 'Just the reporting month' },
  { id: 'last_3_months', label: 'Last 3 months', hint: 'The reporting month and the two before it' },
  { id: 'last_6_months', label: 'Last 6 months', hint: 'Half a year to the reporting month' },
  { id: 'ytd', label: 'Year to date', hint: 'January through the reporting month' },
  { id: 'last_12_months', label: 'Last 12 months', hint: 'A rolling year' },
  { id: 'custom', label: 'Custom range', hint: 'Pick a start and end month' },
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

/** Accepts '2026-03' or '2026-03-01'. */
export function normaliseRangeMonth(value: string | undefined): MonthKey | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}$/.test(value)) return `${value}-01`;
  if (/^\d{4}-\d{2}-01$/.test(value)) return value;
  return null;
}

export function rangeForPreset(preset: RangePreset, month: MonthKey): { from: MonthKey; to: MonthKey } {
  switch (preset) {
    case 'this_month':
      return { from: month, to: month };
    case 'last_3_months':
      return { from: shift(month, -2), to: month };
    case 'last_6_months':
      return { from: shift(month, -5), to: month };
    case 'ytd':
      return { from: `${month.slice(0, 4)}-01-01`, to: month };
    case 'last_12_months':
      return { from: shift(month, -11), to: month };
    case 'custom':
      return { from: month, to: month };
  }
}

/**
 * Resolves the range from the URL.
 *
 * An explicit from/to wins; otherwise a named preset; otherwise a sensible
 * default. Reversed dates are swapped rather than rejected — somebody picking
 * the end month first is making an ordering mistake, not asking for an empty
 * result, and an empty dashboard is a worse answer than the one they meant.
 */
export function resolveRange(
  params: { from?: string; to?: string; range?: string },
  month: MonthKey,
  availableMonths: MonthKey[],
): DateRange {
  const earliest = availableMonths.length
    ? availableMonths[availableMonths.length - 1]!
    : month;
  const latest = availableMonths[0] ?? month;

  const requestedPreset = RANGE_PRESETS.some((p) => p.id === params.range)
    ? (params.range as RangePreset)
    : null;

  let from = normaliseRangeMonth(params.from);
  let to = normaliseRangeMonth(params.to);
  let preset: RangePreset;

  if (from || to) {
    preset = requestedPreset === 'custom' || (from && to) ? 'custom' : (requestedPreset ?? 'custom');
    from ??= to!;
    to ??= from;
  } else {
    preset = requestedPreset ?? 'ytd';
    ({ from, to } = rangeForPreset(preset, month));
  }

  if (from > to) [from, to] = [to, from];

  // Clamp to periods that exist. A range extending past the warehouse would
  // otherwise render empty months that look like a data outage.
  if (from < earliest) from = earliest;
  if (to > latest) to = latest;

  return {
    from,
    to,
    preset,
    label: from === to ? formatMonthLabel(from) : `${formatMonthLabel(from)} – ${formatMonthLabel(to)}`,
  };
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
  const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`;
  return key >= range.from && key <= range.to;
}
