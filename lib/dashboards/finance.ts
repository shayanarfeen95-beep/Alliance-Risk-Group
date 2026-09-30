import 'server-only';
import Decimal from 'decimal.js';
import { safeDiv } from '@/lib/money';
import { resolveKpi, CONSOLIDATED_CODE, type SemanticSession } from '@/lib/semantic/resolve';
import {
  balanceSheetFor,
  budgetFor,
  companyPl,
  companyUnassigned,
  hasPl,
  sumPl,
  sumPlOverMonths,
  key,
  type BsMeasures,
  type FactBundle,
  type PlMeasures,
} from '@/lib/semantic/facts';
import { preferredBudgetScenario } from '@/lib/semantic/registry';
import { formatNumber } from '@/lib/format';
import { formatMonth, formatMonthShort, monthRange, type MonthKey } from '@/lib/semantic/periods';

/**
 * §9.2 — the Finance dashboard.
 *
 * Rebuilt after ARG's first review against its own books (September 2026). What
 * that review asked for, and where it lives here:
 *
 *   - Month and year-to-date side by side on every line, with budget, variance
 *     and attainment for both — "YTD figures are not consistently shown".
 *   - Every comparison names the period it compares against — "we need to know
 *     what period/comparison they are based on".
 *   - The budget says which budget it is — "where the Budget numbers are coming
 *     from" — and the full-year outlook uses the forecast where one is loaded.
 *   - A tie-out to QuickBooks' own total, so "does this reconcile?" is answered
 *     on the page rather than by exporting a report.
 *   - Working capital from the balance sheet; A/R as a total with dollars and
 *     percentages per bucket; the 10X plan with YTD, variance and pace.
 *
 * Every figure still comes from the semantic layer's facts and helpers. Nothing
 * is computed here that the KPI registry computes differently.
 */

export type LineId = 'revenue' | 'cogs' | 'gross_profit' | 'opex' | 'net_profit';

export interface Figure {
  actual: number | null;
  budget: number | null;
  /** actual − budget. For a percentage row, the difference in points. */
  variance: number | null;
  /** actual ÷ budget. Null on percentage rows. */
  attainment: number | null;
}

export interface PlLine {
  id: string;
  label: string;
  /** How the row's value is formatted. */
  kind: 'money' | 'percent';
  isSubtotal: boolean;
  /** Memo rows are components of the total below them, never deductions. */
  isMemo: boolean;
  /** A ratio row, drawn quieter under the lines it is computed from. */
  isRatio: boolean;
  higherIsBetter: boolean;
  /** How the figure is worked out, in words. Shown on hover. */
  formula: string;
  month: Figure;
  ytd: Figure;
  /** Full-year budget and the outlook (YTD actual + forecast or budget for the rest). */
  fullYear: { budget: number | null; outlook: number | null };
  priorMonth: number | null;
  priorYear: number | null;
  priorYearYtd: number | null;
}

export interface ChangeRow {
  label: string;
  higherIsBetter: boolean;
  current: number | null;
  vsPriorMonth: { base: number | null; dollars: number | null; percent: number | null };
  vsPriorYear: { base: number | null; dollars: number | null; percent: number | null };
  ytdVsPriorYtd: { current: number | null; base: number | null; dollars: number | null; percent: number | null };
}

export interface TieOutRow {
  label: string;
  quickbooks: number;
  divisions: number;
  difference: number;
  /** Divisions plus what sits on no-division classes equals QuickBooks. */
  ties: boolean;
  /** QuickBooks' amount on classes that belong to no division, when recorded. */
  unassigned: number | null;
  /** "Not Specified $94,267 · Z Alloc $200" — which classes hold it. */
  unassignedDetail: string | null;
}

export interface BalanceSheetRow {
  label: string;
  current: number | null;
  priorYearEnd: number | null;
  priorYearSameMonth: number | null;
  percentOfAssets: number | null;
  isSubtotal?: boolean;
  indent?: boolean;
}

export interface AgingBucketRow {
  bucket: string;
  label: string;
  amount: number;
  share: number | null;
}

export interface AgingBlock {
  kind: 'AR' | 'AP';
  total: number;
  buckets: AgingBucketRow[];
  /** How much is more than 60 days past due, the figure collections is judged on. */
  over60: number;
  /** The date the snapshot describes. */
  asOf: string;
}

