/**
 * Leadership 2026 — Westport's review, chart by chart, on their definitions.
 *
 * Each chart carries its definition under it, in Westport's words, and lists
 * the deals behind any bar it is clicked on. Where a field a chart is defined
 * on has not loaded, the panel says which one rather than drawing zeros.
 */
import { ChartCard } from '@/components/charts/chart-card';
import { StatTile } from '@/components/dashboard/stat-tile';
import { SourceBreakdownCard } from '@/components/dashboard/source-breakdown-card';
import { CircleAlert } from 'lucide-react';
import type { Leadership2026, MonthlySeries } from '@/lib/dashboards/leadership-2026';

function Monthly({
  title,
  subtitle,
  series,
  definition,
  format,
  label = format === 'count' ? 'Count' : 'Value',
  color = 'var(--series-1)',
}: {
  title: string;
  subtitle: string;
  series: MonthlySeries;
  definition: string;
  format: 'count' | 'currency';
  label?: string;
  color?: string;
}) {
  return (
    <ChartCard
      title={title}
      subtitle={subtitle}
      series={[{ id: 'value', label, color }]}
      data={series.points}
      form="bar"
      valueFormat={format}
      height={240}
      showValues
      definition={definition}
      drill={Object.keys(series.drill).length ? series.drill : undefined}
    />
  );
}

export function Leadership2026Panel({ model }: { model: Leadership2026 }) {
  const d = model.definitions;
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
          value={model.proposalsThisYear.dealCount}
          detail={model.yearLabel}
          basis={d.proposalsThisYear}
        />
        <StatTile
          label="Compliance reviews this year"
          value={model.complianceReviewsByMonth.points.some((p) => p.value !== null) ? model.complianceReviewsByMonth.dealCount : null}
          detail={model.yearLabel}
          basis={d.complianceReviewsByMonth}
        />
        <StatTile
          label="Deals created"
          value={model.dealsCreatedByMonth.dealCount}
          detail={model.trailingLabel}
          basis={d.dealsCreatedByMonth}
        />
        <StatTile
          label="SQLs"
          value={model.sqlsByMonth.points.some((p) => p.value !== null) ? model.sqlsByMonth.dealCount : null}
          detail={model.trailingLabel}
          basis={d.sqlsByMonth}
        />
      </div>

      {/* --- The monthly series --------------------------------------------- */}
      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard
          title="SQLs by month"
          subtitle={`Contacts qualified from the four lead sources, ${model.trailingLabel}`}
          series={[{ id: 'value', label: 'SQLs', color: 'var(--series-1)' }]}
          data={model.sqlsByMonth.points}
          form="bar"
          valueFormat="count"
          height={240}
          showValues
          definition={d.sqlsByMonth}
        />
        <ChartCard
          title="MQLs by month"
          subtitle={`Contacts reaching Marketing Qualified Lead, ${model.trailingLabel}`}
          series={[{ id: 'value', label: 'MQLs', color: 'var(--series-1)' }]}
          data={model.mqlsByMonth.points}
          form="bar"
          valueFormat="count"
          height={240}
          showValues
          definition={d.mqlsByMonth}
        />
        <Monthly
          title="Deals created by month"
          subtitle={`New Background Checks deals, ${model.trailingLabel}`}
          series={model.dealsCreatedByMonth}
          definition={d.dealsCreatedByMonth}
          format="count"
          label="Deals"
        />
        <Monthly
          title="Compliance reviews by month"
          subtitle={`Deals whose compliance review completed, ${model.yearLabel}`}
          series={model.complianceReviewsByMonth}
          definition={d.complianceReviewsByMonth}
          format="count"
          label="Reviews"
        />
        <Monthly
          title="Proposals by month"
          subtitle={`Deals entering the Proposal stage, ${model.yearLabel}`}
          series={model.proposalsThisYear}
          definition={d.proposalsThisYear}
          format="count"
          label="Proposals"
        />
        <Monthly
          title="Total pipeline value by month"
          subtitle={`Background Checks pipeline, by the month its compliance review completed, ${model.yearLabel}`}
          series={model.pipelineAddedByMonth}
          definition={d.pipelineAddedByMonth}
          format="currency"
          label="Pipeline"
        />
        <Monthly
          title="Total pipeline by month, minus closed lost"
          subtitle={`The same pipeline, in the open and won stages only, ${model.yearLabel}`}
          series={model.pipelineLessLostByMonth}
          definition={d.pipelineLessLostByMonth}
          format="currency"
          label="Pipeline"
        />
        <Monthly
          title="Closed won by month"
          subtitle={`Won value, by close date, ${model.trailingLabel}`}
          series={model.closedWonByMonth}
          definition={d.closedWonByMonth}
          format="currency"
          label="Won"
          color="var(--status-good)"
        />
        <Monthly
          title="Closed lost by month"
          subtitle={`Lost value, by close date, ${model.trailingLabel}`}
          series={model.closedLostByMonth}
          definition={d.closedLostByMonth}
          format="currency"
          label="Lost"
          color="var(--status-critical)"
        />
        <Monthly
          title="Average deal size by month — 2026"
          subtitle={`Every Background Checks deal whose review completed that month, ${model.yearLabel}`}
          series={model.avgDealSizeByMonth}
          definition={d.avgDealSizeByMonth}
          format="currency"
          label="Average"
        />
        <Monthly
          title="Average deal size by month — 2026 ICP"
          subtitle={`Deals over $10,000, by the month they were created, ${model.yearLabel}`}
          series={model.avgDealSizeIcpByMonth}
          definition={d.avgDealSizeIcpByMonth}
          format="currency"
          label="Average"
        />
      </div>

      {/* --- Attribution ----------------------------------------------------- */}
      <div className="grid gap-4 xl:grid-cols-2">
        <SourceBreakdownCard
          title="Deals won by lead source"
          subtitle={`Where the business that closed came from, ${model.yearLabel}`}
          model={model.dealsWonBySource}
          definition={d.dealsWonBySource}
        />
        <SourceBreakdownCard
          title="Compliance reviews by lead source"
          subtitle={`Deals whose review completed, by where they came from, ${model.yearLabel}`}
          model={model.complianceReviewsBySource}
          definition={d.complianceReviewsBySource}
        />
      </div>
    </div>
  );
}
