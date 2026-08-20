/**
 * §6 — The KPI Dictionary. All 24, defined exactly once.
 *
 * "Every KPI is defined once, in the semantic layer, and reused by every
 * dashboard, export and AI answer... Formulas below are the authority — they
 * were reverse-engineered from the live Excel and confirmed against it."
 *
 * Nothing in this file reads the database. A KPI is a pure function of
 * (period, bundle, divisions), which is why the tie-out suite can assert every
 * one of them against §13.1 without standing up a server.
 *
 * The `/kpi-dictionary` page is generated from this registry at request time, so
 * the published dictionary can never drift from the implementation.
 */
import Decimal from 'decimal.js';
import { safeDiv } from '@/lib/money';
import {
  hasBudget,
  hasPl,
  sumBs,
  sumBudget,
  sumPl,
  sumPlOverMonths,
  sumSpend,
  key,
  type FactBundle,
  type PlMeasures,
} from './facts';
import { annualise, monthBounds, type MonthKey, type PeriodContext } from './periods';
import type { Citation, KpiComputation, KpiDefinition, KpiInput, Unavailable } from './types';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const ZERO = new Decimal(0);

/**
 * §4.2 derived measures. Computed, never stored.
 *
 *   gross_profit = revenue − cogs      // payroll_direct is NOT subtracted
 *   net_profit   = gross_profit − opex // payroll_expense is NOT subtracted
 */
function grossProfitOf(pl: { revenue: Decimal; cogs: Decimal }): Decimal {
  return pl.revenue.minus(pl.cogs);
}

function netProfitOf(pl: { revenue: Decimal; cogs: Decimal; opex: Decimal }): Decimal {
  return grossProfitOf(pl).minus(pl.opex);
}

function unavailable(reason: Unavailable['reason'], detail: string): KpiComputation {
  return { value: null, unavailable: { reason, detail }, citations: [] };
}

function money(label: string, value: Decimal, source: Citation['source'], month?: MonthKey): Citation {
  return { label, value: value.toDecimalPlaces(2).toString(), source, periodMonth: month };
}

const NO_PL_FOR_PERIOD =
  'No profit-and-loss data has been loaded for this period and division. Showing nothing rather than zero — a missing figure must never read as $0.';

/**
 * Defect 2: the balance sheet may carry no division-level data at all.
 *
 * "If QBO cannot produce a classed balance sheet, DSO, DPO, CCC and Cash Runway
 * are ARG-Total-only in Phase 1. Flag this to Westport before building the
 * Finance dashboard."
 *
 * Open item #1 decides this. Until then the flag governs, and a division-level
 * request returns an explicit unavailable rather than a zero.
 */
function balanceSheetScope(input: KpiInput): Unavailable | null {
  const classed = input.bundle.config.get('BALANCE_SHEET_CLASSED')?.value === 'true';
  if (classed || input.isConsolidated) return null;
  return {
    reason: 'NOT_AVAILABLE_BY_DIVISION',
    detail:
      'ARG does not class its balance sheet in QuickBooks, so this metric is available at ARG Total only in Phase 1 (Defect 2, open item 1). It is not zero — the underlying data was never captured by division.',
  };
}

/**
 * §4.6: "Before you build them, confirm with Westport how a HubSpot deal is
 * attributed to a division... If no reliable attribution exists, sales and
 * marketing KPIs report at ARG Total only in Phase 1. Do not invent an
 * attribution rule."
 */
function hubspotDivisionScope(input: KpiInput): Unavailable | null {
  if (input.isConsolidated) return null;
  const attribution = input.bundle.config.get('HUBSPOT_DIVISION_ATTRIBUTION');
  if (attribution?.value && attribution.value !== 'none' && attribution.isConfirmed) return null;
  return {
    reason: 'NOT_AVAILABLE_BY_DIVISION',
    detail:
      'No confirmed rule attributes a HubSpot deal to a division, so sales and marketing metrics report at ARG Total only (open item 2). No attribution rule has been invented in its place.',
  };
}

/**
 * §6 Marketing: "Marketing spend must resolve to a specific, agreed set of QBO
 * accounts... An unagreed denominator makes all of them unusable."
 */
function spendDefinitionScope(bundle: FactBundle, configKey: string): Unavailable | null {
  const entry = bundle.config.get(configKey);
  if (entry?.value && entry.isConfirmed) return null;
  return {
    reason: 'PENDING_DEFINITION',
    detail: `The account set for ${configKey} has not been signed off by Westport (open item 4). An unagreed denominator makes this metric unusable, so it is withheld rather than estimated.`,
  };
}

/** Deals closed within the reporting month. */
function dealsClosedIn(bundle: FactBundle, month: MonthKey, divisions: string[], isConsolidated: boolean) {
  const { start, endExclusive } = monthBounds(month);
  return bundle.deals.filter((deal) => {
    if (!deal.isClosed || !deal.closedate) return false;
    if (deal.closedate < start || deal.closedate >= endExclusive) return false;
    return isConsolidated || (deal.divisionCode !== null && divisions.includes(deal.divisionCode));
  });
}

// ---------------------------------------------------------------------------
// Base measures — the P&L lines every dashboard reads
// ---------------------------------------------------------------------------

interface BaseSpec {
  id: string;
  name: string;
  /** What ARG's workbook calls this, when the two differ. */
  workbookLabel?: string;
  definition: string;
  formula: string;
  higherIsBetter: boolean;
  pick: (pl: ReturnType<typeof sumPl>) => Decimal;
  notes?: string;
}

const BASE_MEASURES: BaseSpec[] = [
  {
    id: 'revenue',
    workbookLabel: 'Total Revenue / Total Income',
    name: 'Revenue',
    definition: 'Total income for the month, from QuickBooks.',
    formula: 'QBO total income',
    higherIsBetter: true,
    pick: (pl) => pl.revenue,
  },
  {
    id: 'payroll_direct',
    workbookLabel: 'Total Payroll - Direct',
    name: 'Payroll — Direct (memo)',
    definition:
      'Direct labour payroll. A MEMO line: it is already a component of COGS and must never be subtracted separately.',
    formula: 'Sum of payroll accounts classified within COGS',
    higherIsBetter: false,
    pick: (pl) => pl.payrollDirect,
    notes:
      '§4.2 MEMO ONLY. Subtracting this alongside COGS double-counts payroll and understates profit at every division, in every month, on every dashboard.',
  },
  {
    id: 'cogs',
    workbookLabel: 'Total COGS',
    name: 'COGS',
    definition: 'Total cost of goods sold, inclusive of direct payroll.',
    formula: 'QBO total cost of goods sold (inclusive of payroll_direct)',
    higherIsBetter: false,
    pick: (pl) => pl.cogs,
  },
  {
    id: 'gross_profit',
    workbookLabel: 'Gross Profit',
    name: 'Gross Profit',
    definition: 'Revenue less COGS. Direct payroll is not subtracted — it is already inside COGS.',
    formula: 'revenue − cogs',
    higherIsBetter: true,
    pick: (pl) => grossProfitOf(pl),
    notes:
      '§13.1 guard: SHRC gross profit for March 2026 is $71,451. If it computes to $38,407 the payroll memo column has been subtracted.',
  },
  {
    id: 'payroll_expense',
    workbookLabel: 'Total Payroll Expense',
    name: 'Payroll Expense (memo)',
    definition:
      'Administrative payroll. A MEMO line: already a component of operating expense and never subtracted separately.',
    formula: 'Sum of payroll accounts classified within OpEx',
    higherIsBetter: false,
    pick: (pl) => pl.payrollExpense,
    notes: '§4.2 MEMO ONLY.',
  },
  {
    id: 'opex',
    workbookLabel: 'Total OpEx',
    name: 'Operating Expense',
    definition: 'Total operating expense, inclusive of administrative payroll.',
    formula: 'QBO total operating expense (inclusive of payroll_expense)',
    higherIsBetter: false,
    pick: (pl) => pl.opex,
  },
  {
    id: 'net_profit',
    workbookLabel: 'Net Ordinary Income (NOI)',
    name: 'Net Profit',
    definition: 'Gross profit less operating expense.',
    formula: 'gross_profit − opex',
    higherIsBetter: true,
    pick: (pl) => netProfitOf(pl),
  },
];

