import Link from 'next/link';
import { ArrowDownRight, ArrowRight, ArrowUpRight, Info } from 'lucide-react';
import { formatSignedNumber, sentimentColorVar, sentimentOf, type ValueFormat } from '@/lib/format';

export interface KpiTileProps {
  name: string;
  /** Pre-formatted by the semantic layer — tiles never format a raw figure. */
  formatted: string;
  unavailable?: { reason: string; detail: string };
  higherIsBetter: boolean;
  /** Change against prior month, in the KPI's own unit. */
  deltaPriorMonth?: number | null;
  /** Change against the same month one year earlier. */
  deltaPriorYear?: number | null;
  format: ValueFormat;
  /** Twelve monthly values, oldest first. */
  sparkline?: Array<number | null>;
  href?: string;
  /** Shown on hover — usually the formula or the denominator. */
  hint?: string;
}

/**
 * §9.1: "Each tile shows the current value, the change against prior month and
 * prior year, and a 12-month sparkline."
 *
 * The hero figure uses proportional figures; tabular-nums is reserved for
 * columns that must align.
 */
export function KpiTile({
  name,
  formatted,
  unavailable,
  higherIsBetter,
  deltaPriorMonth,
  deltaPriorYear,
  format,
  sparkline,
  href,
  hint,
}: KpiTileProps) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <p className="text-[11px] font-medium leading-tight text-[var(--text-secondary)]">{name}</p>
        {hint ? (
          <span title={hint} className="shrink-0 text-[var(--text-muted)]">
            <Info size={12} aria-hidden />
          </span>
        ) : null}
      </div>

      {unavailable ? (
        <>
          <p className="mt-2 text-[22px] font-semibold leading-none tracking-tight text-[var(--text-muted)]">
            —
          </p>
          <p className="mt-2 line-clamp-3 text-[10.5px] leading-relaxed text-[var(--text-muted)]">
            {unavailable.detail}
          </p>
        </>
      ) : (
        <>
          <p className="mt-2 text-[22px] font-semibold leading-none tracking-tight">{formatted}</p>

          <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            <Delta label="PM" value={deltaPriorMonth} format={format} higherIsBetter={higherIsBetter} />
            <Delta label="PY" value={deltaPriorYear} format={format} higherIsBetter={higherIsBetter} />
          </div>

          {sparkline && sparkline.filter((v) => v !== null).length > 1 ? (
            <Sparkline values={sparkline} higherIsBetter={higherIsBetter} />
          ) : null}
        </>
      )}
    </>
  );

  const className =
    'flex flex-col rounded-[var(--radius-lg)] border p-4 transition-colors';
  const style = {
    background: 'var(--surface-1)',
    borderColor: 'var(--border)',
    boxShadow: 'var(--shadow-card)',
  } as const;

  if (href && !unavailable) {
    return (
      <Link href={href} className={`${className} hover:border-[var(--border-strong)]`} style={style}>
        {body}
      </Link>
    );
  }
  return (
    <div className={className} style={style}>
      {body}
    </div>
  );
}

function Delta({
  label,
  value,
  format,
  higherIsBetter,
}: {
  label: string;
  value: number | null | undefined;
  format: ValueFormat;
  higherIsBetter: boolean;
}) {
  if (value === null || value === undefined) {
    return (
      <span className="text-[10.5px] text-[var(--text-muted)]">
        {label} <span className="tnum">—</span>
      </span>
    );
  }

  // Direction comes from higherIsBetter, never from the sign of the number.
  const sentiment = sentimentOf(value, higherIsBetter);
  const color = sentimentColorVar(sentiment);
  const Icon = value > 0 ? ArrowUpRight : value < 0 ? ArrowDownRight : ArrowRight;

  return (
    <span className="inline-flex items-center gap-1 text-[10.5px]">
      <span className="text-[var(--text-muted)]">{label}</span>
      <Icon size={11} aria-hidden style={{ color }} />
      <span className="tnum font-medium" style={{ color }}>
        {formatSignedNumber(value, format)}
      </span>
    </span>
  );
}

/**
 * Twelve-month trend, drawn inline rather than through the chart library: it is
 * a few dozen bytes of SVG and avoids mounting a client component per tile.
 */
function Sparkline({
  values,
  higherIsBetter,
}: {
  values: Array<number | null>;
  higherIsBetter: boolean;
}) {
  const points = values.map((value, index) => ({ index, value }));
  const numeric = points.filter((p): p is { index: number; value: number } => p.value !== null);
  if (numeric.length < 2) return null;

  const width = 100;
  const height = 26;
  const min = Math.min(...numeric.map((p) => p.value));
  const max = Math.max(...numeric.map((p) => p.value));
  const span = max - min || 1;
  const stepX = width / Math.max(values.length - 1, 1);

  const coords = numeric.map((p) => ({
    x: p.index * stepX,
    y: height - ((p.value - min) / span) * height,
  }));

  const path = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
  const last = coords[coords.length - 1]!;
  const first = numeric[0]!.value;
  const latest = numeric[numeric.length - 1]!.value;
  const sentiment = sentimentOf(latest - first, higherIsBetter);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="mt-3 h-[26px] w-full"
      aria-hidden
      focusable="false"
    >
      <path d={path} fill="none" stroke={sentimentColorVar(sentiment)} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last.x} cy={last.y} r={2} fill={sentimentColorVar(sentiment)} />
    </svg>
  );
}
