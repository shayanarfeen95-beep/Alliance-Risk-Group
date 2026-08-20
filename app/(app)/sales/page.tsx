import type { Metadata } from 'next';
import { loadDashboardContext, type SearchParams } from '@/lib/dashboards/context';
import { loadSales } from '@/lib/dashboards/sales';
import { buildDivisionColorMap } from '@/lib/charts/colors';
import { formatMonth } from '@/lib/semantic/periods';
import { formatNumber } from '@/lib/format';
import { KpiTile } from '@/components/dashboard/kpi-tile';
import { ChartCard } from '@/components/charts/chart-card';
import { Card, CardHeader, DataTable, SectionTitle, Td, Th, Unavailable } from '@/components/ui/primitives';
import { OwnerFilter } from '@/components/dashboard/owner-filter';

export const metadata: Metadata = { title: 'Sales' };
export const dynamic = 'force-dynamic';

export default async function SalesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const context = await loadDashboardContext(await searchParams);
  const { session, divisionCode, range, owners, ownerName } = context;
  const colors = buildDivisionColorMap(session.bundle.divisions);
  const model = loadSales(session, divisionCode, colors, { range, ownerName });

  const divisionLabel =
    divisionCode === 'ARG_TOTAL'
      ? 'ARG Total'
      : (session.bundle.divisions.find((d) => d.divisionCode === divisionCode)?.divisionName ??
        divisionCode);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[19px] font-semibold tracking-tight">Sales</h1>
        <p className="mt-1 max-w-2xl text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
          What was booked, what is in the pipeline, and who closed it.
        </p>
        <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">
          {divisionLabel} · {formatMonth(session.period.month)} · sourced from HubSpot
        </p>
      </header>

      {model.unavailable ? (
        <Unavailable reason="NOT_AVAILABLE_BY_DIVISION" detail={model.unavailable} />
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {model.tiles.map((tile) => (
          <KpiTile key={tile.name} {...tile} />
        ))}
      </div>

      {/* §6: "State the denominator on the dashboard — it is the single most
          commonly misread sales metric." */}
      {model.bookingRateDenominator ? (
        <p className="text-[11px] text-[var(--text-muted)]">
          Booking Rate is {model.bookingRateDenominator.won} won ÷{' '}
          {model.bookingRateDenominator.closed} deals <strong>closed</strong> in the period (won plus
          lost). It is not a share of open pipeline.
        </p>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard
          title="Booked against budgeted revenue"
          subtitle="Closed-won bookings by division, against the operating budget"
          series={model.bookedVsBudgetSeries}
          data={model.bookedVsBudget}
          form="bar"
          valueFormat="currency"
          height={260}
          note="Bookings and recognised revenue are different measures — a deal closed this month may be delivered over several. QBO revenue is the secondary check."
        />

        <Card>
          <CardHeader title="Pipeline by stage" subtitle="Open deals as of the reporting date" />
          {model.pipelineByStage.length === 0 ? (
            <p className="text-[12px] text-[var(--text-muted)]">No open deals in scope.</p>
          ) : (
            <DataTable>
              <thead>
                <tr>
                  <Th align="left">Stage</Th>
                  <Th>Deals</Th>
                  <Th>Value</Th>
                </tr>
              </thead>
              <tbody>
                {model.pipelineByStage.map((row) => (
                  <tr key={row.stage}>
                    <Td align="left" numeric={false}>
                      {row.label}
                    </Td>
                    <Td>{formatNumber(row.count, 'count')}</Td>
                    <Td>{formatNumber(row.value, 'currency')}</Td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </Card>
      </div>

      <ChartCard
        title="Bookings trend"
        subtitle="Dollars booked, trailing twelve months"
        series={model.bookingsTrendSeries}
        data={model.bookingsTrend}
        form="bar"
        valueFormat="currency"
        height={240}
      />

      {/* Per-salesperson performance — the leaderboard leadership asked for. */}
      <section>
        <SectionTitle hint="Closed in the selected date range, by the person who owns the deal">
          By salesperson
        </SectionTitle>
        <Card>
          {model.bySalesperson.length === 0 ? (
            <p className="text-[12px] text-[var(--text-muted)]">
              No deals closed or open in {model.dealScope.rangeLabel}.
            </p>
          ) : (
            <DataTable>
              <thead>
                <tr>
                  <Th align="left">Salesperson</Th>
                  <Th>Won</Th>
                  <Th>Value won</Th>
                  <Th>Lost</Th>
                  <Th>Win rate</Th>
                  <Th>Open</Th>
                  <Th>Open value</Th>
                </tr>
              </thead>
              <tbody>
                {model.bySalesperson.map((row) => (
                  <tr key={row.owner}>
                    <Td align="left" numeric={false}>
                      {row.owner}
                    </Td>
                    <Td>{row.won}</Td>
                    <Td>{formatNumber(row.wonValue, 'currency')}</Td>
                    <Td muted>{row.lost}</Td>
                    {/* Null rather than 0% when nothing closed — a rep with no
                        closed deals has no win rate, which is not the same as
                        losing every one. */}
                    <Td muted>{row.winRate === null ? '—' : `${Math.round(row.winRate * 100)}%`}</Td>
                    <Td muted>{row.open}</Td>
                    <Td muted>{formatNumber(row.openValue, 'currency')}</Td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </Card>
      </section>

      {/* §9.3: a deal-level table behind every tile. */}
      <Card>
        <CardHeader
          title="Deals"
          subtitle={
            model.dealScope.ownerName
              ? `${model.dealScope.ownerName}'s deals closed in ${model.dealScope.rangeLabel}, plus everything still open.`
              : `Deals closed in ${model.dealScope.rangeLabel}, plus everything still open. Sales leadership will not trust an aggregate they cannot open.`
          }
          action={<OwnerFilter owners={owners} selected={ownerName} />}
        />
        <DataTable maxHeight={520}>
          <thead>
            <tr>
              <Th align="left">Deal</Th>
              <Th align="left">Division</Th>
              <Th align="left">Salesperson</Th>
              <Th align="left">Stage</Th>
              <Th align="left">Status</Th>
              <Th>Amount</Th>
              <Th align="left">Created</Th>
              <Th align="left">Closed</Th>
              <Th>Days</Th>
            </tr>
          </thead>
          <tbody>
            {model.deals.map((deal) => (
              <tr key={deal.dealId}>
                <Td align="left" numeric={false}>
                  {deal.dealName}
                </Td>
                <Td align="left" numeric={false} muted>
                  {deal.divisionCode ?? 'Unattributed'}
                </Td>
                <Td align="left" numeric={false} muted>
                  {deal.owner}
                </Td>
                <Td align="left" numeric={false} muted>
                  {deal.dealstage}
                </Td>
                <Td align="left" numeric={false}>
                  <span
                    className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                    style={{
                      background:
                        deal.status === 'Won'
                          ? 'var(--status-good-wash)'
                          : deal.status === 'Lost'
                            ? 'var(--status-critical-wash)'
                            : 'var(--surface-2)',
                      color:
                        deal.status === 'Won'
                          ? 'var(--status-good)'
                          : deal.status === 'Lost'
                            ? 'var(--status-critical)'
                            : 'var(--text-secondary)',
                    }}
                  >
                    {deal.status}
                  </span>
                </Td>
                <Td>{formatNumber(deal.amount, 'currency')}</Td>
                <Td align="left" muted>
                  {deal.createdate ?? '—'}
                </Td>
                <Td align="left" muted>
                  {deal.closedate ?? '—'}
                </Td>
                <Td muted>{deal.daysToClose ?? '—'}</Td>
              </tr>
            ))}
          </tbody>
        </DataTable>
        {model.deals.length === 0 ? (
          <p className="pt-3 text-[12px] text-[var(--text-muted)]">
            No deals match these filters in {model.dealScope.rangeLabel}.
          </p>
        ) : (
          <p className="pt-3 text-[11px] text-[var(--text-muted)]">
            Showing {model.dealScope.shown} of {model.dealScope.total} deals, largest first.
          </p>
        )}
      </Card>
    </div>
  );
}