const baseDefinitions: KpiDefinition[] = BASE_MEASURES.map((spec) => ({
  id: spec.id,
  name: spec.name,
  workbookLabel: spec.workbookLabel,
  category: 'base',
  definition: spec.definition,
  formula: spec.formula,
  sourceSystem: 'QuickBooks Online',
  format: 'currency',
  higherIsBetter: spec.higherIsBetter,
  refreshCadence: 'Daily while the month is open; frozen on close',
  specReference: '§4.2',
  notes: spec.notes,
  compute: ({ period, bundle, divisions }) => {
    if (!hasPl(bundle, period.month, divisions)) {
      return unavailable('NO_DATA', NO_PL_FOR_PERIOD);
    }
    const pl = sumPl(bundle, period.month, divisions);
    return {
      value: spec.pick(pl),
      citations: [
        money('Revenue', pl.revenue, 'QBO', period.month),
        money('COGS', pl.cogs, 'QBO', period.month),
        money('OpEx', pl.opex, 'QBO', period.month),
      ],
    };
  },
}));

// Ratio measures, used by the Finance dashboard's ratio block.
const RATIOS: Array<{
  id: string;
  name: string;
  workbookLabel?: string;
  higherIsBetter: boolean;
  numerator: (pl: ReturnType<typeof sumPl>) => Decimal;
}> = [
  { id: 'cogs_pct', name: 'COGS %', higherIsBetter: false, numerator: (pl) => pl.cogs },
  { id: 'gross_profit_pct',
    workbookLabel: 'GP %', name: 'Gross Profit %', higherIsBetter: true, numerator: grossProfitOf },
  { id: 'opex_pct', name: 'OpEx %', higherIsBetter: false, numerator: (pl) => pl.opex },
  { id: 'net_profit_pct',
    workbookLabel: 'NOI %', name: 'Net Profit %', higherIsBetter: true, numerator: netProfitOf },
];

const ratioDefinitions: KpiDefinition[] = RATIOS.map((spec) => ({
  id: spec.id,
  name: spec.name,
  workbookLabel: spec.workbookLabel,
  category: 'base',
  definition: `${spec.name} of revenue for the month.`,
  formula: `${spec.id.replace('_pct', '')} ÷ revenue`,
  sourceSystem: 'QuickBooks Online',
  format: 'percent',
  higherIsBetter: spec.higherIsBetter,
  refreshCadence: 'Daily while the month is open; frozen on close',
  specReference: '§9.2 ratio block',
  compute: ({ period, bundle, divisions }) => {
    if (!hasPl(bundle, period.month, divisions)) return unavailable('NO_DATA', NO_PL_FOR_PERIOD);
    const pl = sumPl(bundle, period.month, divisions);
    return {
      value: safeDiv(spec.numerator(pl), pl.revenue),
      citations: [money('Revenue', pl.revenue, 'QBO', period.month)],
    };
  },
}));

// ---------------------------------------------------------------------------
// Finance (8) — source: QuickBooks Online
// ---------------------------------------------------------------------------

