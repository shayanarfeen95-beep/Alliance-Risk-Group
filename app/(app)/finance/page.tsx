import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { CircleAlert, CircleCheck, Download, Info } from 'lucide-react';
import { loadDashboardContext, type SearchParams } from '@/lib/dashboards/context';
import {
  loadFinance,
  type AgingBlock,
  type Figure,
  type FinanceViewModel,
  type PlLine,
} from '@/lib/dashboards/finance';
import { buildDivisionColorMap } from '@/lib/charts/colors';
import { formatNumber, formatSignedNumber, sentimentColorVar, sentimentOf } from '@/lib/format';
import { ChartCard } from '@/components/charts/chart-card';
import { Card, CardHeader, Chip, DataTable, Td, Th, Unavailable } from '@/components/ui/primitives';
import { Headline, type HeadlineTile } from '@/components/finance/headline';
import { SectionNav } from '@/components/finance/section-nav';

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

  const month = session.period.month.slice(0, 7);
  const sections = [
    { id: 'overview', label: 'Overview' },
    ...(model.tieOut ? [{ id: 'tie-out', label: 'Ties to QuickBooks' }] : []),
    { id: 'pl', label: 'Profit & loss' },
    ...(model.divisionBreakdown ? [{ id: 'divisions', label: 'By division' }] : []),
    { id: 'change', label: 'Change' },
    { id: 'cash', label: 'Working capital & aging' },
    { id: 'tenx', label: '10X plan' },
    { id: 'balance-sheet', label: 'Balance sheet' },
    { id: 'trend', label: 'Trend' },
  ];

  return (
    <div className="space-y-6">
      <header id="overview" className="flex scroll-mt-32 flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[19px] font-semibold tracking-tight">Finance</h1>
          <p className="mt-1 max-w-3xl text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
            {model.divisionLabel} · {model.monthLabel} and year to date ({model.ytdLabel}) ·{' '}
            {session.accountingBasis} basis, straight from QuickBooks.{' '}
            {session.periodIsClosed
              ? 'The books for this month are closed; figures are final.'
              : 'The books for this month are not closed yet, so figures can still change.'}
          </p>
        </div>
        <a
          href={`/api/export/finance?month=${month}&division=${divisionCode}`}
          className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius)] border px-3 text-[12px] font-medium"
          style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-1)', color: 'var(--text-primary)' }}
          title="Download the P&L on this page — month, YTD, full year and the division split — as a spreadsheet"
        >
          <Download size={13} aria-hidden />
          Download CSV
        </a>
      </header>

      <Headline tiles={headlineTiles(model)} />
      <SectionNav sections={sections} />

      {!model.hasData ? (
        <Card>
          <Unavailable
            reason="NO_DATA"
            detail={`No QuickBooks profit and loss has been loaded for ${model.monthLabel}. Run a pull in Admin → Data.`}
          />
        </Card>
      ) : null}

      {/* --- Tie-out ------------------------------------------------------- */}
      {model.tieOut ? (
        <section id="tie-out" className="scroll-mt-32">
          <TieOut model={model} />
        </section>
      ) : null}

      {/* --- P&L: month, YTD, full year ------------------------------------ */}
      <section id="pl" className="scroll-mt-32">
      <Card>
        <CardHeader
          title="Profit & loss"
          subtitle={<BudgetSource model={model} />}
        />
        <DataTable dense>
          <thead>
            <tr>
              <GroupTh align="left"> </GroupTh>
              <GroupTh span={4}>{model.monthLabel}</GroupTh>
              <GroupTh span={4}>Year to date · {model.ytdLabel}</GroupTh>
              <GroupTh span={2}>Full year {model.fiscalYear}</GroupTh>
            </tr>
            <tr>
              <Th align="left">Line</Th>
              <Th>Actual</Th>
              <Th title="From the budget named above the table">Budget</Th>
              <Th title="Actual − budget">Variance</Th>
              <Th title="Actual ÷ budget. Above 100% is good on revenue and profit, bad on costs.">% of budget</Th>
              <Th>Actual</Th>
              <Th>Budget</Th>
              <Th>Variance</Th>
              <Th>% of budget</Th>
              <Th>Budget</Th>
              <Th title={model.budget.outlookSource}>Outlook</Th>
            </tr>
          </thead>
          <tbody>
            {model.lines.map((line) => (
              <PlRow key={line.id} line={line} />
            ))}
          </tbody>
        </DataTable>
        <p className="mt-3 text-[11px] leading-relaxed text-[var(--text-muted)]">
          <strong className="font-medium">Outlook</strong> is {lowerFirst(model.budget.outlookSource)}{' '}
          Hover any line for how it is calculated. The two payroll rows are already inside COGS and
          operating expenses — shown for visibility, never subtracted again.
        </p>
      </Card>
      </section>

      {/* --- By division ---------------------------------------------------- */}
      {model.divisionBreakdown ? (
        <section id="divisions" className="scroll-mt-32">
          <DivisionBreakdown model={model} />
        </section>
      ) : null}

      {/* --- Change --------------------------------------------------------- */}
      <section id="change" className="scroll-mt-32">
      <Card>
        <CardHeader
          title="Change"
          subtitle={`${model.monthLabel} against the month before and the same month last year, and year to date against the same months of last year.`}
        />
        <DataTable dense>
          <thead>
            <tr>
              <GroupTh align="left"> </GroupTh>
              <GroupTh>{model.monthLabel}</GroupTh>
              <GroupTh span={3}>vs {model.priorMonthLabel} (prior month)</GroupTh>
              <GroupTh span={3}>vs {model.priorYearLabel} (same month last year)</GroupTh>
              <GroupTh span={4}>YTD {model.ytdLabel} vs {model.priorYtdLabel}</GroupTh>
            </tr>
            <tr>
              <Th align="left">Line</Th>
              <Th>Actual</Th>
              <Th>{shortLabel(model.priorMonthLabel)}</Th>
              <Th>Change $</Th>
              <Th>Change %</Th>
              <Th>{shortLabel(model.priorYearLabel)}</Th>
              <Th>Change $</Th>
              <Th>Change %</Th>
              <Th>This year</Th>
              <Th>Last year</Th>
              <Th>Change $</Th>
              <Th>Change %</Th>
            </tr>
          </thead>
          <tbody>
            {model.changes.map((row) => (
              <tr key={row.label}>
                <Td align="left" numeric={false}>
                  {row.label}
                </Td>
                <Td>{money(row.current)}</Td>
                <Td muted>{money(row.vsPriorMonth.base)}</Td>
                <Delta value={row.vsPriorMonth.dollars} higherIsBetter={row.higherIsBetter} format="currency" />
                <Delta value={row.vsPriorMonth.percent} higherIsBetter={row.higherIsBetter} format="percent" />
                <Td muted>{money(row.vsPriorYear.base)}</Td>
                <Delta value={row.vsPriorYear.dollars} higherIsBetter={row.higherIsBetter} format="currency" />
                <Delta value={row.vsPriorYear.percent} higherIsBetter={row.higherIsBetter} format="percent" />
                <Td>{money(row.ytdVsPriorYtd.current)}</Td>
                <Td muted>{money(row.ytdVsPriorYtd.base)}</Td>
                <Delta value={row.ytdVsPriorYtd.dollars} higherIsBetter={row.higherIsBetter} format="currency" />
                <Delta value={row.ytdVsPriorYtd.percent} higherIsBetter={row.higherIsBetter} format="percent" />
              </tr>
            ))}
          </tbody>
        </DataTable>
        <p className="mt-3 text-[11px] leading-relaxed text-[var(--text-muted)]">
          Change % is measured against the size of the earlier figure, so a smaller loss reads as an
          improvement. A dash means that period has not been loaded from QuickBooks — pull a range
          that includes last year to fill the prior-year columns.
        </p>
      </Card>
      </section>

      {/* --- Working capital and A/R --------------------------------------- */}
      <section id="cash" className="grid scroll-mt-32 gap-4 xl:grid-cols-2">
        <WorkingCapitalCard model={model} />
        <AgingCard model={model} />
      </section>

      {/* --- 10X ------------------------------------------------------------ */}
      <section id="tenx" className="scroll-mt-32">
        <TenXCard model={model} />
      </section>

      {/* --- Balance sheet -------------------------------------------------- */}
      <section id="balance-sheet" className="scroll-mt-32">
      <Card>
        <CardHeader
          title="Balance sheet"
          subtitle={`Month end ${model.monthLabel}, from the QuickBooks balance sheet, against the prior year end and the same month last year.`}
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
                title="Total assets − (total liabilities + equity). Equity is loaded from QuickBooks rather than plugged, so this is a real check."
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
                <Th>{model.monthLabel}</Th>
                <Th>Dec {model.fiscalYear - 1}</Th>
                <Th>{model.priorYearLabel}</Th>
                <Th>% of assets</Th>
              </tr>
            </thead>
            <tbody>
              {model.balanceSheet.map((row) => (
                <tr key={row.label}>
                  <Td
                    align="left"
                    numeric={false}
                    style={{ fontWeight: row.isSubtotal ? 600 : 400, paddingLeft: row.indent ? 24 : undefined }}
                  >
                    {row.label}
                  </Td>
                  <Td style={{ fontWeight: row.isSubtotal ? 600 : 400 }}>{money(row.current)}</Td>
                  <Td muted>{money(row.priorYearEnd)}</Td>
                  <Td muted>{money(row.priorYearSameMonth)}</Td>
                  <Td muted>{formatNumber(row.percentOfAssets, 'percent')}</Td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        ) : (
          <Unavailable
            reason="NOT_AVAILABLE_BY_DIVISION"
            detail={
              model.balanceSheetUnavailable ??
              `No balance sheet has been loaded for ${model.monthLabel} yet. It loads with the next QuickBooks pull.`
            }
          />
        )}
      </Card>
      </section>

      {/* --- Rolling trend -------------------------------------------------- */}
      <section id="trend" className="scroll-mt-32">
      <ChartCard
        title="Revenue trend"
        subtitle="Monthly revenue by division, the fifteen months to the selected month"
        series={model.trendSeries}
        data={model.trend}
        form="line"
        valueFormat="currency"
        height={280}
      />
      </section>
    </div>
  );
}

