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
import type { DealStatusFilter } from '@/lib/dashboards/sales';
import Link from 'next/link';

const STATUS_TABS: Array<{ id: DealStatusFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'won', label: 'Closed won' },
  { id: 'lost', label: 'Closed lost' },
  { id: 'open', label: 'Open' },
];

export const metadata: Metadata = { title: 'Sales' };
export const dynamic = 'force-dynamic';

export default async function SalesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const context = await loadDashboardContext(params);
  const { session, divisionCode, range, owners, ownerName } = context;
  const colors = buildDivisionColorMap(session.bundle.divisions);
  const rawStatus = Array.isArray(params.status) ? params.status[0] : params.status;
  const status = STATUS_TABS.some((tab) => tab.id === rawStatus) ? (rawStatus as DealStatusFilter) : 'all';
  const model = loadSales(session, divisionCode, colors, { range, ownerName, status });

  // Each tab keeps every other filter on the page.
  const tabHref = (id: DealStatusFilter) => {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      const single = Array.isArray(value) ? value[0] : value;
      if (single !== undefined && key !== 'status') next.set(key, single);
    }
    if (id !== 'all') next.set('status', id);
    const query = next.toString();
    return `/sales${query ? `?${query}` : ''}#deals`;
  };

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

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
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
                  <Th align="left">Pipeline</Th>
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
                    <Td align="left" numeric={false} muted>
                      {row.pipeline}
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
        <div id="deals" className="scroll-mt-20" />
        <CardHeader
          title="Deals"
          subtitle={
            model.dealScope.ownerName
              ? `${model.dealScope.ownerName}'s deals closed in ${model.dealScope.rangeLabel}, plus everything still open.`
              : `Deals closed in ${model.dealScope.rangeLabel}, plus everything still open — with who owns each one, which for a won deal is who closed it.`
          }
          action={<OwnerFilter owners={owners} selected={ownerName} />}
        />
        <nav className="mb-3 flex flex-wrap gap-1" aria-label="Deal status">
          {STATUS_TABS.map((tab) => (
            <Link
              key={tab.id}
              href={tabHref(tab.id)}
              scroll={false}
              aria-current={model.dealScope.status === tab.id ? 'page' : undefined}
              className="rounded-[4px] border px-2 py-0.5 text-[11px] font-medium"
              style={{
                borderColor: model.dealScope.status === tab.id ? 'var(--text-primary)' : 'var(--border)',
                background: model.dealScope.status === tab.id ? 'var(--text-primary)' : 'transparent',
                color: model.dealScope.status === tab.id ? 'var(--text-inverse)' : 'var(--text-secondary)',
              }}
            >
              {tab.label} · {formatNumber(model.dealScope.counts[tab.id], 'count')}
            </Link>
          ))}
        </nav>
        <DataTable maxHeight={520}>
          <thead>
            <tr>
              <Th align="left">Deal</Th>
              <Th align="left">Company</Th>
              <Th align="left">{model.dealScope.status === 'won' ? 'Closed by' : 'Owner'}</Th>
              <Th align="left">Stage</Th>
              <Th align="left">Status</Th>
              <Th>Amount</Th>
              <Th align="left">Lead source</Th>
              <Th align="left">Line of business</Th>
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
                  {deal.company ?? '—'}
                </Td>
                <Td align="left" numeric={false}>
                  {deal.owner}
                </Td>
                <Td align="left" numeric={false} muted>
                  {deal.dealstage}
                  <span className="block text-[10px]">{deal.pipeline}</span>
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
                <Td align="left" numeric={false} muted>
                  {deal.source}
                </Td>
                <Td align="left" numeric={false} muted>
                  {deal.lineOfBusiness ?? '—'}
                </Td>
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
            Showing {model.dealScope.shown} of {model.dealScope.total} deals,{' '}
            {model.dealScope.status === 'won' || model.dealScope.status === 'lost'
              ? 'most recently closed first'
              : 'largest first'}
            .
          </p>
        )}
      </Card>
    </div>
  );
}
