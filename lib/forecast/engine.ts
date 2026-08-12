/**
 * §10.1 — how the forecast is built.
 *
 * Five assumptions per division go in; a projected P&L comes out. Same input
 * pattern as the Excel, because ARG's team already knows it.
 *
 * ARG Total is always the sum of the four divisions, never an independently
 * entered figure — the same rule that governs actuals.
 */
import Decimal from 'decimal.js';
import { d } from '@/lib/money';

export interface ForecastAssumptions {
  /** Forecast revenue = budgeted revenue for that division/month × this %. */
  revenuePctOfBudget: number;
  /** Memo line = forecast revenue × this %. */
  payrollDirectPct: number;
  /** Forecast COGS = forecast revenue × this %. */
  cogsPct: number;
  /** Memo line, entered flat. */
  payrollExpenseAmt: number;
  /** Forecast OpEx, entered flat. */
  opexAmt: number;
}

export interface ForecastProjection {
  revenue: Decimal;
  /** MEMO — already inside cogs, never subtracted separately. */
  payrollDirect: Decimal;
  cogs: Decimal;
  grossProfit: Decimal;
  /** MEMO — already inside opex. */
  payrollExpense: Decimal;
  opex: Decimal;
  netProfit: Decimal;
}

export const DEFAULT_ASSUMPTIONS: ForecastAssumptions = {
  revenuePctOfBudget: 1,
  payrollDirectPct: 0,
  cogsPct: 0,
  payrollExpenseAmt: 0,
  opexAmt: 0,
};

/**
 * Projects one division's P&L.
 *
 * The memo lines are derived alongside the totals they belong to, exactly as in
 * actuals: gross profit is revenue less COGS with payroll-direct untouched, and
 * net profit is gross profit less OpEx with payroll-expense untouched.
 */
export function project(
  budgetedRevenue: string | number | Decimal,
  assumptions: ForecastAssumptions,
): ForecastProjection {
  const revenue = d(budgetedRevenue).times(assumptions.revenuePctOfBudget);
  const cogs = revenue.times(assumptions.cogsPct);
  const payrollDirect = revenue.times(assumptions.payrollDirectPct);
  const opex = d(assumptions.opexAmt);
  const payrollExpense = d(assumptions.payrollExpenseAmt);

  const grossProfit = revenue.minus(cogs);

  return {
    revenue,
    payrollDirect,
    cogs,
    grossProfit,
    payrollExpense,
    opex,
    netProfit: grossProfit.minus(opex),
  };
}

/** ARG Total — the sum of the four divisions, never entered directly. */
export function consolidate(projections: ForecastProjection[]): ForecastProjection {
  const zero = new Decimal(0);
  return projections.reduce<ForecastProjection>(
    (total, projection) => ({
      revenue: total.revenue.plus(projection.revenue),
      payrollDirect: total.payrollDirect.plus(projection.payrollDirect),
      cogs: total.cogs.plus(projection.cogs),
      grossProfit: total.grossProfit.plus(projection.grossProfit),
      payrollExpense: total.payrollExpense.plus(projection.payrollExpense),
      opex: total.opex.plus(projection.opex),
      netProfit: total.netProfit.plus(projection.netProfit),
    }),
    {
      revenue: zero,
      payrollDirect: zero,
      cogs: zero,
      grossProfit: zero,
      payrollExpense: zero,
      opex: zero,
      netProfit: zero,
    },
  );
}

/**
 * Suggests a starting assumption set from budget, prior year and trailing
 * actuals.
 *
 * The judgement stays with the user — but they adjust a sensible starting point
 * rather than filling an empty form, which is the difference between a tool that
 * is pleasant to use and one that is a chore.
 */
export function suggestAssumptions(input: {
  budgetedRevenue: Decimal;
  trailingRevenue: Decimal;
  trailingCogs: Decimal;
  trailingPayrollDirect: Decimal;
  trailingOpex: Decimal;
  trailingPayrollExpense: Decimal;
  monthsInTrailing: number;
}): ForecastAssumptions {
  const months = Math.max(input.monthsInTrailing, 1);
  const avgRevenue = input.trailingRevenue.div(months);
  const avgCogs = input.trailingCogs.div(months);
  const avgPayrollDirect = input.trailingPayrollDirect.div(months);

  return {
    revenuePctOfBudget: input.budgetedRevenue.isZero()
      ? 1
      : Number(avgRevenue.div(input.budgetedRevenue).toDecimalPlaces(4)),
    cogsPct: avgRevenue.isZero() ? 0 : Number(avgCogs.div(avgRevenue).toDecimalPlaces(4)),
    payrollDirectPct: avgRevenue.isZero()
      ? 0
      : Number(avgPayrollDirect.div(avgRevenue).toDecimalPlaces(4)),
    opexAmt: Number(input.trailingOpex.div(months).toDecimalPlaces(2)),
    payrollExpenseAmt: Number(input.trailingPayrollExpense.div(months).toDecimalPlaces(2)),
  };
}

export interface VarianceRow {
  label: string;
  forecast: number | null;
  actual: number | null;
  varianceDollars: number | null;
  variancePct: number | null;
  higherIsBetter: boolean;
}

/**
 * §10.4 — scores a locked forecast against actuals.
 *
 * "Where a forecast was never locked, show the row as 'not logged' — never as
 * zero variance." A null forecast here becomes exactly that upstream; it never
 * becomes a zero.
 */
export function scoreForecast(
  forecast: ForecastProjection | null,
  actual: { revenue: Decimal; cogs: Decimal; opex: Decimal } | null,
): VarianceRow[] {
  const actualGrossProfit = actual ? actual.revenue.minus(actual.cogs) : null;
  const actualNetProfit = actualGrossProfit && actual ? actualGrossProfit.minus(actual.opex) : null;

  const rows: Array<[string, Decimal | null, Decimal | null, boolean]> = [
    ['Revenue', forecast?.revenue ?? null, actual?.revenue ?? null, true],
    ['COGS', forecast?.cogs ?? null, actual?.cogs ?? null, false],
    ['Gross Profit', forecast?.grossProfit ?? null, actualGrossProfit, true],
    ['OpEx', forecast?.opex ?? null, actual?.opex ?? null, false],
    ['Net Profit', forecast?.netProfit ?? null, actualNetProfit, true],
  ];

  return rows.map(([label, forecastValue, actualValue, higherIsBetter]) => {
    const variance =
      forecastValue !== null && actualValue !== null ? actualValue.minus(forecastValue) : null;
    return {
      label,
      forecast: forecastValue?.toNumber() ?? null,
      actual: actualValue?.toNumber() ?? null,
      varianceDollars: variance?.toNumber() ?? null,
      variancePct:
        variance !== null && forecastValue !== null && !forecastValue.isZero()
          ? variance.div(forecastValue.abs()).toNumber()
          : null,
      higherIsBetter,
    };
  });
}

/**
 * Forecast accuracy: how close the forecast was, as a percentage. 100% is a
 * perfect call. Used for the accuracy trend, which is what tells ARG whether its
 * forecasting is improving.
 */
export function accuracyOf(forecast: number | null, actual: number | null): number | null {
  if (forecast === null || actual === null || forecast === 0) return null;
  return 1 - Math.abs(actual - forecast) / Math.abs(forecast);
}