/** The headline row, from the same model as every table below it. */
function headlineTiles(model: FinanceViewModel): HeadlineTile[] {
  const line = (id: string) => model.lines.find((l) => l.id === id)!;
  const revenue = line('revenue');
  const grossMargin = line('gross_margin_pct');
  const netProfit = line('net_profit');
  const wc = model.workingCapital;
  const ar = model.aging.ar;

  const vsBudget = (f: Figure, higherIsBetter: boolean): Pick<HeadlineTile, 'context' | 'tone'> => {
    if (f.attainment === null) return { context: 'No budget loaded', tone: 'neutral' };
    const above = f.attainment >= 1;
    return {
      context: `${formatNumber(f.attainment, 'ratio')} of budget`,
      tone: above === higherIsBetter ? 'good' : 'bad',
    };
  };

  const vsPrior = (current: number | null, prior: number | null, label: string, higherIsBetter: boolean) => {
    if (current === null || prior === null) return { context: `No ${label} to compare`, tone: 'neutral' as const };
    const delta = current - prior;
    return {
      context: `${formatSignedNumber(delta, 'currency')} vs ${label}`,
      tone: delta === 0 ? ('neutral' as const) : (delta > 0) === higherIsBetter ? ('good' as const) : ('bad' as const),
    };
  };

  return [
    { label: 'Revenue', value: money(revenue.month.actual), ...vsBudget(revenue.month, true), hint: 'Month revenue from the QuickBooks P&L, against the budget.', href: '#pl' },
    {
      label: 'Gross margin',
      value: formatNumber(grossMargin.month.actual, 'percent'),
      context: grossMargin.month.budget === null ? 'No budget loaded' : `${points(grossMargin.month.variance)} vs budget`,
      tone: grossMargin.month.variance === null ? 'neutral' : grossMargin.month.variance >= 0 ? 'good' : 'bad',
      hint: 'Gross profit ÷ revenue for the month.',
      href: '#pl',
    },
    { label: 'Net profit', value: money(netProfit.month.actual), ...vsPrior(netProfit.month.actual, netProfit.priorMonth, shortLabel(model.priorMonthLabel), true), hint: 'Gross profit − operating expenses.', href: '#change' },
    { label: 'YTD net profit', value: money(netProfit.ytd.actual), ...vsBudget(netProfit.ytd, true), hint: `Net profit ${model.ytdLabel}.`, href: '#pl' },
    {
      label: 'Working capital',
      value: money(wc.workingCapital),
      ...(wc.workingCapital === null
        ? { context: model.isConsolidated ? 'Balance sheet not loaded' : 'ARG Total only', tone: 'neutral' as const }
        : { context: `Current ratio ${formatNumber(wc.currentRatio, 'multiple')}`, tone: (wc.currentRatio ?? 0) >= 1 ? ('good' as const) : ('bad' as const) }),
      hint: 'Current assets − current liabilities, from the QuickBooks balance sheet.',
      href: '#cash',
    },
    {
      label: 'Accounts receivable',
      value: ar ? money(ar.total) : '—',
      ...(ar
        ? {
            context: `${formatNumber(ar.total ? ar.over60 / ar.total : null, 'percent')} over 60 days`,
            tone: ar.total && ar.over60 / ar.total > 0.25 ? ('bad' as const) : ('neutral' as const),
          }
        : { context: 'No open invoices loaded', tone: 'neutral' as const }),
      hint: `Open invoices as of ${ar?.asOf ?? '—'}.`,
      href: '#cash',
    },
  ];
}

