import 'server-only';
import Decimal from 'decimal.js';
import { safeDiv } from '@/lib/money';
import { resolveKpi, CONSOLIDATED_CODE, type SemanticSession } from '@/lib/semantic/resolve';
import { sumBs, sumPl, sumPlOverMonths, key } from '@/lib/semantic/facts';
import { formatMonthShort, type MonthKey } from '@/lib/semantic/periods';

/**
 * §9.2 — the Finance dashboard.
 *
 * "This replaces the 'Monthly P&L Roll Up' tab, the heaviest and most-used sheet
 * in the workbook. Match its content exactly, then improve the delivery."
 *
 * Every figure here comes from the semantic layer. The blocks below mirror the
 * Excel's structure so a reviewer can sit the two side by side, which is exactly
 * what the Sprint 4 sign-off gate asks for.
 */

export interface PlRow {
  label: string;
  /** Memo lines are marked so they can be rendered as components, not deductions. */
  isMemo: boolean;
  isSubtotal: boolean;
  higherIsBetter: boolean;
  priorMonth: number | null;
  priorYear: number | null;
  actual: number | null;
  budget: number | null;
  varianceDollars: number | null;
  attainment: number | null;
}

export interface RatioRow {
  label: string;
  value: number | null;
  higherIsBetter: boolean;
  hint?: string;
}

export interface ChangeRow {
  label: string;
  monthOverMonth: number | null;
  yearOverYear: number | null;
  higherIsBetter: boolean;
}

export interface YtdRow {
  label: string;
  higherIsBetter: boolean;
  priorYearYtd: number | null;
  ytdActual: number | null;
  ytdBudget: number | null;
  varianceDollars: number | null;
  attainment: number | null;
  isPercent: boolean;
}

export interface TenXRow {
  label: string;
  monthActual: number | null;
  monthPlan: number | null;
  monthVariance: number | null;
  ytdActual: number | null;
  ytdPlan: number | null;
  ytdVariance: number | null;
  higherIsBetter: boolean;
}

export interface BalanceSheetRow {
  label: string;
  current: number | null;
  priorYearEnd: number | null;
  priorYearSameMonth: number | null;
  percentOfAssets: number | null;
  isSubtotal?: boolean;
}

export interface AgingRow {
  bucket: string;
  label: string;
  ar: number | null;
  ap: number | null;
}

export interface WorkingCapital {
  dso: { value: number | null; unavailable?: string };
  dpo: { value: number | null; unavailable?: string };
  ccc: { value: number | null; unavailable?: string };
  runwaySingleMonth: { value: number | null; unavailable?: string };
  runwayTrailing: { value: number | null; unavailable?: string };
}

export interface FinanceViewModel {
  pl: PlRow[];
  ratios: RatioRow[];
  changes: ChangeRow[];
  ytd: YtdRow[];
  tenX: TenXRow[] | null;
  balanceSheet: BalanceSheetRow[] | null;
  balanceCheck: { difference: number; passes: boolean } | null;
  balanceSheetUnavailable?: string;
  workingCapital: WorkingCapital;
  aging: AgingRow[];
  trend: Array<{ x: string; xLabel: string } & Record<string, number | null | string>>;
  trendSeries: Array<{ id: string; label: string; color: string }>;
}

const num = (result: { value: Decimal | null }): number | null =>
  result.value ? result.value.toNumber() : null;

const dec = (value: Decimal | null | undefined): number | null =>
  value === null || value === undefined ? null : value.toNumber();