const financeDefinitions: KpiDefinition[] = [
  {
    id: 'dso',
    workbookLabel: 'Daily Sales Outstanding',
    name: 'Days Sales Outstanding',
    category: 'finance',
    definition: 'How long it takes ARG to collect what it has billed.',
    formula: '(A/R at month end ÷ revenue for the month) × days in month',
    sourceSystem: 'QuickBooks Online',
    format: 'days',
    higherIsBetter: false,
    refreshCadence: 'Daily while the month is open',
    specReference: '§6 Finance',
    notes: 'Days in month is actual calendar days, not 30.',
    compute: (input) => {
      const scope = balanceSheetScope(input);
      if (scope) return { value: null, unavailable: scope, citations: [] };

      const { period, bundle, divisions } = input;
      const bs = sumBs(bundle, period.month, divisions);
      if (!bs) return unavailable('NO_DATA', 'No balance sheet loaded for this period.');
      const pl = sumPl(bundle, period.month, divisions);

      return {
        value: safeDiv(bs.accountsReceivable, pl.revenue).times(period.daysInMonth),
        citations: [
          money('A/R at month end', bs.accountsReceivable, 'QBO', period.month),
          money('Revenue for the month', pl.revenue, 'QBO', period.month),
          { label: 'Days in month', value: String(period.daysInMonth), source: 'Derived' },
        ],
        components: { accountsReceivable: bs.accountsReceivable, revenue: pl.revenue },
      };
    },
  },
  {
    id: 'dpo',
    workbookLabel: 'Daily Payables Outstanding',
    name: 'Days Payable Outstanding',
    category: 'finance',
    definition: 'How long ARG takes to pay what it owes.',
    formula: '(A/P at month end ÷ COGS for the month) × days in month',
    sourceSystem: 'QuickBooks Online',
    format: 'days',
    // Paying later conserves cash, so a higher DPO reads favourably in
    // isolation. It is presented beside DSO and CCC for exactly that reason.
    higherIsBetter: true,
    refreshCadence: 'Daily while the month is open',
    specReference: '§6 Finance',
    compute: (input) => {
      const scope = balanceSheetScope(input);
      if (scope) return { value: null, unavailable: scope, citations: [] };

      const { period, bundle, divisions } = input;
      const bs = sumBs(bundle, period.month, divisions);
      if (!bs) return unavailable('NO_DATA', 'No balance sheet loaded for this period.');
      const pl = sumPl(bundle, period.month, divisions);

      return {
        value: safeDiv(bs.accountsPayable, pl.cogs).times(period.daysInMonth),
        citations: [
          money('A/P at month end', bs.accountsPayable, 'QBO', period.month),
          money('COGS for the month', pl.cogs, 'QBO', period.month),
          { label: 'Days in month', value: String(period.daysInMonth), source: 'Derived' },
        ],
      };
    },
  },
  {
    id: 'ccc',
    workbookLabel: 'Cash Conversion Cycle',
    name: 'Cash Conversion Cycle',
    category: 'finance',
    definition: 'Days between paying suppliers and collecting from customers.',
    formula: 'DSO − DPO',
    sourceSystem: 'QuickBooks Online',
    format: 'days',
    higherIsBetter: false,
    refreshCadence: 'Daily while the month is open',
    specReference: '§6 Finance',
    notes:
      'Inventory days are zero — ARG is a services business. There is deliberately no DIO term.',
    compute: (input) => {
      const scope = balanceSheetScope(input);
      if (scope) return { value: null, unavailable: scope, citations: [] };

      const { period, bundle, divisions } = input;
      const bs = sumBs(bundle, period.month, divisions);
      if (!bs) return unavailable('NO_DATA', 'No balance sheet loaded for this period.');
      const pl = sumPl(bundle, period.month, divisions);

      const dso = safeDiv(bs.accountsReceivable, pl.revenue).times(period.daysInMonth);
      const dpo = safeDiv(bs.accountsPayable, pl.cogs).times(period.daysInMonth);

      return {
        value: dso.minus(dpo),
        citations: [
          { label: 'DSO', value: dso.toDecimalPlaces(1).toString(), source: 'Derived' },
          { label: 'DPO', value: dpo.toDecimalPlaces(1).toString(), source: 'Derived' },
        ],
        components: { dso, dpo },
      };
    },
  },
  {
    id: 'cash_runway',
    workbookLabel: 'Cash Runway (Months)',
    name: 'Cash Runway',
    category: 'finance',
    definition: 'Months of operating expense the current cash balance covers.',
    formula: 'Cash at month end ÷ monthly OpEx',
    sourceSystem: 'QuickBooks Online',
    format: 'months',
    higherIsBetter: true,
    refreshCadence: 'Daily while the month is open',
    specReference: '§6 Finance, §7, Defect 6',
    notes:
      'OpEx-only denominator, confirmed by Westport — not total cash out, not OpEx plus COGS. Defect 6: single-month OpEx swings materially, so a trailing-three-month-average variant is available via the `variant` option. The single-month figure is the default so it ties to the Excel.',
    compute: (input) => {
      const scope = balanceSheetScope(input);
      if (scope) return { value: null, unavailable: scope, citations: [] };

      const { period, bundle, divisions, options } = input;
      const bs = sumBs(bundle, period.month, divisions);
      if (!bs) return unavailable('NO_DATA', 'No balance sheet loaded for this period.');

      const useTrailing = options?.variant === 'trailing_3m';
      const denominator = useTrailing
        ? sumPlOverMonths(bundle, period.trailingThreeMonths, divisions).opex.div(
            period.trailingThreeMonths.length,
          )
        : sumPl(bundle, period.month, divisions).opex;

      return {
        value: safeDiv(bs.cash, denominator),
        citations: [
          money('Cash at month end', bs.cash, 'QBO', period.month),
          money(
            useTrailing ? 'Trailing 3-month average OpEx' : 'Monthly OpEx',
            denominator,
            'QBO',
            period.month,
          ),
        ],
        components: { cash: bs.cash, opex: denominator },
      };
    },
  },
  {
    id: 'revenue_run_rate',
    workbookLabel: 'Revenue Run Rate $',
    name: 'Revenue Run Rate',
    category: 'finance',
    definition: 'Annualised revenue, projected from year-to-date performance.',
    formula: '(YTD revenue ÷ months elapsed) × 12',
    sourceSystem: 'QuickBooks Online',
    format: 'currency',
    higherIsBetter: true,
    refreshCadence: 'Daily while the month is open',
    specReference: '§6 Finance, §7',
    notes:
      'Annualised from YTD, NOT single month × 12. §13.1: ARG Total for March 2026 is roughly $5,640,939; $6,538,128 is March alone annualised, which is the wrong method and the easiest run-rate error to make.',
    compute: ({ period, bundle, divisions }) => {
      if (!hasPl(bundle, period.month, divisions)) return unavailable('NO_DATA', NO_PL_FOR_PERIOD);
      const ytd = sumPlOverMonths(bundle, period.ytdMonths, divisions);
      return {
        value: new Decimal(annualise(ytd.revenue.toNumber(), period.monthsElapsed)),
        citations: [
          money('YTD revenue', ytd.revenue, 'QBO'),
          { label: 'Months elapsed', value: String(period.monthsElapsed), source: 'Derived' },
        ],
        components: { ytdRevenue: ytd.revenue },
      };
    },
  },
  {
    id: 'ytd_gross_margin_pct',
    workbookLabel: 'Gross Profit Run Rate %',
    name: 'YTD Gross Margin %',
    category: 'finance',
    definition: 'Year-to-date gross profit as a share of year-to-date revenue.',
    formula: 'YTD gross profit ÷ YTD revenue',
    sourceSystem: 'QuickBooks Online',
    format: 'percent',
    higherIsBetter: true,
    refreshCadence: 'Daily while the month is open',
    specReference: '§6 Finance, Defect 5',
    notes:
      'Defect 5: labelled "Gross Profit Run Rate %" in the Excel. That label is wrong — this is a year-to-date margin, not an annualised run rate. The number was always correct; only the name misled.',
    compute: ({ period, bundle, divisions }) => {
      if (!hasPl(bundle, period.month, divisions)) return unavailable('NO_DATA', NO_PL_FOR_PERIOD);
      const ytd = sumPlOverMonths(bundle, period.ytdMonths, divisions);
      return {
        value: safeDiv(grossProfitOf(ytd), ytd.revenue),
        citations: [
          money('YTD gross profit', grossProfitOf(ytd), 'Derived'),
          money('YTD revenue', ytd.revenue, 'QBO'),
        ],
      };
    },
  },
  {
    id: 'ytd_net_margin_pct',
    workbookLabel: 'Net Profit Run Rate %',
    name: 'YTD Net Margin %',
    category: 'finance',
    definition: 'Year-to-date net profit as a share of year-to-date revenue.',
    formula: 'YTD net profit ÷ YTD revenue',
    sourceSystem: 'QuickBooks Online',
    format: 'percent',
    higherIsBetter: true,
    refreshCadence: 'Daily while the month is open',
    specReference: '§6 Finance, Defect 5',
    notes: 'Defect 5: relabelled from "Net Profit Run Rate %", which it never was.',
    compute: ({ period, bundle, divisions }) => {
      if (!hasPl(bundle, period.month, divisions)) return unavailable('NO_DATA', NO_PL_FOR_PERIOD);
      const ytd = sumPlOverMonths(bundle, period.ytdMonths, divisions);
      return {
        value: safeDiv(netProfitOf(ytd), ytd.revenue),
        citations: [
          money('YTD net profit', netProfitOf(ytd), 'Derived'),
          money('YTD revenue', ytd.revenue, 'QBO'),
        ],
      };
    },
  },
  {
    id: 'budget_attainment',
    name: 'Budget vs. Actual (attainment)',
    category: 'finance',
    definition:
      'Actual revenue as a ratio of budgeted revenue, shown alongside the dollar variance.',
    formula: 'Attainment ratio = actual ÷ budget · Variance $ = actual − budget',
    sourceSystem: 'QuickBooks Online + Budget',
    format: 'ratio',
    higherIsBetter: true,
    refreshCadence: 'Daily while the month is open',
    specReference: '§6 Finance, §7',
    notes:
      'Attainment ratio, NOT variance %. A deliberate Westport convention — preserve it. The two columns are labelled distinctly ("Attainment %" and "Variance $") because in the Excel a reader sees "−36,773" beside "84%" and reasonably assumes both are variances. Direction matters: above 100% is good on revenue and gross profit, bad on COGS, OpEx and payroll.',
    compute: ({ period, bundle, divisions, options }) => {
      const scenario = String(options?.scenario ?? 'MONTHLY_BUDGET');
      const lineItem = (options?.lineItem ?? 'revenue') as 'revenue' | 'cogs' | 'opex';
      const months = options?.scope === 'ytd' ? period.ytdMonths : [period.month];

      if (!hasBudget(bundle, scenario, months, divisions)) {
        return unavailable(
          'NO_DATA',
          `No ${scenario} figures exist for this period. The 10X plan covers 2026–2029 only and is blank outside that range.`,
        );
      }
      if (!hasPl(bundle, period.month, divisions)) return unavailable('NO_DATA', NO_PL_FOR_PERIOD);

      const actualPl = sumPlOverMonths(bundle, months, divisions);
      const actual =
        lineItem === 'revenue' ? actualPl.revenue : lineItem === 'cogs' ? actualPl.cogs : actualPl.opex;
      const budget = sumBudget(bundle, scenario, months, divisions, lineItem);

      return {
        value: safeDiv(actual, budget),
        citations: [
          money('Actual', actual, 'QBO'),
          money('Budget', budget, 'Budget'),
          { label: 'Scenario', value: scenario, source: 'Budget' },
        ],
        components: { actual, budget, varianceDollars: actual.minus(budget) },
      };
    },
  },
];

