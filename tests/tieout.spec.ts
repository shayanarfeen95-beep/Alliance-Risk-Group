/**
 * §13 Acceptance Tests — the tie-out suite.
 *
 * "The build is accepted when every test below passes... §13.1: From the live
 * Excel model, March 2026. Your system must reproduce these exactly. If it does
 * not, stop and reconcile before building anything else on top."
 *
 * These assertions run against the semantic layer, which is the same code path
 * every dashboard, export and agent answer uses. When live QBO data replaces the
 * seed, this file does not change — the same assertions run against the real
 * numbers.
 *
 * On what this does and does not prove: the seed is constructed FROM the §13.1
 * figures, so "March revenue equals March revenue" is not an interesting claim.
 * What these tests genuinely prove is that the CONVENTIONS are right — the memo
 * columns are not subtracted, gross profit and net profit are derived rather
 * than stored, YTD windows are Jan-through-selected-month, run rate annualises
 * YTD rather than a single month, and ARG Total is the sum of its parts. Those
 * are the failure modes §13 warns about by name, and they are all method errors
 * that the seed cannot mask.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { createTestDb, CFO_USER, CLAIMS_MANAGER_USER, type TestDb } from './helpers/db';
import { seedDatabase } from '@/lib/seed/load';
import { openSemanticSession, resolveKpi, type SemanticSession } from '@/lib/semantic/resolve';
import {
  MARCH_2026,
  YTD_MARCH_2026,
  WORKBOOK_KPI_MARCH_2026,
  KNOWN_WRONG_ANSWERS,
  DIVISION_CODES,
  TIE_OUT_MONTH,
} from '@/lib/seed/reference';
import { runAllChecks, persistFindings } from '@/lib/recon/checks';
import { sql } from 'drizzle-orm';
import * as t from '@/lib/db/schema';
import { KPI_REGISTRY, getKpiDefinition } from '@/lib/semantic/registry';
import { ScopeError } from '@/lib/auth/scope';

/**
 * §13.1: "Figures are rounded to the dollar from unrounded source data; a column
 * of components may differ from its total by $1."
 */
const DOLLAR = 1;

/**
 * A run rate annualises YTD by 12 ÷ months elapsed. For March that is ×4, so the
 * spec's own $1 of component rounding scales by 4 as well. The tolerance is
 * derived from the arithmetic, not loosened to make a test pass — and it stays
 * far tighter than the ~$900K gap to the wrong method the spec warns about.
 */
const RUN_RATE_TOLERANCE = DOLLAR * (12 / 3);

let harness: TestDb;
let session: SemanticSession;

function valueOf(id: string, division: string, options?: Record<string, string>): number {
  const result = resolveKpi(session, id, division, options ? { options } : {});
  expect(result.unavailable, `${id} for ${division} was unavailable: ${result.unavailable?.detail}`)
    .toBeUndefined();
  expect(result.value, `${id} for ${division} returned no value`).not.toBeNull();
  return (result.value as Decimal).toNumber();
}

