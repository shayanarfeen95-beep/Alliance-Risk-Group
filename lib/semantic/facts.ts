/**
 * Fact loading for the semantic layer.
 *
 * Everything a set of KPIs needs for one reporting context is loaded once into a
 * bundle, then the KPI definitions compute from it. ARG's data is small — 39
 * months × 4 divisions is 156 P&L rows — so this is both faster than per-KPI
 * queries and far easier to test: a KPI is a pure function of (period, bundle,
 * divisions).
 *
 * Division entitlements are applied HERE, at load time. A KPI cannot reach data
 * the caller was not entitled to, because it was never loaded.
 */
import Decimal from 'decimal.js';
import { and, gte, inArray, lte, eq, notInArray, sql } from 'drizzle-orm';
import { getDataMode, seedLoadRunIds } from '@/lib/data-mode';
import { d } from '@/lib/money';
import * as t from '@/lib/db/schema';
import type { Database } from '@/lib/db/client';
import {
  addMonths,
  monthBounds,
  monthRange,
  type MonthKey,
  type PeriodContext,
} from './periods';

export interface DivisionRow {
  divisionCode: string;
  divisionName: string;
  lineOfBusiness: string;
  sortOrder: number;
}

export interface PlMeasures {
  revenue: Decimal;
  /** MEMO — already inside cogs. */
  payrollDirect: Decimal;
  cogs: Decimal;
  /** MEMO — already inside opex. */
  payrollExpense: Decimal;
  opex: Decimal;
}