function DivisionBreakdown({ model }: { model: FinanceViewModel }) {
  const rows = model.divisionBreakdown!;
  return (
    <Card>
      <CardHeader
        title="By division"
        subtitle={`Each division for ${model.monthLabel} beside ARG Total, with its share of revenue and its year to date.`}
      />
      <DataTable dense>
        <thead>
          <tr>
            <GroupTh align="left"> </GroupTh>
            <GroupTh span={8}>{model.monthLabel}</GroupTh>
            <GroupTh span={3}>Year to date</GroupTh>
          </tr>
          <tr>
            <Th align="left">Division</Th>
            <Th>Revenue</Th>
            <Th title="Share of ARG Total revenue">Share</Th>
            <Th title="Month revenue ÷ the division's budgeted revenue">% of budget</Th>
            <Th>Gross profit</Th>
            <Th>Gross margin</Th>
            <Th>Operating exp.</Th>
            <Th>Net profit</Th>
            <Th>Net margin</Th>
            <Th>Revenue</Th>
            <Th>Net profit</Th>
            <Th>Net margin</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const weight = row.isTotal ? 600 : 400;
            return (
              <tr key={row.divisionCode}>
                <Td align="left" numeric={false} style={{ fontWeight: weight }}>
                  <span className="inline-flex items-center gap-2">
                    {row.color ? (
                      <span aria-hidden className="h-2.5 w-2.5 rounded-[2px]" style={{ background: row.color }} />
                    ) : null}
                    {row.label}
                  </span>
                </Td>
                <Td style={{ fontWeight: weight }}>{money(row.revenue)}</Td>
                <Td muted>
                  <span className="inline-flex items-center justify-end gap-2">
                    {!row.isTotal && row.revenueShare !== null ? (
                      <span aria-hidden className="h-1.5 w-12 overflow-hidden rounded-full" style={{ background: 'var(--surface-2)' }}>
                        <span className="block h-full rounded-full" style={{ width: `${Math.max(0, Math.min(1, row.revenueShare)) * 100}%`, background: row.color ?? 'var(--series-1)' }} />
                      </span>
                    ) : null}
                    {formatNumber(row.revenueShare, 'percent')}
                  </span>
                </Td>
                <Td style={{ color: sentimentColorVar(sentimentOf(row.budgetAttainment === null ? null : row.budgetAttainment - 1, true)) }}>
                  {formatNumber(row.budgetAttainment, 'ratio')}
                </Td>
                <Td style={{ fontWeight: weight }}>{money(row.grossProfit)}</Td>
                <Td muted>{formatNumber(row.grossMargin, 'percent')}</Td>
                <Td>{money(row.opex)}</Td>
                <Td style={{ fontWeight: weight, color: row.netProfit !== null && row.netProfit < 0 ? 'var(--delta-bad)' : undefined }}>
                  {money(row.netProfit)}
                </Td>
                <Td muted>{formatNumber(row.netMargin, 'percent')}</Td>
                <Td>{money(row.ytdRevenue)}</Td>
                <Td style={{ color: row.ytdNetProfit !== null && row.ytdNetProfit < 0 ? 'var(--delta-bad)' : undefined }}>
                  {money(row.ytdNetProfit)}
                </Td>
                <Td muted>{formatNumber(row.ytdNetMargin, 'percent')}</Td>
              </tr>
            );
          })}
        </tbody>
      </DataTable>
      <p className="mt-3 text-[11px] text-[var(--text-muted)]">
        Pick a division in the selector at the top to open its full P&amp;L.
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function money(value: number | null): string {
  return formatNumber(value, 'currency');
}