/**
 * §6: "Add two derived measures the Excel is missing but the dashboards need...
 * These are what 'run rate' actually means and what the Executive dashboard
 * should show."
 */
const additionalRunRates: KpiDefinition[] = (
  [
    ['gross_profit_run_rate', 'Gross Profit Run Rate', grossProfitOf],
    ['net_profit_run_rate', 'Net Profit Run Rate', netProfitOf],
  ] as const
).map(([id, name, pick]) => ({
  id,
  name,
  category: 'finance' as const,
  definition: `Annualised ${name.replace(' Run Rate', '').toLowerCase()}, projected from year-to-date.`,
  formula: `(YTD ${name.replace(' Run Rate', '').toLowerCase()} ÷ months elapsed) × 12`,
  sourceSystem: 'QuickBooks Online',
  format: 'currency' as const,
  higherIsBetter: true,
  refreshCadence: 'Daily while the month is open',
  specReference: '§6 — added; missing from the Excel',
  notes: 'Uses the same annualisation method as Revenue Run Rate.',
  compute: ({ period, bundle, divisions }: KpiInput) => {
    if (!hasPl(bundle, period.month, divisions)) return unavailable('NO_DATA', NO_PL_FOR_PERIOD);
    const ytd = sumPlOverMonths(bundle, period.ytdMonths, divisions);
    const ytdValue = pick(ytd);
    return {
      value: new Decimal(annualise(ytdValue.toNumber(), period.monthsElapsed)),
      citations: [
        money(`YTD ${name.replace(' Run Rate', '')}`, ytdValue, 'Derived'),
        { label: 'Months elapsed', value: String(period.monthsElapsed), source: 'Derived' as const },
      ],
    };
  },
}));

/**
 * The change metrics ARG's workbook carries and this build did not.
 *
 * The rollup tabs publish nine of these — MoM and YoY percentage change on
 * revenue, gross profit and net profit, and each division's share of the
 * consolidated total. They existed only as a delta printed under a tile, which
 * is not the same thing: a figure that is not a metric cannot be asked for by
 * the assistant, cannot be charted, cannot carry a standing goal, and cannot
 * appear in the audit pack. ARG reads these every month, so they are metrics.
 *
 * Percentage change against a zero or negative base is left unavailable rather
 * than computed. Claims ran a negative net profit in every month of Q1; "net
 * profit improved by −140%" is a sentence with no meaning, and a dashboard that
 * prints one has quietly stopped being trustworthy. The dollar movement is
 * always available and always means something, so the refusal costs nothing.
 */
const CHANGE_BASES = [
  { key: 'revenue', label: 'Revenue', pick: (pl: PlMeasures) => pl.revenue, higherIsBetter: true },
  { key: 'gross_profit', label: 'Gross Profit', pick: grossProfitOf, higherIsBetter: true },
  { key: 'net_profit', label: 'Net Profit', pick: netProfitOf, higherIsBetter: true },
] as const;

const changeDefinitions: KpiDefinition[] = CHANGE_BASES.flatMap((base) =>
  (
    [
      {
        suffix: 'mom_pct',
        name: `${base.label} MoM %`,
        workbookLabel: `MoM ${base.label === 'Net Profit' ? 'Net Profit' : base.label === 'Gross Profit' ? 'GP' : 'Rev'} % Change`,
        against: (period: PeriodContext) => period.priorMonth,
        againstLabel: 'prior month',
      },
      {
        suffix: 'yoy_pct',
        name: `${base.label} YoY %`,
        workbookLabel: `YoY for Month ${base.label === 'Net Profit' ? 'NOI' : base.label === 'Gross Profit' ? 'GP' : 'Revenue'} % Change`,
        against: (period: PeriodContext) => period.priorYearMonth,
        againstLabel: 'the same month last year',
      },
    ] as const
  ).map((variant) => ({
    id: `${base.key}_${variant.suffix}`,
    name: variant.name,
    workbookLabel: variant.workbookLabel,
    category: 'finance' as const,
    definition: `${base.label} change against ${variant.againstLabel}, as a percentage.`,
    formula: `(${base.label.toLowerCase()} − ${variant.againstLabel} ${base.label.toLowerCase()}) ÷ |${variant.againstLabel} ${base.label.toLowerCase()}|`,
    sourceSystem: 'QuickBooks Online',
    format: 'percent' as const,
    higherIsBetter: base.higherIsBetter,
    refreshCadence: 'Daily while the month is open',
    specReference: "§7 — from ARG's rollup tabs",
    notes:
      'Undefined against a zero or negative base, and reported as unavailable rather than as a percentage that would read backwards.',
    compute: ({ period, bundle, divisions }: KpiInput) => {
      if (!hasPl(bundle, period.month, divisions)) return unavailable('NO_DATA', NO_PL_FOR_PERIOD);

      const comparisonMonth = variant.against(period);
      if (!hasPl(bundle, comparisonMonth, divisions)) {
        return unavailable(
          'NO_DATA',
          `No profit-and-loss data is loaded for ${comparisonMonth.slice(0, 7)}, so there is nothing to compare against.`,
        );
      }

      const current = base.pick(sumPl(bundle, period.month, divisions));
      const prior = base.pick(sumPl(bundle, comparisonMonth, divisions));

      if (prior.isZero() || prior.isNegative()) {
        return unavailable(
          'NO_DATA',
          `${base.label} for ${comparisonMonth.slice(0, 7)} was ${prior.isZero() ? 'zero' : 'negative'}, so a percentage change is not meaningful. ` +
            `The movement is ${current.minus(prior).toDecimalPlaces(0).toString()} in dollars.`,
        );
      }

      return {
        value: current.minus(prior).dividedBy(prior),
        citations: [
          money(base.label, current, 'Derived', period.month),
          money(`${base.label}, ${variant.againstLabel}`, prior, 'Derived', comparisonMonth),
        ],
        components: { current, prior, movement: current.minus(prior) },
      };
    },
  })),
);