export function loadFinance(
  session: SemanticSession,
  divisionCode: string,
  divisionColors: Record<string, string>,
): FinanceViewModel {
  const { period, bundle } = session;
  const isConsolidated = divisionCode === CONSOLIDATED_CODE;
  const divisions = isConsolidated ? session.visibleDivisions : [divisionCode];

  // --- Budget helpers ----------------------------------------------------
  // GP and NP budgets are DERIVED from the three loaded line items (§4.4), never
  // imported, so the identity holds by construction.
  const budgetFor = (
    scenario: string,
    lineItem: 'revenue' | 'cogs' | 'opex',
    scope: 'month' | 'ytd',
  ): number | null => {
    const result = resolveKpi(session, 'budget_attainment', divisionCode, {
      options: { scenario, lineItem, scope },
    });
    return dec(result.components?.budget);
  };

  const budgetBundle = (scenario: string, scope: 'month' | 'ytd') => {
    const revenue = budgetFor(scenario, 'revenue', scope);
    const cogs = budgetFor(scenario, 'cogs', scope);
    const opex = budgetFor(scenario, 'opex', scope);
    const grossProfit = revenue !== null && cogs !== null ? revenue - cogs : null;
    const netProfit = grossProfit !== null && opex !== null ? grossProfit - opex : null;
    return { revenue, cogs, opex, grossProfit, netProfit };
  };

  const monthBudget = budgetBundle('MONTHLY_BUDGET', 'month');
  const ytdBudget = budgetBundle('MONTHLY_BUDGET', 'ytd');

  // --- P&L block ---------------------------------------------------------
  const plSpecs: Array<{
    id: string;
    label: string;
    isMemo: boolean;
    isSubtotal: boolean;
    budget: number | null;
  }> = [
    { id: 'revenue', label: 'Revenue', isMemo: false, isSubtotal: false, budget: monthBudget.revenue },
    // §9.2 lists the memo rows inside the P&L block, immediately above the total
    // they belong to — they are components, shown for visibility, not deductions.
    { id: 'payroll_direct', label: 'Payroll — Direct', isMemo: true, isSubtotal: false, budget: null },
    { id: 'cogs', label: 'COGS', isMemo: false, isSubtotal: false, budget: monthBudget.cogs },
    { id: 'gross_profit', label: 'Gross Profit', isMemo: false, isSubtotal: true, budget: monthBudget.grossProfit },
    { id: 'payroll_expense', label: 'Payroll Expense', isMemo: true, isSubtotal: false, budget: null },
    { id: 'opex', label: 'OpEx', isMemo: false, isSubtotal: false, budget: monthBudget.opex },
    { id: 'net_profit', label: 'Net Profit', isMemo: false, isSubtotal: true, budget: monthBudget.netProfit },
  ];

  const pl: PlRow[] = plSpecs.map((spec) => {
    const actual = resolveKpi(session, spec.id, divisionCode);
    const actualValue = num(actual);
    const variance =
      actualValue !== null && spec.budget !== null ? actualValue - spec.budget : null;

    return {
      label: spec.label,
      isMemo: spec.isMemo,
      isSubtotal: spec.isSubtotal,
      higherIsBetter: actual.higherIsBetter,
      priorMonth: num(resolveKpi(session, spec.id, divisionCode, { month: period.priorMonth })),
      priorYear: num(resolveKpi(session, spec.id, divisionCode, { month: period.priorYearMonth })),
      actual: actualValue,
      budget: spec.budget,
      varianceDollars: variance,
      attainment:
        actualValue !== null && spec.budget !== null && spec.budget !== 0
          ? actualValue / spec.budget
          : null,
    };
  });

  // --- Ratio block -------------------------------------------------------
  const ratios: RatioRow[] = (['cogs_pct', 'gross_profit_pct', 'opex_pct', 'net_profit_pct'] as const).map(
    (id) => {
      const result = resolveKpi(session, id, divisionCode);
      return { label: result.name, value: num(result), higherIsBetter: result.higherIsBetter };
    },
  );

  // §7: contribution is against ARG Total; net profit contribution divides by
  // the ABSOLUTE total so the sign stays readable in a loss month.
  if (!isConsolidated && session.consolidatedAvailable) {
    const divisionRevenue = num(resolveKpi(session, 'revenue', divisionCode));
    const totalRevenue = num(resolveKpi(session, 'revenue', CONSOLIDATED_CODE));
    const divisionNetProfit = num(resolveKpi(session, 'net_profit', divisionCode));
    const totalNetProfit = num(resolveKpi(session, 'net_profit', CONSOLIDATED_CODE));

    ratios.push(
      {
        label: 'Revenue contribution %',
        value:
          divisionRevenue !== null && totalRevenue
            ? safeDiv(divisionRevenue, totalRevenue).toNumber()
            : null,
        higherIsBetter: true,
        hint: 'Division revenue ÷ ARG Total revenue',
      },
      {
        label: 'Net profit contribution %',
        value:
          divisionNetProfit !== null && totalNetProfit
            ? safeDiv(divisionNetProfit, Math.abs(totalNetProfit)).toNumber()
            : null,
        higherIsBetter: true,
        hint: 'Division net profit ÷ |ARG Total net profit| — the absolute denominator keeps the sign readable in a loss month',
      },
    );
  }

  // --- Change block ------------------------------------------------------
  const changes: ChangeRow[] = (['revenue', 'gross_profit', 'net_profit'] as const).map((id) => {
    const current = num(resolveKpi(session, id, divisionCode));
    const pm = num(resolveKpi(session, id, divisionCode, { month: period.priorMonth }));
    const py = num(resolveKpi(session, id, divisionCode, { month: period.priorYearMonth }));
    const definition = resolveKpi(session, id, divisionCode);

    return {
      label: definition.name,
      monthOverMonth: current !== null && pm !== null && pm !== 0 ? (current - pm) / Math.abs(pm) : null,
      yearOverYear: current !== null && py !== null && py !== 0 ? (current - py) / Math.abs(py) : null,
      higherIsBetter: definition.higherIsBetter,
    };
  });

  // --- YTD block ---------------------------------------------------------
  const ytdActuals = sumPlOverMonths(bundle, period.ytdMonths, divisions);
  const priorYearYtd = sumPlOverMonths(bundle, period.priorYearYtdMonths, divisions);

  const ytdGrossProfit = ytdActuals.revenue.minus(ytdActuals.cogs);
  const ytdNetProfit = ytdGrossProfit.minus(ytdActuals.opex);
  const pyGrossProfit = priorYearYtd.revenue.minus(priorYearYtd.cogs);
  const pyNetProfit = pyGrossProfit.minus(priorYearYtd.opex);

  const ytdRow = (
    label: string,
    higherIsBetter: boolean,
    py: Decimal,
    actual: Decimal,
    budget: number | null,
  ): YtdRow => ({
    label,
    higherIsBetter,
    priorYearYtd: py.toNumber(),
    ytdActual: actual.toNumber(),
    ytdBudget: budget,
    varianceDollars: budget !== null ? actual.toNumber() - budget : null,
    attainment: budget !== null && budget !== 0 ? actual.toNumber() / budget : null,
    isPercent: false,
  });

  const ytd: YtdRow[] = [
    ytdRow('Revenue', true, priorYearYtd.revenue, ytdActuals.revenue, ytdBudget.revenue),
    ytdRow('COGS', false, priorYearYtd.cogs, ytdActuals.cogs, ytdBudget.cogs),
    ytdRow('Gross Profit', true, pyGrossProfit, ytdGrossProfit, ytdBudget.grossProfit),
    {
      label: 'Gross Profit %',
      higherIsBetter: true,
      priorYearYtd: safeDiv(pyGrossProfit, priorYearYtd.revenue).toNumber(),
      ytdActual: safeDiv(ytdGrossProfit, ytdActuals.revenue).toNumber(),
      ytdBudget:
        ytdBudget.grossProfit !== null && ytdBudget.revenue
          ? ytdBudget.grossProfit / ytdBudget.revenue
          : null,
      varianceDollars: null,
      attainment: null,
      isPercent: true,
    },
    ytdRow('OpEx', false, priorYearYtd.opex, ytdActuals.opex, ytdBudget.opex),
    ytdRow('Net Profit', true, pyNetProfit, ytdNetProfit, ytdBudget.netProfit),
    {
      label: 'Net Profit %',
      higherIsBetter: true,
      priorYearYtd: safeDiv(pyNetProfit, priorYearYtd.revenue).toNumber(),
      ytdActual: safeDiv(ytdNetProfit, ytdActuals.revenue).toNumber(),
      ytdBudget:
        ytdBudget.netProfit !== null && ytdBudget.revenue
          ? ytdBudget.netProfit / ytdBudget.revenue
          : null,
      varianceDollars: null,
      attainment: null,
      isPercent: true,
    },
  ];

  // --- 10X block ---------------------------------------------------------
  // §9.2: "shown only for 2026–2029; blank outside that range."
  const inTenXRange = period.fiscalYear >= 2026 && period.fiscalYear <= 2029;
  const tenXMonth = inTenXRange ? budgetBundle('TENX', 'month') : null;
  const tenXYtd = inTenXRange ? budgetBundle('TENX', 'ytd') : null;

  const monthActuals = sumPl(bundle, period.month, divisions);
  const monthGrossProfit = monthActuals.revenue.minus(monthActuals.cogs);
  const monthNetProfit = monthGrossProfit.minus(monthActuals.opex);

  const tenX: TenXRow[] | null =
    tenXMonth && tenXYtd
      ? [
          ['Revenue', true, monthActuals.revenue, tenXMonth.revenue, ytdActuals.revenue, tenXYtd.revenue],
          ['COGS', false, monthActuals.cogs, tenXMonth.cogs, ytdActuals.cogs, tenXYtd.cogs],
          ['Gross Profit', true, monthGrossProfit, tenXMonth.grossProfit, ytdGrossProfit, tenXYtd.grossProfit],
          ['OpEx', false, monthActuals.opex, tenXMonth.opex, ytdActuals.opex, tenXYtd.opex],
          ['Net Profit', true, monthNetProfit, tenXMonth.netProfit, ytdNetProfit, tenXYtd.netProfit],
        ].map(([label, higherIsBetter, monthActual, monthPlan, ytdActual, ytdPlan]) => {
          const ma = (monthActual as Decimal).toNumber();
          const ya = (ytdActual as Decimal).toNumber();
          return {
            label: label as string,
            higherIsBetter: higherIsBetter as boolean,
            monthActual: ma,
            monthPlan: monthPlan as number | null,
            monthVariance: monthPlan === null ? null : ma - (monthPlan as number),
            ytdActual: ya,
            ytdPlan: ytdPlan as number | null,
            ytdVariance: ytdPlan === null ? null : ya - (ytdPlan as number),
          };
        })
      : null;

  // --- Balance sheet block -----------------------------------------------
  const classed = bundle.config.get('BALANCE_SHEET_CLASSED')?.value === 'true';
  const balanceSheetAvailable = classed || isConsolidated;

  const priorYearEndMonth: MonthKey = `${period.fiscalYear - 1}-12-01`;
  const currentBs = balanceSheetAvailable ? sumBs(bundle, period.month, divisions) : null;
  const priorYearEndBs = balanceSheetAvailable ? sumBs(bundle, priorYearEndMonth, divisions) : null;
  const priorYearBs = balanceSheetAvailable ? sumBs(bundle, period.priorYearMonth, divisions) : null;

  let balanceSheet: BalanceSheetRow[] | null = null;
  let balanceCheck: { difference: number; passes: boolean } | null = null;

  if (currentBs) {
    const totalAssets = currentBs.cash
      .plus(currentBs.accountsReceivable)
      .plus(currentBs.otherCurrentAssets)
      .plus(currentBs.fixedAssets);

    const line = (
      label: string,
      field: keyof typeof currentBs,
      isSubtotal = false,
    ): BalanceSheetRow => ({
      label,
      current: currentBs[field].toNumber(),
      priorYearEnd: priorYearEndBs ? priorYearEndBs[field].toNumber() : null,
      priorYearSameMonth: priorYearBs ? priorYearBs[field].toNumber() : null,
      percentOfAssets: safeDiv(currentBs[field], totalAssets).toNumber(),
      isSubtotal,
    });

    const totalLiabilities = currentBs.accountsPayable
      .plus(currentBs.ccLiability)
      .plus(currentBs.otherCurrentLiabilities)
      .plus(currentBs.ltLiabilities);

    const sumOf = (bs: typeof currentBs | null, fields: Array<keyof typeof currentBs>) =>
      bs ? fields.reduce((total, field) => total.plus(bs[field]), new Decimal(0)).toNumber() : null;

    const assetFields: Array<keyof typeof currentBs> = [
      'cash',
      'accountsReceivable',
      'otherCurrentAssets',
      'fixedAssets',
    ];
    const liabilityFields: Array<keyof typeof currentBs> = [
      'accountsPayable',
      'ccLiability',
      'otherCurrentLiabilities',
      'ltLiabilities',
    ];

    balanceSheet = [
      line('Cash', 'cash'),
      line('Accounts Receivable', 'accountsReceivable'),
      line('Other Current Assets', 'otherCurrentAssets'),
      line('Fixed Assets', 'fixedAssets'),
      {
        label: 'Total Assets',
        current: totalAssets.toNumber(),
        priorYearEnd: sumOf(priorYearEndBs, assetFields),
        priorYearSameMonth: sumOf(priorYearBs, assetFields),
        percentOfAssets: 1,
        isSubtotal: true,
      },
      line('Accounts Payable', 'accountsPayable'),
      line('Credit Cards', 'ccLiability'),
      line('Other Current Liabilities', 'otherCurrentLiabilities'),
      line('Long-Term Liabilities', 'ltLiabilities'),
      {
        label: 'Total Liabilities',
        current: totalLiabilities.toNumber(),
        priorYearEnd: sumOf(priorYearEndBs, liabilityFields),
        priorYearSameMonth: sumOf(priorYearBs, liabilityFields),
        percentOfAssets: safeDiv(totalLiabilities, totalAssets).toNumber(),
        isSubtotal: true,
      },
      // Defect 3: loaded from QBO as its own figure, never plugged as assets
      // minus liabilities — which is what makes the check below real.
      line('Shareholders’ Equity', 'shareholderEquity', true),
    ];

    const difference = totalAssets.minus(totalLiabilities.plus(currentBs.shareholderEquity));
    balanceCheck = {
      difference: difference.toNumber(),
      passes: difference.abs().lessThanOrEqualTo(1),
    };
  }

  // --- Working capital ---------------------------------------------------
  const wc = (id: string, options?: Record<string, string>) => {
    const result = resolveKpi(session, id, divisionCode, options ? { options } : {});
    return { value: num(result), unavailable: result.unavailable?.detail };
  };

  const workingCapital: WorkingCapital = {
    dso: wc('dso'),
    dpo: wc('dpo'),
    ccc: wc('ccc'),
    runwaySingleMonth: wc('cash_runway'),
    runwayTrailing: wc('cash_runway', { variant: 'trailing_3m' }),
  };

  // --- A/R and A/P aging -------------------------------------------------
  const BUCKETS: Array<[string, string]> = [
    ['current', 'Current'],
    ['1_30', '1–30 days'],
    ['31_60', '31–60 days'],
    ['61_90', '61–90 days'],
    ['over_90', 'Over 90 days'],
  ];

  const aging: AgingRow[] = BUCKETS.map(([bucket, label]) => {
    const total = (kind: 'AR' | 'AP') => {
      let sum = new Decimal(0);
      let found = false;
      for (const division of divisions) {
        const buckets = bundle.agingBuckets.get(`${period.month}|${division}|${kind}`);
        const amount = buckets?.get(bucket);
        if (amount) {
          sum = sum.plus(amount);
          found = true;
        }
      }
      return found ? sum.toNumber() : null;
    };
    return { bucket, label, ar: total('AR'), ap: total('AP') };
  });

  // --- Rolling 15-month trend --------------------------------------------
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

  return {
    pl,
    ratios,
    changes,
    ytd,
    tenX,
    balanceSheet,
    balanceCheck,
    balanceSheetUnavailable: balanceSheetAvailable
      ? undefined
      : 'ARG does not class its balance sheet in QuickBooks, so balance-sheet figures and the working-capital metrics are available at ARG Total only in Phase 1 (Defect 2, open item 1). These are not zero — the underlying data was never captured by division.',
    workingCapital,
    aging,
    trend,
    trendSeries,
  };
}
