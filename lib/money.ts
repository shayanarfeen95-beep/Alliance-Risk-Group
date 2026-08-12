/**
 * Exact decimal arithmetic.
 *
 * §13.1: "Figures are rounded to the dollar from unrounded source data; a column
 * of components may differ from its total by $1. Compute on unrounded values and
 * round only for display."
 *
 * Every figure in this system is a Decimal from the moment it leaves the
 * database until the moment it is formatted. No float arithmetic touches money.
 */
import Decimal from 'decimal.js';

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

export type Money = Decimal;
export type Numeric = Decimal;

/** Coerce a database numeric (string), number, or Decimal into a Decimal. */
export function d(value: string | number | Decimal | null | undefined): Decimal {
  if (value === null || value === undefined || value === '') return new Decimal(0);
  return value instanceof Decimal ? value : new Decimal(value);
}

export const ZERO = new Decimal(0);

export function sum(values: Array<string | number | Decimal | null | undefined>): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(d(v)), new Decimal(0));
}

/**
 * §4.2: "Every one of these divisions guards against a zero denominator and
 * returns 0, not an error."
 *
 * This is deliberately NOT the Excel's IFERROR(...,0). The Excel wraps *lookups*
 * in a silent zero, which is Defect 1 — a missing figure reads as $0. This guards
 * only the arithmetic: a genuine 0/0 is 0. A missing row is a loud failure,
 * handled in the resolver, never here.
 */
export function safeDiv(
  numerator: string | number | Decimal | null | undefined,
  denominator: string | number | Decimal | null | undefined,
): Decimal {
  const den = d(denominator);
  if (den.isZero()) return new Decimal(0);
  return d(numerator).div(den);
}

/** $1 tolerance — the spec's reconciliation bar throughout §13. */
export const DOLLAR_TOLERANCE = new Decimal(1);

export function within(a: Decimal, b: Decimal, tolerance: Decimal = DOLLAR_TOLERANCE): boolean {
  return a.minus(b).abs().lessThanOrEqualTo(tolerance);
}

// ---------------------------------------------------------------------------
// Display formatting — the only place rounding happens
// ---------------------------------------------------------------------------

export type ValueFormat = 'currency' | 'currency_precise' | 'percent' | 'ratio' | 'days' | 'count' | 'months';

const currency0 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});
const currency2 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const number1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const number0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/**
 * Negative money renders in parentheses — the convention the Excel uses and the
 * one ARG's leadership reads, e.g. Claims net profit of (25,717).
 */
export function formatValue(value: Decimal | null | undefined, format: ValueFormat): string {
  if (value === null || value === undefined) return '—';
  const n = value.toNumber();

  switch (format) {
    case 'currency': {
      const abs = currency0.format(Math.abs(n));
      return n < 0 ? `(${abs})` : abs;
    }
    case 'currency_precise': {
      const abs = currency2.format(Math.abs(n));
      return n < 0 ? `(${abs})` : abs;
    }
    case 'percent':
      return `${number1.format(n * 100)}%`;
    case 'ratio':
      return `${number1.format(n * 100)}%`;
    case 'days':
      return `${number1.format(n)} days`;
    case 'months':
      return `${number1.format(n)} mo`;
    case 'count':
      return number0.format(n);
  }
}

/** Compact form for KPI tiles: $5.6M, $544K. */
export function formatCompact(value: Decimal | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const n = value.toNumber();
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}$${number1.format(abs / 1_000_000)}M`;
  if (abs >= 1_000) return `${sign}$${number0.format(abs / 1_000)}K`;
  return `${sign}$${number0.format(abs)}`;
}

/** Signed delta for change-vs-prior labels. */
export function formatDelta(value: Decimal | null | undefined, format: ValueFormat): string {
  if (value === null || value === undefined) return '—';
  const formatted = formatValue(value.abs(), format);
  if (value.isZero()) return formatted;
  return `${value.isNegative() ? '−' : '+'}${formatted}`;
}
