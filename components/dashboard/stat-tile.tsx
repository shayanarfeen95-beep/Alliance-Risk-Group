/**
 * A single headline figure.
 *
 * Deliberately not a KpiTile. A KpiTile carries a target, a variance and a trend
 * because the metrics it shows are measured against something. These are counts
 * and sums of what happened — a discovery call has no budget — and dressing them
 * in the same chrome would imply a comparison that does not exist.
 *
 * The denominator line is not optional decoration. "Pipeline added" and "closed"
 * are counted on different dates from different deals, and two dollar figures
 * side by side invite exactly the subtraction that comparison does not support.
 * Saying what each one counts, under each one, is what stops that.
 */
import type { ReactNode } from 'react';
import { formatNumber, type ValueFormat } from '@/lib/format';

export interface StatTileProps {
  label: string;
  value: number | null;
  valueFormat?: ValueFormat;
  /** What this figure counts — the denominator, stated. */
  basis?: string;
  /** Secondary line, e.g. "12 deals". */
  detail?: string;
  /** Shown instead of the value when it cannot be computed. */
  unavailable?: string;
  children?: ReactNode;
}

export function StatTile({
  label,
  value,
  valueFormat = 'count',
  basis,
  detail,
  unavailable,
  children,
}: StatTileProps) {
  return (
    <div
      className="flex flex-col rounded-[var(--radius)] border p-3.5"
      style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}
    >
      <p className="text-[11.5px] font-medium text-[var(--text-secondary)]">{label}</p>

      {unavailable ? (
        <p className="mt-2 text-[12px] leading-relaxed text-[var(--text-muted)]">{unavailable}</p>
      ) : (
        <p className="mt-1.5 text-[26px] font-semibold leading-none tracking-tight tabular-nums">
          {value === null ? '—' : formatNumber(value, valueFormat)}
        </p>
      )}

      {detail && !unavailable && (
        <p className="mt-1.5 text-[11px] text-[var(--text-secondary)]">{detail}</p>
      )}
      {basis && (
        <p className="mt-auto pt-2 text-[10.5px] leading-relaxed text-[var(--text-muted)]">
          {basis}
        </p>
      )}
      {children}
    </div>
  );
}

/**
 * The per-rep split that sits under a headline figure.
 *
 * A bar per rep rather than a number per rep: the question leadership asks of
 * this panel is "who is carrying this", which is a comparison, and comparisons
 * are read faster from length than from digits. The digits stay too, because
 * the exact figure is the second question.
 */
export function RepBars({
  rows,
  valueFormat = 'count',
  emptyLabel = 'Nobody in this range.',
  max = 8,
}: {
  rows: Array<{ rep: string; value: number }>;
  valueFormat?: ValueFormat;
  emptyLabel?: string;
  max?: number;
}) {
  if (rows.length === 0) {
    return <p className="mt-3 text-[11px] text-[var(--text-muted)]">{emptyLabel}</p>;
  }

  const shown = rows.slice(0, max);
  const peak = Math.max(...shown.map((row) => Math.abs(row.value)), 1);

  return (
    <ul className="mt-3 space-y-1.5">
      {shown.map((row) => (
        <li key={row.rep}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="truncate text-[11.5px]" title={row.rep}>
              {row.rep}
            </span>
            <span className="shrink-0 text-[11.5px] tabular-nums text-[var(--text-secondary)]">
              {formatNumber(row.value, valueFormat)}
            </span>
          </div>
          <div
            className="mt-1 h-1.5 w-full overflow-hidden rounded-full"
            style={{ background: 'var(--surface-2)' }}
          >
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.max(2, (Math.abs(row.value) / peak) * 100)}%`,
                background: 'var(--series-1)',
              }}
            />
          </div>
        </li>
      ))}
      {rows.length > shown.length && (
        <li className="pt-0.5 text-[10.5px] text-[var(--text-muted)]">
          and {rows.length - shown.length} more
        </li>
      )}
    </ul>
  );
}
