import type { FinanceViewModel } from '@/lib/dashboards/finance';

/**
 * The Finance P&L as a spreadsheet: exactly the rows and columns on the page.
 *
 * Built from the same view model the page renders, so the download and the
 * screen cannot disagree. Money is written as plain numbers to two decimals and
 * percentages as fractions, which is what a spreadsheet wants to compute with —
 * formatting is the reader's to apply.
 */
export function financeCsv(model: FinanceViewModel): string {
  const cell = (value: string | number | null): string => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') return Number.isFinite(value) ? String(Math.round(value * 10000) / 10000) : '';
    return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  };
  const row = (values: Array<string | number | null>) => values.map(cell).join(',');

  const lines = [
    row([`${model.divisionLabel} — ${model.monthLabel}`]),
    row([model.budget.source ? `Budget: ${model.budget.source}` : 'No budget loaded']),
    '',
    row([
      'Line',
      'Kind',
      `${model.monthLabel} actual`,
      `${model.monthLabel} budget`,
      `${model.monthLabel} variance`,
      `${model.monthLabel} % of budget`,
      `YTD ${model.ytdLabel} actual`,
      'YTD budget',
      'YTD variance',
      'YTD % of budget',
      `FY${model.fiscalYear} budget`,
      `FY${model.fiscalYear} outlook`,
      `${model.priorMonthLabel}`,
      `${model.priorYearLabel}`,
      `YTD ${model.priorYtdLabel}`,
    ]),
    ...model.lines.map((line) =>
      row([
        line.label,
        line.kind === 'percent' ? 'percent' : line.isMemo ? 'memo' : 'money',
        line.month.actual,
        line.month.budget,
        line.month.variance,
        line.month.attainment,
        line.ytd.actual,
        line.ytd.budget,
        line.ytd.variance,
        line.ytd.attainment,
        line.fullYear.budget,
        line.fullYear.outlook,
        line.priorMonth,
        line.priorYear,
        line.priorYearYtd,
      ]),
    ),
  ];

  if (model.divisionBreakdown) {
    lines.push('', row(['By division', 'Revenue', 'Gross profit', 'Gross margin', 'Operating expenses', 'Net profit', 'Net margin', 'Share of revenue', 'YTD revenue', 'YTD net profit']));
    for (const d of model.divisionBreakdown) {
      lines.push(row([d.label, d.revenue, d.grossProfit, d.grossMargin, d.opex, d.netProfit, d.netMargin, d.revenueShare, d.ytdRevenue, d.ytdNetProfit]));
    }
  }

  return lines.join('\n') + '\n';
}
