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
import { DrillRows } from '@/components/dashboard/drill-rows';
import { DealDrillProvider, DealLink } from '@/components/charts/deal-drill';
import { companyNames, stageHistoryIndex, toDealBillingIndex, toDealRow } from '@/lib/dashboards/deal-rows';
import { loadAccountBilling } from '@/lib/billing/accounts';
import { getDb } from '@/lib/db/client';
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
  const { session, divisionCode, range, owners, ownerName, inactiveOwners } = context;
  const colors = buildDivisionColorMap(session.bundle.divisions);
  const rawStatus = Array.isArray(params.status) ? params.status[0] : params.status;
  const status = STATUS_TABS.some((tab) => tab.id === rawStatus) ? (rawStatus as DealStatusFilter) : 'all';
  const model = loadSales(session, divisionCode, colors, { range, ownerName, status, inactiveOwners });

  // Every figure lists its deals, and every deal opens its detail.
  const stageName = (stageId: string | null) =>
    stageId ? (session.bundle.dealStages.find((stage) => stage.stageId === stageId)?.label ?? stageId) : '—';
  const history = stageHistoryIndex(session.bundle.stageEntries, stageName);
  const company = companyNames(session.bundle.companies);
  const wanted = new Set(model.drill.dealIds);
  const drillDeals = session.bundle.deals
    .filter((deal) => wanted.has(deal.dealId))
    .map((deal) => {
      const row = toDealRow(deal, stageName, company, history);
      return inactiveOwners.includes(row.owner) ? { ...row, owner: `${row.owner} (inactive)` } : row;
    });
  const billingHorizon = new Date(Date.UTC(new Date().getUTCFullYear() - 1, 0, 1));
  const billing = await loadAccountBilling(await getDb(), session, {
    wonFrom: new Date(Date.UTC(2000, 0, 1)),
    wonTo: new Date(Date.now() + 24 * 60 * 60 * 1000),
    billingFrom: billingHorizon,
  })
    .then((result) => toDealBillingIndex(result, billingHorizon.toISOString().slice(0, 10)))
    .catch((error: unknown) => {
      console.error('Billing for the Sales deal lists could not be read', error);
      return null;
    });

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
    <DealDrillProvider deals={drillDeals} billing={billing}>
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
          <DrillRows
            emptyLabel="No open deals in scope."
            headers={[{ label: 'Stage' }, { label: 'Pipeline', align: 'left' }, { label: 'Deals' }, { label: 'Value' }]}
            rows={model.pipelineByStage.map((row) => ({
              id: row.stage,
              cells: [row.label, row.pipeline, formatNumber(row.count, 'count'), formatNumber(row.value, 'currency')],
              dealIds: model.drill.openByStage[row.stage] ?? [],
              listTitle: `Open in ${row.label}`,
            }))}
          />
          <p className="pt-2 text-[10.5px] text-[var(--text-muted)]">Click a stage to list its deals.</p>
        </Card>
      </div>

      <ChartCard
        title="Bookings trend"
        subtitle="Dollars booked, last twelve months — click a bar for the deals behind it"
        series={model.bookingsTrendSeries}
        data={model.bookingsTrend}
        form="bar"
        valueFormat="currency"
        height={240}
        drill={model.drill.bookedByMonth}
        showValues
      />

      {/* Per-salesperson performance — the leaderboard leadership asked for. */}
      <section>
        <SectionTitle hint="Closed in the selected date range, by the person who owns the deal">
          By salesperson
        </SectionTitle>
        <Card>
          <DrillRows
            emptyLabel={`No deals closed or open in ${model.dealScope.rangeLabel}.`}
            headers={[
              { label: 'Salesperson' },
              { label: 'Won' },
              { label: 'Value won' },
              { label: 'Lost' },
              { label: 'Win rate' },
              { label: 'Open' },
              { label: 'Open value' },
            ]}
            rows={model.bySalesperson.map((row) => ({
              id: row.owner,
              cells: [
                row.inactive ? `${row.owner} (inactive)` : row.owner,
                String(row.won),
                formatNumber(row.wonValue, 'currency'),
                String(row.lost),
                // Null rather than 0% when nothing closed: no win rate is not losing every deal.
                row.winRate === null ? '—' : `${Math.round(row.winRate * 100)}%`,
                String(row.open),
                formatNumber(row.openValue, 'currency'),
              ],
              dealIds: model.drill.byOwner[row.owner] ?? [],
              listTitle: `${row.owner}'s deals in ${model.dealScope.rangeLabel}`,
              muted: row.inactive,
            }))}
          />
          <p className="pt-2 text-[10.5px] text-[var(--text-muted)]">
            Click a salesperson to list their deals. People archived in HubSpot are marked inactive and drop off once
            nothing they closed is in the period.
          </p>
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
              <Th align="left">Est. close</Th>
              <Th>Days</Th>
            </tr>
          </thead>
          <tbody>
            {model.deals.map((deal) => (
              <tr key={deal.dealId}>
                <Td align="left" numeric={false}>
                  <DealLink dealId={deal.dealId} className="font-medium">
                    {deal.dealName}
                  </DealLink>
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
                  {deal.status === 'Open' ? '—' : (deal.closedate ?? '—')}
                </Td>
                <Td align="left" muted>
                  {deal.status === 'Open' ? (deal.expectedClose ?? '—') : '—'}
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
    </DealDrillProvider>
  );
}