/**
 * A division's share of the consolidated total — the workbook's "% of Revenue
 * Contribution" and "% of NOI Contribution".
 *
 * Only meaningful for one division against ARG Total, so asking for it at ARG
 * Total returns an explicit unavailable rather than 100%, which would be true
 * and useless. Net profit contribution is refused when the consolidated figure
 * is zero or negative: a division that lost less than the group is not
 * "contributing 340% of net profit", and that is what the arithmetic would say.
 */
const contributionDefinitions: KpiDefinition[] = (
  [
    ['revenue_contribution_pct', 'Revenue Contribution %', '% of Revenue Contribution', (pl: PlMeasures) => pl.revenue],
    ['net_profit_contribution_pct', 'Net Profit Contribution %', '% of NOI Contribution', netProfitOf],
  ] as const
).map(([id, name, workbookLabel, pick]) => ({
  id,
  name,
  workbookLabel,
  category: 'finance' as const,
  definition: `This division's ${name.replace(' Contribution %', '').toLowerCase()} as a share of ARG Total.`,
  formula: `division ${name.replace(' Contribution %', '').toLowerCase()} ÷ ARG Total ${name.replace(' Contribution %', '').toLowerCase()}`,
  sourceSystem: 'QuickBooks Online',
  format: 'percent' as const,
  higherIsBetter: true,
  refreshCadence: 'Daily while the month is open',
  specReference: "§7 — from ARG's rollup tabs",
  compute: ({ period, bundle, divisions, isConsolidated }: KpiInput) => {
    if (isConsolidated) {
      return unavailable(
        'NOT_AVAILABLE_BY_DIVISION',
        'Contribution is a division’s share of ARG Total. At ARG Total it would always be 100%. Select a division.',
      );
    }
    if (!hasPl(bundle, period.month, divisions)) return unavailable('NO_DATA', NO_PL_FOR_PERIOD);

    const part = pick(sumPl(bundle, period.month, divisions));
    // The denominator is every division the caller is entitled to see. A
    // division manager who cannot see the consolidated total cannot be shown a
    // share of it, and gets an unavailable rather than a share of their own
    // division, which would read as 100%.
    const whole = pick(sumPl(bundle, period.month, bundle.allowedDivisions));

    if (bundle.allowedDivisions.length < bundle.divisions.length) {
      return unavailable(
        'NOT_AVAILABLE_BY_DIVISION',
        'Contribution needs the consolidated total as its denominator, and this user is not entitled to every division.',
      );
    }

    if (whole.isZero() || whole.isNegative()) {
      return unavailable(
        'NO_DATA',
        `ARG Total ${name.replace(' Contribution %', '').toLowerCase()} for this month is ${whole.isZero() ? 'zero' : 'negative'}, so a share of it is not meaningful.`,
      );
    }

    return {
      value: part.dividedBy(whole),
      citations: [
        money(`Division ${name.replace(' Contribution %', '')}`, part, 'Derived', period.month),
        money(`ARG Total ${name.replace(' Contribution %', '')}`, whole, 'Derived', period.month),
      ],
    };
  },
}));

const cashPosition: KpiDefinition = {
  id: 'cash_position',
    workbookLabel: 'Cash and Equivalents',
  name: 'Cash Position',
  category: 'finance',
  definition: 'Cash and equivalents at month end.',
  formula: 'Balance sheet cash at month end',
  sourceSystem: 'QuickBooks Online',
  format: 'currency',
  higherIsBetter: true,
  refreshCadence: 'Daily while the month is open',
  specReference: '§9.1 Executive tiles',
  compute: (input) => {
    const scope = balanceSheetScope(input);
    if (scope) return { value: null, unavailable: scope, citations: [] };
    const bs = sumBs(input.bundle, input.period.month, input.divisions);
    if (!bs) return unavailable('NO_DATA', 'No balance sheet loaded for this period.');
    return { value: bs.cash, citations: [money('Cash', bs.cash, 'QBO', input.period.month)] };
  },
};

// ---------------------------------------------------------------------------
// Sales (9) — source: HubSpot
// ---------------------------------------------------------------------------

