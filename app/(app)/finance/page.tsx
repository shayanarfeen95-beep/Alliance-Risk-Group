import type { Metadata } from 'next';
import { CircleAlert, CircleCheck } from 'lucide-react';
import { loadDashboardContext, type SearchParams } from '@/lib/dashboards/context';
import { loadFinance, type PlRow, type YtdRow } from '@/lib/dashboards/finance';
import { buildDivisionColorMap } from '@/lib/charts/colors';
import { formatMonth, formatMonthShort } from '@/lib/semantic/periods';
import { formatNumber, formatSignedNumber, sentimentColorVar, sentimentOf } from '@/lib/format';
import { ChartCard } from '@/components/charts/chart-card';
import {
  Card,
  CardHeader,
  Chip,
  DataTable,
  SectionTitle,
  Td,
  Th,
  Unavailable,
} from '@/components/ui/primitives';

export const metadata: Metadata = { title: 'Finance' };
export const dynamic = 'force-dynamic';

export default async function FinancePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const context = await loadDashboardContext(await searchParams);
  const { session, divisionCode } = context;
  const colors = buildDivisionColorMap(session.bundle.divisions);
  const model = loadFinance(session, divisionCode, colors);
  const { period } = session;

  const divisionLabel =
    divisionCode === 'ARG_TOTAL'
      ? 'ARG Total'
      : (session.bundle.divisions.find((d) => d.divisionCode === divisionCode)?.divisionName ??
        divisionCode);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[19px] font-semibold tracking-tight">Finance</h1>
        <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">
          {divisionLabel} · {formatMonth(period.month)} · {session.accountingBasis} basis ·{' '}
          {session.periodIsClosed ? 'closed period' : 'open period, figures preliminary'}
        </p>
      </header>

      {/* --- P&L block ---------------------------------------------------- */}
      <Card>
        <CardHeader
          title="Profit & loss"
          subtitle={`Prior month (${formatMonthShort(period.priorMonth)}) and prior year (${formatMonthShort(period.priorYearMonth)}) against actual and budget. Payroll rows are memo lines — they are components of COGS and OpEx, never deducted again.`}
        />
        <DataTable>
          <thead>
            <tr>
              <Th align="left">Line</Th>
              <Th title="Prior month — the selected month minus one">PM</Th>
              <Th title="Prior year — the same calendar month one year earlier">PY</Th>
              <Th>Actual</Th>
              <Th>Budget</Th>
              <Th title="Actual − budget, in dollars">Variance $</Th>
              <Th title="Actual ÷ budget. Direction depends on the line: above 100% is good on revenue, bad on COGS and OpEx.">
                Attainment %
              </Th>
            </tr>
          </thead>
          <tbody>
            {model.pl.map((row) => (
              <PlTableRow key={row.label} row={row} />
            ))}
          </tbody>
        </DataTable>
      </Card>

      <div className="grid gap-4 xl:grid-cols-3">
        {/* --- Ratio block ------------------------------------------------ */}
        <Card>
          <CardHeader title="Ratios" subtitle="As a share of revenue for the month" />
          <ul className="space-y-2">
            {model.ratios.map((ratio) => (
              <li
                key={ratio.label}
                className="flex items-baseline justify-between gap-3 border-b pb-2 last:border-b-0"
                style={{ borderColor: 'var(--border)' }}
                title={ratio.hint}
              >
                <span className="text-[12px] text-[var(--text-secondary)]">{ratio.label}</span>
                <span className="tnum text-[13px] font-medium">
                  {formatNumber(ratio.value, 'percent')}
                </span>
              </li>
            ))}
          </ul>
        </Card>

        {/* --- Change block ----------------------------------------------- */}
        <Card>
          <CardHeader title="Change" subtitle="Month over month and year over year" />
          <DataTable>
            <thead>
              <tr>
                <Th align="left">Measure</Th>
                <Th>MoM</Th>
                <Th>YoY</Th>
              </tr>
            </thead>
            <tbody>
              {model.changes.map((row) => (
                <tr key={row.label}>
                  <Td align="left" numeric={false}>
                    {row.label}
                  </Td>
                  <Td style={{ color: sentimentColorVar(sentimentOf(row.monthOverMonth, row.higherIsBetter)) }}>
                    {formatSignedNumber(row.monthOverMonth, 'percent')}
                  </Td>
                  <Td style={{ color: sentimentColorVar(sentimentOf(row.yearOverYear, row.higherIsBetter)) }}>
                    {formatSignedNumber(row.yearOverYear, 'percent')}
                  </Td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </Card>

        {/* --- Working capital -------------------------------------------- */}
        <Card>
          <CardHeader
            title="Working capital"
            subtitle="Cash runway is shown both ways: the single-month figure ties to the Excel, the trailing average removes the swing that Defect 6 describes."
          />
          {model.workingCapital.dso.unavailable ? (
            <Unavailable reason="NOT_AVAILABLE_BY_DIVISION" detail={model.workingCapital.dso.unavailable} />
          ) : (
            <ul className="space-y-2">
              <Metric label="Days Sales Outstanding" value={model.workingCapital.dso.value} format="days" />
              <Metric label="Days Payable Outstanding" value={model.workingCapital.dpo.value} format="days" />
              <Metric label="Cash Conversion Cycle" value={model.workingCapital.ccc.value} format="days" hint="DSO − DPO. No inventory term — ARG is a services business." />
              <Metric label="Cash Runway (this month's OpEx)" value={model.workingCapital.runwaySingleMonth.value} format="months" />
              <Metric label="Cash Runway (trailing 3-month OpEx)" value={model.workingCapital.runwayTrailing.value} format="months" />
            </ul>
          )}
        </Card>
      </div>

      {/* --- YTD block ---------------------------------------------------- */}
      <Card>
        <CardHeader
          title="Year to date"
          subtitle="Prior-year YTD covers comparable periods only — January through the same month last year, never a full prior year against a partial current one."
        />
        <DataTable>
          <thead>
            <tr>
              <Th align="left">Line</Th>
              <Th>PY YTD</Th>
              <Th>YTD actual</Th>
              <Th>YTD budget</Th>
              <Th>Variance $</Th>
              <Th>Attainment %</Th>
            </tr>
          </thead>
          <tbody>
            {model.ytd.map((row) => (
              <YtdTableRow key={row.label} row={row} />
            ))}
          </tbody>
        </DataTable>
      </Card>

      {/* --- 10X block ---------------------------------------------------- */}
      <Card>
        <CardHeader
          title="10X plan"
          subtitle="Shown for 2026–2029 only, and blank outside that range."
        />
        {model.tenX ? (
          <DataTable>
            <thead>
              <tr>
                <Th align="left">Line</Th>
                <Th>Month actual</Th>
                <Th>Month plan</Th>
                <Th>Variance $</Th>
                <Th>YTD actual</Th>
                <Th>YTD plan</Th>
                <Th>YTD variance $</Th>
              </tr>
            </thead>
            <tbody>
              {model.tenX.map((row) => (
                <tr key={row.label}>
                  <Td align="left" numeric={false}>
                    {row.label}
                  </Td>
                  <Td>{formatNumber(row.monthActual, 'currency')}</Td>
                  <Td muted>{formatNumber(row.monthPlan, 'currency')}</Td>
                  <Td style={{ color: sentimentColorVar(sentimentOf(row.monthVariance, row.higherIsBetter)) }}>
                    {formatSignedNumber(row.monthVariance, 'currency')}
                  </Td>
                  <Td>{formatNumber(row.ytdActual, 'currency')}</Td>
                  <Td muted>{formatNumber(row.ytdPlan, 'currency')}</Td>
                  <Td style={{ color: sentimentColorVar(sentimentOf(row.ytdVariance, row.higherIsBetter)) }}>
                    {formatSignedNumber(row.ytdVariance, 'currency')}
                  </Td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        ) : (
          <p className="text-[12px] text-[var(--text-muted)]">
            The 10X plan covers 2026 through 2029. {formatMonth(period.month)} falls outside that
            range, so this block is intentionally blank.
          </p>
        )}
      </Card>

      {/* --- Balance sheet ------------------------------------------------ */}
      <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
        <Card>
          <CardHeader
            title="Balance sheet"
            subtitle="Each line as a share of total assets, against prior year end and the same month last year."
            action={
              model.balanceCheck ? (
                <Chip
                  tone={model.balanceCheck.passes ? 'good' : 'critical'}
                  icon={
                    model.balanceCheck.passes ? (
                      <CircleCheck size={13} aria-hidden />
                    ) : (
                      <CircleAlert size={13} aria-hidden />
                    )
                  }
                  title="Assets − (liabilities + equity). Equity is loaded from source rather than plugged, so this is a real assertion."
                >
                  {model.balanceCheck.passes
                    ? 'Balances'
                    : `Out by ${formatNumber(model.balanceCheck.difference, 'currency')}`}
                </Chip>
              ) : undefined
            }
          />
          {model.balanceSheet ? (
            <DataTable>
              <thead>
                <tr>
                  <Th align="left">Line</Th>
                  <Th>Current</Th>
                  <Th>Prior year end</Th>
                  <Th>PY same month</Th>
                  <Th>% of assets</Th>
                </tr>
              </thead>
              <tbody>
                {model.balanceSheet.map((row) => (
                  <tr key={row.label}>
                    <Td
                      align="left"
                      numeric={false}
                      style={{ fontWeight: row.isSubtotal ? 600 : 400 }}
                    >
                      {row.label}
                    </Td>
                    <Td style={{ fontWeight: row.isSubtotal ? 600 : 400 }}>
                      {formatNumber(row.current, 'currency')}
                    </Td>
                    <Td muted>{formatNumber(row.priorYearEnd, 'currency')}</Td>
                    <Td muted>{formatNumber(row.priorYearSameMonth, 'currency')}</Td>
                    <Td muted>{formatNumber(row.percentOfAssets, 'percent')}</Td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          ) : (
            <Unavailable
              reason="NOT_AVAILABLE_BY_DIVISION"
              detail={model.balanceSheetUnavailable ?? 'No balance sheet loaded for this period.'}
            />
          )}
        </Card>

        <Card>
          <CardHeader title="A/R and A/P aging" subtitle="Month-end balances by bucket" />
          <DataTable>
            <thead>
              <tr>
                <Th align="left">Bucket</Th>
                <Th>A/R</Th>
                <Th>A/P</Th>
              </tr>
            </thead>
            <tbody>
              {model.aging.map((row) => (
                <tr key={row.bucket}>
                  <Td align="left" numeric={false}>
                    {row.label}
                  </Td>
                  <Td>{formatNumber(row.ar, 'currency')}</Td>
                  <Td>{formatNumber(row.ap, 'currency')}</Td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </Card>
      </div>

      {/* --- Rolling trend ------------------------------------------------ */}
      <ChartCard
        title="Revenue trend"
        subtitle="Rolling fifteen months"
        series={model.trendSeries}
        data={model.trend}
        form="line"
        valueFormat="currency"
        height={280}
      />

      <SectionTitle hint="Every figure above resolves through the semantic layer and is drillable to its underlying accounts">
        Notes
      </SectionTitle>
      <p className="text-[11px] leading-relaxed text-[var(--text-muted)]">
        Gross profit is revenue less COGS, and net profit is gross profit less OpEx. The two
        payroll rows are memo lines that already sit inside COGS and OpEx respectively — subtracting
        them a second time would double-count payroll and understate profit at every division, in
        every month.
      </p>
    </div>
  );
}

function PlTableRow({ row }: { row: PlRow }) {
  return (
    <tr>
      <Td
        align="left"
        numeric={false}
        muted={row.isMemo}
        style={{
          fontWeight: row.isSubtotal ? 600 : 400,
          paddingLeft: row.isMemo ? 24 : undefined,
        }}
      >
        {row.label}
        {row.isMemo ? (
          <span
            className="ml-1.5 rounded px-1 py-px text-[9.5px] uppercase tracking-wide"
            style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}
            title="Memo line — already included in the total above it. Never subtracted separately."
          >
            memo
          </span>
        ) : null}
      </Td>
      <Td muted>{formatNumber(row.priorMonth, 'currency')}</Td>
      <Td muted>{formatNumber(row.priorYear, 'currency')}</Td>
      <Td style={{ fontWeight: row.isSubtotal ? 600 : 400 }}>
        {formatNumber(row.actual, 'currency')}
      </Td>
      <Td muted>{formatNumber(row.budget, 'currency')}</Td>
      <Td style={{ color: sentimentColorVar(sentimentOf(row.varianceDollars, row.higherIsBetter)) }}>
        {formatSignedNumber(row.varianceDollars, 'currency')}
      </Td>
      <Td
        style={{
          color: sentimentColorVar(
            sentimentOf(row.attainment === null ? null : row.attainment - 1, row.higherIsBetter),
          ),
        }}
      >
        {formatNumber(row.attainment, 'ratio')}
      </Td>
    </tr>
  );
}

function YtdTableRow({ row }: { row: YtdRow }) {
  const format = row.isPercent ? 'percent' : 'currency';
  return (
    <tr>
      <Td align="left" numeric={false}>
        {row.label}
      </Td>
      <Td muted>{formatNumber(row.priorYearYtd, format)}</Td>
      <Td style={{ fontWeight: 500 }}>{formatNumber(row.ytdActual, format)}</Td>
      <Td muted>{formatNumber(row.ytdBudget, format)}</Td>
      <Td style={{ color: sentimentColorVar(sentimentOf(row.varianceDollars, row.higherIsBetter)) }}>
        {row.isPercent ? '—' : formatSignedNumber(row.varianceDollars, 'currency')}
      </Td>
      <Td
        style={{
          color: sentimentColorVar(
            sentimentOf(row.attainment === null ? null : row.attainment - 1, row.higherIsBetter),
          ),
        }}
      >
        {row.isPercent ? '—' : formatNumber(row.attainment, 'ratio')}
      </Td>
    </tr>
  );
}

function Metric({
  label,
  value,
  format,
  hint,
}: {
  label: string;
  value: number | null;
  format: 'days' | 'months';
  hint?: string;
}) {
  return (
    <li
      className="flex items-baseline justify-between gap-3 border-b pb-2 last:border-b-0"
      style={{ borderColor: 'var(--border)' }}
      title={hint}
    >
      <span className="text-[12px] text-[var(--text-secondary)]">{label}</span>
      <span className="tnum text-[13px] font-medium">{formatNumber(value, format)}</span>
    </li>
  );
}
