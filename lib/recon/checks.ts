/**
 * Standing reconciliation controls.
 *
 * §2 Rule 1: "Build these as standing automated checks that run on every refresh
 * and surface a visible pass/fail — not as one-time validations you run by hand
 * at go-live."
 *
 * §2 Rule 2: "If a reconciliation check fails, the dashboard says so rather than
 * quietly displaying a wrong number."
 *
 * These are Acceptance Tests 1–4 and 8. They are implemented once, here, and are
 * called both by the test suite and by the application on every load.
 */
import Decimal from 'decimal.js';
import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { d, DOLLAR_TOLERANCE } from '@/lib/money';
import { rollUpGl, type ReportingLine } from '@/lib/etl/rollup';
import * as t from '@/lib/db/schema';
import type { Database } from '@/lib/db/client';

export interface ReconFinding {
  checkId: string;
  checkName: string;
  periodMonth: string | null;
  divisionCode: string | null;
  status: 'PASS' | 'FAIL' | 'NOT_APPLICABLE';
  expected: Decimal | null;
  actual: Decimal | null;
  variance: Decimal | null;
  detail: string;
}

export interface ReconOptions {
  /** Restrict to a window. Omit to check every period in the warehouse. */
  fromMonth?: string;
  toMonth?: string;
}

const TOL = DOLLAR_TOLERANCE;

function verdict(
  base: Omit<ReconFinding, 'status' | 'variance'>,
  expected: Decimal,
  actual: Decimal,
  passDetail: string,
  failDetail: (variance: Decimal) => string,
): ReconFinding {
  const variance = actual.minus(expected);
  const pass = variance.abs().lessThanOrEqualTo(TOL);
  return {
    ...base,
    status: pass ? 'PASS' : 'FAIL',
    expected,
    actual,
    variance,
    detail: pass ? passDetail : failDetail(variance),
  };
}

// ---------------------------------------------------------------------------
// Test 1 — P&L ties to source
// ---------------------------------------------------------------------------

/**
 * "System revenue, COGS and OpEx equal the QBO trial balance for the closed
 * month, per division and at ARG Total — within $1."
 *
 * fact_gl_balance IS the trial balance at account level, so this check compares
 * the summarised five lines against the accounts they were rolled up from. If
 * they ever disagree, one of the two was written by something that bypassed the
 * mapping.
 */
