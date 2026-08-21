'use client';

/**
 * The one chart component every surface uses.
 *
 * Dashboards render charts through this, and so does the agent's generated
 * output — a generated chart and a built chart are the same component reading
 * the same semantic-layer values, which is why they can never look or read
 * differently.
 *
 * Mark specs applied throughout: 2px lines, 4px rounded data-ends anchored to
 * the baseline, a 2px surface gap between adjacent and stacked fills, ≥8px
 * markers, recessive grid and axes, and a crosshair tooltip on every time
 * series.
 *
 * Every chart ships a legend when there are two or more series and a table view
 * behind it. The table is not decoration: three light-mode series colours sit
 * below 3:1 against the surface, and the relief rule requires either visible
 * labels or a table view.
 */
import { useId, useState, type ReactNode } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Table2, ChartColumn } from 'lucide-react';
import { formatAxisTick, formatNumber, type ValueFormat } from '@/lib/format';

export interface ChartSeries {
  id: string;
  label: string;
  /** A CSS variable reference — colour follows the entity, never its rank. */
  color: string;
}

export type ChartDatum = { x: string; xLabel: string } & Record<string, string | number | null>;

export type ChartForm = 'bar' | 'stackedBar' | 'line' | 'area';

export interface ChartCardProps {
  title: string;
  subtitle?: string;
  series: ChartSeries[];
  data: ChartDatum[];
  form?: ChartForm;
  valueFormat?: ValueFormat;
  height?: number;
  /** Rendered under the chart — used to state a denominator or a caveat. */
  note?: string;
  /** Draws a zero line when the data crosses it. */
  showZeroLine?: boolean;
  /**
   * This box's own filter, rendered beside the table toggle.
   *
   * Never part of a generated view spec — the agent emits data, the page
   * decides whether the box is filterable.
   */
  filter?: ReactNode;
}

