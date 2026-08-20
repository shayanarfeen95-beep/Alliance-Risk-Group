'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  ChevronDown,
  ExternalLink,
  Info,
} from 'lucide-react';
import {
  formatNumber,
  formatSignedNumber,
  sentimentColorVar,
  sentimentOf,
  type ValueFormat,
} from '@/lib/format';

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

  // --- What opens when the card is expanded ------------------------------
  //
  // All precomputed. The alternative — fetching on expand — puts a spinner
  // between a question and its answer for data that was already in memory when
  // the page rendered, and a control that spins is a control nobody uses twice.

  /** Bases this figure can be read against. The card switches between them. */
  comparisons?: Array<{
    id: 'prior_month' | 'prior_year' | 'budget';
    label: string;
    periodLabel: string;
    /** The comparison figure itself, so "down $82,000" says down from what. */
    formatted: string | null;
    delta: number | null;
    pctChange: number | null;
  }>;

  /** Division split. Absent at a single division, where there is nothing to split. */
  breakdown?: {
    dimension: string;
    /**
     * False for margins, ratios and day counts. A share of a percentage is a
     * meaningless number, and drawing a bar of it is worse than not drawing it.
     */
    additive: boolean;
    rows: Array<{
      label: string;
      code: string;
      formatted: string | null;
      value: number | null;
      share: number | null;
    }>;
  };

  trend?: Array<{ month: string; label: string; value: number | null }>;

  definition?: { formula: string; source: string; workbookLabel: string | null };

  citations?: Array<{ label: string; value: string; source: string }>;

  periodLabel?: string;
  isOpenPeriod?: boolean;
}

/**
 * §9.1: "Each tile shows the current value, the change against prior month and
 * prior year, and a 12-month sparkline."
 *
 * The hero figure uses proportional figures; tabular-nums is reserved for
 * columns that must align.
 */
