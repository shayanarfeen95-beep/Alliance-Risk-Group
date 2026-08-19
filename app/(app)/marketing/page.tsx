import type { Metadata } from 'next';
import { loadDashboardContext, type SearchParams } from '@/lib/dashboards/context';
import { loadMarketing } from '@/lib/dashboards/marketing';
import { formatMonth } from '@/lib/semantic/periods';
import { formatNumber } from '@/lib/format';
import { KpiTile } from '@/components/dashboard/kpi-tile';
import { BoxFilter } from '@/components/dashboard/box-filter';
import { ChartCard } from '@/components/charts/chart-card';
import { Card, CardHeader, DataTable, Td, Th, Unavailable } from '@/components/ui/primitives';

export const metadata: Metadata = { title: 'Marketing' };
export const dynamic = 'force-dynamic';

export default async function MarketingPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const context = await loadDashboardContext(await searchParams);
  const { session, divisionCode } = context;
  const model = loadMarketing(session, divisionCode, context.boxScope);
  const boxOptions = context.boxFilterOptions;

  const divisionLabel =
    divisionCode === 'ARG_TOTAL'
      ? 'ARG Total'
      : (session.bundle.divisions.find((d) => d.divisionCode === divisionCode)?.divisionName ??
        divisionCode);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[19px] font-semibold tracking-tight">Marketing</h1>
        <p className="mt-1 max-w-2xl text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
          What marketing spend produced — leads, cost per lead, and what it returned.
        </p>
        <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">
          {divisionLabel} · {formatMonth(session.period.month)} · HubSpot leads against QuickBooks
          spend
        </p>
      </header>

      {model.spendPending ? (
        <Unavailable reason="PENDING_DEFINITION" detail={model.spendPending} />
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {model.tiles.map((tile) => (
          <KpiTile key={tile.box?.boxId ?? tile.name} {...tile} boxOptions={boxOptions} />
        ))}
      </div>

      <p className="text-[11px] leading-relaxed text-[var(--text-muted)]">
        Cost Per Lead, Return on Ad Spend and the Marketing Efficiency Ratio use the
        marketing-only account set. Customer Acquisition Cost uses a deliberately different, larger
        set that also includes sales spend. Both lists are configuration, reviewed in Admin.
      </p>

      <div className="grid gap-4 xl:grid-cols-2">
        {/* Two measures of different scale get two charts, never a second y-axis. */}
        <ChartCard
          title="Marketing spend against closed-won revenue"
          subtitle="Trailing twelve months"
          series={model.spendTrendSeries}
          data={model.spendTrend}
          form="bar"
          valueFormat="currency"
          height={250}
          filter={<BoxFilter state={model.boxes.spendTrend} options={boxOptions} />}
        />
        <ChartCard
          title="Leads received"
          subtitle="Trailing twelve months"
          series={model.leadsTrendSeries}
          data={model.leadsTrend}
          form="line"
          valueFormat="count"
          height={250}
          filter={<BoxFilter state={model.boxes.leadsTrend} options={boxOptions} />}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
        <Card>
          <CardHeader
            title="Leads by original source"
            subtitle="Cost per lead is apportioned by lead share — HubSpot carries no per-source spend, so this is an allocation, not a measured figure."
            action={<BoxFilter state={model.boxes.sources} options={boxOptions} />}
          />
          {model.sources.length === 0 ? (
            <p className="text-[12px] text-[var(--text-muted)]">
              No leads recorded for this period.
            </p>
          ) : (
            <DataTable>
              <thead>
                <tr>
                  <Th align="left">Source</Th>
                  <Th>Leads</Th>
                  <Th>Cost per lead</Th>
                  <Th>Customers</Th>
                  <Th>Conversion</Th>
                </tr>
              </thead>
              <tbody>
                {model.sources.map((row) => (
                  <tr key={row.source}>
                    <Td align="left" numeric={false}>
                      {row.label}
                    </Td>
                    <Td>{formatNumber(row.leads, 'count')}</Td>
                    <Td>{formatNumber(row.costPerLead, 'currency_precise')}</Td>
                    <Td>{formatNumber(row.customers, 'count')}</Td>
                    <Td muted>{formatNumber(row.conversionRate, 'percent')}</Td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Conversion"
            subtitle="Lead to customer, this period"
            action={<BoxFilter state={model.boxes.conversion} options={boxOptions} />}
          />
          <ul className="space-y-2">
            <li
              className="flex items-baseline justify-between gap-3 border-b pb-2"
              style={{ borderColor: 'var(--border)' }}
            >
              <span className="text-[12px] text-[var(--text-secondary)]">
                Lead-to-customer rate
              </span>
              <span className="tnum text-[13px] font-medium">
                {formatNumber(model.conversion.leadToCustomer, 'percent')}
              </span>
            </li>
            <li className="flex items-baseline justify-between gap-3">
              <span className="text-[12px] text-[var(--text-secondary)]">
                Average days lead to close
              </span>
              <span className="tnum text-[13px] font-medium">
                {formatNumber(model.conversion.averageDaysLeadToClose, 'days')}
              </span>
            </li>
          </ul>
        </Card>
      </div>
    </div>
  );
}