export function ChartCard({
  title,
  subtitle,
  series,
  data,
  form = 'bar',
  valueFormat = 'currency',
  height = 260,
  note,
  showZeroLine = true,
  filter,
}: ChartCardProps) {
  const [asTable, setAsTable] = useState(false);
  const titleId = useId();

  const hasNegative = data.some((row) =>
    series.some((s) => typeof row[s.id] === 'number' && (row[s.id] as number) < 0),
  );

  return (
    <section
      aria-labelledby={titleId}
      className="rounded-[var(--radius-lg)] border p-5"
      style={{
        background: 'var(--surface-1)',
        borderColor: 'var(--border)',
        boxShadow: 'var(--shadow-card)',
      }}
    >
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 id={titleId} className="text-[13px] font-semibold tracking-tight">
            {title}
          </h3>
          {subtitle ? (
            <p className="mt-0.5 text-[11px] leading-snug text-[var(--text-muted)]">{subtitle}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {filter}
          <button
            type="button"
            onClick={() => setAsTable((value) => !value)}
            aria-pressed={asTable}
            title={asTable ? 'Show chart' : 'Show the underlying numbers'}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border transition-colors hover:bg-[var(--surface-2)]"
            style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
          >
            {asTable ? <ChartColumn size={14} aria-hidden /> : <Table2 size={14} aria-hidden />}
            <span className="sr-only">{asTable ? 'Show chart' : 'Show table'}</span>
          </button>
        </div>
      </div>

      {/* A legend is always present for two or more series, so identity is never
          carried by colour alone. */}
      {series.length > 1 ? (
        <ul className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
          {series.map((s) => (
            <li key={s.id} className="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
              <span
                aria-hidden
                className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                style={{ background: s.color }}
              />
              {s.label}
            </li>
          ))}
        </ul>
      ) : null}

      {asTable ? (
        <ChartTable series={series} data={data} valueFormat={valueFormat} />
      ) : (
        <div style={{ height }}>
          <ResponsiveContainer width="100%" height="100%">
            {renderChart({ form, series, data, valueFormat, hasNegative, showZeroLine })}
          </ResponsiveContainer>
        </div>
      )}

      {note ? (
        <p className="mt-3 border-t pt-3 text-[11px] leading-relaxed text-[var(--text-muted)]" style={{ borderColor: 'var(--border)' }}>
          {note}
        </p>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------

function renderChart({
  form,
  series,
  data,
  valueFormat,
  hasNegative,
  showZeroLine,
}: {
  form: ChartForm;
  series: ChartSeries[];
  data: ChartDatum[];
  valueFormat: ValueFormat;
  hasNegative: boolean;
  showZeroLine: boolean;
}) {
  const axes = (
    <>
      <CartesianGrid
        strokeDasharray="0"
        vertical={false}
        stroke="var(--grid)"
        strokeWidth={1}
      />
      <XAxis
        dataKey="xLabel"
        tickLine={false}
        axisLine={{ stroke: 'var(--axis)', strokeWidth: 1 }}
        tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
        interval="preserveStartEnd"
        minTickGap={12}
      />
      <YAxis
        tickLine={false}
        axisLine={false}
        width={52}
        tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
        tickFormatter={(value: number) => formatAxisTick(value, valueFormat)}
      />
      <Tooltip
        cursor={{ fill: 'var(--surface-2)', stroke: 'var(--axis)', strokeWidth: 1 }}
        content={<ChartTooltip series={series} valueFormat={valueFormat} />}
      />
      {showZeroLine && hasNegative ? (
        <ReferenceLine y={0} stroke="var(--axis)" strokeWidth={1} />
      ) : null}
    </>
  );

  if (form === 'line') {
    return (
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        {axes}
        {series.map((s) => (
          <Line
            key={s.id}
            type="monotone"
            dataKey={s.id}
            name={s.label}
            stroke={s.color}
            strokeWidth={2}
            dot={false}
            // Markers appear on hover at 8px so they are a real hit target.
            activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface-1)' }}
            connectNulls={false}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    );
  }

  if (form === 'area') {
    return (
      <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <defs>
          {series.map((s) => (
            <linearGradient key={s.id} id={`fill-${s.id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity={0.22} />
              <stop offset="100%" stopColor={s.color} stopOpacity={0.02} />
            </linearGradient>
          ))}
        </defs>
        {axes}
        {series.map((s) => (
          <Area
            key={s.id}
            type="monotone"
            dataKey={s.id}
            name={s.label}
            stroke={s.color}
            strokeWidth={2}
            fill={`url(#fill-${s.id})`}
            activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface-1)' }}
            isAnimationActive={false}
          />
        ))}
      </AreaChart>
    );
  }

  const stacked = form === 'stackedBar';
  return (
    <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="22%">
      {axes}
      {series.map((s) => (
        <Bar
          key={s.id}
          dataKey={s.id}
          name={s.label}
          stackId={stacked ? 'stack' : undefined}
          fill={s.color}
          // 4px rounded data-end, square against the baseline.
          radius={[4, 4, 0, 0]}
          // A 2px surface gap keeps adjacent and stacked fills legibly separate.
          stroke="var(--surface-1)"
          strokeWidth={stacked ? 2 : 0}
          isAnimationActive={false}
          maxBarSize={54}
        >
          {/* Negative values flip the rounded end to the other side so the
              radius always sits at the data end, never at the baseline. */}
          {data.map((row) => {
            const value = row[s.id];
            const negative = typeof value === 'number' && value < 0;
            return (
              <Cell
                key={`${s.id}-${row.x}`}
                radius={(negative ? [0, 0, 4, 4] : [4, 4, 0, 0]) as unknown as number}
              />
            );
          })}
        </Bar>
      ))}
    </BarChart>
  );
}

// ---------------------------------------------------------------------------

interface TooltipPayloadEntry {
  dataKey?: string | number;
  value?: number;
  payload?: ChartDatum;
}

function ChartTooltip({
  active,
  payload,
  series,
  valueFormat,
}: {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  series: ChartSeries[];
  valueFormat: ValueFormat;
}) {
  if (!active || !payload?.length) return null;
  const label = payload[0]?.payload?.xLabel ?? '';

  return (
    <div
      className="rounded-[var(--radius)] border px-3 py-2 text-[11px] shadow-lg"
      style={{
        background: 'var(--surface-raised)',
        borderColor: 'var(--border-strong)',
        color: 'var(--text-primary)',
      }}
    >
      <p className="mb-1.5 font-medium">{label}</p>
      <ul className="space-y-1">
        {payload.map((entry) => {
          const definition = series.find((s) => s.id === entry.dataKey);
          if (!definition) return null;
          return (
            <li key={definition.id} className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-1.5 text-[var(--text-secondary)]">
                <span
                  aria-hidden
                  className="h-2 w-2 shrink-0 rounded-[2px]"
                  style={{ background: definition.color }}
                />
                {definition.label}
              </span>
              {/* The value wears text ink, not the series colour. */}
              <span className="tnum font-medium">{formatNumber(entry.value ?? null, valueFormat)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ChartTable({
  series,
  data,
  valueFormat,
}: {
  series: ChartSeries[];
  data: ChartDatum[];
  valueFormat: ValueFormat;
}) {
  return (
    <div className="scroll-x max-h-[280px] overflow-y-auto">
      <table className="w-full min-w-max border-collapse text-[12px]">
        <thead className="sticky top-0" style={{ background: 'var(--surface-1)' }}>
          <tr>
            <th
              className="border-b px-3 py-2 text-left text-[10.5px] font-semibold uppercase tracking-[0.06em]"
              style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
            >
              Period
            </th>
            {series.map((s) => (
              <th
                key={s.id}
                className="border-b px-3 py-2 text-right text-[10.5px] font-semibold uppercase tracking-[0.06em]"
                style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
              >
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row) => (
            <tr key={row.x}>
              <td className="border-b px-3 py-1.5" style={{ borderColor: 'var(--border)' }}>
                {row.xLabel}
              </td>
              {series.map((s) => (
                <td
                  key={s.id}
                  className="tnum border-b px-3 py-1.5 text-right"
                  style={{ borderColor: 'var(--border)' }}
                >
                  {formatNumber(row[s.id] as number | null, valueFormat)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