const salesDefinitions: KpiDefinition[] = [
  {
    id: 'dollars_booked',
    name: 'Dollars Booked',
    category: 'sales',
    definition: 'Value of deals won in the period.',
    formula: 'SUM(amount) WHERE is_closed_won = true AND closedate in period',
    sourceSystem: 'HubSpot',
    format: 'currency',
    higherIsBetter: true,
    refreshCadence: 'Daily, overnight',
    specReference: '§6 Sales',
    compute: (input) => {
      const scope = hubspotDivisionScope(input);
      if (scope) return { value: null, unavailable: scope, citations: [] };
      const closed = dealsClosedIn(input.bundle, input.period.month, input.divisions, input.isConsolidated);
      const won = closed.filter((deal) => deal.isClosedWon);
      const total = won.reduce((sum, deal) => sum.plus(deal.amount), ZERO);
      return {
        value: total,
        citations: [
          { label: 'Deals won', value: String(won.length), source: 'HubSpot' },
          money('Total value', total, 'HubSpot', input.period.month),
        ],
      };
    },
  },
  {
    id: 'count_of_bookings',
    name: 'Count of Bookings',
    category: 'sales',
    definition: 'Number of deals won in the period.',
    formula: 'COUNT(deals) WHERE is_closed_won = true AND closedate in period',
    sourceSystem: 'HubSpot',
    format: 'count',
    higherIsBetter: true,
    refreshCadence: 'Daily, overnight',
    specReference: '§6 Sales',
    compute: (input) => {
      const scope = hubspotDivisionScope(input);
      if (scope) return { value: null, unavailable: scope, citations: [] };
      const won = dealsClosedIn(input.bundle, input.period.month, input.divisions, input.isConsolidated).filter(
        (deal) => deal.isClosedWon,
      );
      return {
        value: new Decimal(won.length),
        citations: [{ label: 'Deals won', value: String(won.length), source: 'HubSpot' }],
      };
    },
  },
  {
    id: 'average_booking_value',
    name: 'Average Booking Value',
    category: 'sales',
    definition: 'Average value of a deal won in the period.',
    formula: 'Dollars Booked ÷ Count of Bookings',
    sourceSystem: 'HubSpot',
    format: 'currency',
    higherIsBetter: true,
    refreshCadence: 'Daily, overnight',
    specReference: '§6 Sales',
    compute: (input) => {
      const scope = hubspotDivisionScope(input);
      if (scope) return { value: null, unavailable: scope, citations: [] };
      const won = dealsClosedIn(input.bundle, input.period.month, input.divisions, input.isConsolidated).filter(
        (deal) => deal.isClosedWon,
      );
      const total = won.reduce((sum, deal) => sum.plus(deal.amount), ZERO);
      return {
        value: safeDiv(total, won.length),
        citations: [
          money('Dollars booked', total, 'HubSpot', input.period.month),
          { label: 'Count of bookings', value: String(won.length), source: 'HubSpot' },
        ],
      };
    },
  },
  {
    id: 'booking_rate_pct',
    name: 'Booking Rate %',
    category: 'sales',
    definition: 'Share of deals closed in the period that were won.',
    formula: 'Closed-won deals ÷ total deals closed in period (won + lost)',
    sourceSystem: 'HubSpot',
    format: 'percent',
    higherIsBetter: true,
    refreshCadence: 'Daily, overnight',
    specReference: '§6 Sales',
    notes:
      'The denominator is deals CLOSED in the period — won plus lost — not all open deals. §6: "State the denominator on the dashboard — it is the single most commonly misread sales metric."',
    compute: (input) => {
      const scope = hubspotDivisionScope(input);
      if (scope) return { value: null, unavailable: scope, citations: [] };
      const closed = dealsClosedIn(input.bundle, input.period.month, input.divisions, input.isConsolidated);
      if (closed.length === 0) {
        return unavailable('NO_DATA', 'No deals closed in this period, so there is no rate to report.');
      }
      const won = closed.filter((deal) => deal.isClosedWon);
      return {
        value: safeDiv(won.length, closed.length),
        citations: [
          { label: 'Deals won', value: String(won.length), source: 'HubSpot' },
          { label: 'Deals closed (won + lost)', value: String(closed.length), source: 'HubSpot' },
        ],
        components: { won: new Decimal(won.length), closed: new Decimal(closed.length) },
      };
    },
  },
  {
    id: 'pipeline_value',
    name: 'Pipeline Value',
    category: 'sales',
    definition: 'Total value of deals still open as of the reporting date.',
    formula: 'SUM(amount) WHERE deal is open, as of the reporting date',
    sourceSystem: 'HubSpot',
    format: 'currency',
    higherIsBetter: true,
    refreshCadence: 'Daily, overnight',
    specReference: '§6 Sales',
    compute: (input) => {
      const scope = hubspotDivisionScope(input);
      if (scope) return { value: null, unavailable: scope, citations: [] };
      const open = input.bundle.deals.filter(
        (deal) =>
          !deal.isClosed &&
          (input.isConsolidated ||
            (deal.divisionCode !== null && input.divisions.includes(deal.divisionCode))),
      );
      const total = open.reduce((sum, deal) => sum.plus(deal.amount), ZERO);
      return {
        value: total,
        citations: [
          { label: 'Open deals', value: String(open.length), source: 'HubSpot' },
          money('Pipeline value', total, 'HubSpot'),
        ],
      };
    },
  },
  {
    id: 'meetings_completed',
    name: 'Meetings Completed',
    category: 'sales',
    definition: 'Meetings held in the period.',
    formula: 'COUNT(meetings) by meeting date in period',
    sourceSystem: 'HubSpot',
    format: 'count',
    higherIsBetter: true,
    refreshCadence: 'Daily, overnight',
    specReference: '§6 Sales',
    compute: (input) => {
      const scope = hubspotDivisionScope(input);
      if (scope) return { value: null, unavailable: scope, citations: [] };
      const { start, endExclusive } = monthBounds(input.period.month);
      const held = input.bundle.meetings.filter(
        (meeting) =>
          meeting.meetingDate >= start &&
          meeting.meetingDate < endExclusive &&
          meeting.outcome === 'COMPLETED' &&
          (input.isConsolidated ||
            (meeting.divisionCode !== null && input.divisions.includes(meeting.divisionCode))),
      );
      return {
        value: new Decimal(held.length),
        citations: [{ label: 'Meetings completed', value: String(held.length), source: 'HubSpot' }],
      };
    },
  },
  {
    id: 'new_proposals_sent',
    name: 'New Proposals Sent',
    category: 'sales',
    definition: 'Deals that entered the Proposal stage during the period.',
    formula: 'COUNT(deals) entering the Proposal stage in period',
    sourceSystem: 'HubSpot (deal stage history)',
    format: 'count',
    higherIsBetter: true,
    refreshCadence: 'Daily, overnight',
    specReference: '§6 Sales, §5.2',
    notes:
      'Requires deal stage history, not current stage. A deal that entered Proposal in March and closed in April still counts in March.',
    compute: (input) => {
      const scope = hubspotDivisionScope(input);
      if (scope) return { value: null, unavailable: scope, citations: [] };
      const { start, endExclusive } = monthBounds(input.period.month);
      const entries = input.bundle.proposalEntries.filter(
        (entry) =>
          entry.enteredAt >= start &&
          entry.enteredAt < endExclusive &&
          (input.isConsolidated ||
            (entry.divisionCode !== null && input.divisions.includes(entry.divisionCode))),
      );
      return {
        value: new Decimal(entries.length),
        citations: [
          { label: 'Deals entering Proposal', value: String(entries.length), source: 'HubSpot' },
        ],
      };
    },
  },
  {
    id: 'average_close_time',
    name: 'Average Close Time',
    category: 'sales',
    definition: 'Average days from deal creation to close, for deals won in the period.',
    formula: 'AVG(closedate − createdate) in days, for deals closed-won in period',
    sourceSystem: 'HubSpot',
    format: 'days',
    higherIsBetter: false,
    refreshCadence: 'Daily, overnight',
    specReference: '§6 Sales',
    compute: (input) => {
      const scope = hubspotDivisionScope(input);
      if (scope) return { value: null, unavailable: scope, citations: [] };
      const won = dealsClosedIn(input.bundle, input.period.month, input.divisions, input.isConsolidated).filter(
        (deal) => deal.isClosedWon && deal.createdate && deal.closedate,
      );
      if (won.length === 0) {
        return unavailable('NO_DATA', 'No deals were won in this period, so there is no close time to average.');
      }
      const totalDays = won.reduce((sum, deal) => {
        const days = (deal.closedate!.getTime() - deal.createdate!.getTime()) / 86_400_000;
        return sum.plus(days);
      }, ZERO);
      return {
        value: safeDiv(totalDays, won.length),
        citations: [{ label: 'Deals won', value: String(won.length), source: 'HubSpot' }],
      };
    },
  },
  {
    id: 'budgeted_sales_vs_actual',
    name: 'Budgeted Sales vs. Actual',
    category: 'sales',
    definition: 'Closed-won bookings measured against budgeted revenue.',
    formula:
      'Closed-won amount vs budgeted revenue (HubSpot + FACT_BUDGET; QBO revenue as the secondary check)',
    sourceSystem: 'HubSpot + Budget',
    format: 'ratio',
    higherIsBetter: true,
    refreshCadence: 'Daily, overnight',
    specReference: '§6 Sales',
    compute: (input) => {
      const scope = hubspotDivisionScope(input);
      if (scope) return { value: null, unavailable: scope, citations: [] };
      const { period, bundle, divisions } = input;

      if (!hasBudget(bundle, 'MONTHLY_BUDGET', [period.month], divisions)) {
        return unavailable('NO_DATA', 'No budget exists for this period.');
      }
      const won = dealsClosedIn(bundle, period.month, divisions, input.isConsolidated).filter(
        (deal) => deal.isClosedWon,
      );
      const booked = won.reduce((sum, deal) => sum.plus(deal.amount), ZERO);
      const budget = sumBudget(bundle, 'MONTHLY_BUDGET', [period.month], divisions, 'revenue');
      const qboRevenue = sumPl(bundle, period.month, divisions).revenue;

      return {
        value: safeDiv(booked, budget),
        citations: [
          money('Dollars booked', booked, 'HubSpot', period.month),
          money('Budgeted revenue', budget, 'Budget', period.month),
          money('QBO revenue (secondary check)', qboRevenue, 'QBO', period.month),
        ],
        components: { booked, budget, varianceDollars: booked.minus(budget), qboRevenue },
      };
    },
  },
];