beforeAll(async () => {
  harness = await createTestDb();
  await seedDatabase(harness.db, { quiet: true });
  session = await openSemanticSession(harness.db, CFO_USER, TIE_OUT_MONTH);
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

// ---------------------------------------------------------------------------

describe('Test 1 — P&L ties to source', () => {
  it.each(DIVISION_CODES)('%s reproduces the March 2026 figures', (division) => {
    const expected = MARCH_2026[division]!;
    expect(valueOf('revenue', division)).toBeCloseTo(expected.revenue, -0.5);
    expect(valueOf('cogs', division)).toBeCloseTo(expected.cogs, -0.5);
    expect(valueOf('opex', division)).toBeCloseTo(expected.opex, -0.5);
  });

  it.each(DIVISION_CODES)('%s gross profit and net profit are derived correctly', (division) => {
    const expected = MARCH_2026[division]!;
    expect(Math.abs(valueOf('gross_profit', division) - expected.grossProfit)).toBeLessThanOrEqual(DOLLAR);
    expect(Math.abs(valueOf('net_profit', division) - expected.netProfit)).toBeLessThanOrEqual(DOLLAR);
  });

  it('ARG Total reproduces the consolidated March 2026 figures', () => {
    const expected = MARCH_2026.ARG_TOTAL!;
    for (const [id, target] of [
      ['revenue', expected.revenue],
      ['cogs', expected.cogs],
      ['gross_profit', expected.grossProfit],
      ['opex', expected.opex],
      ['net_profit', expected.netProfit],
    ] as const) {
      expect(Math.abs(valueOf(id, 'ARG_TOTAL') - target), id).toBeLessThanOrEqual(DOLLAR);
    }
  });
});

describe('the memo columns are not subtracted', () => {
  /**
   * §13.1: "If your gross profit for SHRC comes out near $38,407 instead of
   * $71,451, you have subtracted the payroll memo column — go back to §4.2."
   *
   * This is the single most likely way to break the build, so it is asserted in
   * both directions: the right answer, and explicitly not the wrong one.
   */
  it('SHRC gross profit is $71,451, not $38,407', () => {
    const grossProfit = valueOf('gross_profit', 'SHRC');
    expect(Math.abs(grossProfit - MARCH_2026.SHRC!.grossProfit)).toBeLessThanOrEqual(DOLLAR);
    expect(
      Math.abs(grossProfit - KNOWN_WRONG_ANSWERS.shrcGrossProfitIfPayrollMemoSubtracted),
    ).toBeGreaterThan(1_000);
  });

  it('payroll memo lines sit INSIDE their totals, not beside them', () => {
    for (const division of DIVISION_CODES) {
      const payrollDirect = valueOf('payroll_direct', division);
      const cogs = valueOf('cogs', division);
      const payrollExpense = valueOf('payroll_expense', division);
      const opex = valueOf('opex', division);

      // A memo line that exceeded its parent total would mean it is being
      // carried independently rather than as a component.
      expect(payrollDirect).toBeGreaterThan(0);
      expect(payrollDirect).toBeLessThan(cogs);
      expect(payrollExpense).toBeGreaterThan(0);
      expect(payrollExpense).toBeLessThan(opex);
    }
  });
});

describe('Test 2 — division sums tie to ARG Total', () => {
  it.each(['revenue', 'cogs', 'gross_profit', 'opex', 'net_profit'])(
    '%s: the four divisions foot to ARG Total',
    (id) => {
      const parts = DIVISION_CODES.reduce((sum, division) => sum + valueOf(id, division), 0);
      expect(Math.abs(parts - valueOf(id, 'ARG_TOTAL'))).toBeLessThanOrEqual(DOLLAR);
    },
  );

  it('holds in every period, not just the tie-out month', async () => {
    // §7: "The four divisions always sum to ARG Total, on every measure, in
    // every period. This is a hard assertion, not an aspiration."
    for (const month of ['2023-06-01', '2024-11-01', '2025-03-01', '2026-01-01', '2026-03-01']) {
      const monthly = await openSemanticSession(harness.db, CFO_USER, month);
      for (const id of ['revenue', 'cogs', 'gross_profit', 'opex', 'net_profit']) {
        const parts = DIVISION_CODES.reduce(
          (sum, division) => sum + (resolveKpi(monthly, id, division).value?.toNumber() ?? 0),
          0,
        );
        const total = resolveKpi(monthly, id, 'ARG_TOTAL').value?.toNumber() ?? 0;
        expect(Math.abs(parts - total), `${id} in ${month}`).toBeLessThanOrEqual(DOLLAR);
      }
    }
  });
});

describe('YTD conventions and run rates', () => {
  it.each([...DIVISION_CODES, 'ARG_TOTAL'])('%s YTD revenue and margins', (division) => {
    const expected = YTD_MARCH_2026[division]!;

    // YTD gross margin × YTD revenue recovers YTD gross profit, which is how the
    // YTD window itself is verified.
    const ytdGrossMargin = valueOf('ytd_gross_margin_pct', division);
    const impliedGrossProfit = ytdGrossMargin * expected.revenue;
    expect(Math.abs(impliedGrossProfit - expected.grossProfit)).toBeLessThanOrEqual(DOLLAR * 2);

    const ytdNetMargin = valueOf('ytd_net_margin_pct', division);
    const impliedNetProfit = ytdNetMargin * expected.revenue;
    expect(Math.abs(impliedNetProfit - expected.netProfit)).toBeLessThanOrEqual(DOLLAR * 2);
  });

  it.each([...DIVISION_CODES, 'ARG_TOTAL'])('%s revenue run rate annualises YTD', (division) => {
    const expected = YTD_MARCH_2026[division]!;
    expect(
      Math.abs(valueOf('revenue_run_rate', division) - expected.revenueRunRate),
    ).toBeLessThanOrEqual(RUN_RATE_TOLERANCE);
  });

  /**
   * §13.1: "Verify your implementation reproduces the ARG Total figure of
   * roughly $5.64 million and not $6,538,128 — the latter is March alone
   * annualized, which is the wrong method and the single easiest run-rate error
   * to make."
   */
  it('run rate is NOT single-month annualised', () => {
    const runRate = valueOf('revenue_run_rate', 'ARG_TOTAL');
    expect(Math.abs(runRate - YTD_MARCH_2026.ARG_TOTAL!.revenueRunRate)).toBeLessThanOrEqual(
      RUN_RATE_TOLERANCE,
    );

    const singleMonthAnnualised = MARCH_2026.ARG_TOTAL!.revenue * 12;
    expect(Math.abs(singleMonthAnnualised - KNOWN_WRONG_ANSWERS.argTotalRunRateIfSingleMonthAnnualised))
      .toBeLessThanOrEqual(100);
    // The two methods differ by ~$900K. Nothing can conflate them.
    expect(Math.abs(runRate - singleMonthAnnualised)).toBeGreaterThan(800_000);
  });

  it('adds the true annualised dollar run rates the Excel is missing (Defect 5)', () => {
    const expected = YTD_MARCH_2026.ARG_TOTAL!;
    expect(Math.abs(valueOf('gross_profit_run_rate', 'ARG_TOTAL') - expected.grossProfit * 4))
      .toBeLessThanOrEqual(RUN_RATE_TOLERANCE);
    expect(Math.abs(valueOf('net_profit_run_rate', 'ARG_TOTAL') - expected.netProfit * 4))
      .toBeLessThanOrEqual(RUN_RATE_TOLERANCE);
  });
});

describe('§7 period conventions', () => {
  it('prior year is the same calendar month a year earlier, not a trailing twelve', async () => {
    const marchSession = await openSemanticSession(harness.db, CFO_USER, '2026-03-01');
    const priorYear = resolveKpi(marchSession, 'revenue', 'ARG_TOTAL', {
      month: marchSession.period.priorYearMonth,
    });
    expect(marchSession.period.priorYearMonth).toBe('2025-03-01');

    const march2025 = await openSemanticSession(harness.db, CFO_USER, '2025-03-01');
    expect(priorYear.value!.toNumber()).toBeCloseTo(
      resolveKpi(march2025, 'revenue', 'ARG_TOTAL').value!.toNumber(),
      2,
    );
  });

  it('YTD runs January through the selected month, inclusive', () => {
    expect(session.period.ytdMonths).toEqual(['2026-01-01', '2026-02-01', '2026-03-01']);
    expect(session.period.monthsElapsed).toBe(3);
  });

  it('PY YTD covers comparable periods only', () => {
    // "Never full prior year against partial current year."
    expect(session.period.priorYearYtdMonths).toEqual(['2025-01-01', '2025-02-01', '2025-03-01']);
    expect(session.period.priorYearYtdMonths).toHaveLength(session.period.ytdMonths.length);
  });

  it('days in month is actual calendar days, not 30', () => {
    expect(session.period.daysInMonth).toBe(31);
  });
});

describe('Defect 6 — Cash Runway variants', () => {
  it('defaults to single-month OpEx so it ties to the Excel', () => {
    const single = valueOf('cash_runway', 'ARG_TOTAL');
    expect(single).toBeGreaterThan(0);
  });

  it('offers a trailing-three-month-average variant that differs from the default', () => {
    const single = valueOf('cash_runway', 'ARG_TOTAL');
    const trailing = valueOf('cash_runway', 'ARG_TOTAL', { variant: 'trailing_3m' });
    // ARG Total OpEx ran 177K / 145K / 153K, so the two must not coincide.
    expect(trailing).not.toBeCloseTo(single, 3);
  });

  it('uses an OpEx-only denominator, not OpEx plus COGS', () => {
    const runway = resolveKpi(session, 'cash_runway', 'ARG_TOTAL');
    const cash = runway.components!.cash!.toNumber();
    const denominator = runway.components!.opex!.toNumber();
    expect(Math.abs(denominator - MARCH_2026.ARG_TOTAL!.opex)).toBeLessThanOrEqual(DOLLAR);
    expect(runway.value!.toNumber()).toBeCloseTo(cash / denominator, 6);
  });
});

describe('Test 3 & 4 — balance sheet and aging controls', () => {
  it('all standing reconciliation checks pass', async () => {
    const summary = await runAllChecks(harness.db);
    const failures = summary.findings.filter((f) => f.status === 'FAIL');
    expect(failures.map((f) => `${f.checkName} ${f.periodMonth ?? ''} ${f.divisionCode ?? ''}`)).toEqual([]);
    expect(summary.passed).toBeGreaterThan(500);
  });

  it('a persisted run is readable as one run, not as its last chunk', async () => {
    // The findings are inserted in chunks, and every reader in the app selects
    // the latest run with `ran_at = (select max(ran_at) ...)`. If each chunk got
    // its own timestamp, that query would return only the final chunk — and a
    // failing control in an earlier one would be invisible everywhere while the
    // status chip reported green. Rule 2 says a failing check must surface.
    const summary = await runAllChecks(harness.db);
    expect(summary.findings.length).toBeGreaterThan(400); // more than one chunk

    await persistFindings(harness.db, summary.findings);

    const [latest] = await harness.db
      .select({ count: sql<number>`count(*)::int` })
      .from(t.reconResult)
      .where(sql`ran_at = (select max(ran_at) from recon_result)`);

    expect(latest!.count).toBe(summary.findings.length);
  });

  it('a failing check in the first chunk is still visible after persisting', async () => {
    const summary = await runAllChecks(harness.db);
    const findings = [...summary.findings];

    // Plant a failure at the very front, where the old chunking bug buried it.
    findings[0] = {
      ...findings[0]!,
      status: 'FAIL',
      detail: 'Planted failure — must remain visible to the latest-run query.',
    };

    await persistFindings(harness.db, findings);

    const visible = await harness.db
      .select({ detail: t.reconResult.detail })
      .from(t.reconResult)
      .where(sql`status = 'FAIL' and ran_at = (select max(ran_at) from recon_result)`);

    expect(visible.map((row) => row.detail)).toContain(
      'Planted failure — must remain visible to the latest-run query.',
    );
  });

  it('DSO uses actual calendar days and the month-end A/R balance', () => {
    const dso = resolveKpi(session, 'dso', 'SHRC');
    const ar = dso.components!.accountsReceivable!.toNumber();
    const revenue = dso.components!.revenue!.toNumber();
    expect(dso.value!.toNumber()).toBeCloseTo((ar / revenue) * 31, 6);
  });

  it('CCC is DSO minus DPO with no inventory term', () => {
    const ccc = resolveKpi(session, 'ccc', 'ARG_TOTAL');
    expect(ccc.value!.toNumber()).toBeCloseTo(
      ccc.components!.dso!.toNumber() - ccc.components!.dpo!.toNumber(),
      6,
    );
  });
});

describe('§7 direction flags', () => {
  it('marks spending measures as lower-is-better', () => {
    // A blanket "green above 100%" rule would paint an overspending month green.
    for (const id of ['cogs', 'opex', 'payroll_direct', 'payroll_expense', 'cost_per_lead', 'customer_acquisition_cost']) {
      expect(resolveKpi(session, id, 'ARG_TOTAL').higherIsBetter, id).toBe(false);
    }
    for (const id of ['revenue', 'gross_profit', 'net_profit', 'dollars_booked', 'pipeline_value']) {
      expect(resolveKpi(session, id, 'ARG_TOTAL').higherIsBetter, id).toBe(true);
    }
  });
});

describe('§11 — refuse rather than estimate', () => {
  it('withholds Customer Onboarding Time rather than substituting a proxy', () => {
    const result = resolveKpi(session, 'customer_onboarding_time', 'ARG_TOTAL');
    expect(result.value).toBeNull();
    expect(result.unavailable?.reason).toBe('DEFERRED_TO_PHASE_2');
    expect(result.formatted).toBe('—');
  });

  it('returns a typed unavailable, never zero, for a period with no data', async () => {
    const empty = await openSemanticSession(harness.db, CFO_USER, '2019-05-01');
    const result = resolveKpi(empty, 'revenue', 'ARG_TOTAL');
    expect(result.value).toBeNull();
    expect(result.unavailable?.reason).toBe('NO_DATA');
    // Defect 1 in one line: a missing figure must not read as $0.
    expect(result.formatted).not.toBe('$0');
  });

  it('rejects an unknown KPI instead of computing something ad hoc', () => {
    expect(() => resolveKpi(session, 'ebitda_margin', 'ARG_TOTAL')).toThrow(/Unknown KPI/);
  });
});

describe('period state', () => {
  it('labels the tie-out month as closed', () => {
    expect(resolveKpi(session, 'revenue', 'ARG_TOTAL').periodState).toBe('CLOSED');
  });

  it('labels April 2026 as open, so answers about it can be marked preliminary', async () => {
    const openSession = await openSemanticSession(harness.db, CFO_USER, '2026-04-01');
    expect(resolveKpi(openSession, 'revenue', 'ARG_TOTAL').periodState).toBe('OPEN');
  });
});

describe('division entitlements are enforced in the data path', () => {
  it('a division manager cannot resolve another division', async () => {
    const scoped = await openSemanticSession(harness.db, CLAIMS_MANAGER_USER, TIE_OUT_MONTH);
    expect(() => resolveKpi(scoped, 'revenue', 'SHRC')).toThrow(ScopeError);
  });

  it('a division manager cannot resolve ARG Total', async () => {
    // The consolidated figure would disclose the three divisions they cannot see.
    const scoped = await openSemanticSession(harness.db, CLAIMS_MANAGER_USER, TIE_OUT_MONTH);
    expect(scoped.consolidatedAvailable).toBe(false);
    expect(() => resolveKpi(scoped, 'revenue', 'ARG_TOTAL')).toThrow(ScopeError);
  });

  it('a division manager sees their own division correctly', async () => {
    const scoped = await openSemanticSession(harness.db, CLAIMS_MANAGER_USER, TIE_OUT_MONTH);
    const revenue = resolveKpi(scoped, 'revenue', 'CLAIMS').value!.toNumber();
    expect(Math.abs(revenue - MARCH_2026.CLAIMS!.revenue)).toBeLessThanOrEqual(DOLLAR);
  });
});

describe('every KPI resolves without throwing', () => {
  it('the full registry produces either a value or a typed unavailable', () => {
    for (const definition of KPI_REGISTRY) {
      const result = resolveKpi(session, definition.id, 'ARG_TOTAL');
      const resolved = result.value !== null || result.unavailable !== undefined;
      expect(resolved, `${definition.id} returned neither a value nor a reason`).toBe(true);
      if (result.value === null) {
        expect(result.unavailable!.detail.length, `${definition.id} unavailable with no explanation`)
          .toBeGreaterThan(20);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The workbook's own KPI tab
// ---------------------------------------------------------------------------

describe("ARG's workbook KPI tab reproduces exactly", () => {
  const DIVISIONS = ['SHRC', 'CLAIMS', 'TP', 'LITS', 'ARG_TOTAL'];

  it.each(DIVISIONS)('%s gross and net margin match the spreadsheet', (division) => {
    const expected = WORKBOOK_KPI_MARCH_2026[division]!;

    // Tolerance is the spec's own $1 rounding, expressed as a margin: these
    // figures are computed from YTD dollars that §13.1 publishes rounded, so a
    // margin can differ by at most one dollar over the YTD revenue.
    //
    // A fixed epsilon would be wrong in both directions. TP's YTD net profit is
    // $40, where a dollar of rounding is 2.5% of the numerator and 7e-6 of the
    // margin; ARG Total's is $62,197, where the same dollar is 7e-7. One
    // constant either fails on TP or stops asserting anything at ARG Total.
    const dollar = 1 / YTD_MARCH_2026[division]!.revenue;

    // The workbook labels these "Gross Profit Run Rate %" and "Net Profit Run
    // Rate %". They are year-to-date margins, and this build renamed them —
    // these assertions are what make that a rename rather than a change.
    const grossMargin = valueOf('ytd_gross_margin_pct', division);
    expect(Math.abs(grossMargin - expected.grossMarginPct)).toBeLessThanOrEqual(dollar);

    const netMargin = valueOf('ytd_net_margin_pct', division);
    expect(Math.abs(netMargin - expected.netMarginPct)).toBeLessThanOrEqual(dollar);
  });

  it('the workbook label is carried, so the old name still finds the metric', () => {
    const gross = getKpiDefinition('ytd_gross_margin_pct')!;
    expect(gross.workbookLabel).toBe('Gross Profit Run Rate %');

    const net = getKpiDefinition('ytd_net_margin_pct')!;
    expect(net.workbookLabel).toBe('Net Profit Run Rate %');
  });
});

describe('the change and contribution metrics', () => {
  it('revenue MoM matches the movement between the two months', async () => {
    const current = valueOf('revenue', 'ARG_TOTAL');
    const mom = valueOf('revenue_mom_pct', 'ARG_TOTAL');

    // Recomputed from the two figures the system itself publishes, so this
    // asserts the metric agrees with its own components rather than restating
    // the implementation.
    const priorSession = await openSemanticSession(harness.db, CFO_USER, '2026-02-01');
    const prior = resolveKpi(priorSession, 'revenue', 'ARG_TOTAL').value!.toNumber();

    expect(Math.abs(mom - (current - prior) / prior)).toBeLessThanOrEqual(1e-9);
  });

  it('refuses a percentage change against a negative base', () => {
    // Claims ran a negative net profit through Q1. "Improved by −140%" is a
    // sentence with no meaning, so the metric declines to produce one.
    const result = resolveKpi(session, 'net_profit_mom_pct', 'CLAIMS');
    expect(result.value).toBeNull();
    expect(result.unavailable!.detail).toMatch(/negative/i);
    // And it still says what the movement was, in dollars, which does mean
    // something.
    expect(result.unavailable!.detail).toMatch(/dollars/i);
  });

  it('division revenue contributions sum to 100%', () => {
    const shares = ['SHRC', 'CLAIMS', 'TP', 'LITS'].map((division) =>
      resolveKpi(session, 'revenue_contribution_pct', division).value!.toNumber(),
    );
    const total = shares.reduce((sum, share) => sum + share, 0);
    expect(Math.abs(total - 1)).toBeLessThanOrEqual(1e-9);
  });

  it('contribution is unavailable at ARG Total rather than reading 100%', () => {
    const result = resolveKpi(session, 'revenue_contribution_pct', 'ARG_TOTAL');
    expect(result.value).toBeNull();
    expect(result.unavailable!.reason).toBe('NOT_AVAILABLE_BY_DIVISION');
  });
});
