import type { Metadata } from 'next';
import { loadDashboardContext, type SearchParams } from '@/lib/dashboards/context';
import { loadHubspotDashboard } from '@/lib/dashboards/hubspot';
import { buildDivisionColorMap } from '@/lib/charts/colors';
import { formatMonth } from '@/lib/semantic/periods';
import { formatNumber } from '@/lib/format';
import { KpiTile } from '@/components/dashboard/kpi-tile';
import { ChartCard } from '@/components/charts/chart-card';
import {
  Card,
  CardHeader,
  DataTable,
  EmptyState,
  Td,
  Th,
  Unavailable,
} from '@/components/ui/primitives';
import { OwnerFilter } from '@/components/dashboard/owner-filter';
import { PipelineFilter } from '@/components/dashboard/pipeline-filter';

export const metadata: Metadata = { title: 'HubSpot Leadership' };
export const dynamic = 'force-dynamic';

/**
 * HubSpot Leadership Dashboard 2026.
 *
 * Laid out the way HubSpot lays out a pipeline review — funnel, board,
 * leaderboard, sources — because that is the shape ARG's sales leadership
 * already reads without being taught. The figures are this system's figures:
 * every tile resolves through the semantic layer, so this page and the Sales
 * page cannot disagree about what was booked.
 */