export interface WorkingCapitalBlock {
  unavailable?: string;
  currentAssets: number | null;
  currentLiabilities: number | null;
  workingCapital: number | null;
  priorMonthWorkingCapital: number | null;
  currentRatio: number | null;
  cash: number | null;
  dso: number | null;
  dpo: number | null;
  ccc: number | null;
  runwaySingleMonth: number | null;
  runwayTrailing: number | null;
}

export interface TenXRow {
  label: string;
  higherIsBetter: boolean;
  annualTarget: number | null;
  ytdTarget: number | null;
  ytdActual: number | null;
  ytdVariance: number | null;
  ytdAttainment: number | null;
  /** YTD actual annualised: where the year lands at the current pace. */
  projectedFullYear: number | null;
  /** Projected full year − annual target. */
  paceGap: number | null;
}

/** One division's month and YTD, side by side with the others. */
export interface DivisionBreakdownRow {
  divisionCode: string;
  label: string;
  color: string | null;
  isTotal: boolean;
  revenue: number | null;
  grossProfit: number | null;
  grossMargin: number | null;
  opex: number | null;
  netProfit: number | null;
  netMargin: number | null;
  /** Share of ARG Total revenue for the month. */
  revenueShare: number | null;
  ytdRevenue: number | null;
  ytdNetProfit: number | null;
  ytdNetMargin: number | null;
  /** Month revenue against the division's budget. */
  budgetAttainment: number | null;
}

export interface FinanceViewModel {
  divisionLabel: string;
  isConsolidated: boolean;
  monthLabel: string;
  priorMonthLabel: string;
  priorYearLabel: string;
  ytdLabel: string;
  priorYtdLabel: string;
  fiscalYear: number;
  hasData: boolean;
  lines: PlLine[];
  changes: ChangeRow[];
  budget: {
    scenario: string | null;
    source: string | null;
    loaded: boolean;
    outlookSource: string;
  };
  tieOut: { rows: TieOutRow[]; allTie: boolean } | null;
  workingCapital: WorkingCapitalBlock;
  balanceSheet: BalanceSheetRow[] | null;
  balanceCheck: { difference: number; passes: boolean } | null;
  balanceSheetUnavailable?: string;
  aging: { ar: AgingBlock | null; ap: AgingBlock | null; note: string | null };
  tenX: { rows: TenXRow[]; source: string | null } | null;
  /** Each division beside ARG Total. Only at ARG Total, where there is more than one. */
  divisionBreakdown: DivisionBreakdownRow[] | null;
  trend: Array<{ x: string; xLabel: string } & Record<string, number | null | string>>;
  trendSeries: Array<{ id: string; label: string; color: string }>;
}

const num = (value: Decimal | null | undefined): number | null =>
  value === null || value === undefined ? null : value.toNumber();

function pick(pl: PlMeasures, id: LineId): Decimal {
  switch (id) {
    case 'revenue':
      return pl.revenue;
    case 'cogs':
      return pl.cogs;
    case 'opex':
      return pl.opex;
    case 'gross_profit':
      return pl.revenue.minus(pl.cogs);
    case 'net_profit':
      return pl.revenue.minus(pl.cogs).minus(pl.opex);
  }
}

interface BudgetLines {
  revenue: number | null;
  cogs: number | null;
  opex: number | null;
}

function derive(b: BudgetLines, id: LineId): number | null {
  // GP and NP budgets are DERIVED from the three loaded lines (§4.4), never
  // imported, so the identity holds by construction.
  switch (id) {
    case 'revenue':
    case 'cogs':
    case 'opex':
      return b[id];
    case 'gross_profit':
      return b.revenue !== null && b.cogs !== null ? b.revenue - b.cogs : null;
    case 'net_profit':
      return b.revenue !== null && b.cogs !== null && b.opex !== null ? b.revenue - b.cogs - b.opex : null;
  }
}

function figure(actual: number | null, budget: number | null): Figure {
  return {
    actual,
    budget,
    variance: actual !== null && budget !== null ? actual - budget : null,
    attainment: actual !== null && budget !== null && budget !== 0 ? actual / budget : null,
  };
}

function ratioFigure(actual: number | null, budget: number | null): Figure {
  return {
    actual,
    budget,
    variance: actual !== null && budget !== null ? actual - budget : null,
    attainment: null,
  };
}

const ratio = (numerator: number | null, denominator: number | null): number | null =>
  numerator !== null && denominator !== null && denominator !== 0 ? numerator / denominator : null;

