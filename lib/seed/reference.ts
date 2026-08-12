/**
 * Spec §13.1 — the tie-out reference figures.
 *
 * "From the live Excel model, March 2026 (the most recent closed month in the
 * file). Your system must reproduce these exactly. If it does not, stop and
 * reconcile before building anything else on top."
 *
 * These constants are the contract. `lib/seed/generate.ts` builds a dataset that
 * satisfies them, and `tests/tieout.spec.ts` asserts the semantic layer
 * reproduces them. When live QBO data replaces the seed, the same assertions run
 * unchanged against the real numbers.
 *
 * Note on the source table's internal rounding: §13.1 says "Figures are rounded
 * to the dollar from unrounded source data; a column of components may differ
 * from its total by $1." That is visible here — e.g. Claims revenue minus COGS
 * is 36,024 while the published Gross Profit reads 36,025. Every assertion
 * therefore carries the spec's own $1 tolerance rather than demanding exact
 * equality on derived columns.
 */

export const TIE_OUT_MONTH = '2026-03-01';

export interface DivisionFigures {
  revenue: number;
  cogs: number;
  grossProfit: number;
  opex: number;
  netProfit: number;
}

/** March 2026, per division and at ARG Total. */
export const MARCH_2026: Record<string, DivisionFigures> = {
  SHRC: { revenue: 195_519, cogs: 124_068, grossProfit: 71_451, opex: 45_252, netProfit: 26_198 },
  CLAIMS: { revenue: 102_963, cogs: 66_939, grossProfit: 36_025, opex: 61_741, netProfit: -25_717 },
  TP: { revenue: 42_999, cogs: 28_807, grossProfit: 14_192, opex: 18_764, netProfit: -4_572 },
  LITS: { revenue: 203_363, cogs: 79_444, grossProfit: 123_918, opex: 27_133, netProfit: 96_786 },
  ARG_TOTAL: {
    revenue: 544_844,
    cogs: 299_258,
    grossProfit: 245_586,
    opex: 152_890,
    netProfit: 92_696,
  },
};

export interface YtdFigures {
  revenue: number;
  grossProfit: number;
  netProfit: number;
  revenueRunRate: number;
}

/** YTD 2026 through March — the run-rate checks. */
export const YTD_MARCH_2026: Record<string, YtdFigures> = {
  SHRC: { revenue: 591_421, grossProfit: 238_456, netProfit: 80_750, revenueRunRate: 2_365_685 },
  CLAIMS: { revenue: 335_254, grossProfit: 113_256, netProfit: -62_114, revenueRunRate: 1_341_016 },
  TP: { revenue: 136_472, grossProfit: 52_747, netProfit: 40, revenueRunRate: 545_889 },
  LITS: { revenue: 347_087, grossProfit: 133_030, netProfit: 43_521, revenueRunRate: 1_388_349 },
  ARG_TOTAL: {
    revenue: 1_410_235,
    grossProfit: 537_490,
    netProfit: 62_197,
    revenueRunRate: 5_640_939,
  },
};

/**
 * The two errors §13 tells us to guard against by name. Both are asserted as
 * NOT equal in the tie-out suite, because a passing total can hide a wrong
 * method.
 */
export const KNOWN_WRONG_ANSWERS = {
  /**
   * §13.1: "If your gross profit for SHRC comes out near $38,407 instead of
   * $71,451, you have subtracted the payroll memo column."
   */
  shrcGrossProfitIfPayrollMemoSubtracted: 38_407,
  /**
   * §13.1: "Verify your implementation reproduces the ARG Total figure of
   * roughly $5.64 million and not $6,538,128 — the latter is March alone
   * annualized, which is the wrong method."
   */
  argTotalRunRateIfSingleMonthAnnualised: 6_538_128,
} as const;

/**
 * Defect 6 quotes ARG Total OpEx for the first three months of 2026:
 * "$177K in January 2026, $145K in February and $153K in March."
 *
 * This is a genuine cross-check on the seed rather than a restatement of it:
 * YTD gross profit (537,490) minus YTD net profit (62,197) gives YTD OpEx of
 * 475,293, and 177K + 145K + 153K foots to the same figure. The two tables were
 * produced independently in the spec and agree, so the January and February
 * splits are constrained, not invented.
 */
export const ARG_TOTAL_OPEX_2026 = {
  '2026-01-01': 177_000,
  '2026-02-01': 145_000,
  '2026-03-01': 152_890,
} as const;

/** §3 — the division model. ARG Total is a rollup and is deliberately absent. */
export const DIVISION_CODES = ['SHRC', 'CLAIMS', 'TP', 'LITS'] as const;
export type DivisionCode = (typeof DIVISION_CODES)[number];

export const CONSOLIDATED_CODE = 'ARG_TOTAL';