export default async function HubspotPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const context = await loadDashboardContext(await searchParams);
  const { session, divisionCode, range, owners, ownerName, pipelines, pipeline } = context;
  const colors = buildDivisionColorMap(session.bundle.divisions);
  const model = loadHubspotDashboard(session, divisionCode, colors, { range, ownerName, pipeline });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[19px] font-semibold tracking-tight">HubSpot Leadership</h1>
        <p className="mt-1 max-w-2xl text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
          The pipeline as HubSpot shows it — funnel, board, leaderboard and sources — with ARG&rsquo;s
          own definitions behind every figure.
        </p>
        <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">
          {model.scope.divisionLabel} · {formatMonth(session.period.month)} · deals scoped to{' '}
          {model.scope.rangeLabel} · sourced from HubSpot
        </p>
      </header>

      {/* The filter strip. Every panel below obeys all of it — a filter that
          applies to some cards and not others is worse than no filter. */}
      <div
        className="flex flex-wrap items-center gap-3 rounded-[var(--radius)] border px-3 py-2"
        style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}
      >
        <PipelineFilter pipelines={pipelines} selected={pipeline} />
        <OwnerFilter owners={owners} selected={ownerName} />
        <p className="text-[11px] text-[var(--text-muted)]">
          {formatNumber(model.scope.dealsInScope, 'count')} deal
          {model.scope.dealsInScope === 1 ? '' : 's'} in scope
          {pipeline ? ` · ${pipeline === 'default' ? 'Sales Pipeline' : pipeline}` : ''}
          {ownerName ? ` · ${ownerName}` : ''}
        </p>
      </div>

      {model.noData ? (
        <EmptyState
          title="No HubSpot deals have loaded yet"
          detail="Connect HubSpot in Admin → Source connections and run a sync. Until then this page has nothing to show, which is different from a pipeline of zero."
        />
      ) : null}

      {model.unavailable ? <Unavailable reason="NOT_AVAILABLE_BY_DIVISION" detail={model.unavailable} /> : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {model.tiles.map((tile) => (
          <KpiTile key={tile.name} {...tile} />
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader
            title="Deal funnel"
            subtitle="Deals that reached each stage, with the conversion from the stage above"
          />
          {model.funnelUnavailable ? (
            <Unavailable reason="NO_STAGE_HISTORY" detail={model.funnelUnavailable} />
          ) : model.funnel.length === 0 ? (
            <p className="text-[12px] text-[var(--text-muted)]">No deals in the current filters.</p>
          ) : (
            <ul className="space-y-2">
              {model.funnel.map((stage) => (
                <li key={stage.stage}>
                  <div className="flex items-baseline justify-between gap-3 text-[12px]">
                    <span className="font-medium">{stage.label}</span>
                    <span className="text-[var(--text-secondary)]">
                      {formatNumber(stage.count, 'count')} · {formatNumber(stage.value, 'currency')}
                    </span>
                  </div>
                  <div
                    className="mt-1 h-2 w-full overflow-hidden rounded-full"
                    style={{ background: 'var(--surface-2)' }}
                  >
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.max(1, Math.min(100, stage.ofTotalPct ?? 0))}%`,
                        background: 'var(--series-1)',
                      }}
                    />
                  </div>
                  {stage.fromPreviousPct !== null && (
                    <p className="mt-0.5 text-[10.5px] text-[var(--text-muted)]">
                      {stage.fromPreviousPct.toFixed(0)}% of the stage above
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-[10.5px] leading-relaxed text-[var(--text-muted)]">
            Counted from stage history — deals that <em>entered</em> each stage, not deals sitting
            in it now. A funnel built from current stage shows more deals in Closed Won than in
            Proposal Sent, because a won deal is only in one stage today. Closed-lost is excluded
            here and shown on the board.
          </p>
        </Card>

        <ChartCard
          title="Bookings and open pipeline"
          subtitle="Trailing twelve months"
          series={model.bookingsTrendSeries}
          data={model.bookingsTrend}
          form="line"
          valueFormat="currency"
          height={260}
          note="Both series resolve through the same definitions as the tiles above — this line cannot disagree with Dollars Booked."
        />
      </div>

      <Card>
        <CardHeader
          title="Pipeline board"
          subtitle="Where each deal stands now — one column per stage, largest first"
        />
        {model.board.length === 0 ? (
          <p className="text-[12px] text-[var(--text-muted)]">No deals in the current filters.</p>
        ) : (
          <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-2">
            {model.board.map((column) => (
              <div
                key={column.stage}
                className="flex w-[230px] shrink-0 flex-col rounded-[var(--radius)] border"
                style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}
              >
                <div className="border-b px-2.5 py-2" style={{ borderColor: 'var(--border)' }}>
                  <p className="text-[11.5px] font-semibold">{column.label}</p>
                  <p className="text-[10.5px] text-[var(--text-muted)]">
                    {formatNumber(column.count, 'count')} · {formatNumber(column.value, 'currency')}
                  </p>
                </div>
                <ul className="space-y-1.5 p-2">
                  {column.cards.map((card) => (
                    <li
                      key={card.dealId}
                      className="rounded-[5px] border px-2 py-1.5"
                      style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}
                    >
                      <p className="truncate text-[11.5px] font-medium" title={card.dealName}>
                        {card.dealName}
                      </p>
                      <p className="text-[11px] text-[var(--text-secondary)]">
                        {formatNumber(card.amount, 'currency')}
                      </p>
                      <p className="mt-0.5 text-[10px] text-[var(--text-muted)]">
                        {card.owner}
                        {card.ageDays !== null ? ` · ${card.ageDays}d old` : ''}
                        {card.closedate ? ` · closes ${card.closedate}` : ''}
                      </p>
                    </li>
                  ))}
                  {column.hidden > 0 && (
                    <li className="px-1 text-[10.5px] text-[var(--text-muted)]">
                      and {formatNumber(column.hidden, 'count')} more
                    </li>
                  )}
                  {column.cards.length === 0 && (
                    <li className="px-1 text-[10.5px] text-[var(--text-muted)]">Empty</li>
                  )}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader
            title="Owner leaderboard"
            subtitle="Won, lost and open, for the selected range"
          />
          {model.owners.length === 0 ? (
            <p className="text-[12px] text-[var(--text-muted)]">No deals in the current filters.</p>
          ) : (
            <DataTable>
              <thead>
                <tr>
                  <Th align="left">Owner</Th>
                  <Th>Won</Th>
                  <Th>Won value</Th>
                  <Th>Win rate</Th>
                  <Th>Open</Th>
                  <Th>Open value</Th>
                </tr>
              </thead>
              <tbody>
                {model.owners.map((owner) => (
                  <tr key={owner.owner}>
                    <Td align="left" numeric={false}>
                      {owner.owner}
                    </Td>
                    <Td>{formatNumber(owner.won, 'count')}</Td>
                    <Td>{formatNumber(owner.wonValue, 'currency')}</Td>
                    <Td>
                      {owner.winRate === null ? '—' : `${owner.winRate.toFixed(0)}%`}
                    </Td>
                    <Td>{formatNumber(owner.open, 'count')}</Td>
                    <Td>{formatNumber(owner.openValue, 'currency')}</Td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
          <p className="mt-3 text-[10.5px] leading-relaxed text-[var(--text-muted)]">
            Win rate is won ÷ deals <strong>closed</strong> in the range — the same denominator as
            the Booking Rate tile, so the two cannot tell different stories.
          </p>
        </Card>

        <Card>
          <CardHeader
            title="Leads by original source"
            subtitle="Contacts by the date they became a lead"
          />
          {model.sources.length === 0 ? (
            <p className="text-[12px] text-[var(--text-muted)]">
              No contacts became leads in this range.
            </p>
          ) : (
            <DataTable>
              <thead>
                <tr>
                  <Th align="left">Source</Th>
                  <Th>Leads</Th>
                  <Th>Became customers</Th>
                  <Th>Conversion</Th>
                </tr>
              </thead>
              <tbody>
                {model.sources.map((source) => (
                  <tr key={source.source}>
                    <Td align="left" numeric={false}>
                      {source.source}
                    </Td>
                    <Td>{formatNumber(source.leads, 'count')}</Td>
                    <Td>{formatNumber(source.customers, 'count')}</Td>
                    <Td>
                      {source.conversionPct === null ? '—' : `${source.conversionPct.toFixed(0)}%`}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
          <p className="mt-3 text-[10.5px] leading-relaxed text-[var(--text-muted)]">
            Counted by the date a contact <em>became a lead</em>, not the date the record was
            created. The two differ on every imported contact.
          </p>
        </Card>
      </div>
    </div>
  );
}