/** Lower-cases a leading word for use mid-sentence, leaving acronyms such as YTD alone. */
function lowerFirst(text: string): string {
  if (!text || /^[A-Z]{2}/.test(text)) return text;
  return text[0]!.toLowerCase() + text.slice(1);
}

/** "August 2025" → "Aug 2025", for a column heading. */
function shortLabel(label: string): string {
  const [month, year] = label.split(' ');
  return `${(month ?? '').slice(0, 3)} ${year ?? ''}`.trim();
}

function GroupTh({ children, span = 1, align = 'center' }: { children: ReactNode; span?: number; align?: 'left' | 'center' }) {
  return (
    <th
      colSpan={span}
      className="whitespace-nowrap border-b px-3 pb-1 pt-2 text-[11px] font-semibold"
      style={{ textAlign: align, borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
    >
      {children}
    </th>
  );
}

function Delta({
  value,
  higherIsBetter,
  format,
}: {
  value: number | null;
  higherIsBetter: boolean;
  format: 'currency' | 'percent';
}) {
  return (
    <Td style={{ color: sentimentColorVar(sentimentOf(value, higherIsBetter)) }}>
      {formatSignedNumber(value, format)}
    </Td>
  );
}

function BudgetSource({ model }: { model: FinanceViewModel }) {
  if (!model.budget.loaded) {
    return (
      <span className="inline-flex items-start gap-1.5">
        <Info size={13} className="mt-px shrink-0" aria-hidden />
        No budget is loaded for {model.fiscalYear}, so the budget columns are empty. The budget is read
        from QuickBooks (Budgets) on every pull; create it there, or load a budget tab from Google
        Sheets, and pull again.
      </span>
    );
  }
  return (
    <span>
      Budget: <strong className="font-medium text-[var(--text-primary)]">{model.budget.source}</strong>.
      Gross and net profit budgets are derived from the budgeted revenue, COGS and operating expenses.
    </span>
  );
}

function PlRow({ line }: { line: PlLine }) {
  const format = line.kind === 'percent' ? 'percent' : 'currency';
  const weight = line.isSubtotal ? 600 : 400;
  const color = line.isMemo || line.isRatio ? 'var(--text-muted)' : undefined;
  const value = (v: number | null) => formatNumber(v, format);

  const cells = (f: Figure) => (
    <>
      <Td style={{ fontWeight: weight, color }}>{value(f.actual)}</Td>
      <Td muted>{value(f.budget)}</Td>
      <Td style={{ color: sentimentColorVar(sentimentOf(f.variance, line.higherIsBetter)) }}>
        {line.kind === 'percent' ? points(f.variance) : formatSignedNumber(f.variance, 'currency')}
      </Td>
      <Td
        style={{
          color: sentimentColorVar(sentimentOf(f.attainment === null ? null : f.attainment - 1, line.higherIsBetter)),
        }}
      >
        {line.kind === 'percent' ? '' : formatNumber(f.attainment, 'ratio')}
      </Td>
    </>
  );

  return (
    <tr title={line.formula}>
      <Td
        align="left"
        numeric={false}
        style={{
          fontWeight: weight,
          color,
          paddingLeft: line.isMemo || line.isRatio ? 24 : undefined,
          fontStyle: line.isMemo ? 'italic' : undefined,
        }}
      >
        {line.label}
      </Td>
      {cells(line.month)}
      {cells(line.ytd)}
      <Td muted>{value(line.fullYear.budget)}</Td>
      <Td style={{ fontWeight: weight, color }}>{value(line.fullYear.outlook)}</Td>
    </tr>
  );
}

/** A difference between two percentages, in points: +2.1 pts. */
function points(value: number | null): string {
  if (value === null || Number.isNaN(value)) return '—';
  const pts = value * 100;
  const rounded = Math.round(pts * 10) / 10;
  return `${rounded > 0 ? '+' : rounded < 0 ? '−' : ''}${Math.abs(rounded).toFixed(1)} pts`;
}

function TieOut({ model }: { model: FinanceViewModel }) {
  const tie = model.tieOut!;
  return (
    <Card>
      <CardHeader
        title="Ties to QuickBooks"
        subtitle={`ARG Total — the four divisions added up — against QuickBooks' own company total for ${model.monthLabel}.`}
        action={
          <Chip
            tone={tie.allTie ? 'good' : 'critical'}
            icon={tie.allTie ? <CircleCheck size={13} aria-hidden /> : <CircleAlert size={13} aria-hidden />}
          >
            {tie.allTie ? 'Ties' : 'Does not tie'}
          </Chip>
        }
      />
      <DataTable>
        <thead>
          <tr>
            <Th align="left">Line</Th>
            <Th>QuickBooks total</Th>
            <Th>Four divisions</Th>
            <Th title="Four divisions − QuickBooks. Anything here sits on a class that is not a division (Not Specified, Z Alloc).">
              Not in a division
            </Th>
          </tr>
        </thead>
        <tbody>
          {tie.rows.map((row) => (
            <tr key={row.label}>
              <Td align="left" numeric={false}>
                {row.label}
              </Td>
              <Td>{formatNumber(row.quickbooks, 'currency_precise')}</Td>
              <Td>{formatNumber(row.divisions, 'currency_precise')}</Td>
              <Td style={{ color: row.ties ? 'var(--text-muted)' : 'var(--status-critical)' }}>
                {formatNumber(-row.difference, 'currency_precise')}
              </Td>
            </tr>
          ))}
        </tbody>
      </DataTable>
      <p className="mt-3 text-[11px] leading-relaxed text-[var(--text-muted)]">
        QuickBooks&apos; total includes every class. Amounts on classes that are not a division — such as
        Not Specified and Z Alloc — are in QuickBooks&apos; total but in no division, and are shown here
        rather than hidden.
      </p>
    </Card>
  );
}

function WorkingCapitalCard({ model }: { model: FinanceViewModel }) {
  const wc = model.workingCapital;
  const change =
    wc.workingCapital !== null && wc.priorMonthWorkingCapital !== null
      ? wc.workingCapital - wc.priorMonthWorkingCapital
      : null;

  return (
    <Card>
      <CardHeader
        title="Working capital"
        subtitle={`From the QuickBooks balance sheet at month end ${model.monthLabel}.`}
      />
      {wc.unavailable ? (
        <Unavailable reason="NOT_AVAILABLE_BY_DIVISION" detail={wc.unavailable} />
      ) : (
        <ul className="space-y-2">
          <Metric
            label="Working capital"
            value={money(wc.workingCapital)}
            strong
            hint="Current assets − current liabilities."
            extra={
              change === null ? undefined : (
                <span style={{ color: sentimentColorVar(sentimentOf(change, true)) }}>
                  {formatSignedNumber(change, 'currency')} vs {model.priorMonthLabel}
                </span>
              )
            }
          />
          <Metric label="Current assets" value={money(wc.currentAssets)} hint="Cash + accounts receivable + other current assets." />
          <Metric label="Current liabilities" value={money(wc.currentLiabilities)} hint="Accounts payable + credit cards + other current liabilities." />
          <Metric label="Current ratio" value={formatNumber(wc.currentRatio, 'multiple')} hint="Current assets ÷ current liabilities. Above 1.0× means short-term obligations are covered." />
          <Metric label="Cash" value={money(wc.cash)} />
          <Metric label="Days sales outstanding" value={formatNumber(wc.dso, 'days')} hint="A/R at month end ÷ revenue for the month × days in the month." />
          <Metric label="Days payable outstanding" value={formatNumber(wc.dpo, 'days')} hint="A/P at month end ÷ COGS for the month × days in the month." />
          <Metric label="Cash conversion cycle" value={formatNumber(wc.ccc, 'days')} hint="DSO − DPO. No inventory term — ARG is a services business." />
          <Metric label="Cash runway (this month's OpEx)" value={formatNumber(wc.runwaySingleMonth, 'months')} hint="Cash ÷ operating expenses for the month." />
          <Metric label="Cash runway (3-month average OpEx)" value={formatNumber(wc.runwayTrailing, 'months')} hint="Cash ÷ average monthly operating expenses over the last three months." />
        </ul>
      )}
    </Card>
  );
}

function AgingCard({ model }: { model: FinanceViewModel }) {
  const { ar, ap, note } = model.aging;
  return (
    <Card>
      <CardHeader title="Receivables and payables aging" subtitle={note ?? undefined} />
      {ar || ap ? (
        <div className="space-y-5">
          {ar ? <AgingTable block={ar} title="Accounts receivable" /> : null}
          {ap ? <AgingTable block={ap} title="Accounts payable" /> : null}
        </div>
      ) : (
        <Unavailable reason="NO_DATA" detail="No open invoices or bills have been loaded yet. They load with the next QuickBooks pull." />
      )}
    </Card>
  );
}

function AgingTable({ block, title }: { block: AgingBlock; title: string }) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="text-[12px] font-semibold">
          {title} · {money(block.total)}
        </span>
        <span className="text-[11px] text-[var(--text-muted)]">as of {block.asOf}</span>
      </div>
      <DataTable>
        <thead>
          <tr>
            <Th align="left">Bucket</Th>
            <Th>Amount</Th>
            <Th>% of total</Th>
            <Th align="left"> </Th>
          </tr>
        </thead>
        <tbody>
          {block.buckets.map((row) => (
            <tr key={row.bucket}>
              <Td align="left" numeric={false}>
                {row.label}
              </Td>
              <Td>{money(row.amount)}</Td>
              <Td muted>{formatNumber(row.share, 'percent')}</Td>
              <Td align="left" numeric={false} className="w-[30%]">
                <span
                  className="block h-1.5 rounded-full"
                  style={{
                    width: `${Math.max(0, Math.min(1, row.share ?? 0)) * 100}%`,
                    background:
                      row.bucket === 'current'
                        ? 'var(--status-good)'
                        : row.bucket === '1_30' || row.bucket === '31_60'
                          ? 'var(--status-warning)'
                          : 'var(--status-critical)',
                  }}
                  aria-hidden
                />
              </Td>
            </tr>
          ))}
          <tr>
            <Td align="left" numeric={false} style={{ fontWeight: 600 }}>
              Total
            </Td>
            <Td style={{ fontWeight: 600 }}>{money(block.total)}</Td>
            <Td muted>{block.total ? '100%' : '—'}</Td>
            <Td align="left" numeric={false}>
              {' '}
            </Td>
          </tr>
        </tbody>
      </DataTable>
      <p className="mt-1.5 text-[11px] text-[var(--text-muted)]">
        {money(block.over60)} ({formatNumber(block.total ? block.over60 / block.total : null, 'percent')}) is more
        than 60 days past due.
      </p>
    </div>
  );
}

