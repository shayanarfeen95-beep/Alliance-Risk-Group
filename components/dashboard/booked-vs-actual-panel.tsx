/**
 * Booked against billed.
 *
 * The one comparison that needs both systems, and the one most easily misread —
 * so the caveat is not a footnote, it sits under the headline where the number
 * is. Booked and billed are not the same money on the same date: a deal booked
 * in March may bill from April to September. Booked above billed is timing, not
 * a shortfall, and on a multi-month contract it is timing by design.
 */
import Link from 'next/link';
import { ChartCard } from '@/components/charts/chart-card';
import { Card, CardHeader, DataTable, Td, Th, Unavailable } from '@/components/ui/primitives';
import { StatTile } from '@/components/dashboard/stat-tile';
import { formatNumber } from '@/lib/format';
import { CircleAlert } from 'lucide-react';
import type { BookedVsActual, NewBusinessFilter } from '@/lib/dashboards/booked-vs-actual';

const FILTERS: Array<{ id: NewBusinessFilter; label: string }> = [
  { id: 'all', label: 'All deals' },
  { id: 'new', label: 'New business' },
  { id: 'existing', label: 'Existing business' },
];

export function BookedVsActualPanel({
  model,
  basePath,
  searchParams,
}: {
  model: BookedVsActual;
  basePath: string;
  searchParams: Record<string, string | undefined>;
}) {
  const href = (filter: NewBusinessFilter) => {
    const params = new URLSearchParams(
      Object.entries(searchParams).filter(([, value]) => value) as [string, string][],
    );
    if (filter === 'all') params.delete('newBusiness');
    else params.set('newBusiness', filter);
    return `${basePath}?${params.toString()}`;
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-medium text-[var(--text-secondary)]">Booked this year</span>
        {FILTERS.map((filter) => (
          <Link
            key={filter.id}
            href={href(filter.id)}
            className="rounded-[5px] border px-2.5 py-1 text-[11.5px] font-medium"
            style={{
              borderColor: model.filter === filter.id ? 'var(--text-primary)' : 'var(--border)',
              background: model.filter === filter.id ? 'var(--surface-2)' : 'transparent',
            }}
          >
            {filter.label}
          </Link>
        ))}
        {model.dealTypeMissing && (
          <span className="text-[10.5px]" style={{ color: 'var(--status-warning)' }}>
            No deal carries a type yet, so this filter has nothing to separate — pull HubSpot again.
          </span>
        )}
      </div>

      {model.unavailable ? (
        <Card>
          <CardHeader title="Booked versus billed" />
          <Unavailable reason="SOURCE_NOT_LOADED" detail={model.unavailable} />
        </Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile
              label="Booked year to date"
              value={model.ytd.booked}
              valueFormat="currency"
              basis="HubSpot: deals closed won this year, by close date."
            />
            <StatTile
              label="Billed year to date"
              value={model.ytd.billed}
              valueFormat="currency"
              basis="QuickBooks: revenue recognised this year, accrual basis."
            />
            <StatTile
              label="Prior year, same months"
              value={model.ytd.priorYearBilled}
              valueFormat="currency"
              detail={
                model.ytd.vsPriorYearPct === null
                  ? undefined
                  : `${model.ytd.vsPriorYearPct >= 0 ? '+' : ''}${model.ytd.vsPriorYearPct.toFixed(1)}% on last year`
              }
              basis={`The first ${model.ytd.monthsElapsed} month${model.ytd.monthsElapsed === 1 ? '' : 's'} of last year, so the comparison is like for like.`}
            />
            <StatTile
              label="Paced full year"
              value={model.ytd.pacedFullYear}
              valueFormat="currency"
              detail={`Last year finished at ${formatNumber(model.ytd.priorYearFull, 'currency')}`}
              basis="A projection, not a forecast: this year's billed rate carried across twelve months. It assumes nothing about seasonality."
            />
          </div>

          <div
            className="flex items-start gap-2 rounded-[var(--radius)] border p-3"
            style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}
          >
            <CircleAlert size={13} className="mt-0.5 shrink-0 text-[var(--text-muted)]" aria-hidden />
            <p className="text-[11.5px] leading-relaxed text-[var(--text-secondary)]">
              {model.ytd.conversionPct === null ? (
                'Nothing was booked in this period, so there is no conversion rate to state.'
              ) : (
                <>
                  <strong>
                    {model.ytd.conversionPct.toFixed(0)}% of what was booked has billed so far.
                  </strong>{' '}
                </>
              )}
              Booked and billed are not the same money on the same date — a deal booked in March
              may bill from April to September, or not at all. Read the difference as timing and
              conversion, never as a shortfall to be closed.
            </p>
          </div>

          <ChartCard
            title="Booked, billed and prior year by month"
            subtitle="HubSpot bookings against QuickBooks revenue, with the same months last year"
            series={[
              { id: 'booked', label: 'Booked (HubSpot)', color: 'var(--series-1)' },
              { id: 'billed', label: 'Billed (QuickBooks)', color: 'var(--series-2)' },
              { id: 'priorYearBilled', label: 'Billed last year', color: 'var(--series-3)' },
            ]}
            data={model.rows.map((row) => ({
              x: row.month,
              xLabel: row.label,
              booked: row.booked,
              billed: row.billed,
              priorYearBilled: row.priorYearBilled,
            }))}
            form="bar"
            valueFormat="currency"
            height={300}
            note="One axis — all three are dollars. Bookings are dated by close date and revenue by the month it was recognised, so a bar pair is not a like-for-like settlement of the same contract."
          />

          <Card>
            <CardHeader
              title="Month by month"
              subtitle="The same figures, with conversion stated per month"
            />
            <DataTable>
              <thead>
                <tr>
                  <Th align="left">Month</Th>
                  <Th>Booked</Th>
                  <Th>Billed</Th>
                  <Th>Billed last year</Th>
                  <Th>vs last year</Th>
                </tr>
              </thead>
              <tbody>
                {model.rows.map((row) => (
                  <tr key={row.month}>
                    <Td align="left" numeric={false}>
                      {row.label}
                    </Td>
                    <Td>{formatNumber(row.booked, 'currency')}</Td>
                    <Td>{formatNumber(row.billed, 'currency')}</Td>
                    <Td>{formatNumber(row.priorYearBilled, 'currency')}</Td>
                    <Td>
                      {row.priorYearBilled === 0
                        ? '—'
                        : `${(((row.billed - row.priorYearBilled) / row.priorYearBilled) * 100).toFixed(0)}%`}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          </Card>
        </>
      )}

      <p className="text-[10.5px] leading-relaxed text-[var(--text-muted)]">
        <strong>Per customer is not shown.</strong> {model.perCustomerBlocked}
      </p>
    </div>
  );
}
