import type { Metadata } from 'next';
import Link from 'next/link';
import { loadDashboardContext, type SearchParams } from '@/lib/dashboards/context';
import { formatMonth, formatMonthShort, monthRange, addMonths } from '@/lib/semantic/periods';
import { formatNumber, formatSignedNumber, sentimentColorVar, sentimentOf } from '@/lib/format';
import { sumPl } from '@/lib/semantic/facts';
import { officialForecast } from '@/lib/forecast/service';
import { accuracyOf, scoreForecast } from '@/lib/forecast/engine';
import { CONSOLIDATED_CODE } from '@/lib/semantic/resolve';
import { ChartCard } from '@/components/charts/chart-card';
import { Card, CardHeader, DataTable, Td, Th } from '@/components/ui/primitives';

export const metadata: Metadata = { title: 'Forecast vs. actual' };
export const dynamic = 'force-dynamic';

export default async function ForecastAccuracyPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const context = await loadDashboardContext(await searchParams);
  const { session, divisionCode } = context;
  const { period } = session;

  const divisions =
    divisionCode === CONSOLIDATED_CODE ? session.visibleDivisions : [divisionCode];

  // --- This month's scorecard -------------------------------------------
  const locked = await officialForecast(period.month, divisions);
  const actualPl = sumPl(session.bundle, period.month, divisions);
  const hasActuals = session.bundle.pl.has(`${period.month}|${divisions[0]}`);

  const rows = scoreForecast(
    locked?.projection ?? null,
    hasActuals ? { revenue: actualPl.revenue, cogs: actualPl.cogs, opex: actualPl.opex } : null,
  );

  // --- Accuracy trend ----------------------------------------------------
  // §10.4: "trend forecast accuracy over time, because the trend is what tells
  // ARG whether its forecasting is improving."
  const trendMonths = monthRange(addMonths(period.month, -11), period.month);
  const trendPoints = await Promise.all(
    trendMonths.map(async (month) => {
      const monthly = await officialForecast(month, divisions);
      const monthActual = sumPl(session.bundle, month, divisions);
      const actualRevenue = session.bundle.pl.has(`${month}|${divisions[0]}`)
        ? monthActual.revenue.toNumber()
        : null;
      const forecastRevenue = monthly?.projection.revenue.toNumber() ?? null;

      return {
        x: month,
        xLabel: formatMonthShort(month),
        // "Where a forecast was never locked, show the row as 'not logged' —
        // never as zero variance." A null renders as a gap in the line, not a
        // point at zero.
        accuracy: accuracyOf(forecastRevenue, actualRevenue),
      };
    }),
  );

  const loggedMonths = trendPoints.filter((point) => point.accuracy !== null).length;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[19px] font-semibold tracking-tight">Forecast vs. actual</h1>
          <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">
            {formatMonth(period.month)} ·{' '}
            {locked
              ? `locked ${new Date(locked.lockedAt).toLocaleDateString()} by ${locked.lockedByName ?? 'unknown'}`
              : 'no locked forecast for this month'}
          </p>
        </div>
        <Link
          href={`/forecast?month=${period.month.slice(0, 7)}&division=${divisionCode}`}
          className="text-[12px] underline-offset-2 hover:underline"
          style={{ color: 'var(--series-1)' }}
        >
          ← Back to the forecast builder
        </Link>
      </header>

      <Card>
        <CardHeader
          title="Scorecard"
          subtitle="Actuals always join from the fact table — they are never stored on the forecast record, so a restatement flows through automatically."
        />
        {locked ? (
          <DataTable>
            <thead>
              <tr>
                <Th align="left">Line</Th>
                <Th>Forecast</Th>
                <Th>Actual</Th>
                <Th>Variance $</Th>
                <Th>Variance %</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label}>
                  <Td align="left" numeric={false}>
                    {row.label}
                  </Td>
                  <Td muted>{formatNumber(row.forecast, 'currency')}</Td>
                  <Td>{formatNumber(row.actual, 'currency')}</Td>
                  <Td style={{ color: sentimentColorVar(sentimentOf(row.varianceDollars, row.higherIsBetter)) }}>
                    {formatSignedNumber(row.varianceDollars, 'currency')}
                  </Td>
                  <Td style={{ color: sentimentColorVar(sentimentOf(row.variancePct, row.higherIsBetter)) }}>
                    {formatSignedNumber(row.variancePct, 'percent')}
                  </Td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        ) : (
          <p
            className="rounded-[var(--radius)] px-3 py-2.5 text-[12px] leading-relaxed"
            style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}
          >
            <strong>Not logged.</strong> No forecast was locked for {formatMonth(period.month)}, so
            there is nothing to score against. This is deliberately not shown as zero variance — a
            month nobody forecast is not a month forecast perfectly.
          </p>
        )}
      </Card>

      <ChartCard
        title="Forecast accuracy"
        subtitle={`Revenue accuracy over the trailing twelve months — ${loggedMonths} of ${trendMonths.length} months have a locked forecast`}
        series={[{ id: 'accuracy', label: 'Revenue forecast accuracy', color: 'var(--series-1)' }]}
        data={trendPoints}
        form="line"
        valueFormat="percent"
        height={260}
        note="Gaps are months where no forecast was locked. The trend is what tells ARG whether its forecasting is improving — a single month's accuracy says very little."
      />
    </div>
  );
}