export function KpiTile(props: KpiTileProps) {
  const {
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
    comparisons,
    breakdown,
    trend,
    definition,
    citations,
    periodLabel,
    isOpenPeriod,
  } = props;

  const [open, setOpen] = useState(false);
  const [basis, setBasis] = useState<string>(comparisons?.[0]?.id ?? 'prior_month');

  const expandable =
    !unavailable && Boolean(comparisons?.length || breakdown || trend?.length || definition);

  const selected = comparisons?.find((comparison) => comparison.id === basis) ?? comparisons?.[0];

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

  const style = {
    background: 'var(--surface-1)',
    borderColor: 'var(--border)',
    boxShadow: 'var(--shadow-card)',
  } as const;

  // Nothing to open — an unavailable metric, or a tile built without the
  // detail. Kept as the plain card it always was rather than a card with a
  // control that does nothing.
  if (!expandable) {
    const className = 'flex flex-col rounded-[var(--radius-lg)] border p-4 transition-colors';
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

  return (
    <div
      className={`flex flex-col rounded-[var(--radius-lg)] border transition-colors ${open ? 'col-span-full' : ''}`}
      style={style}
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex flex-col p-4 text-left transition-colors hover:bg-[var(--surface-2)]"
      >
        {body}
        <span className="mt-2.5 inline-flex items-center gap-1 text-[10.5px] text-[var(--text-muted)]">
          <ChevronDown
            size={11}
            aria-hidden
            style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform 120ms' }}
          />
          {open ? 'Close' : 'Break down and compare'}
        </span>
      </button>

      {open && (
        <div className="border-t px-4 pb-4 pt-3" style={{ borderColor: 'var(--border)' }}>
          <div className="grid gap-5 lg:grid-cols-3">
            {/* --- Compare against ------------------------------------- */}
            {comparisons && comparisons.length > 0 && (
              <section>
                <Legend>Compare against</Legend>
                <div className="flex flex-wrap gap-1">
                  {comparisons.map((comparison) => (
                    <button
                      key={comparison.id}
                      type="button"
                      onClick={() => setBasis(comparison.id)}
                      className="rounded-[5px] border px-2 py-0.5 text-[11px] transition-colors"
                      style={{
                        borderColor:
                          basis === comparison.id ? 'var(--border-strong)' : 'var(--border)',
                        background:
                          basis === comparison.id ? 'var(--surface-2)' : 'transparent',
                        fontWeight: basis === comparison.id ? 600 : 400,
                      }}
                    >
                      {comparison.label}
                    </button>
                  ))}
                </div>

                {selected && (
                  <dl className="mt-2.5 space-y-1 text-[11.5px]">
                    <Row label={selected.periodLabel} value={selected.formatted ?? '—'} />
                    <Row
                      label="Change"
                      value={
                        selected.delta === null
                          ? '—'
                          : formatSignedNumber(selected.delta, format)
                      }
                      color={
                        selected.delta === null
                          ? undefined
                          : sentimentColorVar(sentimentOf(selected.delta, higherIsBetter))
                      }
                    />
                    <Row
                      label="Change %"
                      value={
                        selected.pctChange === null
                          ? '—'
                          : formatNumber(selected.pctChange, 'percent')
                      }
                      color={
                        selected.pctChange === null
                          ? undefined
                          : sentimentColorVar(sentimentOf(selected.pctChange, higherIsBetter))
                      }
                    />
                  </dl>
                )}
              </section>
            )}

            {/* --- Breakdown -------------------------------------------- */}
            {breakdown && (
              <section>
                <Legend>By {breakdown.dimension.toLowerCase()}</Legend>
                <ul className="space-y-1.5">
                  {breakdown.rows.map((row) => (
                    <li key={row.code}>
                      <div className="flex items-baseline justify-between gap-2 text-[11.5px]">
                        <span>{row.label}</span>
                        <span className="tnum font-medium">{row.formatted ?? '—'}</span>
                      </div>
                      {/* Only where a share means something. A margin's share
                          of a margin is not a quantity. */}
                      {breakdown.additive && row.share !== null && (
                        <div
                          className="mt-0.5 h-1 w-full overflow-hidden rounded-full"
                          style={{ background: 'var(--surface-2)' }}
                        >
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${Math.max(1, Math.min(100, row.share * 100))}%`,
                              background: 'var(--series-1)',
                            }}
                          />
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
                {!breakdown.additive && (
                  <p className="mt-2 text-[10px] leading-relaxed text-[var(--text-muted)]">
                    Shown without shares: this is a ratio, and a division&rsquo;s ratio is not a
                    portion of the consolidated one.
                  </p>
                )}
              </section>
            )}

            {/* --- Definition and provenance ---------------------------- */}
            <section>
              <Legend>How it is calculated</Legend>
              {definition && (
                <dl className="space-y-1 text-[11.5px]">
                  <Row label="Formula" value={definition.formula} />
                  <Row label="Source" value={definition.source} />
                  {definition.workbookLabel && (
                    <Row label="In the workbook" value={definition.workbookLabel} />
                  )}
                </dl>
              )}

              {citations && citations.length > 0 && (
                <>
                  <Legend className="mt-3">Figures behind it</Legend>
                  <dl className="space-y-1 text-[11.5px]">
                    {citations.map((citation) => (
                      <Row
                        key={`${citation.label}-${citation.value}`}
                        label={citation.label}
                        value={citation.value}
                      />
                    ))}
                  </dl>
                </>
              )}

              {isOpenPeriod && (
                <p className="mt-2 text-[10px] leading-relaxed" style={{ color: 'var(--status-warning)' }}>
                  {periodLabel} is not closed. This figure is preliminary and still moving.
                </p>
              )}

              {href && (
                <Link
                  href={href}
                  className="mt-2.5 inline-flex items-center gap-1 text-[11px] underline-offset-2 hover:underline"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  <ExternalLink size={11} aria-hidden />
                  Open the detail
                </Link>
              )}
            </section>
          </div>

          {/* --- Trend ------------------------------------------------- */}
          {trend && trend.filter((point) => point.value !== null).length > 1 && (
            <section className="mt-4">
              <Legend>Trailing twelve months</Legend>
              <TrendBars trend={trend} format={format} higherIsBetter={higherIsBetter} />
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function Legend({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <p
      className={`mb-1.5 text-[10px] font-semibold uppercase tracking-[0.07em] ${className}`}
      style={{ color: 'var(--text-muted)' }}
    >
      {children}
    </p>
  );
}

function Row({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-[var(--text-muted)]">{label}</dt>
      <dd className="text-right" style={{ color }}>
        {value}
      </dd>
    </div>
  );
}

/**
 * The twelve months as labelled bars.
 *
 * The collapsed card carries a sparkline, which shows shape and nothing else.
 * Once somebody has opened the card they are asking a specific question —
 * which month, how much — and a line with no axis cannot answer it.
 */
function TrendBars({
  trend,
  format,
  higherIsBetter,
}: {
  trend: NonNullable<KpiTileProps['trend']>;
  format: ValueFormat;
  higherIsBetter: boolean;
}) {
  const values = trend.map((point) => point.value).filter((value): value is number => value !== null);
  if (values.length === 0) return null;

  // Bars are drawn from zero, which is the only honest baseline for a
  // magnitude — a truncated axis turns a 4% move into a cliff. But a series
  // that varies 10% around $5M then draws twelve bars of nearly identical
  // height, and a chart with no visible variation is not worth the space.
  //
  // So the axis is labelled instead of rescaled: the reader sees the range and
  // reads the variation off the numbers, and nobody is misled about the shape.
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const observedHigh = Math.max(...values);
  const observedLow = Math.min(...values);

  return (
    <div className="flex gap-2">
      <div
        className="flex shrink-0 flex-col justify-between py-0.5 text-[9px] tnum"
        style={{ height: 60, color: 'var(--text-muted)' }}
      >
        <span>{formatNumber(max, format)}</span>
        <span>{formatNumber(min, format)}</span>
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-end gap-1" style={{ height: 60 }}>
          {trend.map((point) => {
            const height = point.value === null ? 0 : ((point.value - min) / span) * 58;
            const negative = point.value !== null && point.value < 0;
            return (
              <div key={point.month} className="flex min-w-0 flex-1 items-end self-stretch">
                <div
                  title={`${point.label}: ${point.value === null ? 'no data' : formatNumber(point.value, format)}`}
                  className="w-full rounded-[2px]"
                  style={{
                    height: Math.max(2, height),
                    background: negative
                      ? sentimentColorVar(sentimentOf(-1, higherIsBetter))
                      : 'var(--series-1)',
                    opacity: point.value === null ? 0.2 : 1,
                  }}
                />
              </div>
            );
          })}
        </div>

        <div className="mt-1 flex gap-1">
          {trend.map((point) => (
            <span
              key={point.month}
              className="min-w-0 flex-1 truncate text-center text-[9px] text-[var(--text-muted)]"
            >
              {point.label.slice(0, 3)}
            </span>
          ))}
        </div>

        <p className="mt-1.5 text-[10px] text-[var(--text-muted)]">
          Ranged {formatNumber(observedLow, format)} to {formatNumber(observedHigh, format)} over the
          twelve months. Bars are drawn from zero.
        </p>
      </div>
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