function TenXCard({ model }: { model: FinanceViewModel }) {
  if (!model.tenX) {
    return (
      <Card>
        <CardHeader title="10X plan" />
        <p className="text-[12px] text-[var(--text-muted)]">
          The 10X plan covers 2026 through 2029. {model.monthLabel} falls outside that range.
        </p>
      </Card>
    );
  }

  const loaded = model.tenX.rows.some((row) => row.annualTarget !== null);
  return (
    <Card>
      <CardHeader
        title="10X plan — are we on pace?"
        subtitle={
          loaded
            ? `Year to date against the 10X targets (${model.tenX.source ?? '10X plan'}), and where ${model.fiscalYear} lands at the current pace.`
            : 'The 10X targets have not been loaded. They are read from the 10X tab of the connected Google Sheet on every pull.'
        }
      />
      <DataTable>
        <thead>
          <tr>
            <Th align="left">Line</Th>
            <Th>{model.fiscalYear} 10X target</Th>
            <Th>YTD target</Th>
            <Th>YTD actual</Th>
            <Th title="YTD actual − YTD target">Variance to goal</Th>
            <Th title="YTD actual ÷ YTD target">% of goal</Th>
            <Th title="YTD actual ÷ months elapsed × 12">Full year at current pace</Th>
            <Th>Pace</Th>
          </tr>
        </thead>
        <tbody>
          {model.tenX.rows.map((row) => {
            const onPace = row.paceGap === null ? null : row.higherIsBetter ? row.paceGap >= 0 : row.paceGap <= 0;
            return (
              <tr key={row.label}>
                <Td align="left" numeric={false}>
                  {row.label}
                </Td>
                <Td muted>{money(row.annualTarget)}</Td>
                <Td muted>{money(row.ytdTarget)}</Td>
                <Td style={{ fontWeight: 500 }}>{money(row.ytdActual)}</Td>
                <Delta value={row.ytdVariance} higherIsBetter={row.higherIsBetter} format="currency" />
                <Td
                  style={{
                    color: sentimentColorVar(
                      sentimentOf(row.ytdAttainment === null ? null : row.ytdAttainment - 1, row.higherIsBetter),
                    ),
                  }}
                >
                  {formatNumber(row.ytdAttainment, 'ratio')}
                </Td>
                <Td>{money(row.projectedFullYear)}</Td>
                <Td>
                  {onPace === null ? (
                    '—'
                  ) : (
                    <Chip tone={onPace ? 'good' : 'critical'}>
                      {onPace ? 'On pace' : `Behind by ${formatNumber(Math.abs(row.paceGap!), 'currency')}`}
                    </Chip>
                  )}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </DataTable>
    </Card>
  );
}

function Metric({
  label,
  value,
  hint,
  strong,
  extra,
}: {
  label: string;
  value: string;
  hint?: string;
  strong?: boolean;
  extra?: ReactNode;
}) {
  return (
    <li
      className="flex items-baseline justify-between gap-3 border-b pb-2 last:border-b-0"
      style={{ borderColor: 'var(--border)' }}
      title={hint}
    >
      <span className="text-[12px] text-[var(--text-secondary)]">{label}</span>
      <span className="text-right">
        <span className={`tnum ${strong ? 'text-[15px] font-semibold' : 'text-[13px] font-medium'}`}>{value}</span>
        {extra ? <span className="ml-2 text-[11px]">{extra}</span> : null}
      </span>
    </li>
  );
}
