/**
 * Leadership 2026 — the panels ARG asked for, in the order they asked.
 *
 * Where an input has not been loaded, the panel says which one and why rather
 * than drawing a zero. That is the difference between a review that can be acted
 * on and one that quietly reports no proposals because nobody landed the stage
 * names.
 */
import { ChartCard } from '@/components/charts/chart-card';
import { Card, CardHeader, DataTable, Td, Th } from '@/components/ui/primitives';
import { StatTile } from '@/components/dashboard/stat-tile';
import { formatNumber } from '@/lib/format';
import { CircleAlert } from 'lucide-react';
import type { Leadership2026, Breakdown } from '@/lib/dashboards/leadership-2026';

const ONE = [{ id: 'value', label: 'Value', color: 'var(--series-1)' }];

export function Leadership2026Panel({ model }: { model: Leadership2026 }) {
  return (
    <div className="space-y-4">
      {model.gaps.length > 0 && (
        <div
          className="rounded-[var(--radius)] border p-3.5"
          style={{ borderColor: 'var(--status-warning)', background: 'var(--surface-1)' }}
        >
          <p className="flex items-center gap-1.5 text-[12px] font-semibold">
            <CircleAlert size={13} style={{ color: 'var(--status-warning)' }} aria-hidden />
            Some of this review cannot be counted yet
          </p>
          <ul className="mt-1.5 space-y-1">
            {model.gaps.map((gap, index) => (
              <li key={index} className="text-[11.5px] leading-relaxed text-[var(--text-secondary)]">
                {gap}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* --- Headline counts ------------------------------------------------ */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Proposals this year"
          value={model.proposalsThisYear.count}
          detail={`${formatNumber(model.proposalsThisYear.amount, 'currency')} of pipeline`}
          basis="Deals that ENTERED the proposal stage since January, counted from stage history rather than from where they sit now."
        />
        <StatTile
          label="Compliance reviews — deals"
          value={model.complianceReviews.deals}
          basis="Deals that reached the Compliance Review stage."
        />
        <StatTile
          label="Compliance reviews — meetings"
          value={model.complianceReviews.meetings}
          basis="Meetings logged as a compliance review. Reported separately from the stage count, never added to it — a deal whose review was also logged as a meeting would otherwise count twice."
        />
        <StatTile
          label="Deals created"
          value={model.dealsCreatedByMonth.reduce((sum, point) => sum + point.value, 0)}
          detail={model.monthsLabel}
          basis="New deals by create date."
        />
      </div>

      {/* --- The monthly series --------------------------------------------- */}
      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard
          title="MQLs by month"
          subtitle="Contacts reaching Marketing Qualified Lead"
          series={ONE}
          data={model.mqlsByMonth}
          form="bar"
          valueFormat="count"
          height={240}
          note="Counted from the month a contact ENTERED the stage, read out of HubSpot's lifecycle-stage history — the dated fields HubSpot documents are empty in this portal."
        />
        <ChartCard
          title="SQLs by month"
          subtitle="Contacts reaching Sales Qualified Lead"
          series={ONE}
          data={model.sqlsByMonth}
          form="bar"
          valueFormat="count"
          height={240}
        />
        <ChartCard
          title="Deals created by month"
          subtitle="New deals, by create date"
          series={ONE}
          data={model.dealsCreatedByMonth}
          form="bar"
          valueFormat="count"
          height={240}
        />
        <ChartCard
          title="Pipeline added by month"
          subtitle="Deal value created, by create date"
          series={ONE}
          data={model.pipelineAddedByMonth}
          form="bar"
          valueFormat="currency"
          height={240}
        />
        <ChartCard
          title="Closed won by month"
          subtitle="Won value, by close date"
          series={ONE}
          data={model.closedWonByMonth}
          form="bar"
          valueFormat="currency"
          height={240}
        />
        <ChartCard
          title="Average deal size by month"
          subtitle="Won value divided by deals won, each month"
          series={ONE}
          data={model.avgDealSizeByMonth}
          form="line"
          valueFormat="currency"
          height={240}
          note="Averaged within each month, not across the year — dividing the year's value by the year's count would weight a busy month twice."
        />
      </div>

      <ChartCard
        title="Average deal size by ICP tier"
        subtitle="The same average, split by the customer's Ideal Customer Profile tier"
        series={model.avgDealSizeByIcp.series}
        data={model.avgDealSizeByIcp.data}
        form="line"
        valueFormat="currency"
        height={280}
        note="ICP tier is a property of the company, not the deal, so a deal with no company associated shows under “No tier set”. A month in which a tier won nothing has no point rather than a zero — an average of no deals is not zero."
      />

      {/* --- Attribution ----------------------------------------------------- */}
      <div className="grid gap-4 xl:grid-cols-2">
        <BreakdownTable
          title="Deals won by lead source"
          subtitle="Where the business that closed came from"
          rows={model.dealsWonBySource}
        />
        <BreakdownTable
          title="Compliance reviews by lead source"
          subtitle="Deals that reached the Compliance Review stage, by where they came from"
          rows={model.complianceReviewsBySource}
        />
      </div>
    </div>
  );
}

function BreakdownTable({
  title,
  subtitle,
  rows,
}: {
  title: string;
  subtitle: string;
  rows: Breakdown[];
}) {
  const total = rows.reduce((sum, row) => sum + row.amount, 0);

  return (
    <Card>
      <CardHeader title={title} subtitle={subtitle} />
      {rows.length === 0 ? (
        <p className="text-[12px] text-[var(--text-muted)]">Nothing in this period.</p>
      ) : (
        <DataTable>
          <thead>
            <tr>
              <Th align="left">Source</Th>
              <Th>Deals</Th>
              <Th>Value</Th>
              <Th>Share</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <Td align="left" numeric={false}>
                  {row.label}
                </Td>
                <Td>{formatNumber(row.count, 'count')}</Td>
                <Td>{formatNumber(row.amount, 'currency')}</Td>
                <Td>{total === 0 ? '—' : `${((row.amount / total) * 100).toFixed(0)}%`}</Td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
      <p className="mt-3 text-[10.5px] leading-relaxed text-[var(--text-muted)]">
        “Not recorded” is business with no lead source set. It is shown rather than dropped —
        unattributed volume is worth seeing the size of.
      </p>
    </Card>
  );
}