function change(current: number | null, base: number | null) {
  return {
    base,
    dollars: current !== null && base !== null ? current - base : null,
    // Against the absolute base, so a smaller loss reads as an improvement.
    percent: current !== null && base !== null && base !== 0 ? (current - base) / Math.abs(base) : null,
  };
}

const MONEY_LINES: Array<{
  id: LineId;
  label: string;
  higherIsBetter: boolean;
  isSubtotal: boolean;
  formula: string;
}> = [
  { id: 'revenue', label: 'Revenue', higherIsBetter: true, isSubtotal: false, formula: 'Total income from the QuickBooks P&L, all income accounts including sub-accounts.' },
  { id: 'cogs', label: 'Cost of goods sold', higherIsBetter: false, isSubtotal: false, formula: 'Total cost of goods sold from the QuickBooks P&L, including direct payroll.' },
  { id: 'gross_profit', label: 'Gross profit', higherIsBetter: true, isSubtotal: true, formula: 'Revenue − cost of goods sold.' },
  { id: 'opex', label: 'Operating expenses', higherIsBetter: false, isSubtotal: false, formula: 'Total expenses from the QuickBooks P&L (including other expenses and administrative payroll).' },
  { id: 'net_profit', label: 'Net profit', higherIsBetter: true, isSubtotal: true, formula: 'Gross profit − operating expenses.' },
];

const AGING_LABELS: Array<[string, string]> = [
  ['current', 'Current (not yet due)'],
  ['1_30', '1–30 days past due'],
  ['31_60', '31–60 days past due'],
  ['61_90', '61–90 days past due'],
  ['over_90', 'Over 90 days past due'],
];

