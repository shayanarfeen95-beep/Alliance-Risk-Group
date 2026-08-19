/**
 * Deterministic dataset generator.
 *
 * The 2026 figures are not invented — they are *derived* from the two tie-out
 * tables in spec §13.1, so the seeded warehouse reproduces the published numbers
 * by construction:
 *
 *   - March 2026 revenue / COGS / OpEx come straight from the monthly table.
 *   - January + February 2026 = the YTD table minus March. That is a hard
 *     constraint, not a choice.
 *   - The January/February split is pinned by Defect 6, which quotes ARG Total
 *     OpEx of $177K, $145K and $153K. Those three foot to YTD gross profit minus
 *     YTD net profit ($537,490 − $62,197 = $475,293), so the two spec tables
 *     agree and the split is constrained from both directions.
 *   - 2023–2025 history is generated to total roughly $17.5M, which is the
 *     company revenue Defect 8 states while calling out the pivot caches that
 *     double it.
 *
 * Everything is a pure function of a fixed seed, so the same dataset comes back
 * on every run and the tie-out suite is reproducible.
 */
import Decimal from 'decimal.js';
import { DIVISION_CODES, MARCH_2026, YTD_MARCH_2026, type DivisionCode } from './reference';
import {
  COGS_ACCOUNTS,
  OPEX_ACCOUNTS,
  REVENUE_ACCOUNTS,
  type AccountSeed,
} from './accounts';

// ---------------------------------------------------------------------------
// Deterministic pseudo-randomness
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 20260331;

// ---------------------------------------------------------------------------
// Calendar helpers
// ---------------------------------------------------------------------------

export function monthKey(year: number, month1: number): string {
  return `${year}-${String(month1).padStart(2, '0')}-01`;
}

export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/**
 * §13.1 calls March 2026 "the most recent closed month in the file", and §12
 * Sprint 2 asks for the 39 months of P&L history from January 2023.
 */
export const LAST_CLOSED_MONTH = '2026-03-01';

/**
 * One month beyond the closed history, carried as an OPEN period.
 *
 * §5.3 requires the open month to refresh nightly and to be "labeled clearly as
 * an open, unclosed period on the face of every view", and §11 requires the
 * agent to mark answers about it as preliminary. Without an open month in the
 * data none of that is demonstrable or testable. It is excluded from every
 * tie-out assertion, which targets the closed month.
 */
export const OPEN_MONTH = '2026-04-01';

/** Jan 2023 → Mar 2026 inclusive. 39 months, as §12 Sprint 2 specifies. */
export function allMonths(): Array<{ key: string; year: number; month: number }> {
  const months: Array<{ key: string; year: number; month: number }> = [];
  for (let year = 2023; year <= 2026; year++) {
    const lastMonth = year === 2026 ? 3 : 12;
    for (let month = 1; month <= lastMonth; month++) {
      months.push({ key: monthKey(year, month), year, month });
    }
  }
  return months;
}

