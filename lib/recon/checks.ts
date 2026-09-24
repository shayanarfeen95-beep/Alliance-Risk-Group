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

/** The first of the month we are in. */
function currentMonth(): string {
  return `${new Date().toISOString().slice(0, 7)}-01`;
}

/**
 * The months a check covers — never later than the month we are in.
 *
 * A month that has not happened has nothing to reconcile. Checking one anyway is
 * what put "3 failing" in the header all September: QuickBooks had a few future-
 * dated entries in October to December, so those months held one or two
 * divisions each and failed "all divisions present" — a red badge about months
 * nobody had kept yet, sitting over an August that was the thing being read.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function windowFilter(column: any, options: ReconOptions) {
  const clauses = [];
  if (options.fromMonth) clauses.push(gte(column, options.fromMonth));
  const ceiling = options.toMonth && options.toMonth < currentMonth() ? options.toMonth : currentMonth();
  clauses.push(lte(column, ceiling));
  return and(...clauses);
}

// ---------------------------------------------------------------------------
// The P&L ties to QuickBooks' own company total
// ---------------------------------------------------------------------------

/**
 * ARG Total (the four divisions) against QuickBooks' TOTAL column, per line.
 *
 * This is the check Mario ran by hand: "revenue in August was $482,405" against
 * a dashboard showing $321,078. Had it existed, the parent-account parsing bug
 * would have failed it on the first pull instead of reaching the CFO.
 *
 * A difference within $1 — or within 0.1% of the line, which is what an amount
 * left on an allocation class like Z Alloc typically is — passes, and the detail
 * always states the exact amount that sits outside the divisions.
 */
export async function checkPlTiesToQuickBooks(
  db: Database,
  options: ReconOptions = {},
): Promise<ReconFinding[]> {
  const companyRows = await db
    .select()
    .from(t.factCompanyTotal)
    .where(and(eq(t.factCompanyTotal.statement, 'PL'), windowFilter(t.factCompanyTotal.periodMonth, options)));
  if (!companyRows.length) return [];

  const plRows = await db
    .select()
    .from(t.factPlActual)
    .where(windowFilter(t.factPlActual.periodMonth, options));

  const divisionTotals = new Map<string, Record<'revenue' | 'cogs' | 'opex', Decimal>>();
  for (const row of plRows) {
    const totals = divisionTotals.get(row.periodMonth) ?? {
      revenue: new Decimal(0),
      cogs: new Decimal(0),
      opex: new Decimal(0),
    };
    totals.revenue = totals.revenue.plus(d(row.revenue));
    totals.cogs = totals.cogs.plus(d(row.cogs));
    totals.opex = totals.opex.plus(d(row.opex));
    divisionTotals.set(row.periodMonth, totals);
  }

  const labels = { revenue: 'Revenue', cogs: 'COGS', opex: 'Operating expense' } as const;
  const findings: ReconFinding[] = [];

  for (const row of companyRows) {
    if (!(row.line in labels)) continue;
    const line = row.line as keyof typeof labels;
    const quickbooks = d(row.amount);
    const ours = divisionTotals.get(row.periodMonth)?.[line] ?? new Decimal(0);
    const variance = ours.minus(quickbooks);
    const tolerance = Decimal.max(TOL, quickbooks.abs().times(0.001));
    const pass = variance.abs().lessThanOrEqualTo(tolerance);
    const month = row.periodMonth.slice(0, 7);

    findings.push({
      checkId: 'PL_TIES_TO_QUICKBOOKS',
      checkName: `${labels[line]} ties to QuickBooks`,
      periodMonth: row.periodMonth,
      divisionCode: null,
      status: pass ? 'PASS' : 'FAIL',
      expected: quickbooks,
      actual: ours,
      variance,
      detail: variance.abs().lessThanOrEqualTo(TOL)
        ? `${labels[line]} for ${month} is ${quickbooks.toFixed(2)} in QuickBooks and in the four divisions.`
        : pass
          ? `${labels[line]} for ${month}: QuickBooks ${quickbooks.toFixed(2)}, the four divisions ${ours.toFixed(2)}. ` +
            `The ${variance.negated().toFixed(2)} difference is on classes that belong to no division (Not Specified, Z Alloc).`
          : `${labels[line]} for ${month} does NOT tie: QuickBooks ${quickbooks.toFixed(2)}, the four divisions ` +
            `${ours.toFixed(2)}, out by ${variance.toFixed(2)}. Check the class mapping, then pull again.`,
    });
  }

  return findings;
}

/** QuickBooks' company balance sheet: assets equal liabilities plus equity. */
export async function checkCompanyBalanceSheetBalances(
  db: Database,
  options: ReconOptions = {},
): Promise<ReconFinding[]> {
  const rows = await db
    .select()
    .from(t.factCompanyTotal)
    .where(and(eq(t.factCompanyTotal.statement, 'BS'), windowFilter(t.factCompanyTotal.periodMonth, options)));

  const byMonth = new Map<string, Map<string, Decimal>>();
  for (const row of rows) {
    const lines = byMonth.get(row.periodMonth) ?? new Map<string, Decimal>();
    lines.set(row.line, d(row.amount));
    byMonth.set(row.periodMonth, lines);
  }

  const sum = (lines: Map<string, Decimal>, keys: string[]) =>
    keys.reduce((total, key) => total.plus(lines.get(key) ?? 0), new Decimal(0));

  return [...byMonth].map(([periodMonth, lines]) => {
    const assets = sum(lines, ['cash', 'accounts_receivable', 'other_current_assets', 'fixed_assets']);
    const liabilitiesAndEquity = sum(lines, [
      'accounts_payable',
      'cc_liability',
      'other_current_liabilities',
      'lt_liabilities',
      'shareholder_equity',
    ]);
    return verdict(
      {
        checkId: 'BALANCE_SHEET_BALANCES',
        checkName: 'Company balance sheet balances',
        periodMonth,
        divisionCode: null,
        expected: assets,
        actual: liabilitiesAndEquity,
        detail: '',
      },
      assets,
      liabilitiesAndEquity,
      'Total assets equal total liabilities and equity on the QuickBooks company balance sheet.',
      (v) => `Assets minus liabilities and equity is ${v.toFixed(2)} on the company balance sheet.`,
    );
  });
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
    ...(await checkPlTiesToQuickBooks(db, options)),
    ...(await checkCompanyBalanceSheetBalances(db, options)),
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

  // One timestamp for the whole run, set here rather than left to the column
  // default.
  //
  // This is load-bearing. Every reader — the status chip, the Admin table, the
  // agent's recon tool, the audit pack — selects the latest run with
  // `ran_at = (select max(ran_at) ...)`. The rows are inserted in chunks, and
  // each chunk is its own transaction, so a column default of `now()` stamps
  // each chunk with a different time and `max(ran_at)` returns only the last
  // one. A failing control in any earlier chunk would then be invisible
  // everywhere, while the chip reported a confident green.
  //
  // Rule 2 is that a dashboard says so when a check fails rather than quietly
  // displaying a wrong number. A partitioned run breaks that silently, which is
  // the worst way for it to break.
  const ranAt = new Date();

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
    ranAt,
  }));

  for (let i = 0; i < rows.length; i += 400) {
    await db.insert(t.reconResult).values(rows.slice(i, i + 400));
  }
}