export function loadFinance(
  session: SemanticSession,
  divisionCode: string,
  divisionColors: Record<string, string>,
): FinanceViewModel {
  const { period, bundle } = session;
  const isConsolidated = divisionCode === CONSOLIDATED_CODE;
  const divisions = isConsolidated ? session.visibleDivisions : [divisionCode];

  const divisionLabel = isConsolidated
    ? 'ARG Total'
    : (bundle.divisions.find((d) => d.divisionCode === divisionCode)?.divisionName ?? divisionCode);

  // --- Actuals -------------------------------------------------------------
  const plFor = (month: MonthKey): PlMeasures | null =>
    hasPl(bundle, month, divisions) ? sumPl(bundle, month, divisions) : null;
  const plOver = (months: MonthKey[]): PlMeasures | null =>
    months.some((month) => hasPl(bundle, month, divisions))
      ? sumPlOverMonths(bundle, months, divisions)
      : null;

  const monthPl = plFor(period.month);
  const priorMonthPl = plFor(period.priorMonth);
  const priorYearPl = plFor(period.priorYearMonth);
  const ytdPl = plOver(period.ytdMonths);
  // PY YTD only when every comparable month is loaded; a partial year against a
  // full one would overstate growth.
  const priorYtdPl = period.priorYearYtdMonths.every((month) => hasPl(bundle, month, divisions))
    ? sumPlOverMonths(bundle, period.priorYearYtdMonths, divisions)
    : null;

  // --- Budget and outlook ---------------------------------------------------
  const scenario = preferredBudgetScenario(bundle);
  const budgetLines = (months: MonthKey[]): BudgetLines => ({
    revenue: num(budgetFor(bundle, scenario, months, divisions, 'revenue', isConsolidated)),
    cogs: num(budgetFor(bundle, scenario, months, divisions, 'cogs', isConsolidated)),
    opex: num(budgetFor(bundle, scenario, months, divisions, 'opex', isConsolidated)),
  });
  const yearMonths = monthRange(`${period.fiscalYear}-01-01`, `${period.fiscalYear}-12-01`);
  const remainingMonths = yearMonths.filter((month) => month > period.month);

  const monthBudget = budgetLines([period.month]);
  const ytdBudget = budgetLines(period.ytdMonths);
  const yearBudget = budgetLines(yearMonths);

  // The rest of the year: the forecast where one is loaded for those months,
  // otherwise the budget. Each month independently, so a forecast that only
  // covers Q4 still uses the budget for anything before it.
  const forecastMonths = remainingMonths.filter(
    (month) => budgetFor(bundle, 'FORECAST', [month], divisions, 'revenue', isConsolidated) !== null,
  );
  const budgetMonths = remainingMonths.filter((month) => !forecastMonths.includes(month));
  const restOfYear = (line: 'revenue' | 'cogs' | 'opex'): number | null => {
    const forecast = forecastMonths.length
      ? num(budgetFor(bundle, 'FORECAST', forecastMonths, divisions, line, isConsolidated))
      : 0;
    const budget = budgetMonths.length
      ? num(budgetFor(bundle, scenario, budgetMonths, divisions, line, isConsolidated))
      : 0;
    return forecast === null || budget === null ? null : forecast + budget;
  };
  const outlookLines: BudgetLines | null = ytdPl
    ? {
        revenue: ((r) => (r === null ? null : ytdPl.revenue.toNumber() + r))(restOfYear('revenue')),
        cogs: ((r) => (r === null ? null : ytdPl.cogs.toNumber() + r))(restOfYear('cogs')),
        opex: ((r) => (r === null ? null : ytdPl.opex.toNumber() + r))(restOfYear('opex')),
      }
    : null;

  const scenarioInfo = bundle.scenarios.get(scenario);
  const budgetLoaded = monthBudget.revenue !== null || ytdBudget.revenue !== null;
  const outlookSource = !remainingMonths.length
    ? 'The year is complete, so the outlook is the actual.'
    : forecastMonths.length
      ? `YTD actual + ${bundle.scenarios.get('FORECAST')?.description ?? 'the loaded forecast'} for ${formatMonthShort(forecastMonths[0]!)}–${formatMonthShort(forecastMonths[forecastMonths.length - 1]!)}` +
        (budgetMonths.length ? ' and the budget for the other remaining months.' : '.')
      : 'YTD actual + budget for the remaining months (no forecast loaded).';

  // --- P&L lines -----------------------------------------------------------
  const valueOf = (pl: PlMeasures | null, id: LineId) => (pl ? pick(pl, id).toNumber() : null);

  const moneyLines = MONEY_LINES.map<PlLine>((spec) => ({
    id: spec.id,
    label: spec.label,
    kind: 'money',
    isSubtotal: spec.isSubtotal,
    isMemo: false,
    isRatio: false,
    higherIsBetter: spec.higherIsBetter,
    formula: spec.formula,
    month: figure(valueOf(monthPl, spec.id), derive(monthBudget, spec.id)),
    ytd: figure(valueOf(ytdPl, spec.id), derive(ytdBudget, spec.id)),
    fullYear: {
      budget: derive(yearBudget, spec.id),
      outlook: outlookLines ? derive(outlookLines, spec.id) : null,
    },
    priorMonth: valueOf(priorMonthPl, spec.id),
    priorYear: valueOf(priorYearPl, spec.id),
    priorYearYtd: valueOf(priorYtdPl, spec.id),
  }));

  const byId = new Map(moneyLines.map((line) => [line.id, line]));
  const ratioLine = (
    id: string,
    label: string,
    numerator: LineId,
    higherIsBetter: boolean,
  ): PlLine => {
    const top = byId.get(numerator)!;
    const revenue = byId.get('revenue')!;
    return {
      id,
      label,
      kind: 'percent',
      isSubtotal: false,
      isMemo: false,
      isRatio: true,
      higherIsBetter,
      formula: `${top.label} ÷ revenue for the same period.`,
      month: ratioFigure(ratio(top.month.actual, revenue.month.actual), ratio(top.month.budget, revenue.month.budget)),
      ytd: ratioFigure(ratio(top.ytd.actual, revenue.ytd.actual), ratio(top.ytd.budget, revenue.ytd.budget)),
      fullYear: {
        budget: ratio(top.fullYear.budget, revenue.fullYear.budget),
        outlook: ratio(top.fullYear.outlook, revenue.fullYear.outlook),
      },
      priorMonth: ratio(top.priorMonth, revenue.priorMonth),
      priorYear: ratio(top.priorYear, revenue.priorYear),
      priorYearYtd: ratio(top.priorYearYtd, revenue.priorYearYtd),
    };
  };

  const memoLine = (id: 'payroll_direct' | 'payroll_expense', label: string, within: string): PlLine => {
    const value = (pl: PlMeasures | null) =>
      pl ? (id === 'payroll_direct' ? pl.payrollDirect : pl.payrollExpense).toNumber() : null;
    return {
      id,
      label,
      kind: 'money',
      isSubtotal: false,
      isMemo: true,
      isRatio: false,
      higherIsBetter: false,
      formula: `Payroll accounts inside ${within}. Already counted in ${within} — shown for visibility, never subtracted again.`,
      month: figure(value(monthPl), null),
      ytd: figure(value(ytdPl), null),
      fullYear: { budget: null, outlook: null },
      priorMonth: value(priorMonthPl),
      priorYear: value(priorYearPl),
      priorYearYtd: value(priorYtdPl),
    };
  };

  const lines: PlLine[] = [
    byId.get('revenue')!,
    byId.get('cogs')!,
    memoLine('payroll_direct', 'of which direct payroll', 'cost of goods sold'),
    ratioLine('cogs_pct', 'COGS % of revenue', 'cogs', false),
    byId.get('gross_profit')!,
    ratioLine('gross_margin_pct', 'Gross margin %', 'gross_profit', true),
    byId.get('opex')!,
    memoLine('payroll_expense', 'of which administrative payroll', 'operating expenses'),
    ratioLine('opex_pct', 'OpEx % of revenue', 'opex', false),
    byId.get('net_profit')!,
    ratioLine('net_margin_pct', 'Net margin %', 'net_profit', true),
  ];

  // --- Change --------------------------------------------------------------
  const changes: ChangeRow[] = (['revenue', 'gross_profit', 'opex', 'net_profit'] as const).map((id) => {
    const line = byId.get(id)!;
    return {
      label: line.label,
      higherIsBetter: line.higherIsBetter,
      current: line.month.actual,
      vsPriorMonth: change(line.month.actual, line.priorMonth),
      vsPriorYear: change(line.month.actual, line.priorYear),
      ytdVsPriorYtd: { current: line.ytd.actual, ...change(line.ytd.actual, line.priorYearYtd) },
    };
  });

  // --- Tie-out to QuickBooks -----------------------------------------------
  let tieOut: FinanceViewModel['tieOut'] = null;
  const company = isConsolidated ? companyPl(bundle, period.month) : null;
  if (company && monthPl) {
    const outside = companyUnassigned(bundle, period.month);
    const rows = (['revenue', 'cogs', 'opex'] as const).map((line) => {
      const quickbooks = company[line].toNumber();
      const inDivisions = monthPl[line].toNumber();
      const difference = inDivisions - quickbooks;
      const unassigned = outside ? outside.totals[line].toNumber() : null;
      const explained = inDivisions + (unassigned ?? 0) - quickbooks;
      return {
        label: line === 'revenue' ? 'Revenue' : line === 'cogs' ? 'Cost of goods sold' : 'Operating expenses',
        quickbooks,
        divisions: inDivisions,
        difference,
        ties: Math.abs(explained) <= Math.max(1, Math.abs(quickbooks) * 0.001),
        unassigned,
        unassignedDetail: outside
          ? outside.byClass
              .filter((entry) => entry.line === line)
              .map((entry) => `${entry.className} ${formatNumber(entry.amount.toNumber(), 'currency')}`)
              .join(' · ') || null
          : null,
      };
    });
    tieOut = { rows, allTie: rows.every((row) => row.ties) };
  }

  // --- Balance sheet and working capital -----------------------------------
  const classed = bundle.config.get('BALANCE_SHEET_CLASSED')?.value === 'true';
  const balanceSheetAvailable = classed || isConsolidated;
  const balanceSheetUnavailable = balanceSheetAvailable
    ? undefined
    : 'QuickBooks keeps ARG’s balance sheet at company level — it is not split by class — so the balance sheet, working capital and A/R-based metrics are shown for ARG Total. Switch the division selector to ARG Total to see them.';

  const bsAt = (month: MonthKey): BsMeasures | null =>
    balanceSheetAvailable ? balanceSheetFor(bundle, month, divisions, isConsolidated) : null;

  const currentBs = bsAt(period.month);
  const priorMonthBs = bsAt(period.priorMonth);
  const priorYearEndBs = bsAt(`${period.fiscalYear - 1}-12-01`);
  const priorYearBs = bsAt(period.priorYearMonth);

  const currentAssetsOf = (bs: BsMeasures) => bs.cash.plus(bs.accountsReceivable).plus(bs.otherCurrentAssets);
  const currentLiabilitiesOf = (bs: BsMeasures) =>
    bs.accountsPayable.plus(bs.ccLiability).plus(bs.otherCurrentLiabilities);

  const kpi = (id: string, options?: Record<string, string>) =>
    num(resolveKpi(session, id, divisionCode, options ? { options } : {}).value);

  const workingCapital: WorkingCapitalBlock = currentBs
    ? {
        currentAssets: currentAssetsOf(currentBs).toNumber(),
        currentLiabilities: currentLiabilitiesOf(currentBs).toNumber(),
        workingCapital: currentAssetsOf(currentBs).minus(currentLiabilitiesOf(currentBs)).toNumber(),
        priorMonthWorkingCapital: priorMonthBs
          ? currentAssetsOf(priorMonthBs).minus(currentLiabilitiesOf(priorMonthBs)).toNumber()
          : null,
        currentRatio: safeDiv(currentAssetsOf(currentBs), currentLiabilitiesOf(currentBs)).toNumber(),
        cash: currentBs.cash.toNumber(),
        dso: kpi('dso'),
        dpo: kpi('dpo'),
        ccc: kpi('ccc'),
        runwaySingleMonth: kpi('cash_runway'),
        runwayTrailing: kpi('cash_runway', { variant: 'trailing_3m' }),
      }
    : {
        unavailable:
          balanceSheetUnavailable ??
          `No balance sheet has been loaded for ${formatMonth(period.month)} yet. It loads with the next QuickBooks pull.`,
        currentAssets: null,
        currentLiabilities: null,
        workingCapital: null,
        priorMonthWorkingCapital: null,
        currentRatio: null,
        cash: null,
        dso: null,
        dpo: null,
        ccc: null,
        runwaySingleMonth: null,
        runwayTrailing: null,
      };

  let balanceSheet: BalanceSheetRow[] | null = null;
  let balanceCheck: FinanceViewModel['balanceCheck'] = null;

  if (currentBs) {
    const totalAssets = currentAssetsOf(currentBs).plus(currentBs.fixedAssets);
    const sumOf = (bs: BsMeasures | null, fields: Array<keyof BsMeasures>) =>
      bs ? fields.reduce((total, field) => total.plus(bs[field]), new Decimal(0)).toNumber() : null;
    const line = (label: string, fields: Array<keyof BsMeasures>, extra: Partial<BalanceSheetRow> = {}): BalanceSheetRow => {
      const current = sumOf(currentBs, fields)!;
      return {
        label,
        current,
        priorYearEnd: sumOf(priorYearEndBs, fields),
        priorYearSameMonth: sumOf(priorYearBs, fields),
        percentOfAssets: safeDiv(current, totalAssets).toNumber(),
        ...extra,
      };
    };

    const currentAssetFields: Array<keyof BsMeasures> = ['cash', 'accountsReceivable', 'otherCurrentAssets'];
    const currentLiabilityFields: Array<keyof BsMeasures> = ['accountsPayable', 'ccLiability', 'otherCurrentLiabilities'];
    const liabilityFields: Array<keyof BsMeasures> = [...currentLiabilityFields, 'ltLiabilities'];

    balanceSheet = [
      line('Cash', ['cash'], { indent: true }),
      line('Accounts receivable', ['accountsReceivable'], { indent: true }),
      line('Other current assets', ['otherCurrentAssets'], { indent: true }),
      line('Total current assets', currentAssetFields, { isSubtotal: true }),
      line('Fixed and other assets', ['fixedAssets'], { indent: true }),
      line('Total assets', [...currentAssetFields, 'fixedAssets'], { isSubtotal: true }),
      line('Accounts payable', ['accountsPayable'], { indent: true }),
      line('Credit cards', ['ccLiability'], { indent: true }),
      line('Other current liabilities', ['otherCurrentLiabilities'], { indent: true }),
      line('Total current liabilities', currentLiabilityFields, { isSubtotal: true }),
      line('Long-term liabilities', ['ltLiabilities'], { indent: true }),
      line('Total liabilities', liabilityFields, { isSubtotal: true }),
      // Loaded from QuickBooks as its own figure, never plugged — which is what
      // makes the balance check below a real assertion (Defect 3).
      line('Equity (incl. current-year net income)', ['shareholderEquity'], { isSubtotal: true }),
    ];

    const difference = totalAssets.minus(
      currentLiabilitiesOf(currentBs).plus(currentBs.ltLiabilities).plus(currentBs.shareholderEquity),
    );
    balanceCheck = { difference: difference.toNumber(), passes: difference.abs().lessThanOrEqualTo(1) };
  }

  // --- Aging ---------------------------------------------------------------
  const aging = loadAging(bundle, divisions, isConsolidated);

  // --- 10X plan --------------------------------------------------------------
  const inTenXRange = period.fiscalYear >= 2026 && period.fiscalYear <= 2029;
  let tenX: FinanceViewModel['tenX'] = null;
  if (inTenXRange) {
    const tenXLines = (months: MonthKey[]): BudgetLines => ({
      revenue: num(budgetFor(bundle, 'TENX', months, divisions, 'revenue', isConsolidated)),
      cogs: num(budgetFor(bundle, 'TENX', months, divisions, 'cogs', isConsolidated)),
      opex: num(budgetFor(bundle, 'TENX', months, divisions, 'opex', isConsolidated)),
    });
    const annual = tenXLines(yearMonths);
    const ytdTarget = tenXLines(period.ytdMonths);

    tenX = {
      source: bundle.scenarios.get('TENX')?.description ?? null,
      rows: (['revenue', 'gross_profit', 'net_profit'] as const).map((id) => {
        const line = byId.get(id)!;
        const ytdActual = line.ytd.actual;
        const target = derive(ytdTarget, id);
        const annualTarget = derive(annual, id);
        const projected = ytdActual === null ? null : (ytdActual / period.monthsElapsed) * 12;
        return {
          label: line.label,
          higherIsBetter: line.higherIsBetter,
          annualTarget,
          ytdTarget: target,
          ytdActual,
          ytdVariance: ytdActual !== null && target !== null ? ytdActual - target : null,
          ytdAttainment: ytdActual !== null && target ? ytdActual / target : null,
          projectedFullYear: projected,
          paceGap: projected !== null && annualTarget !== null ? projected - annualTarget : null,
        };
      }),
    };
  }

  // --- Rolling 15-month trend ------------------------------------------------
  const trendDivisions = isConsolidated
    ? bundle.divisions
    : bundle.divisions.filter((d) => d.divisionCode === divisionCode);

  const trendSeries = trendDivisions.map((division) => ({
    id: division.divisionCode,
    label: division.divisionName,
    color: divisionColors[division.divisionCode] ?? 'var(--series-1)',
  }));

  const trend = period.trailingFifteenMonths.map((month) => {
    const row: { x: string; xLabel: string } & Record<string, number | null | string> = {
      x: month,
      xLabel: formatMonthShort(month),
    };
    for (const division of trendDivisions) {
      const measures = bundle.pl.get(key(month, division.divisionCode));
      row[division.divisionCode] = measures ? measures.revenue.toNumber() : null;
    }
    return row;
  });

  // --- Division breakdown ---------------------------------------------------
  let divisionBreakdown: DivisionBreakdownRow[] | null = null;
  if (isConsolidated && bundle.divisions.length > 1) {
    const totalRevenue = monthPl ? monthPl.revenue.toNumber() : null;
    const rowFor = (codes: string[], label: string, code: string, color: string | null, isTotal: boolean): DivisionBreakdownRow => {
      const month = hasPl(bundle, period.month, codes) ? sumPl(bundle, period.month, codes) : null;
      const ytd = period.ytdMonths.some((m) => hasPl(bundle, m, codes))
        ? sumPlOverMonths(bundle, period.ytdMonths, codes)
        : null;
      const revenue = month ? month.revenue.toNumber() : null;
      const gp = month ? month.revenue.minus(month.cogs).toNumber() : null;
      const np = month ? month.revenue.minus(month.cogs).minus(month.opex).toNumber() : null;
      const ytdRevenue = ytd ? ytd.revenue.toNumber() : null;
      const ytdNp = ytd ? ytd.revenue.minus(ytd.cogs).minus(ytd.opex).toNumber() : null;
      const budget = num(budgetFor(bundle, scenario, [period.month], codes, 'revenue', isTotal));
      return {
        divisionCode: code,
        label,
        color,
        isTotal,
        revenue,
        grossProfit: gp,
        grossMargin: ratio(gp, revenue),
        opex: month ? month.opex.toNumber() : null,
        netProfit: np,
        netMargin: ratio(np, revenue),
        revenueShare: ratio(revenue, totalRevenue),
        ytdRevenue,
        ytdNetProfit: ytdNp,
        ytdNetMargin: ratio(ytdNp, ytdRevenue),
        budgetAttainment: ratio(revenue, budget),
      };
    };
    divisionBreakdown = [
      ...bundle.divisions.map((d) =>
        rowFor([d.divisionCode], d.divisionName, d.divisionCode, divisionColors[d.divisionCode] ?? null, false),
      ),
      rowFor(divisions, 'ARG Total', CONSOLIDATED_CODE, null, true),
    ];
  }

  const ytdFirst = period.ytdMonths[0]!;
  const priorYtdFirst = period.priorYearYtdMonths[0] ?? period.priorYearMonth;

  return {
    divisionLabel,
    isConsolidated,
    monthLabel: formatMonth(period.month),
    priorMonthLabel: formatMonth(period.priorMonth),
    priorYearLabel: formatMonth(period.priorYearMonth),
    ytdLabel: `${formatMonthShort(ytdFirst)} – ${formatMonthShort(period.month)}`,
    priorYtdLabel: `${formatMonthShort(priorYtdFirst)} – ${formatMonthShort(period.priorYearMonth)}`,
    fiscalYear: period.fiscalYear,
    hasData: monthPl !== null,
    lines,
    changes,
    budget: {
      scenario: budgetLoaded ? scenario : null,
      source: budgetLoaded
        ? scenario === 'QBO_BUDGET' && !isConsolidated
          ? `${scenarioInfo?.description ?? 'QuickBooks budget'} — kept at company level, so this division’s share is read from the Monthly Budget sheet (${bundle.scenarios.get('MONTHLY_BUDGET')?.description ?? 'Google Sheets'})`
          : (scenarioInfo?.description ?? scenarioInfo?.name ?? scenario)
        : null,
      loaded: budgetLoaded,
      outlookSource,
    },
    tieOut,
    workingCapital,
    balanceSheet,
    balanceCheck,
    balanceSheetUnavailable,
    aging,
    tenX,
    divisionBreakdown,
    trend,
    trendSeries,
  };
}

