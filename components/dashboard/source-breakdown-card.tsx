'use client';

/**
 * A lead-source breakdown that can be read as year-to-date totals or month by
 * month.
 *
 * Westport: "Deals by lead source — can we also get a monthly view of this? Or
 * a way to choose between YTD totals or monthly?" Both, behind one switch, over
 * the same deals: the monthly bars add up to the year-to-date rows.
 */
import { useState } from 'react';
import { ChartCard } from '@/components/charts/chart-card';
import { DealList, useDeals } from '@/components/charts/deal-drill';
import { formatNumber } from '@/lib/format';
import type { SourceBreakdown } from '@/lib/dashboards/leadership-2026';

export function SourceBreakdownCard({
  title,
  subtitle,
  model,
  definition,
}: {
  title: string;
  subtitle: string;
  model: SourceBreakdown;
  definition: string;
}) {
  const [view, setView] = useState<'ytd' | 'monthly'>('ytd');
  const [source, setSource] = useState<string | null>(null);
  const deals = useDeals();
  const total = model.ytd.reduce((sum, row) => sum + row.count, 0);

  const toggle = (
    <div className="flex gap-1" role="group" aria-label={`Show ${title} as`}>
      {(
        [
          ['ytd', 'Year to date'],
          ['monthly', 'By month'],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          type="button"
          onClick={() => setView(id)}
          aria-pressed={view === id}
          className="rounded-[4px] border px-2 py-0.5 text-[11px] font-medium"
          style={{
            borderColor: view === id ? 'var(--text-primary)' : 'var(--border)',
            background: view === id ? 'var(--text-primary)' : 'transparent',
            color: view === id ? 'var(--text-inverse)' : 'var(--text-secondary)',
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );

  if (view === 'monthly') {
    return (
      <div className="space-y-2">
        <div className="flex justify-end">{toggle}</div>
        <ChartCard
          title={title}
          subtitle={`${subtitle} — month by month`}
          series={model.monthly.series}
          data={model.monthly.data}
          form="stackedBar"
          valueFormat="count"
          height={280}
          definition={definition}
          drill={model.monthly.drill}
        />
      </div>
    );
  }

  return (
    <section
      className="rounded-[var(--radius-lg)] border p-5"
      style={{ background: 'var(--surface-1)', borderColor: 'var(--border)', boxShadow: 'var(--shadow-card)' }}
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[13px] font-semibold tracking-tight">{title}</h3>
          <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">{subtitle} — year to date</p>
        </div>
        {toggle}
      </div>

      {model.ytd.length === 0 ? (
        <p className="text-[12px] text-[var(--text-muted)]">Nothing this year.</p>
      ) : (
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr>
              {['Source', 'Deals', 'Value', 'Share'].map((heading, index) => (
                <th
                  key={heading}
                  className={`border-b px-2.5 py-1.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] ${index === 0 ? 'text-left' : 'text-right'}`}
                  style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
                >
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {model.ytd.map((row) => (
              <tr
                key={row.key}
                onClick={deals ? () => setSource((current) => (current === row.key ? null : row.key)) : undefined}
                className={deals ? 'cursor-pointer hover:bg-[var(--surface-2)]' : undefined}
                style={source === row.key ? { background: 'var(--surface-2)' } : undefined}
              >
                <td className="border-b px-2.5 py-1.5" style={{ borderColor: 'var(--border)' }}>
                  {row.label}
                </td>
                <td className="tnum border-b px-2.5 py-1.5 text-right" style={{ borderColor: 'var(--border)' }}>
                  {formatNumber(row.count, 'count')}
                </td>
                <td className="tnum border-b px-2.5 py-1.5 text-right" style={{ borderColor: 'var(--border)' }}>
                  {formatNumber(row.amount, 'currency')}
                </td>
                <td className="tnum border-b px-2.5 py-1.5 text-right" style={{ borderColor: 'var(--border)' }}>
                  {total === 0 ? '—' : `${((row.count / total) * 100).toFixed(0)}%`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {source ? (
        <DealList
          title={`${title} — ${source}`}
          ids={model.idsBySource[source] ?? []}
          onClose={() => setSource(null)}
        />
      ) : null}

      <div
        className="mt-3 space-y-1 border-t pt-3 text-[11px] leading-relaxed text-[var(--text-muted)]"
        style={{ borderColor: 'var(--border)' }}
      >
        <p>
          <span className="font-semibold text-[var(--text-secondary)]">Counted as: </span>
          {definition}
        </p>
        <p>
          Share is of deals. “Not recorded” is a deal with no lead source set — shown rather than
          dropped. {deals ? 'Click a source to list its deals.' : ''}
        </p>
      </div>
    </section>
  );
}
