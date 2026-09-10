/**
 * The leadership review panel, in the order ARG reads it.
 *
 * Activity first, then the two counts leadership tracks by name, then the two
 * money figures, then attribution, then the same split by rep. That order is
 * ARG's, taken from the HubSpot dashboard they run every month — the point of
 * reproducing it is that nobody has to learn a new one.
 */
import { ChartCard } from '@/components/charts/chart-card';
import { Card, CardHeader } from '@/components/ui/primitives';
import { StatTile, RepBars } from '@/components/dashboard/stat-tile';
import { formatNumber } from '@/lib/format';
import type { EosViewModel } from '@/lib/dashboards/hubspot-eos';

export function EosPanel({ model, rangeLabel }: { model: EosViewModel; rangeLabel: string }) {
  const typeSeries = [{ id: 'count', label: 'Meetings', color: 'var(--series-1)' }];
  const typeData = model.meetingsByType.map((row) => ({
    x: row.key,
    xLabel: row.label,
    count: row.count,
  }));

  return (
    <div className="space-y-4">
      {/* --- The four headline figures ------------------------------------- */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Meetings"
          value={model.meetingsTotal}
          detail={`${model.meetingsByType.length} type${model.meetingsByType.length === 1 ? '' : 's'} recorded`}
          basis={`Meetings held in ${rangeLabel}, every type included.`}
        />
        <StatTile
          label="Discovery calls"
          value={model.typesUnavailable ? null : model.discoveryCalls.total}
          unavailable={
            model.typesUnavailable
              ? 'No meeting carries a call or meeting type, so discovery calls cannot be separated from the rest.'
              : undefined
          }
          basis={model.classification.discovery}
        />
        <StatTile
          label="Demos"
          value={model.typesUnavailable ? null : model.demos.total}
          unavailable={
            model.typesUnavailable
              ? 'No meeting carries a call or meeting type, so demos cannot be separated from the rest.'
              : undefined
          }
          basis={model.classification.demo}
        />
        <StatTile
          label="Pipeline added"
          value={model.pipelineAdded.total}
          valueFormat="currency"
          detail={`${formatNumber(model.pipelineAdded.deals, 'count')} deal${model.pipelineAdded.deals === 1 ? '' : 's'} created`}
          basis={`Deal amount by the date the deal was CREATED in ${rangeLabel}, open or closed.`}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Closed won"
          value={model.closed.total}
          valueFormat="currency"
          detail={`${formatNumber(model.closed.deals, 'count')} deal${model.closed.deals === 1 ? '' : 's'} won`}
          basis={`Won amount by the date the deal CLOSED in ${rangeLabel} — a different set of deals from pipeline added, so the two do not subtract.`}
        />

        <Card>
          <CardHeader title="Discovery calls by rep" />
          <RepBars
            rows={model.discoveryCalls.byRep.map((row) => ({ rep: row.rep, value: row.count }))}
            emptyLabel="No discovery calls in this range."
          />
        </Card>

        <Card>
          <CardHeader title="Demos by rep" />
          <RepBars
            rows={model.demos.byRep.map((row) => ({ rep: row.rep, value: row.count }))}
            emptyLabel="No demos in this range."
          />
        </Card>

        <Card>
          <CardHeader title="Closed won by rep" />
          <RepBars
            rows={model.closed.byRep.map((row) => ({ rep: row.rep, value: row.amount }))}
            valueFormat="currency"
            emptyLabel="Nothing closed in this range."
          />
        </Card>
      </div>

      {/* --- Activity by type ---------------------------------------------- */}
      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard
          title="Meetings by type"
          subtitle={`Every meeting held in ${rangeLabel}, by HubSpot's call and meeting type`}
          series={typeSeries}
          data={typeData}
          form="horizontalBar"
          valueFormat="count"
          height={Math.max(220, typeData.length * 34 + 40)}
          note="“Not recorded” is a meeting logged without a type. It is shown rather than folded into another category — how many meetings go untyped is itself worth seeing."
        />

        <ChartCard
          title="Meetings by type, per rep"
          subtitle="The same meetings, split by who ran them"
          series={model.meetingsByTypeByRep.series}
          data={model.meetingsByTypeByRep.data}
          form="horizontalBar"
          valueFormat="count"
          height={Math.max(
            220,
            model.meetingsByTypeByRep.data.length *
              Math.max(34, model.meetingsByTypeByRep.series.length * 14) +
              40,
          )}
          note="The eight busiest types are shown individually; anything beyond them is grouped as Other rather than dropped, so the bars still sum to the meetings total."
        />
      </div>

      {/* --- Attribution ---------------------------------------------------- */}
      <Card>
        <CardHeader
          title="Pipeline added by source"
          subtitle={`Where the ${formatNumber(model.pipelineAdded.total, 'currency')} of new pipeline came from`}
        />

        {model.sourcesUnavailable ? (
          <p className="text-[12px] leading-relaxed text-[var(--text-muted)]">
            No deal created in this range carries a lead source, so pipeline cannot be attributed.
            The source is read from the deal&rsquo;s own lead-source property — it is recorded by
            the salesperson, not inferred from a contact&rsquo;s traffic source, because
            &ldquo;employee referral&rdquo; is not something analytics can observe.
          </p>
        ) : model.pipelineAdded.bySource.length === 0 ? (
          <p className="text-[12px] text-[var(--text-muted)]">No pipeline was added in this range.</p>
        ) : (
          <>
            <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {model.pipelineAdded.bySource.map((row) => (
                <div
                  key={row.source}
                  className="rounded-[var(--radius)] border p-3"
                  style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}
                >
                  <p
                    className="truncate text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]"
                    title={row.source}
                  >
                    {row.source}
                  </p>
                  <p className="mt-1 text-[17px] font-semibold tabular-nums">
                    {formatNumber(row.amount, 'currency')}
                  </p>
                  <div
                    className="mt-2 h-1.5 w-full overflow-hidden rounded-full"
                    style={{ background: 'var(--surface-1)' }}
                  >
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.max(2, row.sharePct)}%`,
                        background: 'var(--series-1)',
                      }}
                    />
                  </div>
                  <p className="mt-1.5 text-[10.5px] text-[var(--text-muted)]">
                    {row.sharePct.toFixed(0)}% · {formatNumber(row.deals, 'count')} deal
                    {row.deals === 1 ? '' : 's'}
                  </p>
                </div>
              ))}
            </div>
            <p className="mt-3 text-[10.5px] leading-relaxed text-[var(--text-muted)]">
              Counted on the date each deal was created, so this attributes pipeline to when it
              arrived rather than when it closed. &ldquo;Not recorded&rdquo; is pipeline with no
              source set — worth seeing the size of rather than hiding.
            </p>
          </>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Pipeline added by rep"
          subtitle="Who brought the new pipeline in"
        />
        <RepBars
          rows={model.pipelineAdded.byRep.map((row) => ({ rep: row.rep, value: row.amount }))}
          valueFormat="currency"
          emptyLabel="No pipeline was added in this range."
          max={12}
        />
      </Card>
    </div>
  );
}
