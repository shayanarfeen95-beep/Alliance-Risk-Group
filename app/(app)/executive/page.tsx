import type { Metadata } from 'next';
import { AlertTriangle, CircleAlert, FileText } from 'lucide-react';
import { loadDashboardContext, type SearchParams } from '@/lib/dashboards/context';
import { loadExecutive } from '@/lib/dashboards/executive';
import { buildDivisionColorMap } from '@/lib/charts/colors';
import { formatMonth } from '@/lib/semantic/periods';
import { formatNumber, formatSignedNumber, sentimentColorVar, sentimentOf } from '@/lib/format';
import { KpiTile } from '@/components/dashboard/kpi-tile';
import { ChartCard } from '@/components/charts/chart-card';
import { Card, CardHeader, DataTable, EmptyState, SectionTitle, Td, Th } from '@/components/ui/primitives';
import { CommentaryPanel } from '@/components/dashboard/commentary-panel';
import { can } from '@/lib/auth/scope';

export const metadata: Metadata = { title: 'Executive' };
export const dynamic = 'force-dynamic';

export default async function ExecutivePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const context = await loadDashboardContext(await searchParams);
  const { session, divisionCode } = context;
  const colors = buildDivisionColorMap(session.bundle.divisions);
  const model = await loadExecutive(session, divisionCode, colors);

  const divisionLabel =
    divisionCode === 'ARG_TOTAL'
      ? 'ARG Total'
      : (session.bundle.divisions.find((d) => d.divisionCode === divisionCode)?.divisionName ??
        divisionCode);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[19px] font-semibold tracking-tight">Executive</h1>
        <p className="mt-1 max-w-2xl text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
          How the business did this month, and anything that needs attention.
        </p>
        <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">
          {divisionLabel} · {formatMonth(session.period.month)} ·{' '}
          {session.periodIsClosed ? 'closed period' : 'open period, figures preliminary'}
        </p>
      </header>

      {/* §9.1 — eight tiles, each with PM/PY change and a 12-month sparkline. */}
      <section>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {model.tiles.map((tile) => (
            <KpiTile key={tile.name} {...tile} />
          ))}
        </div>
      </section>

      {/* Exceptions sit above the analysis: if a control is failing, the reader
          must know before they read a number. */}
      <section>
        <SectionTitle hint="Failing reconciliation checks and metrics outside threshold">
          Exceptions
        </SectionTitle>
        <Card padded={model.exceptions.length === 0}>
          {model.exceptions.length === 0 ? (
            <p className="text-[12px] text-[var(--text-secondary)]">
              No failing checks and no metric outside its threshold. Every reconciliation control
              passed on the most recent refresh.
            </p>
          ) : (
            <ul>
              {model.exceptions.map((exception, index) => (
                <li
                  key={index}
                  className="flex items-start gap-2.5 border-b px-5 py-3 last:border-b-0"
                  style={{ borderColor: 'var(--border)' }}
                >
                  {exception.severity === 'critical' ? (
                    <CircleAlert
                      size={14}
                      className="mt-px shrink-0"
                      style={{ color: 'var(--status-critical)' }}
                      aria-hidden
                    />
                  ) : (
                    <AlertTriangle
                      size={14}
                      className="mt-px shrink-0"
                      style={{ color: 'var(--status-warning)' }}
                      aria-hidden
                    />
                  )}
                  <div className="min-w-0">
                    <p className="text-[12.5px] font-medium">{exception.headline}</p>
                    <p className="mt-0.5 text-[11.5px] leading-relaxed text-[var(--text-secondary)]">
                      {exception.detail}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        {/* Revenue and net profit by division, current month and YTD. */}
        <Card>
          <CardHeader
            title="Revenue and net profit by division"
            subtitle="Contribution % is division revenue ÷ ARG Total revenue. Net profit contribution divides by the absolute value of the total, so the sign stays readable in a loss month."
          />
          <DataTable>
            <thead>
              <tr>
                <Th align="left">Division</Th>
                <Th>Revenue</Th>
                <Th>Contrib.</Th>
                <Th>Net profit</Th>
                <Th>Contrib.</Th>
                <Th>YTD revenue</Th>
                <Th>YTD net profit</Th>
              </tr>
            </thead>
            <tbody>
              {model.contributions.map((row) => (
                <tr key={row.divisionCode}>
                  <Td align="left" numeric={false}>
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                        style={{ background: colors[row.divisionCode] }}
                      />
                      {row.divisionName}
                    </span>
                  </Td>
                  <Td>{formatNumber(row.revenue, 'currency')}</Td>
                  <Td muted>{formatNumber(row.revenueContribution, 'percent')}</Td>
                  <Td
                    style={{
                      color:
                        row.netProfit !== null && row.netProfit < 0
                          ? 'var(--delta-bad)'
                          : undefined,
                    }}
                  >
                    {formatNumber(row.netProfit, 'currency')}
                  </Td>
                  <Td muted>{formatNumber(row.netProfitContribution, 'percent')}</Td>
                  <Td>{formatNumber(row.ytdRevenue, 'currency')}</Td>
                  <Td
                    style={{
                      color:
                        row.ytdNetProfit !== null && row.ytdNetProfit < 0
                          ? 'var(--delta-bad)'
                          : undefined,
                    }}
                  >
                    {formatNumber(row.ytdNetProfit, 'currency')}
                  </Td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </Card>

        {/* §9.1 — Actual vs Monthly Budget vs 10X, YTD, at ARG Total. */}
        <Card>
          <CardHeader
            title="YTD revenue against plan"
            subtitle="Attainment % and Variance $ are labelled distinctly on purpose — they are different measures, and the Excel's layout invited reading both as variances."
          />
          <DataTable>
            <thead>
              <tr>
                <Th align="left">Baseline</Th>
                <Th>YTD actual</Th>
                <Th>YTD plan</Th>
                <Th title="Actual ÷ budget. Above 100% is good on revenue.">Attainment %</Th>
                <Th title="Actual − budget, in dollars.">Variance $</Th>
              </tr>
            </thead>
            <tbody>
              {model.baselines.map((row) => (
                <tr key={row.scenario}>
                  <Td align="left" numeric={false}>
                    {row.label}
                  </Td>
                  {row.unavailable ? (
                    <Td align="left" numeric={false} muted className="!whitespace-normal" >
                      <span className="text-[11px]">{row.unavailable}</span>
                    </Td>
                  ) : (
                    <>
                      <Td>{formatNumber(row.actual, 'currency')}</Td>
                      <Td>{formatNumber(row.budget, 'currency')}</Td>
                      <Td
                        style={{
                          color: sentimentColorVar(
                            sentimentOf(
                              row.attainment === null ? null : row.attainment - 1,
                              row.higherIsBetter,
                            ),
                          ),
                          fontWeight: 500,
                        }}
                      >
                        {formatNumber(row.attainment, 'ratio')}
                      </Td>
                      <Td
                        style={{
                          color: sentimentColorVar(
                            sentimentOf(row.varianceDollars, row.higherIsBetter),
                          ),
                        }}
                      >
                        {formatSignedNumber(row.varianceDollars, 'currency')}
                      </Td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </DataTable>
        </Card>
      </div>

      <ChartCard
        title="Revenue by division"
        subtitle="Trailing twelve months"
        series={model.trendSeries}
        data={model.trend}
        form="bar"
        valueFormat="currency"
        height={280}
        note="Each division keeps its colour across every chart in the app, so filtering never repaints the others."
      />

      {/* §9.1 — AI-generated monthly summary. */}
      <section>
        <SectionTitle hint="Drafted from the semantic layer; Westport edits and signs">
          Monthly summary
        </SectionTitle>
        <Card>
          <CommentaryPanel
            month={session.period.month}
            initial={model.commentary}
            canDraft={can(session.user, 'SIGN_COMMENTARY')}
          />
        </Card>
      </section>

      <p className="flex items-start gap-2 pt-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
        <FileText size={12} className="mt-0.5 shrink-0" aria-hidden />
        Figures are reported on the {session.accountingBasis} basis. Every KPI on this page is
        defined once in the semantic layer and reused by every dashboard, export and assistant
        answer — the definitions are published in the KPI dictionary.
      </p>
    </div>
  );
}