// ---------------------------------------------------------------------------
// Marketing (5) — source: HubSpot + QuickBooks Online
// ---------------------------------------------------------------------------

function leadsIn(bundle: FactBundle, month: MonthKey, divisions: string[], isConsolidated: boolean) {
  const { start, endExclusive } = monthBounds(month);
  return bundle.contacts.filter(
    (contact) =>
      contact.becameLeadDate !== null &&
      contact.becameLeadDate >= start &&
      contact.becameLeadDate < endExclusive &&
      (isConsolidated ||
        (contact.divisionCode !== null && divisions.includes(contact.divisionCode))),
  );
}

const marketingDefinitions: KpiDefinition[] = [
  {
    id: 'leads_received',
    name: 'Leads Received',
    category: 'marketing',
    definition: 'Contacts that became leads during the period.',
    formula: 'COUNT(contacts) WHERE lifecycle_stage = Lead, by the date the contact became a lead',
    sourceSystem: 'HubSpot',
    format: 'count',
    higherIsBetter: true,
    refreshCadence: 'Daily, overnight',
    specReference: '§6 Marketing',
    compute: (input) => {
      const scope = hubspotDivisionScope(input);
      if (scope) return { value: null, unavailable: scope, citations: [] };
      const leads = leadsIn(input.bundle, input.period.month, input.divisions, input.isConsolidated);
      return {
        value: new Decimal(leads.length),
        citations: [{ label: 'Leads', value: String(leads.length), source: 'HubSpot' }],
      };
    },
  },
  {
    id: 'cost_per_lead',
    name: 'Cost Per Lead',
    category: 'marketing',
    definition: 'Marketing spend divided by the number of leads received.',
    formula: 'Marketing spend (QBO) ÷ lead count (HubSpot)',
    sourceSystem: 'QuickBooks Online + HubSpot',
    format: 'currency_precise',
    higherIsBetter: false,
    refreshCadence: 'Monthly with the close',
    specReference: '§6 Marketing',
    notes: 'Uses the marketing-only account set — a different set from CAC\'s numerator.',
    compute: (input) => {
      const pending = spendDefinitionScope(input.bundle, 'MARKETING_SPEND_ACCOUNTS');
      if (pending) return { value: null, unavailable: pending, citations: [] };
      const scope = hubspotDivisionScope(input);
      if (scope) return { value: null, unavailable: scope, citations: [] };

      const spend = sumSpend(input.bundle.marketingSpend, [input.period.month], input.divisions);
      const leads = leadsIn(input.bundle, input.period.month, input.divisions, input.isConsolidated);
      if (leads.length === 0) {
        return unavailable('NO_DATA', 'No leads were received in this period, so cost per lead is undefined.');
      }
      return {
        value: safeDiv(spend, leads.length),
        citations: [
          money('Marketing spend', spend, 'QBO', input.period.month),
          { label: 'Leads', value: String(leads.length), source: 'HubSpot' },
        ],
      };
    },
  },
  {
    id: 'roas',
    name: 'Return on Ad Spend',
    category: 'marketing',
    definition: 'Revenue from attributed closed-won deals per dollar of ad spend.',
    formula: 'Revenue from attributed closed-won deals ÷ ad spend',
    sourceSystem: 'HubSpot + QuickBooks Online',
    format: 'ratio',
    higherIsBetter: true,
    refreshCadence: 'Monthly with the close',
    specReference: '§6 Marketing',
    notes: 'Uses the marketing-only account set.',
    compute: (input) => {
      const pending = spendDefinitionScope(input.bundle, 'MARKETING_SPEND_ACCOUNTS');
      if (pending) return { value: null, unavailable: pending, citations: [] };
      const scope = hubspotDivisionScope(input);
      if (scope) return { value: null, unavailable: scope, citations: [] };

      const spend = sumSpend(input.bundle.marketingSpend, [input.period.month], input.divisions);
      if (spend.isZero()) {
        return unavailable('NO_DATA', 'No marketing spend recorded in this period, so return on ad spend is undefined.');
      }
      const won = dealsClosedIn(input.bundle, input.period.month, input.divisions, input.isConsolidated).filter(
        (deal) => deal.isClosedWon,
      );
      const revenue = won.reduce((sum, deal) => sum.plus(deal.amount), ZERO);
      return {
        value: safeDiv(revenue, spend),
        citations: [
          money('Closed-won revenue', revenue, 'HubSpot', input.period.month),
          money('Marketing spend', spend, 'QBO', input.period.month),
        ],
      };
    },
  },
  {
    id: 'marketing_efficiency_ratio',
    name: 'Marketing Efficiency Ratio',
    category: 'marketing',
    definition: 'Total revenue generated per dollar of marketing spend.',
    formula: 'Total revenue ÷ total marketing spend',
    sourceSystem: 'QuickBooks Online',
    format: 'ratio',
    higherIsBetter: true,
    refreshCadence: 'Monthly with the close',
    specReference: '§6 Marketing',
    compute: (input) => {
      const pending = spendDefinitionScope(input.bundle, 'MARKETING_SPEND_ACCOUNTS');
      if (pending) return { value: null, unavailable: pending, citations: [] };

      const spend = sumSpend(input.bundle.marketingSpend, [input.period.month], input.divisions);
      if (spend.isZero()) {
        return unavailable('NO_DATA', 'No marketing spend recorded in this period.');
      }
      const revenue = sumPl(input.bundle, input.period.month, input.divisions).revenue;
      return {
        value: safeDiv(revenue, spend),
        citations: [
          money('Total revenue', revenue, 'QBO', input.period.month),
          money('Marketing spend', spend, 'QBO', input.period.month),
        ],
      };
    },
  },
  {
    id: 'customer_acquisition_cost',
    name: 'Customer Acquisition Cost',
    category: 'marketing',
    definition: 'Sales and marketing spend per new customer won in the period.',
    formula: 'Sales & marketing spend ÷ new customers won in period',
    sourceSystem: 'QuickBooks Online + HubSpot',
    format: 'currency_precise',
    higherIsBetter: false,
    refreshCadence: 'Monthly with the close',
    specReference: '§6 Marketing',
    notes:
      "CAC's numerator is the sales AND marketing account set — a different, larger set than the marketing-only one used by CPL and ROAS. §6 is explicit that these are two separate lists and both need Westport's sign-off.",
    compute: (input) => {
      const pending = spendDefinitionScope(input.bundle, 'SALES_AND_MARKETING_SPEND_ACCOUNTS');
      if (pending) return { value: null, unavailable: pending, citations: [] };
      const scope = hubspotDivisionScope(input);
      if (scope) return { value: null, unavailable: scope, citations: [] };

      const spend = sumSpend(
        input.bundle.salesAndMarketingSpend,
        [input.period.month],
        input.divisions,
      );
      const { start, endExclusive } = monthBounds(input.period.month);
      const newCustomers = input.bundle.contacts.filter(
        (contact) =>
          contact.becameCustomerDate !== null &&
          contact.becameCustomerDate >= start &&
          contact.becameCustomerDate < endExclusive &&
          (input.isConsolidated ||
            (contact.divisionCode !== null && input.divisions.includes(contact.divisionCode))),
      );
      if (newCustomers.length === 0) {
        return unavailable('NO_DATA', 'No new customers were won in this period, so acquisition cost is undefined.');
      }
      return {
        value: safeDiv(spend, newCustomers.length),
        citations: [
          money('Sales & marketing spend', spend, 'QBO', input.period.month),
          { label: 'New customers', value: String(newCustomers.length), source: 'HubSpot' },
        ],
      };
    },
  },
];