/** Closed history plus the open month. */
export function allMonthsIncludingOpen(): Array<{ key: string; year: number; month: number }> {
  return [...allMonths(), { key: OPEN_MONTH, year: 2026, month: 4 }];
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlRow {
  periodMonth: string;
  divisionCode: DivisionCode;
  revenue: Decimal;
  payrollDirect: Decimal;
  cogs: Decimal;
  payrollExpense: Decimal;
  opex: Decimal;
}

export interface GlRowSeed {
  periodMonth: string;
  divisionCode: DivisionCode;
  accountId: string;
  amount: Decimal;
}

export interface BsRow {
  periodMonth: string;
  divisionCode: DivisionCode;
  cash: Decimal;
  accountsReceivable: Decimal;
  otherCurrentAssets: Decimal;
  fixedAssets: Decimal;
  accountsPayable: Decimal;
  ccLiability: Decimal;
  otherCurrentLiabilities: Decimal;
  ltLiabilities: Decimal;
  shareholderEquity: Decimal;
}

export interface AgingRow {
  periodMonth: string;
  divisionCode: DivisionCode;
  kind: 'AR' | 'AP';
  bucket: string;
  amount: Decimal;
}

export interface BudgetRow {
  scenarioCode: string;
  periodMonth: string;
  divisionCode: DivisionCode;
  lineItem: 'revenue' | 'cogs' | 'opex';
  amount: Decimal;
}

export interface DealRow {
  dealId: string;
  divisionCode: DivisionCode;
  dealName: string;
  amount: Decimal;
  dealstage: string;
  pipeline: string;
  isClosedWon: boolean;
  isClosed: boolean;
  createdate: Date;
  closedate: Date | null;
  enteredProposalAt: Date | null;
  ownerId: string;
  ownerName: string;
  contactId: string;
}

export interface StageHistoryRow {
  dealId: string;
  stage: string;
  enteredAt: Date;
}

export interface ContactRow {
  contactId: string;
  divisionCode: DivisionCode;
  lifecycleStage: string;
  originalSource: string;
  createdate: Date;
  becameLeadDate: Date | null;
  becameCustomerDate: Date | null;
}

export interface MeetingRow {
  meetingId: string;
  divisionCode: DivisionCode;
  meetingDate: Date;
  outcome: string;
  ownerId: string;
  associatedDealId: string | null;
}

export interface HeadcountRow {
  periodMonth: string;
  divisionCode: DivisionCode;
  headcount: Decimal;
}

export interface SeedDataset {
  pl: PlRow[];
  gl: GlRowSeed[];
  bs: BsRow[];
  aging: AgingRow[];
  budget: BudgetRow[];
  deals: DealRow[];
  stageHistory: StageHistoryRow[];
  contacts: ContactRow[];
  meetings: MeetingRow[];
  headcount: HeadcountRow[];
}

// ---------------------------------------------------------------------------
// Division shape parameters (history only — 2026 is constrained by the spec)
// ---------------------------------------------------------------------------

interface DivisionProfile {
  /** Share of ARG Total revenue. */
  revenueShare: number;
  /** COGS as a share of revenue. */
  cogsRatio: number;
  /** Payroll-direct as a share of COGS (memo line). */
  payrollDirectOfCogs: number;
  /** OpEx as a share of revenue. */
  opexRatio: number;
  /** Payroll-expense as a share of OpEx (memo line). */
  payrollExpenseOfOpex: number;
  /** Monthly seasonality, index 0 = January. */
  seasonality: number[];
  dsoTarget: number;
  dpoTarget: number;
  runwayMonths: number;
  headcountBase: number;
}

const PROFILES: Record<DivisionCode, DivisionProfile> = {
  SHRC: {
    revenueShare: 0.4,
    cogsRatio: 0.635,
    payrollDirectOfCogs: 0.58,
    opexRatio: 0.232,
    payrollExpenseOfOpex: 0.62,
    seasonality: [0.94, 0.96, 1.05, 1.03, 1.02, 0.99, 0.97, 1.01, 1.06, 1.05, 0.98, 0.94],
    dsoTarget: 48,
    dpoTarget: 34,
    runwayMonths: 4.2,
    headcountBase: 38,
  },
  CLAIMS: {
    revenueShare: 0.23,
    cogsRatio: 0.65,
    payrollDirectOfCogs: 0.64,
    opexRatio: 0.44,
    payrollExpenseOfOpex: 0.58,
    seasonality: [1.02, 1.0, 1.04, 1.01, 0.98, 0.96, 0.95, 0.98, 1.02, 1.04, 1.01, 0.99],
    dsoTarget: 62,
    dpoTarget: 40,
    runwayMonths: 2.1,
    headcountBase: 22,
  },
  TP: {
    revenueShare: 0.1,
    cogsRatio: 0.67,
    payrollDirectOfCogs: 0.49,
    opexRatio: 0.4,
    payrollExpenseOfOpex: 0.55,
    seasonality: [0.97, 0.99, 1.06, 1.04, 1.01, 0.98, 0.96, 0.99, 1.03, 1.04, 0.98, 0.95],
    dsoTarget: 41,
    dpoTarget: 30,
    runwayMonths: 3.0,
    headcountBase: 11,
  },
  LITS: {
    revenueShare: 0.27,
    // Litigation support is lumpy — March 2026 runs a 61% gross margin against
    // roughly 6% in January and February. History carries that volatility.
    cogsRatio: 0.58,
    payrollDirectOfCogs: 0.52,
    opexRatio: 0.19,
    payrollExpenseOfOpex: 0.6,
    seasonality: [0.9, 0.93, 1.12, 1.08, 1.03, 0.97, 0.93, 0.98, 1.07, 1.09, 1.0, 0.9],
    dsoTarget: 55,
    dpoTarget: 28,
    runwayMonths: 5.5,
    headcountBase: 17,
  },
};

/** Defect 8: "actual company revenue of about $17.5 million" through Dec 2025. */
const ANNUAL_TOTAL_REVENUE: Record<number, number> = {
  2023: 5_550_000,
  2024: 5_850_000,
  2025: 6_100_000,
};

// ---------------------------------------------------------------------------
// 2026 — derived from the spec, not invented
// ---------------------------------------------------------------------------

/**
 * Splits January and February so the two months foot exactly to (YTD − March)
 * and ARG Total OpEx lands on Defect 6's stated $177K / $145K.
 *
 * February is computed as the remainder rather than by its own fraction, so the
 * pair sums exactly with no rounding drift.
 */
const JAN_SHARE = {
  revenue: { SHRC: 0.49, CLAIMS: 0.52, TP: 0.47, LITS: 0.44 },
  cogs: { SHRC: 0.5, CLAIMS: 0.53, TP: 0.48, LITS: 0.45 },
  opex: { SHRC: 0.54, CLAIMS: 0.57, TP: 0.52, LITS: 0.55 },
} as const;

function build2026(): PlRow[] {
  const rows: PlRow[] = [];

  for (const division of DIVISION_CODES) {
    const march = MARCH_2026[division]!;
    const ytd = YTD_MARCH_2026[division]!;
    const profile = PROFILES[division];

    // March: revenue, COGS and OpEx are the published figures. Gross profit and
    // net profit are DERIVED, never loaded — so the identity always holds.
    const marchRevenue = new Decimal(march.revenue);
    const marchCogs = new Decimal(march.cogs);
    const marchOpex = new Decimal(march.opex);
    const marchGp = marchRevenue.minus(marchCogs);
    const marchNp = marchGp.minus(marchOpex);

    // January + February, forced by the YTD table.
    const jfRevenue = new Decimal(ytd.revenue).minus(marchRevenue);
    const jfGp = new Decimal(ytd.grossProfit).minus(marchGp);
    const jfCogs = jfRevenue.minus(jfGp);
    const jfNp = new Decimal(ytd.netProfit).minus(marchNp);
    const jfOpex = jfGp.minus(jfNp);

    const janRevenue = jfRevenue.times(JAN_SHARE.revenue[division]).toDecimalPlaces(2);
    const janCogs = jfCogs.times(JAN_SHARE.cogs[division]).toDecimalPlaces(2);
    const janOpex = jfOpex.times(JAN_SHARE.opex[division]).toDecimalPlaces(2);

    const months: Array<[string, Decimal, Decimal, Decimal]> = [
      ['2026-01-01', janRevenue, janCogs, janOpex],
      ['2026-02-01', jfRevenue.minus(janRevenue), jfCogs.minus(janCogs), jfOpex.minus(janOpex)],
      ['2026-03-01', marchRevenue, marchCogs, marchOpex],
    ];

    for (const [periodMonth, revenue, cogs, opex] of months) {
      rows.push({
        periodMonth,
        divisionCode: division,
        revenue,
        // Memo lines sit inside their totals; they are a share of them.
        payrollDirect: cogs.times(profile.payrollDirectOfCogs).toDecimalPlaces(2),
        cogs,
        payrollExpense: opex.times(profile.payrollExpenseOfOpex).toDecimalPlaces(2),
        opex,
      });
    }

    // The open month, carried at the Q1 average shaped by April seasonality.
    // Books are not closed, so these figures are explicitly preliminary.
    const q1Revenue = new Decimal(ytd.revenue).div(3);
    const aprilSeasonal = profile.seasonality[3]!;
    const openRevenue = q1Revenue.times(aprilSeasonal).toDecimalPlaces(2);
    const openCogs = openRevenue.times(profile.cogsRatio).toDecimalPlaces(2);
    const openOpex = openRevenue.times(profile.opexRatio).toDecimalPlaces(2);

    rows.push({
      periodMonth: OPEN_MONTH,
      divisionCode: division,
      revenue: openRevenue,
      payrollDirect: openCogs.times(profile.payrollDirectOfCogs).toDecimalPlaces(2),
      cogs: openCogs,
      payrollExpense: openOpex.times(profile.payrollExpenseOfOpex).toDecimalPlaces(2),
      opex: openOpex,
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// 2023–2025 history
// ---------------------------------------------------------------------------

function buildHistory(rand: () => number): PlRow[] {
  const rows: PlRow[] = [];

  for (const year of [2023, 2024, 2025]) {
    const annual = ANNUAL_TOTAL_REVENUE[year]!;

    for (let month = 1; month <= 12; month++) {
      for (const division of DIVISION_CODES) {
        const profile = PROFILES[division];
        const seasonal = profile.seasonality[month - 1]!;
        const noise = 0.93 + rand() * 0.14;

        const revenue = new Decimal(annual)
          .times(profile.revenueShare)
          .div(12)
          .times(seasonal)
          .times(noise)
          .toDecimalPlaces(2);

        const cogsRatio = profile.cogsRatio * (0.95 + rand() * 0.1);
        const opexRatio = profile.opexRatio * (0.92 + rand() * 0.16);

        const cogs = revenue.times(cogsRatio).toDecimalPlaces(2);
        const opex = revenue.times(opexRatio).toDecimalPlaces(2);

        rows.push({
          periodMonth: monthKey(year, month),
          divisionCode: division,
          revenue,
          payrollDirect: cogs.times(profile.payrollDirectOfCogs).toDecimalPlaces(2),
          cogs,
          payrollExpense: opex.times(profile.payrollExpenseOfOpex).toDecimalPlaces(2),
          opex,
        });
      }
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// GL allocation — account-level detail that foots exactly to the five lines
// ---------------------------------------------------------------------------

/**
 * Splits a reporting-line total across its accounts by weight, then assigns the
 * rounding remainder to the largest account so the accounts sum to the line
 * exactly. Nothing here may drift: the Finance dashboard drills from a P&L cell
 * into these rows, and the two must agree to the cent.
 */
function allocate(total: Decimal, accounts: AccountSeed[], rand: () => number): Map<string, Decimal> {
  const weights = accounts.map((a) => (a.weight ?? 1) * (0.9 + rand() * 0.2));
  const weightSum = weights.reduce((s, w) => s + w, 0);

  const result = new Map<string, Decimal>();
  let running = new Decimal(0);

  accounts.forEach((account, index) => {
    if (index === accounts.length - 1) return;
    const amount = total.times(weights[index]! / weightSum).toDecimalPlaces(2);
    result.set(account.accountId, amount);
    running = running.plus(amount);
  });

  const last = accounts[accounts.length - 1]!;
  result.set(last.accountId, total.minus(running));
  return result;
}

function buildGl(pl: PlRow[], rand: () => number): GlRowSeed[] {
  const rows: GlRowSeed[] = [];

  for (const row of pl) {
    const revenueParts = allocate(row.revenue, REVENUE_ACCOUNTS, rand);

    // COGS: the payroll-direct account carries the memo figure, and the
    // remaining COGS accounts split what is left. Together they equal `cogs` —
    // which is what makes "inclusive of payroll_direct" structural.
    const cogsExPayroll = row.cogs.minus(row.payrollDirect);
    const cogsParts = allocate(cogsExPayroll, COGS_ACCOUNTS.slice(1), rand);
    cogsParts.set('5000', row.payrollDirect);

    // OpEx: same shape. Accounts 6000 and 6010 together are the payroll memo.
    const payrollSplit = row.payrollExpense.times(0.78).toDecimalPlaces(2);
    const opexExPayroll = row.opex.minus(row.payrollExpense);
    const opexParts = allocate(opexExPayroll, OPEX_ACCOUNTS.slice(2), rand);
    opexParts.set('6000', payrollSplit);
    opexParts.set('6010', row.payrollExpense.minus(payrollSplit));

    for (const parts of [revenueParts, cogsParts, opexParts]) {
      for (const [accountId, amount] of parts) {
        rows.push({
          periodMonth: row.periodMonth,
          divisionCode: row.divisionCode,
          accountId,
          amount,
        });
      }
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Balance sheet
// ---------------------------------------------------------------------------

/**
 * §12 Sprint 2: "Balance-sheet history comes from QBO, not the workbook: the
 * workbook holds only 15 months and only at ARG Total."
 *
 * The seed stands in for a classed QBO balance sheet, so it carries division
 * detail across the same 15 months (Jan 2025 – Mar 2026). Whether ARG really
 * classes its balance sheet is open item #1; the BALANCE_SHEET_CLASSED flag
 * drives the Defect 2 degradation path independently of what is stored here.
 *
 * Equity is generated as the balancing figure — that is what QBO's equity
 * actually is — but it is then *stored as its own loaded column*. The
 * application never recomputes it (Defect 3), so the balance check remains a
 * real assertion about stored data rather than a tautology.
 */
function buildBalanceSheet(pl: PlRow[], rand: () => number): BsRow[] {
  const rows: BsRow[] = [];
  const byKey = new Map(pl.map((r) => [`${r.periodMonth}|${r.divisionCode}`, r]));

  const months = allMonthsIncludingOpen().filter((m) => m.year >= 2025);

  for (const { key, year, month } of months) {
    const days = daysInMonth(year, month);

    for (const division of DIVISION_CODES) {
      const plRow = byKey.get(`${key}|${division}`);
      if (!plRow) continue;
      const profile = PROFILES[division];

      const dso = profile.dsoTarget * (0.9 + rand() * 0.2);
      const dpo = profile.dpoTarget * (0.9 + rand() * 0.2);

      const accountsReceivable = plRow.revenue.times(dso / days).toDecimalPlaces(2);
      const accountsPayable = plRow.cogs.times(dpo / days).toDecimalPlaces(2);
      const cash = plRow.opex
        .times(profile.runwayMonths * (0.9 + rand() * 0.2))
        .toDecimalPlaces(2);
      const otherCurrentAssets = plRow.opex.times(0.22 + rand() * 0.08).toDecimalPlaces(2);
      const fixedAssets = plRow.revenue.times(0.35 + rand() * 0.1).toDecimalPlaces(2);

      const ccLiability = plRow.opex.times(0.18 + rand() * 0.06).toDecimalPlaces(2);
      const otherCurrentLiabilities = plRow.opex.times(0.3 + rand() * 0.1).toDecimalPlaces(2);
      const ltLiabilities = plRow.revenue.times(0.28 + rand() * 0.08).toDecimalPlaces(2);

      const assets = cash.plus(accountsReceivable).plus(otherCurrentAssets).plus(fixedAssets);
      const liabilities = accountsPayable
        .plus(ccLiability)
        .plus(otherCurrentLiabilities)
        .plus(ltLiabilities);

      rows.push({
        periodMonth: key,
        divisionCode: division,
        cash,
        accountsReceivable,
        otherCurrentAssets,
        fixedAssets,
        accountsPayable,
        ccLiability,
        otherCurrentLiabilities,
        ltLiabilities,
        shareholderEquity: assets.minus(liabilities),
      });
    }
  }

  return rows;
}

const AR_BUCKET_WEIGHTS: Array<[string, number]> = [
  ['current', 0.62],
  ['1_30', 0.22],
  ['31_60', 0.09],
  ['61_90', 0.04],
  ['over_90', 0.03],
];

const AP_BUCKET_WEIGHTS: Array<[string, number]> = [
  ['current', 0.71],
  ['1_30', 0.19],
  ['31_60', 0.06],
  ['61_90', 0.03],
  ['over_90', 0.01],
];

/** Buckets foot exactly to the balance — Acceptance Test 4 checks this. */
function buildAging(bs: BsRow[], rand: () => number): AgingRow[] {
  const rows: AgingRow[] = [];

  for (const row of bs) {
    for (const [kind, total, weights] of [
      ['AR', row.accountsReceivable, AR_BUCKET_WEIGHTS],
      ['AP', row.accountsPayable, AP_BUCKET_WEIGHTS],
    ] as const) {
      const jittered = weights.map(([bucket, w]) => [bucket, w * (0.9 + rand() * 0.2)] as const);
      const weightSum = jittered.reduce((s, [, w]) => s + w, 0);

      let running = new Decimal(0);
      jittered.forEach(([bucket, weight], index) => {
        const amount =
          index === jittered.length - 1
            ? total.minus(running)
            : total.times(weight / weightSum).toDecimalPlaces(2);
        running = running.plus(amount);
        rows.push({ periodMonth: row.periodMonth, divisionCode: row.divisionCode, kind, bucket, amount });
      });
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

/**
 * §4.4: two scenarios load today — the FY2026 operating budget and the 10X
 * growth plan (2026–2029, straight-line annual ÷ 12). GP and NP are derived,
 * never loaded, so the identity always holds.
 */
function buildBudget(pl: PlRow[], rand: () => number): BudgetRow[] {
  const rows: BudgetRow[] = [];
  // Q1 actuals only — the open month is not a basis for a budget.
  const actual2026 = pl.filter((r) => r.periodMonth.startsWith('2026') && r.periodMonth <= LAST_CLOSED_MONTH);
  const byDivision = new Map<DivisionCode, PlRow[]>();
  for (const row of actual2026) {
    const list = byDivision.get(row.divisionCode) ?? [];
    list.push(row);
    byDivision.set(row.divisionCode, list);
  }

  // Monthly operating budget: Q1 is anchored near actuals so attainment reads
  // realistically; Q2–Q4 grow modestly.
  for (const division of DIVISION_CODES) {
    const q1 = byDivision.get(division) ?? [];
    const q1Revenue = q1.reduce((s, r) => s.plus(r.revenue), new Decimal(0)).div(Math.max(q1.length, 1));
    const q1Cogs = q1.reduce((s, r) => s.plus(r.cogs), new Decimal(0)).div(Math.max(q1.length, 1));
    const q1Opex = q1.reduce((s, r) => s.plus(r.opex), new Decimal(0)).div(Math.max(q1.length, 1));

    for (let month = 1; month <= 12; month++) {
      const seasonal = PROFILES[division].seasonality[month - 1]!;
      const growth = 1 + (month - 1) * 0.012;
      const attainmentGap = 0.97 + rand() * 0.12;

      rows.push(
        {
          scenarioCode: 'MONTHLY_BUDGET',
          periodMonth: monthKey(2026, month),
          divisionCode: division,
          lineItem: 'revenue',
          amount: q1Revenue.times(seasonal).times(growth).div(attainmentGap).toDecimalPlaces(2),
        },
        {
          scenarioCode: 'MONTHLY_BUDGET',
          periodMonth: monthKey(2026, month),
          divisionCode: division,
          lineItem: 'cogs',
          amount: q1Cogs.times(seasonal).times(growth).times(0.98).toDecimalPlaces(2),
        },
        {
          scenarioCode: 'MONTHLY_BUDGET',
          periodMonth: monthKey(2026, month),
          divisionCode: division,
          lineItem: 'opex',
          amount: q1Opex.times(growth).times(0.99).toDecimalPlaces(2),
        },
      );
    }
  }

  // 10X plan — annual targets divided straight-line by 12, 2026 through 2029.
  const TENX_ANNUAL_REVENUE: Record<number, number> = {
    2026: 7_500_000,
    2027: 15_000_000,
    2028: 30_000_000,
    2029: 56_000_000,
  };

  for (const [yearText, annualRevenue] of Object.entries(TENX_ANNUAL_REVENUE)) {
    const year = Number(yearText);
    for (const division of DIVISION_CODES) {
      const profile = PROFILES[division];
      const divisionRevenue = new Decimal(annualRevenue).times(profile.revenueShare).div(12);
      // The 10X plan assumes margin improves with scale.
      const scaleFactor = 1 - Math.min(0.12, (year - 2026) * 0.04);

      for (let month = 1; month <= 12; month++) {
        rows.push(
          {
            scenarioCode: 'TENX',
            periodMonth: monthKey(year, month),
            divisionCode: division,
            lineItem: 'revenue',
            amount: divisionRevenue.toDecimalPlaces(2),
          },
          {
            scenarioCode: 'TENX',
            periodMonth: monthKey(year, month),
            divisionCode: division,
            lineItem: 'cogs',
            amount: divisionRevenue.times(profile.cogsRatio * scaleFactor).toDecimalPlaces(2),
          },
          {
            scenarioCode: 'TENX',
            periodMonth: monthKey(year, month),
            divisionCode: division,
            lineItem: 'opex',
            amount: divisionRevenue.times(profile.opexRatio * scaleFactor).toDecimalPlaces(2),
          },
        );
      }
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// HubSpot
// ---------------------------------------------------------------------------

const PIPELINE_STAGES = [
  'qualifiedtobuy',
  'presentationscheduled',
  'proposalsent',
  'decisionmakerboughtin',
  'closedwon',
  'closedlost',
] as const;

const LEAD_SOURCES = [
  'ORGANIC_SEARCH',
  'PAID_SEARCH',
  'REFERRALS',
  'DIRECT_TRAFFIC',
  'EMAIL_MARKETING',
  'SOCIAL_MEDIA',
  'OFFLINE',
] as const;

/**
 * ARG's sales reps.
 *
 * Named rather than numbered because leadership asked to filter sales by
 * person, and a dropdown of "owner-3" is a dropdown nobody opens. The ids stay
 * provider-shaped so the seed and a real HubSpot pull have the same structure.
 */
const OWNERS: Array<{ ownerId: string; ownerName: string }> = [
  { ownerId: 'owner-1', ownerName: 'Dana Whitfield' },
  { ownerId: 'owner-2', ownerName: 'Marcus Ellery' },
  { ownerId: 'owner-3', ownerName: 'Priya Raghunathan' },
  { ownerId: 'owner-4', ownerName: 'Tom Bassett' },
  { ownerId: 'owner-5', ownerName: 'Lena Ortiz' },
];

interface HubspotData {
  deals: DealRow[];
  stageHistory: StageHistoryRow[];
  contacts: ContactRow[];
  meetings: MeetingRow[];
}

/**
 * §4.6: HubSpot objects land at their natural grain and the KPIs derive from
 * them. Nothing is pre-aggregated on load — ARG will want to slice by owner,
 * source and pipeline stage.
 *
 * Deals carry a division so the Sales and Marketing dashboards can filter, but
 * the KPI layer still checks the HUBSPOT_DIVISION_ATTRIBUTION config before
 * reporting at division level (open item #2). Seeded attribution does not
 * license the app to assume it in production.
 */
function buildHubspot(pl: PlRow[], rand: () => number): HubspotData {
  const deals: DealRow[] = [];
  const stageHistory: StageHistoryRow[] = [];
  const contacts: ContactRow[] = [];
  const meetings: MeetingRow[] = [];

  const revenueByKey = new Map(pl.map((r) => [`${r.periodMonth}|${r.divisionCode}`, r.revenue]));
  const months = allMonthsIncludingOpen().filter((m) => m.year >= 2025);

  let dealCounter = 0;
  let contactCounter = 0;
  let meetingCounter = 0;

  for (const { key, year, month } of months) {
    for (const division of DIVISION_CODES) {
      const monthlyRevenue = revenueByKey.get(`${key}|${division}`) ?? new Decimal(0);

      // Bookings run a little ahead of recognised revenue — new business closed
      // this month is delivered over following months.
      const bookingTarget = monthlyRevenue.times(0.95 + rand() * 0.25);
      const dealCount = Math.max(3, Math.round(4 + rand() * 9));
      const avgDeal = bookingTarget.div(dealCount);

      for (let i = 0; i < dealCount; i++) {
        dealCounter++;
        const dealId = `deal-${dealCounter}`;
        const amount = avgDeal.times(0.5 + rand() * 1.1).toDecimalPlaces(2);

        const createDay = 1 + Math.floor(rand() * 26);
        // Deals are created two to four months before they close.
        const leadMonths = 2 + Math.floor(rand() * 3);
        const createdate = new Date(Date.UTC(year, month - 1 - leadMonths, createDay, 15, 0, 0));
        const closeDay = 1 + Math.floor(rand() * daysInMonth(year, month));
        const closedate = new Date(Date.UTC(year, month - 1, closeDay, 17, 30, 0));

        const roll = rand();
        const isClosedWon = roll < 0.58;
        const isLost = !isClosedWon && roll < 0.85;
        const isClosed = isClosedWon || isLost;

        // §5.2 / §6: New Proposals Sent needs the timestamp a deal ENTERED the
        // Proposal stage, not its current stage.
        const enteredProposalAt = new Date(
          createdate.getTime() + (0.4 + rand() * 0.4) * (closedate.getTime() - createdate.getTime()),
        );

        const contactId = `contact-d${dealCounter}`;
        const owner = OWNERS[Math.floor(rand() * OWNERS.length)]!;
        const ownerId = owner.ownerId;
        const ownerName = owner.ownerName;

        deals.push({
          dealId,
          divisionCode: division,
          dealName: `${division} engagement ${dealCounter}`,
          amount,
          dealstage: isClosedWon ? 'closedwon' : isLost ? 'closedlost' : PIPELINE_STAGES[Math.floor(rand() * 4)]!,
          pipeline: 'default',
          isClosedWon,
          isClosed,
          createdate,
          closedate: isClosed ? closedate : null,
          enteredProposalAt,
          ownerId,
          ownerName,
          contactId,
        });

        stageHistory.push(
          { dealId, stage: 'qualifiedtobuy', enteredAt: createdate },
          { dealId, stage: 'proposalsent', enteredAt: enteredProposalAt },
        );
        if (isClosed) {
          stageHistory.push({
            dealId,
            stage: isClosedWon ? 'closedwon' : 'closedlost',
            enteredAt: closedate,
          });
        }

        contacts.push({
          contactId,
          divisionCode: division,
          lifecycleStage: isClosedWon ? 'customer' : 'lead',
          originalSource: LEAD_SOURCES[Math.floor(rand() * LEAD_SOURCES.length)]!,
          createdate,
          becameLeadDate: createdate,
          becameCustomerDate: isClosedWon ? closedate : null,
        });

        const meetingCount = 1 + Math.floor(rand() * 3);
        for (let m = 0; m < meetingCount; m++) {
          meetingCounter++;
          meetings.push({
            meetingId: `meeting-${meetingCounter}`,
            divisionCode: division,
            meetingDate: new Date(Date.UTC(year, month - 1, 1 + Math.floor(rand() * 26), 14, 0, 0)),
            outcome: rand() < 0.82 ? 'COMPLETED' : 'NO_SHOW',
            ownerId,
            associatedDealId: dealId,
          });
        }
      }

      // Leads that never became deals — the denominator for CPL and the
      // lead-to-customer conversion rate.
      const extraLeads = 18 + Math.floor(rand() * 28);
      for (let i = 0; i < extraLeads; i++) {
        contactCounter++;
        const leadDate = new Date(Date.UTC(year, month - 1, 1 + Math.floor(rand() * 26), 11, 0, 0));
        contacts.push({
          contactId: `contact-l${contactCounter}`,
          divisionCode: division,
          lifecycleStage: 'lead',
          originalSource: LEAD_SOURCES[Math.floor(rand() * LEAD_SOURCES.length)]!,
          createdate: leadDate,
          becameLeadDate: leadDate,
          becameCustomerDate: null,
        });
      }
    }
  }

  return { deals, stageHistory, contacts, meetings };
}

// ---------------------------------------------------------------------------
// Headcount — §6 Operations, monthly manual/imported figure
// ---------------------------------------------------------------------------

function buildHeadcount(rand: () => number): HeadcountRow[] {
  const rows: HeadcountRow[] = [];
  for (const { key, year } of allMonthsIncludingOpen()) {
    for (const division of DIVISION_CODES) {
      const base = PROFILES[division].headcountBase;
      const growth = 1 + (year - 2023) * 0.06;
      rows.push({
        periodMonth: key,
        divisionCode: division,
        headcount: new Decimal(base * growth * (0.96 + rand() * 0.08)).toDecimalPlaces(0),
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function generateSeedDataset(): SeedDataset {
  const rand = mulberry32(SEED);

  const pl = [...buildHistory(rand), ...build2026()].sort((a, b) =>
    a.periodMonth === b.periodMonth
      ? a.divisionCode.localeCompare(b.divisionCode)
      : a.periodMonth.localeCompare(b.periodMonth),
  );

  const gl = buildGl(pl, rand);
  const bs = buildBalanceSheet(pl, rand);
  const aging = buildAging(bs, rand);
  const budget = buildBudget(pl, rand);
  const hubspot = buildHubspot(pl, rand);
  const headcount = buildHeadcount(rand);

  return {
    pl,
    gl,
    bs,
    aging,
    budget,
    deals: hubspot.deals,
    stageHistory: hubspot.stageHistory,
    contacts: hubspot.contacts,
    meetings: hubspot.meetings,
    headcount,
  };
}
