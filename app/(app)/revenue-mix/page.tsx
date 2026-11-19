import type { Metadata } from 'next';
import { getDb } from '@/lib/db/client';
import { loadDashboardContext, type SearchParams } from '@/lib/dashboards/context';
import { monthsInRange } from '@/lib/dashboards/range';
import { formatMonthShort } from '@/lib/semantic/periods';
import { formatNumber } from '@/lib/format';
import { loadRevenueMix, type MixCustomer } from '@/lib/billing/revenue-mix';
import { StatTile } from '@/components/dashboard/stat-tile';
import { ChartCard } from '@/components/charts/chart-card';
import { Card, CardHeader, DataTable, Td, Th, Unavailable } from '@/components/ui/primitives';

export const metadata: Metadata = { title: 'Revenue mix' };
export const dynamic = 'force-dynamic';

/**
 * Existing customers against net-new revenue, by business line.
 *
 * Westport, November 2026: "Is there a way to be able to show (of the total
 * revenue) some type of visual indicator by business line to track net new vs.
 * existing client growth?" — for the 2027 budget.
 */
export default async function RevenueMixPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const context = await loadDashboardContext(await searchParams);
  const { session, range, divisionCode } = context;

  if (!session.consolidatedAvailable) {
    return (
      <div className="space-y-6">
        <h1 className="text-[19px] font-semibold tracking-tight">Revenue mix</h1>
        <Unavailable
          reason="NOT_AVAILABLE_BY_DIVISION"
          detail="Revenue by customer covers the whole company, so it is shown to people who can see ARG Total."
        />
      </div>
    );
  }

  const months = monthsInRange(range).filter((month) => month <= session.period.month);
  const mix = await loadRevenueMix(await getDb(), session, { months, divisionCode });
  const periodLabel =
    months.length === 0
      ? range.label
      : months.length === 1
        ? formatMonthShort(months[0]!)
        : `${formatMonthShort(months[0]!)} – ${formatMonthShort(months[months.length - 1]!)}`;
  const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : '—');

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[19px] font-semibold tracking-tight">Revenue mix: existing vs net new</h1>
        <p className="mt-1 max-w-3xl text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
          Of the revenue in each business line, how much came from customers already billing in that line and how much
          is new business — the split for the 2027 budget. From QuickBooks&rsquo; Income by Customer report, accrual
          basis, by class.
        </p>
        <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">
          {periodLabel} · {divisionCode === 'ARG_TOTAL' ? 'every business line' : mix.lines[0]?.label ?? divisionCode}
          {mix.historyFrom ? ` · customer history from ${formatMonthShort(mix.historyFrom as never)}` : ''}
        </p>
      </header>

      {mix.unavailable ? <Unavailable reason="NO_DATA" detail={mix.unavailable} /> : null}

      {!mix.unavailable ? (
        <>
          {mix.monthsOfHistory < 12 ? (
            <p
              className="rounded-[var(--radius)] px-3 py-2 text-[11.5px]"
              style={{ background: 'var(--status-serious-wash, var(--surface-2))', color: 'var(--text-secondary)' }}
            >
              Only {mix.monthsOfHistory} month{mix.monthsOfHistory === 1 ? '' : 's'} of customer history sit before this
              period, so a customer who last billed before {mix.historyFrom?.slice(0, 7)} counts as new. Loading more
              QuickBooks history (Admin → Data & pulls, an earlier start month) sharpens the split.
            </p>
          ) : null}

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile
              label="Revenue"
              value={mix.total.total}
              valueFormat="currency"
              basis={`Income by customer, ${periodLabel}.`}
            />
            <StatTile
              label="From existing customers"
              value={mix.total.existing}
              valueFormat="currency"
              detail={`${pct(mix.total.existing, mix.total.total)} of revenue · ${formatNumber(mix.total.existingCustomers, 'count')} customers`}
              basis="Customers QuickBooks shows earning before the period started."
            />
            <StatTile
              label="Net new"
              value={mix.total.netNew}
              valueFormat="currency"
              detail={`${pct(mix.total.netNew, mix.total.total)} of revenue · ${formatNumber(mix.total.newCustomers, 'count')} customers`}
              basis="Customers with no revenue before the period."
            />
            <StatTile
              label="Existing-customer growth"
              value={mix.total.existingGrowth}
              valueFormat="currency"
              detail={`vs ${formatNumber(mix.total.existingPriorYear, 'currency')} the same months last year`}
              basis="What existing customers billed in the period, less what they billed in the same months a year earlier."
            />
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <ChartCard
              title="Existing vs net new, by business line"
              subtitle={periodLabel}
              series={[
                { id: 'existing', label: 'Existing customers', color: 'var(--series-1)' },
                { id: 'netNew', label: 'Net new', color: 'var(--series-3)' },
              ]}
              data={mix.lines
                // A sliver (e.g. a small credit on no class) stays in the table, not the chart's scale.
                .filter((line) => Math.abs(line.total) >= Math.abs(mix.total.total) * 0.01)
                .map((line) => ({ x: line.key, xLabel: line.label, existing: line.existing, netNew: line.netNew }))}
              form="stackedBar"
              valueFormat="currency"
              height={280}
              definition="Existing: the customer earned income in that business line in a month before the period. Net new: it did not. Jobs count as their parent customer."
            />
            <ChartCard
              title="Month by month"
              subtitle={`${divisionCode === 'ARG_TOTAL' ? 'ARG Total' : mix.lines[0]?.label ?? ''} · existing vs net new`}
              series={[
                { id: 'existing', label: 'Existing customers', color: 'var(--series-1)' },
                { id: 'netNew', label: 'Net new', color: 'var(--series-3)' },
              ]}
              data={mix.byMonth.map((point) => ({
                x: point.month,
                xLabel: formatMonthShort(point.month as never),
                existing: point.existing,
                netNew: point.netNew,
              }))}
              form="stackedBar"
              valueFormat="currency"
              height={280}
              definition="At ARG Total a customer new to one line but already billing in another is existing (cross-sell); by business line it is new to that line."
            />
          </div>

          <Card>
            <CardHeader title="By business line" subtitle="QuickBooks classes grouped into ARG's divisions" />
            <DataTable>
              <thead>
                <tr>
                  <Th align="left">Business line</Th>
                  <Th>Revenue</Th>
                  <Th>Existing</Th>
                  <Th>% existing</Th>
                  <Th>Net new</Th>
                  <Th>% net new</Th>
                  <Th>Existing customers</Th>
                  <Th>New customers</Th>
                  <Th title="Existing customers' revenue, less the same months a year earlier">Existing growth</Th>
                </tr>
              </thead>
              <tbody>
                {[...mix.lines, ...(divisionCode === 'ARG_TOTAL' ? [mix.total] : [])].map((line) => (
                  <tr key={line.key} style={line.key === 'ARG_TOTAL' ? { fontWeight: 600 } : undefined}>
                    <Td align="left" numeric={false}>
                      {line.label}
                      {line.classes.length ? (
                        <span className="block text-[10.5px] font-normal text-[var(--text-muted)]">
                          QuickBooks: {line.classes.join(', ')}
                        </span>
                      ) : null}
                    </Td>
                    <Td>{formatNumber(line.total, 'currency')}</Td>
                    <Td>{formatNumber(line.existing, 'currency')}</Td>
                    <Td muted>{pct(line.existing, line.total)}</Td>
                    <Td>{formatNumber(line.netNew, 'currency')}</Td>
                    <Td muted>{pct(line.netNew, line.total)}</Td>
                    <Td muted>{formatNumber(line.existingCustomers, 'count')}</Td>
                    <Td muted>{formatNumber(line.newCustomers, 'count')}</Td>
                    <Td>{formatNumber(line.existingGrowth, 'currency')}</Td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          </Card>

          <div className="grid gap-4 xl:grid-cols-2">
            <CustomerTable title="Largest net-new customers" subtitle={`First billed in ${periodLabel}`} rows={mix.topNew} showFirst />
            <CustomerTable
              title="Existing customers growing most"
              subtitle="Against the same months last year"
              rows={mix.topGrowth}
            />
          </div>
          {mix.topDecline.length ? (
            <CustomerTable
              title="Existing customers billing less than last year"
              subtitle="Against the same months last year"
              rows={mix.topDecline}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function CustomerTable({
  title,
  subtitle,
  rows,
  showFirst,
}: {
  title: string;
  subtitle: string;
  rows: MixCustomer[];
  showFirst?: boolean;
}) {
  return (
    <Card>
      <CardHeader title={title} subtitle={subtitle} />
      {rows.length === 0 ? (
        <p className="text-[12px] text-[var(--text-muted)]">None in this period.</p>
      ) : (
        <DataTable maxHeight={420}>
          <thead>
            <tr>
              <Th align="left">Customer</Th>
              <Th align="left">Business line</Th>
              <Th>Revenue</Th>
              <Th>{showFirst ? 'First billed' : 'Same months last year'}</Th>
              {showFirst ? null : <Th>Change</Th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.customerId}-${row.line}`}>
                <Td align="left" numeric={false}>{row.name}</Td>
                <Td align="left" numeric={false} muted>{row.line}</Td>
                <Td>{formatNumber(row.revenue, 'currency')}</Td>
                <Td muted>{showFirst ? row.firstMonth : formatNumber(row.priorYear, 'currency')}</Td>
                {showFirst ? null : <Td>{formatNumber(row.revenue - row.priorYear, 'currency')}</Td>}
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </Card>
  );
}