/**
 * A/R and A/P aging: the latest snapshot in scope.
 *
 * Aging is a position on a date, taken from the open invoices and bills
 * themselves; QuickBooks cannot reconstruct what was outstanding at a past month
 * end once those invoices are paid. So the most recent snapshot is shown, with
 * the date it describes, rather than a blank for every month that is not the
 * current one.
 */
function loadAging(
  bundle: FactBundle,
  divisions: string[],
  isConsolidated: boolean,
): FinanceViewModel['aging'] {
  const block = (kind: 'AR' | 'AP'): AgingBlock | null => {
    let snapshotMonth: string | null = null;
    let amounts: Map<string, Decimal> | null = null;
    let asOf: Date | null = null;

    if (isConsolidated) {
      const keys = [...bundle.company.keys()].filter((k) => k.startsWith(`${kind}_AGING|`)).sort();
      const latest = keys[keys.length - 1];
      if (latest) {
        snapshotMonth = latest.split('|')[1]!;
        amounts = bundle.company.get(latest)!;
        asOf = bundle.companyLoadedAt.get(latest) ?? null;
      }
    }

    if (!amounts) {
      const months = [
        ...new Set(
          [...bundle.agingBuckets.keys()]
            .filter((k) => k.endsWith(`|${kind}`) && divisions.includes(k.split('|')[1]!))
            .map((k) => k.split('|')[0]!),
        ),
      ].sort();
      const latest = months[months.length - 1];
      if (!latest) return null;
      snapshotMonth = latest;
      amounts = new Map();
      for (const division of divisions) {
        for (const [bucket, value] of bundle.agingBuckets.get(`${latest}|${division}|${kind}`) ?? []) {
          amounts.set(bucket, (amounts.get(bucket) ?? new Decimal(0)).plus(value));
        }
      }
    }

    const total = [...amounts.values()].reduce((sum, value) => sum.plus(value), new Decimal(0));
    const buckets = AGING_LABELS.map(([bucket, label]) => {
      const amount = amounts!.get(bucket) ?? new Decimal(0);
      return {
        bucket,
        label,
        amount: amount.toNumber(),
        share: total.isZero() ? null : amount.div(total).toNumber(),
      };
    });

    return {
      kind,
      total: total.toNumber(),
      buckets,
      over60: buckets
        .filter((row) => row.bucket === '61_90' || row.bucket === 'over_90')
        .reduce((sum, row) => sum + row.amount, 0),
      asOf: asOf
        ? asOf.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : formatMonth(snapshotMonth!),
    };
  };

  const ar = block('AR');
  const ap = block('AP');
  const note =
    ar || ap
      ? `Aging is the position on the date shown, built from open invoices and bills in QuickBooks. ` +
        `A past month-end aging cannot be rebuilt once those invoices are paid, so it does not change with the month selector` +
        (isConsolidated ? '.' : ' — and invoices without a class are only in ARG Total.')
      : null;

  return { ar, ap, note };
}