export interface BsMeasures {
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

export interface GlDetail {
  accountId: string;
  accountName: string;
  reportingLine: string | null;
  amount: Decimal;
}

export interface DealRecord {
  dealId: string;
  divisionCode: string | null;
  dealName: string | null;
  amount: Decimal;
  dealstage: string | null;
  pipeline: string | null;
  isClosedWon: boolean;
  isClosed: boolean;
  createdate: Date | null;
  closedate: Date | null;
  enteredProposalAt: Date | null;
  ownerId: string | null;
  ownerName: string | null;
}

export interface ContactRecord {
  contactId: string;
  divisionCode: string | null;
  lifecycleStage: string | null;
  originalSource: string | null;
  becameLeadDate: Date | null;
  becameCustomerDate: Date | null;
}

export interface MeetingRecord {
  meetingId: string;
  divisionCode: string | null;
  meetingDate: Date;
  outcome: string | null;
  ownerId: string | null;
  associatedDealId: string | null;
}

export interface ConfigValue {
  value: string | null;
  isConfirmed: boolean;
  description: string | null;
}

export interface FactBundle {
  divisions: DivisionRow[];
  /** Division codes the caller is entitled to. */
  allowedDivisions: string[];
  periodState: Map<MonthKey, { isClosed: boolean; daysInMonth: number }>;
  pl: Map<string, PlMeasures>;
  bs: Map<string, BsMeasures>;
  agingBuckets: Map<string, Map<string, Decimal>>;
  budget: Map<string, Decimal>;
  headcount: Map<string, Decimal>;
  marketingSpend: Map<string, Decimal>;
  salesAndMarketingSpend: Map<string, Decimal>;
  gl: Map<string, GlDetail[]>;
  deals: DealRecord[];
  proposalEntries: Array<{ dealId: string; divisionCode: string | null; enteredAt: Date }>;
  contacts: ContactRecord[];
  meetings: MeetingRecord[];
  config: Map<string, ConfigValue>;
  lastRefreshedAt: Date | null;
}

export const key = (month: MonthKey, division: string) => `${month}|${division}`;

const ZERO_PL: PlMeasures = {
  revenue: new Decimal(0),
  payrollDirect: new Decimal(0),
  cogs: new Decimal(0),
  payrollExpense: new Decimal(0),
  opex: new Decimal(0),
};

export function emptyPl(): PlMeasures {
  return { ...ZERO_PL };
}

/**
 * The window of months a bundle must cover for a given reporting context.
 * Trailing 15 months (the Finance trend block), the prior-year YTD, and the
 * budget year all have to be present or a comparison silently reads as zero.
 */
function bundleMonths(period: PeriodContext): MonthKey[] {
  const earliest = [
    period.trailingFifteenMonths[0]!,
    period.priorYearYtdMonths[0] ?? period.priorYearMonth,
    period.ytdMonths[0]!,
  ].sort()[0]!;
  // Budget comparisons can reach the end of the budget year.
  const latest = `${period.fiscalYear}-12-01`;
  return monthRange(earliest, latest > period.month ? latest : period.month);
}

export async function loadFactBundle(
  db: Database,
  period: PeriodContext,
  allowedDivisions: string[],
): Promise<FactBundle> {
  const months = bundleMonths(period);
  const from = months[0]!;
  const to = months[months.length - 1]!;

  const divisions = await db
    .select({
      divisionCode: t.dimDivision.divisionCode,
      divisionName: t.dimDivision.divisionName,
      lineOfBusiness: t.dimDivision.lineOfBusiness,
      sortOrder: t.dimDivision.sortOrder,
    })
    .from(t.dimDivision)
    .where(eq(t.dimDivision.isActive, true))
    .orderBy(t.dimDivision.sortOrder);

  const scoped = divisions.filter((row) => allowedDivisions.includes(row.divisionCode));
  const scopedCodes = scoped.map((row) => row.divisionCode);

  // Nothing entitled: return an empty bundle rather than an unscoped one.
  if (scopedCodes.length === 0) {
    return {
      divisions: [],
      allowedDivisions: [],
      periodState: new Map(),
      pl: new Map(),
      bs: new Map(),
      agingBuckets: new Map(),
      budget: new Map(),
      headcount: new Map(),
      marketingSpend: new Map(),
      salesAndMarketingSpend: new Map(),
      gl: new Map(),
      deals: [],
      proposalEntries: [],
      contacts: [],
      meetings: [],
      config: new Map(),
      lastRefreshedAt: null,
    };
  }

  const inWindow = (column: never) => and(gte(column, from), lte(column, to));

  /**
   * In LIVE mode, seeded rows are excluded from every read.
   *
   * Applied here rather than in each dashboard because this is the one place
   * facts enter the system: a view that forgot the filter would show fabricated
   * figures on a screen labelled live, and nothing would catch it. Every seeded
   * row carries the id of the SEED load run, including the tables with no
   * source_system column of their own, so one predicate covers all of them.
   */
  const seedRuns = (await getDataMode(db)) === 'LIVE' ? await seedLoadRunIds(db) : [];
  const excludeSeed = (column: never) =>
    seedRuns.length ? notInArray(column, seedRuns) : undefined;

  const [
    periodRows,
    plRows,
    bsRows,
    agingRows,
    budgetRows,
    headcountRows,
    glRows,
    configRows,
    lastRun,
  ] = await Promise.all([
    db.select().from(t.dimPeriod),
    db
      .select()
      .from(t.factPlActual)
      .where(
        and(
          inWindow(t.factPlActual.periodMonth as never),
          inArray(t.factPlActual.divisionCode, scopedCodes),
          excludeSeed(t.factPlActual.loadRunId as never),
        ),
      ),
    db
      .select()
      .from(t.factBsActual)
      .where(
        and(
          inWindow(t.factBsActual.periodMonth as never),
          inArray(t.factBsActual.divisionCode, scopedCodes),
          excludeSeed(t.factBsActual.loadRunId as never),
        ),
      ),
    db
      .select()
      .from(t.factAging)
      .where(
        and(
          inWindow(t.factAging.periodMonth as never),
          inArray(t.factAging.divisionCode, scopedCodes),
          excludeSeed(t.factAging.loadRunId as never),
        ),
      ),
    db
      .select()
      .from(t.factBudget)
      .where(
        and(
          inArray(t.factBudget.divisionCode, scopedCodes),
          excludeSeed(t.factBudget.loadRunId as never),
        ),
      ),
    db
      .select()
      .from(t.factHeadcount)
      .where(
        and(
          inWindow(t.factHeadcount.periodMonth as never),
          inArray(t.factHeadcount.divisionCode, scopedCodes),
          excludeSeed(t.factHeadcount.loadRunId as never),
        ),
      ),
    db
      .select({
        periodMonth: t.factGlBalance.periodMonth,
        divisionCode: t.factGlBalance.divisionCode,
        accountId: t.factGlBalance.accountId,
        amount: t.factGlBalance.amount,
        accountName: t.dimAccount.accountName,
        reportingLine: t.dimAccount.reportingLine,
      })
      .from(t.factGlBalance)
      .innerJoin(t.dimAccount, eq(t.dimAccount.accountId, t.factGlBalance.accountId))
      .where(
        and(
          inWindow(t.factGlBalance.periodMonth as never),
          inArray(t.factGlBalance.divisionCode, scopedCodes),
          excludeSeed(t.factGlBalance.loadRunId as never),
        ),
      ),
    db.select().from(t.appConfig),
    db
      .select({ finishedAt: t.loadRun.finishedAt })
      .from(t.loadRun)
      .where(
        and(
          eq(t.loadRun.status, 'SUCCEEDED'),
          excludeSeed(t.loadRun.id as never),
        ),
      )
      .orderBy(sql`${t.loadRun.finishedAt} desc nulls last`)
      .limit(1),
  ]);

  // HubSpot records are timestamped, not month-keyed, so they are loaded by a
  // date window covering the trailing period the dashboards can reach.
  const hubspotFrom = monthBounds(addMonths(period.month, -23)).start;
  const hubspotTo = monthBounds(period.month).endExclusive;

  const [dealRows, proposalRows, contactRows, meetingRows] = await Promise.all([
    db.select().from(t.factDeal).where(excludeSeed(t.factDeal.loadRunId as never)),
    db
      .select({
        dealId: t.factDealStageHistory.dealId,
        enteredAt: t.factDealStageHistory.enteredAt,
        divisionCode: t.factDeal.divisionCode,
      })
      .from(t.factDealStageHistory)
      .innerJoin(t.factDeal, eq(t.factDeal.dealId, t.factDealStageHistory.dealId))
      .where(
        and(
          // §6: New Proposals Sent counts deals ENTERING the Proposal stage.
          eq(t.factDealStageHistory.stage, 'proposalsent'),
          gte(t.factDealStageHistory.enteredAt, hubspotFrom),
          lte(t.factDealStageHistory.enteredAt, hubspotTo),
          excludeSeed(t.factDealStageHistory.loadRunId as never),
        ),
      ),
    db.select().from(t.factContact).where(excludeSeed(t.factContact.loadRunId as never)),
    db
      .select()
      .from(t.factMeeting)
      .where(
        and(
          gte(t.factMeeting.meetingDate, hubspotFrom),
          lte(t.factMeeting.meetingDate, hubspotTo),
          excludeSeed(t.factMeeting.loadRunId as never),
        ),
      ),
  ]);

  // --- Shape into lookup maps ---------------------------------------------

  const periodState = new Map<MonthKey, { isClosed: boolean; daysInMonth: number }>();
  for (const row of periodRows) {
    periodState.set(row.periodMonth, { isClosed: row.isClosed, daysInMonth: row.daysInMonth });
  }

  const pl = new Map<string, PlMeasures>();
  for (const row of plRows) {
    pl.set(key(row.periodMonth, row.divisionCode), {
      revenue: d(row.revenue),
      payrollDirect: d(row.payrollDirect),
      cogs: d(row.cogs),
      payrollExpense: d(row.payrollExpense),
      opex: d(row.opex),
    });
  }

  const bs = new Map<string, BsMeasures>();
  for (const row of bsRows) {
    bs.set(key(row.periodMonth, row.divisionCode), {
      cash: d(row.cash),
      accountsReceivable: d(row.accountsReceivable),
      otherCurrentAssets: d(row.otherCurrentAssets),
      fixedAssets: d(row.fixedAssets),
      accountsPayable: d(row.accountsPayable),
      ccLiability: d(row.ccLiability),
      otherCurrentLiabilities: d(row.otherCurrentLiabilities),
      ltLiabilities: d(row.ltLiabilities),
      shareholderEquity: d(row.shareholderEquity),
    });
  }

  const agingBuckets = new Map<string, Map<string, Decimal>>();
  for (const row of agingRows) {
    const k = `${row.periodMonth}|${row.divisionCode}|${row.kind}`;
    const buckets = agingBuckets.get(k) ?? new Map<string, Decimal>();
    buckets.set(row.bucket, d(row.amount));
    agingBuckets.set(k, buckets);
  }

  const budget = new Map<string, Decimal>();
  for (const row of budgetRows) {
    budget.set(
      `${row.scenarioCode}|${row.periodMonth}|${row.divisionCode}|${row.lineItem}`,
      d(row.amount),
    );
  }

  const headcount = new Map<string, Decimal>();
  for (const row of headcountRows) {
    headcount.set(key(row.periodMonth, row.divisionCode), d(row.headcount));
  }

  const gl = new Map<string, GlDetail[]>();
  for (const row of glRows) {
    const k = key(row.periodMonth, row.divisionCode);
    const list = gl.get(k) ?? [];
    list.push({
      accountId: row.accountId,
      accountName: row.accountName,
      reportingLine: row.reportingLine,
      amount: d(row.amount),
    });
    gl.set(k, list);
  }

  const config = new Map<string, ConfigValue>();
  for (const row of configRows) {
    config.set(row.key, {
      value: row.value,
      isConfirmed: row.isConfirmed,
      description: row.description,
    });
  }

  // §6 Marketing: spend resolves to the agreed account sets, which are config,
  // not code. CAC's numerator is a different set from CPL's and ROAS's.
  const marketingAccounts = parseAccountList(config.get('MARKETING_SPEND_ACCOUNTS')?.value);
  const salesMarketingAccounts = parseAccountList(
    config.get('SALES_AND_MARKETING_SPEND_ACCOUNTS')?.value,
  );

  const marketingSpend = new Map<string, Decimal>();
  const salesAndMarketingSpend = new Map<string, Decimal>();
  for (const [k, details] of gl) {
    let marketing = new Decimal(0);
    let salesMarketing = new Decimal(0);
    for (const detail of details) {
      if (marketingAccounts.has(detail.accountId)) marketing = marketing.plus(detail.amount);
      if (salesMarketingAccounts.has(detail.accountId)) {
        salesMarketing = salesMarketing.plus(detail.amount);
      }
    }
    marketingSpend.set(k, marketing);
    salesAndMarketingSpend.set(k, salesMarketing);
  }

  const inScope = (divisionCode: string | null) =>
    divisionCode === null || scopedCodes.includes(divisionCode);

  return {
    divisions: scoped,
    allowedDivisions: scopedCodes,
    periodState,
    pl,
    bs,
    agingBuckets,
    budget,
    headcount,
    marketingSpend,
    salesAndMarketingSpend,
    gl,
    deals: dealRows.filter((row) => inScope(row.divisionCode)).map((row) => ({
      dealId: row.dealId,
      divisionCode: row.divisionCode,
      dealName: row.dealName,
      amount: d(row.amount),
      dealstage: row.dealstage,
      pipeline: row.pipeline,
      isClosedWon: row.isClosedWon,
      isClosed: row.isClosed,
      createdate: row.createdate,
      closedate: row.closedate,
      enteredProposalAt: row.enteredProposalAt,
      ownerId: row.ownerId,
      ownerName: row.ownerName,
    })),
    proposalEntries: proposalRows.filter((row) => inScope(row.divisionCode)),
    contacts: contactRows.filter((row) => inScope(row.divisionCode)).map((row) => ({
      contactId: row.contactId,
      divisionCode: row.divisionCode,
      lifecycleStage: row.lifecycleStage,
      originalSource: row.originalSource,
      becameLeadDate: row.becameLeadDate,
      becameCustomerDate: row.becameCustomerDate,
    })),
    meetings: meetingRows.filter((row) => inScope(row.divisionCode)).map((row) => ({
      meetingId: row.meetingId,
      divisionCode: row.divisionCode,
      meetingDate: row.meetingDate,
      outcome: row.outcome,
      ownerId: row.ownerId,
      associatedDealId: row.associatedDealId,
    })),
    config,
    lastRefreshedAt: lastRun[0]?.finishedAt ?? null,
  };
}

function parseAccountList(value: string | null | undefined): Set<string> {
  if (!value) return new Set();
  return new Set(
    value
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
  );
}

// ---------------------------------------------------------------------------
// Aggregation helpers used by the KPI definitions
// ---------------------------------------------------------------------------

/** Sums the P&L measures for a set of divisions in one month. */
export function sumPl(bundle: FactBundle, month: MonthKey, divisions: string[]): PlMeasures {
  const total = emptyPl();
  for (const division of divisions) {
    const row = bundle.pl.get(key(month, division));
    if (!row) continue;
    total.revenue = total.revenue.plus(row.revenue);
    total.payrollDirect = total.payrollDirect.plus(row.payrollDirect);
    total.cogs = total.cogs.plus(row.cogs);
    total.payrollExpense = total.payrollExpense.plus(row.payrollExpense);
    total.opex = total.opex.plus(row.opex);
  }
  return total;
}

/** Sums the P&L measures across many months — the YTD and trailing aggregations. */
export function sumPlOverMonths(
  bundle: FactBundle,
  months: MonthKey[],
  divisions: string[],
): PlMeasures {
  const total = emptyPl();
  for (const month of months) {
    const monthly = sumPl(bundle, month, divisions);
    total.revenue = total.revenue.plus(monthly.revenue);
    total.payrollDirect = total.payrollDirect.plus(monthly.payrollDirect);
    total.cogs = total.cogs.plus(monthly.cogs);
    total.payrollExpense = total.payrollExpense.plus(monthly.payrollExpense);
    total.opex = total.opex.plus(monthly.opex);
  }
  return total;
}

/** True when at least one division reported for the month. */
export function hasPl(bundle: FactBundle, month: MonthKey, divisions: string[]): boolean {
  return divisions.some((division) => bundle.pl.has(key(month, division)));
}

export function sumBs(
  bundle: FactBundle,
  month: MonthKey,
  divisions: string[],
): BsMeasures | null {
  const present = divisions.filter((division) => bundle.bs.has(key(month, division)));
  if (present.length === 0) return null;

  const total: BsMeasures = {
    cash: new Decimal(0),
    accountsReceivable: new Decimal(0),
    otherCurrentAssets: new Decimal(0),
    fixedAssets: new Decimal(0),
    accountsPayable: new Decimal(0),
    ccLiability: new Decimal(0),
    otherCurrentLiabilities: new Decimal(0),
    ltLiabilities: new Decimal(0),
    shareholderEquity: new Decimal(0),
  };

  for (const division of present) {
    const row = bundle.bs.get(key(month, division))!;
    for (const field of Object.keys(total) as Array<keyof BsMeasures>) {
      total[field] = total[field].plus(row[field]);
    }
  }
  return total;
}

export function sumBudget(
  bundle: FactBundle,
  scenario: string,
  months: MonthKey[],
  divisions: string[],
  lineItem: 'revenue' | 'cogs' | 'opex',
): Decimal {
  let total = new Decimal(0);
  for (const month of months) {
    for (const division of divisions) {
      total = total.plus(bundle.budget.get(`${scenario}|${month}|${division}|${lineItem}`) ?? 0);
    }
  }
  return total;
}

/** True when any budget row exists for the scenario in the window. */
export function hasBudget(
  bundle: FactBundle,
  scenario: string,
  months: MonthKey[],
  divisions: string[],
): boolean {
  return months.some((month) =>
    divisions.some((division) =>
      (['revenue', 'cogs', 'opex'] as const).some((line) =>
        bundle.budget.has(`${scenario}|${month}|${division}|${line}`),
      ),
    ),
  );
}

export function sumSpend(
  map: Map<string, Decimal>,
  months: MonthKey[],
  divisions: string[],
): Decimal {
  let total = new Decimal(0);
  for (const month of months) {
    for (const division of divisions) {
      total = total.plus(map.get(key(month, division)) ?? 0);
    }
  }
  return total;
}