export async function checkPlTiesToTrialBalance(
  db: Database,
  options: ReconOptions = {},
): Promise<ReconFinding[]> {
  const findings: ReconFinding[] = [];

  const plRows = await db
    .select()
    .from(t.factPlActual)
    .where(windowFilter(t.factPlActual.periodMonth, options));

  const glRows = await db
    .select({
      periodMonth: t.factGlBalance.periodMonth,
      divisionCode: t.factGlBalance.divisionCode,
      accountId: t.factGlBalance.accountId,
      amount: t.factGlBalance.amount,
      reportingLine: t.dimAccount.reportingLine,
    })
    .from(t.factGlBalance)
    .innerJoin(t.dimAccount, eq(t.dimAccount.accountId, t.factGlBalance.accountId))
    .where(windowFilter(t.factGlBalance.periodMonth, options));

  const glByKey = new Map<string, Array<{ accountId: string; reportingLine: ReportingLine; amount: string }>>();
  for (const row of glRows) {
    if (!row.reportingLine) continue;
    const key = `${row.periodMonth}|${row.divisionCode}`;
    const list = glByKey.get(key) ?? [];
    list.push({
      accountId: row.accountId,
      reportingLine: row.reportingLine as ReportingLine,
      amount: row.amount,
    });
    glByKey.set(key, list);
  }

  for (const pl of plRows) {
    const key = `${pl.periodMonth}|${pl.divisionCode}`;
    const gl = glByKey.get(key);

    if (!gl || gl.length === 0) {
      findings.push({
        checkId: 'PL_TIES_TO_TRIAL_BALANCE',
        checkName: 'P&L ties to trial balance',
        periodMonth: pl.periodMonth,
        divisionCode: pl.divisionCode,
        status: 'FAIL',
        expected: null,
        actual: null,
        variance: null,
        detail:
          'No account-level trial balance for this period and division. A summarised P&L with no supporting accounts cannot be drilled into or audited.',
      });
      continue;
    }

    const rolled = rollUpGl(gl);
    const comparisons: Array<[string, Decimal, Decimal]> = [
      ['revenue', d(pl.revenue), rolled.revenue],
      ['COGS', d(pl.cogs), rolled.cogs],
      ['OpEx', d(pl.opex), rolled.opex],
      // The memo lines are checked too. If payroll-direct ever drifts from the
      // payroll accounts inside COGS, the memo has stopped being a view of the
      // total and has become an independent number — which is how double
      // counting starts.
      ['payroll (direct, memo)', d(pl.payrollDirect), rolled.payrollDirect],
      ['payroll (expense, memo)', d(pl.payrollExpense), rolled.payrollExpense],
    ];

    for (const [label, summarised, fromAccounts] of comparisons) {
      findings.push(
        verdict(
          {
            checkId: 'PL_TIES_TO_TRIAL_BALANCE',
            checkName: `P&L ${label} ties to trial balance`,
            periodMonth: pl.periodMonth,
            divisionCode: pl.divisionCode,
            expected: summarised,
            actual: fromAccounts,
            detail: '',
          },
          summarised,
          fromAccounts,
          `${label} agrees with the underlying accounts.`,
          (v) =>
            `${label} differs from the sum of its accounts by ${v.toFixed(2)}. The summarised figure and the trial balance disagree.`,
        ),
      );
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Test 2 — Division sums tie to ARG Total
// ---------------------------------------------------------------------------

/**
 * "SHRC + Claims + TP + LITS = ARG Total on every measure, in every period —
 * within $1."
 *
 * In this system ARG Total is computed as that sum, so the arithmetic cannot
 * disagree. What CAN go wrong is a stored ARG Total row sneaking in — which is
 * precisely the Excel's defect, and what makes its total able to drift. So the
 * check asserts the structural property instead of re-adding four numbers: no
 * consolidated row exists, and every division on every fact row resolves to a
 * live division in the dimension.
 */
export async function checkDivisionSumsTieToTotal(
  db: Database,
  options: ReconOptions = {},
): Promise<ReconFinding[]> {
  const findings: ReconFinding[] = [];

  const divisions = await db.select().from(t.dimDivision).where(eq(t.dimDivision.isActive, true));
  const activeCodes = divisions.map((row) => row.divisionCode);

  for (const [label, table, column] of [
    ['P&L', t.factPlActual, t.factPlActual.divisionCode],
    ['balance sheet', t.factBsActual, t.factBsActual.divisionCode],
    ['GL', t.factGlBalance, t.factGlBalance.divisionCode],
  ] as const) {
    const stray = await db
      .select({ divisionCode: column, count: sql<number>`count(*)::int` })
      .from(table)
      .where(sql`${column} not in ${activeCodes}`)
      .groupBy(column);

    findings.push({
      checkId: 'DIVISION_SUMS_TIE_TO_TOTAL',
      checkName: `${label}: every row belongs to a live division`,
      periodMonth: null,
      divisionCode: null,
      status: stray.length === 0 ? 'PASS' : 'FAIL',
      expected: new Decimal(0),
      actual: new Decimal(stray.reduce((sum, row) => sum + row.count, 0)),
      variance: new Decimal(stray.reduce((sum, row) => sum + row.count, 0)),
      detail:
        stray.length === 0
          ? `Every ${label} row maps to one of the ${activeCodes.length} live divisions, so ARG Total is exactly the sum of its parts.`
          : `${label} rows carry division codes outside the dimension: ${stray
              .map((row) => `${row.divisionCode} (${row.count})`)
              .join(', ')}. ARG Total would silently exclude them.`,
    });
  }

  // The four divisions must actually be present in the period being reported,
  // or "the sum of the four" is quietly the sum of three.
  const plRows = await db
    .select({
      periodMonth: t.factPlActual.periodMonth,
      count: sql<number>`count(*)::int`,
    })
    .from(t.factPlActual)
    .where(windowFilter(t.factPlActual.periodMonth, options))
    .groupBy(t.factPlActual.periodMonth);

  for (const row of plRows) {
    const complete = row.count === activeCodes.length;
    findings.push({
      checkId: 'DIVISION_SUMS_TIE_TO_TOTAL',
      checkName: 'All divisions present in period',
      periodMonth: row.periodMonth,
      divisionCode: null,
      status: complete ? 'PASS' : 'FAIL',
      expected: new Decimal(activeCodes.length),
      actual: new Decimal(row.count),
      variance: new Decimal(row.count - activeCodes.length),
      detail: complete
        ? `All ${activeCodes.length} divisions reported.`
        : `Only ${row.count} of ${activeCodes.length} divisions reported. ARG Total for this period is incomplete and must not be displayed as a total.`,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Test 3 — Balance sheet balances
// ---------------------------------------------------------------------------

/**
 * "Total assets − (total liabilities + shareholder equity) = 0, within $1, with
 * equity loaded from QBO rather than plugged."
 *
 * Defect 3: the workbook computes equity as assets minus liabilities, then
 * "checks" that assets equal liabilities plus equity. That check is circular —
 * it returns zero by construction and can never detect an unbalanced balance
 * sheet. Here equity is a stored, loaded column, so the subtraction is a real
 * assertion.
 */
export async function checkBalanceSheetBalances(
  db: Database,
  options: ReconOptions = {},
): Promise<ReconFinding[]> {
  const rows = await db
    .select()
    .from(t.factBsActual)
    .where(windowFilter(t.factBsActual.periodMonth, options));

  return rows.map((row) => {
    const assets = d(row.cash)
      .plus(d(row.accountsReceivable))
      .plus(d(row.otherCurrentAssets))
      .plus(d(row.fixedAssets));
    const liabilitiesAndEquity = d(row.accountsPayable)
      .plus(d(row.ccLiability))
      .plus(d(row.otherCurrentLiabilities))
      .plus(d(row.ltLiabilities))
      .plus(d(row.shareholderEquity));

    return verdict(
      {
        checkId: 'BALANCE_SHEET_BALANCES',
        checkName: 'Balance sheet balances',
        periodMonth: row.periodMonth,
        divisionCode: row.divisionCode,
        expected: assets,
        actual: liabilitiesAndEquity,
        detail: '',
      },
      assets,
      liabilitiesAndEquity,
      'Assets equal liabilities plus equity, with equity loaded from source.',
      (v) =>
        `Assets minus liabilities and equity is ${v.toFixed(2)}. Equity is loaded from source, so this is a genuine imbalance, not a rounding artefact of a plugged figure.`,
    );
  });
}

// ---------------------------------------------------------------------------
// Test 4 — A/R and A/P tie to aging
// ---------------------------------------------------------------------------

export async function checkAgingTiesToBalanceSheet(
  db: Database,
  options: ReconOptions = {},
): Promise<ReconFinding[]> {
  const bsRows = await db
    .select()
    .from(t.factBsActual)
    .where(windowFilter(t.factBsActual.periodMonth, options));

  const agingRows = await db
    .select({
      periodMonth: t.factAging.periodMonth,
      divisionCode: t.factAging.divisionCode,
      kind: t.factAging.kind,
      amount: t.factAging.amount,
    })
    .from(t.factAging)
    .where(windowFilter(t.factAging.periodMonth, options));

  const agingTotals = new Map<string, Decimal>();
  for (const row of agingRows) {
    const key = `${row.periodMonth}|${row.divisionCode}|${row.kind}`;
    agingTotals.set(key, (agingTotals.get(key) ?? new Decimal(0)).plus(d(row.amount)));
  }

  const findings: ReconFinding[] = [];
  for (const row of bsRows) {
    for (const [kind, label, balance] of [
      ['AR', 'A/R', d(row.accountsReceivable)],
      ['AP', 'A/P', d(row.accountsPayable)],
    ] as const) {
      const aged = agingTotals.get(`${row.periodMonth}|${row.divisionCode}|${kind}`);
      if (!aged) {
        findings.push({
          checkId: 'AGING_TIES_TO_BALANCE_SHEET',
          checkName: `${label} ties to aging`,
          periodMonth: row.periodMonth,
          divisionCode: row.divisionCode,
          status: 'NOT_APPLICABLE',
          expected: balance,
          actual: null,
          variance: null,
          detail: `No ${label} aging detail loaded for this period.`,
        });
        continue;
      }

      findings.push(
        verdict(
          {
            checkId: 'AGING_TIES_TO_BALANCE_SHEET',
            checkName: `${label} ties to aging`,
            periodMonth: row.periodMonth,
            divisionCode: row.divisionCode,
            expected: balance,
            actual: aged,
            detail: '',
          },
          balance,
          aged,
          `${label} aging buckets foot to the balance sheet.`,
          (v) => `${label} aging total differs from the balance sheet by ${v.toFixed(2)}.`,
        ),
      );
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Test 8 — No unmapped records
// ---------------------------------------------------------------------------

/**
 * "Zero records land with an unmapped division code or an unmapped GL account.
 * The check fails loudly rather than defaulting to 'other'."
 */
export async function checkNoUnmappedRecords(db: Database): Promise<ReconFinding[]> {
  const findings: ReconFinding[] = [];

  const unmappedAccounts = await db
    .select({ accountId: t.dimAccount.accountId, accountName: t.dimAccount.accountName })
    .from(t.dimAccount)
    .where(
      and(
        inArray(t.dimAccount.accountType, ['INCOME', 'COGS', 'EXPENSE']),
        sql`${t.dimAccount.reportingLine} is null`,
      ),
    );

  findings.push({
    checkId: 'NO_UNMAPPED_RECORDS',
    checkName: 'Every P&L account maps to a reporting line',
    periodMonth: null,
    divisionCode: null,
    status: unmappedAccounts.length === 0 ? 'PASS' : 'FAIL',
    expected: new Decimal(0),
    actual: new Decimal(unmappedAccounts.length),
    variance: new Decimal(unmappedAccounts.length),
    detail:
      unmappedAccounts.length === 0
        ? 'All income, COGS and expense accounts roll up to one of the five reporting lines.'
        : `Unmapped: ${unmappedAccounts
            .map((a) => `${a.accountId} ${a.accountName}`)
            .join(', ')}. These are excluded from every reported figure. Map them before publishing.`,
  });

  const unmappedBsAccounts = await db
    .select({ accountId: t.dimAccount.accountId, accountName: t.dimAccount.accountName })
    .from(t.dimAccount)
    .where(
      and(
        inArray(t.dimAccount.accountType, ['ASSET', 'LIABILITY', 'EQUITY']),
        sql`${t.dimAccount.balanceSheetLine} is null`,
      ),
    );

  findings.push({
    checkId: 'NO_UNMAPPED_RECORDS',
    checkName: 'Every balance-sheet account maps to a line',
    periodMonth: null,
    divisionCode: null,
    status: unmappedBsAccounts.length === 0 ? 'PASS' : 'FAIL',
    expected: new Decimal(0),
    actual: new Decimal(unmappedBsAccounts.length),
    variance: new Decimal(unmappedBsAccounts.length),
    detail:
      unmappedBsAccounts.length === 0
        ? 'All asset, liability and equity accounts map to a balance-sheet line.'
        : `Unmapped: ${unmappedBsAccounts.map((a) => a.accountId).join(', ')}.`,
  });

  return findings;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function windowFilter(column: any, options: ReconOptions) {
  const clauses = [];
  if (options.fromMonth) clauses.push(gte(column, options.fromMonth));
  if (options.toMonth) clauses.push(lte(column, options.toMonth));
  return clauses.length ? and(...clauses) : undefined;
}

export interface ReconSummary {
  findings: ReconFinding[];
  passed: number;
  failed: number;
  notApplicable: number;
  /** True when nothing is failing — drives the green chip in the global header. */
  allPass: boolean;
}

export async function runAllChecks(
  db: Database,
  options: ReconOptions = {},
): Promise<ReconSummary> {
  const findings = [
    ...(await checkPlTiesToTrialBalance(db, options)),
    ...(await checkDivisionSumsTieToTotal(db, options)),
    ...(await checkBalanceSheetBalances(db, options)),
    ...(await checkAgingTiesToBalanceSheet(db, options)),
    ...(await checkNoUnmappedRecords(db)),
  ];

  const passed = findings.filter((f) => f.status === 'PASS').length;
  const failed = findings.filter((f) => f.status === 'FAIL').length;
  const notApplicable = findings.filter((f) => f.status === 'NOT_APPLICABLE').length;

  return { findings, passed, failed, notApplicable, allPass: failed === 0 };
}

/** Persists a run's findings so the dashboards and the agent read the same status. */
export async function persistFindings(
  db: Database,
  findings: ReconFinding[],
  loadRunId?: string,
): Promise<void> {
  if (findings.length === 0) return;

  const rows = findings.map((f) => ({
    checkId: f.checkId,
    checkName: f.checkName,
    periodMonth: f.periodMonth,
    divisionCode: f.divisionCode,
    status: f.status,
    expected: f.expected ? f.expected.toFixed(4) : null,
    actual: f.actual ? f.actual.toFixed(4) : null,
    variance: f.variance ? f.variance.toFixed(4) : null,
    detail: f.detail,
    loadRunId: loadRunId ?? null,
  }));

  for (let i = 0; i < rows.length; i += 400) {
    await db.insert(t.reconResult).values(rows.slice(i, i + 400));
  }
}