// ---------------------------------------------------------------------------
// Operations (2) — Phase 1 limited
// ---------------------------------------------------------------------------

const operationsDefinitions: KpiDefinition[] = [
  {
    id: 'revenue_per_employee',
    name: 'Revenue per Employee',
    category: 'operations',
    definition: 'Monthly revenue divided by headcount.',
    formula: 'Revenue (QBO) ÷ headcount',
    sourceSystem: 'QuickBooks Online + monthly headcount',
    format: 'currency',
    higherIsBetter: true,
    refreshCadence: 'Monthly',
    specReference: '§6 Operations',
    compute: ({ period, bundle, divisions }) => {
      if (!hasPl(bundle, period.month, divisions)) return unavailable('NO_DATA', NO_PL_FOR_PERIOD);
      let headcount = ZERO;
      for (const division of divisions) {
        headcount = headcount.plus(bundle.headcount.get(key(period.month, division)) ?? 0);
      }
      if (headcount.isZero()) {
        return unavailable(
          'NO_DATA',
          'No headcount has been recorded for this period. Import it from Sheets or upload it — the figure is not assumed.',
        );
      }
      const revenue = sumPl(bundle, period.month, divisions).revenue;
      return {
        value: safeDiv(revenue, headcount),
        citations: [
          money('Revenue', revenue, 'QBO', period.month),
          { label: 'Headcount', value: headcount.toString(), source: 'Manual', periodMonth: period.month },
        ],
      };
    },
  },
  {
    id: 'customer_onboarding_time',
    name: 'Customer Onboarding Time',
    category: 'operations',
    definition: 'Days from close to first service date.',
    formula: 'Close date (HubSpot) to first service date (operational system)',
    sourceSystem: 'HubSpot + operational system',
    format: 'days',
    higherIsBetter: false,
    refreshCadence: 'Phase 2',
    specReference: '§6 Operations, §15.1',
    notes:
      '§6: "Defer if the operational system is not available in Phase 1 — do not substitute a proxy." TrackOps, ServeManager, Tazworks and iSolved are assessed but not integrated in this phase, so this metric is deliberately withheld.',
    compute: () =>
      unavailable(
        'DEFERRED_TO_PHASE_2',
        'First service date lives in the operational systems (TrackOps, ServeManager, Tazworks), which are assessed but not integrated in Phase 1. §6 says to defer rather than substitute a proxy, so no estimate is offered.',
      ),
  },
];

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export const KPI_REGISTRY: KpiDefinition[] = [
  ...baseDefinitions,
  ...ratioDefinitions,
  ...financeDefinitions,
  ...additionalRunRates,
  ...changeDefinitions,
  ...contributionDefinitions,
  cashPosition,
  ...salesDefinitions,
  ...marketingDefinitions,
  ...operationsDefinitions,
];

const BY_ID = new Map(KPI_REGISTRY.map((definition) => [definition.id, definition]));

export function getKpiDefinition(id: string): KpiDefinition | undefined {
  return BY_ID.get(id);
}

export function listKpis(category?: KpiDefinition['category']): KpiDefinition[] {
  return category ? KPI_REGISTRY.filter((k) => k.category === category) : KPI_REGISTRY;
}

/**
 * The 24 named in §6, as distinct from the base P&L measures and the two
 * run-rate measures the spec asks us to add.
 */
export const SPEC_KPI_IDS = [
  // Finance (8)
  'dso',
  'dpo',
  'ccc',
  'cash_runway',
  'revenue_run_rate',
  'ytd_gross_margin_pct',
  'ytd_net_margin_pct',
  'budget_attainment',
  // Sales (9)
  'budgeted_sales_vs_actual',
  'meetings_completed',
  'dollars_booked',
  'count_of_bookings',
  'average_booking_value',
  'booking_rate_pct',
  'new_proposals_sent',
  'pipeline_value',
  'average_close_time',
  // Marketing (5)
  'leads_received',
  'cost_per_lead',
  'roas',
  'marketing_efficiency_ratio',
  'customer_acquisition_cost',
  // Operations (2)
  'customer_onboarding_time',
  'revenue_per_employee',
] as const;

export function isSpecKpi(id: string): boolean {
  return (SPEC_KPI_IDS as readonly string[]).includes(id);
}
