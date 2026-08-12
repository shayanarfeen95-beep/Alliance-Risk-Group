/**
 * Client-safe formatting.
 *
 * Mirrors the display rules in lib/money.ts but takes plain numbers, so chart
 * components can format axis ticks and tooltips without shipping decimal.js to
 * the browser. Rounding for display only ever happens here or in money.ts —
 * never in a calculation.
 */

export type ValueFormat =
  | 'currency'
  | 'currency_precise'
  | 'percent'
  | 'ratio'
  | 'days'
  | 'count'
  | 'months';

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
const number0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const number1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

/** Negatives render in parentheses — the convention ARG's leadership reads. */
export function formatNumber(value: number | null | undefined, format: ValueFormat): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';

  switch (format) {
    case 'currency': {
      const abs = currency0.format(Math.abs(value));
      return value < 0 ? `(${abs})` : abs;
    }
    case 'currency_precise': {
      const abs = currency2.format(Math.abs(value));
      return value < 0 ? `(${abs})` : abs;
    }
    case 'percent':
    case 'ratio':
      return `${number1.format(value * 100)}%`;
    case 'days':
      return `${number1.format(value)} days`;
    case 'months':
      return `${number1.format(value)} mo`;
    case 'count':
      return number0.format(value);
  }
}

/** Compact axis and tile form: $5.6M, $544K. */
export function formatCompactNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const abs = Math.abs(value);
  const sign = value < 0 ? '−' : '';
  if (abs >= 1_000_000) return `${sign}$${number1.format(abs / 1_000_000)}M`;
  if (abs >= 1_000) return `${sign}$${number0.format(abs / 1_000)}K`;
  return `${sign}$${number0.format(abs)}`;
}

/** Axis ticks: no currency symbol, so the axis stays recessive. */
export function formatAxisTick(value: number, format: ValueFormat): string {
  if (format === 'percent' || format === 'ratio') return `${number0.format(value * 100)}%`;
  if (format === 'count') return number0.format(value);
  const abs = Math.abs(value);
  const sign = value < 0 ? '−' : '';
  if (abs >= 1_000_000) return `${sign}${number1.format(abs / 1_000_000)}M`;
  if (abs >= 1_000) return `${sign}${number0.format(abs / 1_000)}K`;
  return `${sign}${number0.format(abs)}`;
}

export function formatSignedNumber(
  value: number | null | undefined,
  format: ValueFormat,
): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (value === 0) return formatNumber(0, format);
  const magnitude = formatNumber(Math.abs(value), format);
  return `${value < 0 ? '−' : '+'}${magnitude}`;
}

/**
 * §7: direction is an input, never inferred from the sign.
 *
 * "An attainment ratio above 100% is good on revenue and gross profit. It is bad
 * on COGS, OpEx and payroll — it means you spent more than planned."
 */
export function sentimentOf(
  delta: number | null | undefined,
  higherIsBetter: boolean,
): 'good' | 'bad' | 'neutral' {
  if (delta === null || delta === undefined || delta === 0 || Number.isNaN(delta)) return 'neutral';
  return (higherIsBetter ? delta > 0 : delta < 0) ? 'good' : 'bad';
}

export function sentimentColorVar(sentiment: 'good' | 'bad' | 'neutral'): string {
  if (sentiment === 'good') return 'var(--delta-good)';
  if (sentiment === 'bad') return 'var(--delta-bad)';
  return 'var(--text-muted)';
}

export function percentChange(current: number | null, prior: number | null): number | null {
  if (current === null || prior === null || prior === 0) return null;
  return (current - prior) / Math.abs(prior);
}
