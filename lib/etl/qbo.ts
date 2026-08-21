import 'server-only';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import Decimal from 'decimal.js';
import type { Database } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import { rollUpGl, type ReportingLine } from './rollup';

/**
 * QuickBooks raw → facts.
 *
 * The same gap HubSpot had: a confirmed pull landed Intuit's report JSON and
 * stopped. This walks that JSON into `fact_pl_actual`, `fact_gl_balance`,
 * `fact_bs_actual` and `fact_aging`, and keeps the chart of accounts current.
 *
 * Three things here are load-bearing:
 *
 *   1. **A class becomes a division only through the mapping.** `dim_division`
 *      carries the QuickBooks class ids for each division. A class nobody has
 *      mapped is counted and reported, never folded into "other" — the same
 *      rule as HubSpot's division attribution, for the same reason.
 *   2. **An account becomes a reporting line only through `dim_account`.** An
 *      unmapped account is reported and its amount excluded rather than guessed
 *      into OpEx, because a guess here silently moves profit.
 *   3. **Payroll stays a memo.** Conform writes the five lines as QuickBooks
 *      reports them and lets `rollUpGl` place payroll inside COGS and OpEx.
 *      Nothing here subtracts payroll a second time.
 */

export interface QboConformResult {
  entity: string;
  written: number;
  /** Classes present in the report that map to no division. */
  unmappedClasses: string[];
  /** Accounts present in the report that carry no reporting line. */
  unmappedAccounts: string[];
  /** Months touched, for the message. */
  months: string[];
}

interface RawRow {
  payload: unknown;
  loadRunId?: string | null;
  /** The month this report covers, when the connector recorded one. */
  key?: string | null;
}

// ---------------------------------------------------------------------------
// Intuit's report shape
// ---------------------------------------------------------------------------

interface ReportColumn {
  ColTitle?: string;
  ColType?: string;
  MetaData?: Array<{ Name?: string; Value?: string }>;
}

interface ColDatum {
  value?: string;
  id?: string;
}

interface ReportRow {
  Header?: { ColData?: ColDatum[] };
  Rows?: { Row?: ReportRow[] };
  Summary?: { ColData?: ColDatum[] };
  ColData?: ColDatum[];
  type?: string;
  group?: string;
}

interface QboReport {
  Header?: { ReportName?: string; StartPeriod?: string; EndPeriod?: string };
  Columns?: { Column?: ReportColumn[] };
  Rows?: { Row?: ReportRow[] };
}

/** One figure, at the grain Intuit reports it. */
interface Cell {
  accountId: string | null;
  accountName: string;
  /** Index into the column list, which carries the class. */
  column: number;
  amount: Decimal;
  /** The section this row sat under — Income, Expenses, and so on. */
  group: string | null;
}

function money(value: string | undefined): Decimal {
  if (!value) return new Decimal(0);
  const cleaned = value.replace(/[$,\s]/g, '');
  if (!cleaned || cleaned === '-') return new Decimal(0);
  try {
    // Accounting-style negatives: (1,234.56)
    const negative = cleaned.startsWith('(') && cleaned.endsWith(')');
    const parsed = new Decimal(negative ? cleaned.slice(1, -1) : cleaned);
    return negative ? parsed.negated() : parsed;
  } catch {
    return new Decimal(0);
  }
}

/**
 * Walks a QuickBooks report to its data rows.
 *
 * Intuit nests sections arbitrarily deep and repeats each section's total in a
 * `Summary` row. Summaries are skipped: adding them to the detail lines would
 * double every figure, which is the classic way to read one of these wrong.
 */
function flatten(rows: ReportRow[] | undefined, group: string | null, out: Cell[]): void {
  for (const row of rows ?? []) {
    const rowGroup = row.group ?? row.Header?.ColData?.[0]?.value ?? group;

    if (row.ColData && row.type !== 'Section') {
      const [first, ...rest] = row.ColData;
      const accountName = first?.value?.trim() ?? '';
      if (accountName) {
        rest.forEach((cell, index) => {
          const amount = money(cell?.value);
          if (!amount.isZero()) {
            out.push({
              accountId: first?.id ?? null,
              accountName,
              // rest is offset by one — column 0 is the row label.
              column: index + 1,
              amount,
              group: rowGroup ?? null,
            });
          }
        });
      }
    }

    if (row.Rows?.Row) flatten(row.Rows.Row, rowGroup ?? null, out);
  }
}

/** The class id each column belongs to, by column index. */
function classByColumn(report: QboReport): Map<number, { id: string | null; title: string }> {
  const map = new Map<number, { id: string | null; title: string }>();

  (report.Columns?.Column ?? []).forEach((column, index) => {
    const title = (column.ColTitle ?? '').trim();
    if (!title) return;
    const classRef = column.MetaData?.find(
      (meta) => meta.Name === 'ClassRef' || meta.Name === 'ID',
    )?.Value;
    map.set(index, { id: classRef ?? null, title });
  });

  return map;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

interface DivisionLookup {
  /** QuickBooks class id → division code. */
  byClassId: Map<string, string>;
  /** Lower-cased class name or legacy code → division code. */
  byName: Map<string, string>;
  codes: string[];
}

export async function loadDivisionLookup(db: Database): Promise<DivisionLookup> {
  const rows = await db.select().from(t.dimDivision).where(eq(t.dimDivision.isActive, true));

  const byClassId = new Map<string, string>();
  const byName = new Map<string, string>();

  for (const row of rows) {
    for (const classId of row.qboClassIds ?? []) byClassId.set(classId, row.divisionCode);
    byName.set(row.divisionCode.toLowerCase(), row.divisionCode);
    byName.set(row.divisionName.toLowerCase(), row.divisionCode);
    for (const legacy of row.legacyCodes ?? []) byName.set(legacy.toLowerCase(), row.divisionCode);
  }

  return { byClassId, byName, codes: rows.map((row) => row.divisionCode) };
}

/**
 * The division for one report column, or null.
 *
 * Class id first, because it survives a rename. Then the exact class name, and
 * the legacy codes the workbook used — `dim_division` carries those precisely so
 * the old six-code scheme lands correctly. Nothing looser: a column titled
 * "TOTAL" or "Not Specified" resolves to nothing and is counted as unmapped.
 */
function divisionForColumn(
  lookup: DivisionLookup,
  column: { id: string | null; title: string },
): string | null {
  if (column.id && lookup.byClassId.has(column.id)) return lookup.byClassId.get(column.id)!;
  const byName = lookup.byName.get(column.title.toLowerCase());
  return byName ?? null;
}

const IGNORED_COLUMNS = new Set(['total', 'not specified', '', 'memo', 'account']);

// ---------------------------------------------------------------------------
// Conform
// ---------------------------------------------------------------------------

export async function conformQbo(
  db: Database,
  loadRunId: string,
  entity: string,
  rows: RawRow[],
): Promise<QboConformResult> {
  switch (entity) {
    case 'profit_and_loss':
      return conformProfitAndLoss(db, loadRunId, rows);
    case 'trial_balance':
      return conformTrialBalance(db, loadRunId, rows);
    case 'balance_sheet':
      return conformBalanceSheet(db, loadRunId, rows);
    case 'ar_aging':
      return conformAging(db, loadRunId, rows, 'AR');
    case 'ap_aging':
      return conformAging(db, loadRunId, rows, 'AP');
    case 'accounts':
      return conformAccounts(db, rows);
    default:
      return { entity, written: 0, unmappedClasses: [], unmappedAccounts: [], months: [] };
  }
}

/** The month a report row covers — the record key, else the report header. */
function monthOf(row: RawRow, report: QboReport): string | null {
  const key = row.key ?? report.Header?.StartPeriod ?? null;
  if (!key) return null;
  const match = /^(\d{4})-(\d{2})/.exec(key);
  return match ? `${match[1]}-${match[2]}-01` : null;
}


/**
 * Makes sure the period dimension has a row for this month.
 *
 * Every fact table's month is a foreign key into `dim_period`, so a pull that
 * reaches a month nobody has created fails on the constraint — which is exactly
 * what the constraint is for, but it must not stop a legitimate load. A month
 * created this way is **open**: figures for it are preliminary and every view
 * labels them so. Closing a month stays a deliberate act by a person.
 */
export async function ensurePeriodExists(db: Database, month: string): Promise<void> {
  const [year, monthOfYear] = month.split('-').map(Number) as [number, number];

  await db
    .insert(t.dimPeriod)
    .values({
      periodMonth: month,
      fiscalYear: year,
      monthOfYear,
      daysInMonth: new Date(Date.UTC(year, monthOfYear, 0)).getUTCDate(),
      isClosed: false,
    })
    .onConflictDoNothing();
}

async function reportingLines(db: Database): Promise<Map<string, ReportingLine>> {
  const rows = await db
    .select({ accountId: t.dimAccount.accountId, reportingLine: t.dimAccount.reportingLine })
    .from(t.dimAccount);

  const map = new Map<string, ReportingLine>();
  for (const row of rows) {
    if (row.reportingLine) map.set(row.accountId, row.reportingLine as ReportingLine);
  }
  return map;
}

async function conformProfitAndLoss(
  db: Database,
  loadRunId: string,
  rows: RawRow[],
): Promise<QboConformResult> {
  const lookup = await loadDivisionLookup(db);
  const lines = await reportingLines(db);

  const unmappedClasses = new Set<string>();
  const unmappedAccounts = new Set<string>();
  const months = new Set<string>();
  let written = 0;

  for (const row of rows) {
    const report = row.payload as QboReport;
    const month = monthOf(row, report);
    if (!month) continue;

    const columns = classByColumn(report);
    const cells: Cell[] = [];
    flatten(report.Rows?.Row, null, cells);

    // division → the five lines, accumulated from the account grain.
    const byDivision = new Map<string, Array<{ accountId: string; reportingLine: ReportingLine; amount: Decimal }>>();

    for (const cell of cells) {
      const column = columns.get(cell.column);
      if (!column || IGNORED_COLUMNS.has(column.title.toLowerCase())) continue;

      const divisionCode = divisionForColumn(lookup, column);
      if (!divisionCode) {
        unmappedClasses.add(column.title);
        continue;
      }

      const accountId = cell.accountId;
      const reportingLine = accountId ? lines.get(accountId) : undefined;
      if (!accountId || !reportingLine) {
        // An account with no reporting line is excluded and named, never
        // guessed into a line. Test 8: loads fail loudly on unmapped accounts.
        unmappedAccounts.add(`${cell.accountName}${accountId ? ` (${accountId})` : ''}`);
        continue;
      }

      const bucket = byDivision.get(divisionCode) ?? [];
      bucket.push({ accountId, reportingLine, amount: cell.amount });
      byDivision.set(divisionCode, bucket);
    }

    if (byDivision.size > 0) await ensurePeriodExists(db, month);

    for (const [divisionCode, glRows] of byDivision) {
      const rolled = rollUpGl(glRows);
      months.add(month);

      const values = {
        revenue: rolled.revenue.toFixed(2),
        payrollDirect: rolled.payrollDirect.toFixed(2),
        cogs: rolled.cogs.toFixed(2),
        payrollExpense: rolled.payrollExpense.toFixed(2),
        opex: rolled.opex.toFixed(2),
        basis: 'accrual' as const,
        sourceSystem: 'QBO' as const,
        loadRunId: row.loadRunId ?? loadRunId,
        loadedAt: new Date(),
      };

      await db
        .insert(t.factPlActual)
        .values({ periodMonth: month, divisionCode, ...values })
        .onConflictDoUpdate({
          target: [t.factPlActual.periodMonth, t.factPlActual.divisionCode],
          set: values,
        });
      written += 1;
    }
  }

  return {
    entity: 'profit_and_loss',
    written,
    unmappedClasses: [...unmappedClasses],
    unmappedAccounts: [...unmappedAccounts].slice(0, 20),
    months: [...months].sort(),
  };
}

async function conformTrialBalance(
  db: Database,
  loadRunId: string,
  rows: RawRow[],
): Promise<QboConformResult> {
  const lookup = await loadDivisionLookup(db);
  const known = new Set(
    (await db.select({ accountId: t.dimAccount.accountId }).from(t.dimAccount)).map(
      (row) => row.accountId,
    ),
  );

  const unmappedClasses = new Set<string>();
  const unmappedAccounts = new Set<string>();
  const months = new Set<string>();
  let written = 0;

  for (const row of rows) {
    const report = row.payload as QboReport;
    const month = monthOf(row, report);
    if (!month) continue;

    const columns = classByColumn(report);
    const cells: Cell[] = [];
    flatten(report.Rows?.Row, null, cells);

    for (const cell of cells) {
      const column = columns.get(cell.column);
      if (!column || IGNORED_COLUMNS.has(column.title.toLowerCase())) continue;

      const divisionCode = divisionForColumn(lookup, column);
      if (!divisionCode) {
        unmappedClasses.add(column.title);
        continue;
      }
      if (!cell.accountId || !known.has(cell.accountId)) {
        // fact_gl_balance references dim_account; writing an unknown id would
        // trip the foreign key. Pull the chart of accounts first.
        unmappedAccounts.add(`${cell.accountName}${cell.accountId ? ` (${cell.accountId})` : ''}`);
        continue;
      }

      months.add(month);
      await ensurePeriodExists(db, month);
      const values = {
        amount: cell.amount.toFixed(2),
        basis: 'accrual' as const,
        loadRunId: row.loadRunId ?? loadRunId,
      };

      await db
        .insert(t.factGlBalance)
        .values({ periodMonth: month, divisionCode, accountId: cell.accountId, ...values })
        .onConflictDoUpdate({
          target: [
            t.factGlBalance.periodMonth,
            t.factGlBalance.divisionCode,
            t.factGlBalance.accountId,
          ],
          set: values,
        });
      written += 1;
    }
  }

  return {
    entity: 'trial_balance',
    written,
    unmappedClasses: [...unmappedClasses],
    unmappedAccounts: [...unmappedAccounts].slice(0, 20),
    months: [...months].sort(),
  };
}

/**
 * Balance-sheet groupings, keyed by the `balance_sheet_line` on `dim_account`.
 *
 * Equity is loaded as its own figure rather than plugged as assets minus
 * liabilities — that is what makes the balance check on the Finance dashboard a
 * real assertion instead of an identity that returns zero by construction.
 */
const BS_COLUMNS = [
  'cash',
  'accounts_receivable',
  'other_current_assets',
  'fixed_assets',
  'accounts_payable',
  'cc_liability',
  'other_current_liabilities',
  'lt_liabilities',
  'shareholder_equity',
] as const;

type BsColumn = (typeof BS_COLUMNS)[number];

const BS_FIELD: Record<BsColumn, keyof typeof t.factBsActual.$inferInsert> = {
  cash: 'cash',
  accounts_receivable: 'accountsReceivable',
  other_current_assets: 'otherCurrentAssets',
  fixed_assets: 'fixedAssets',
  accounts_payable: 'accountsPayable',
  cc_liability: 'ccLiability',
  other_current_liabilities: 'otherCurrentLiabilities',
  lt_liabilities: 'ltLiabilities',
  shareholder_equity: 'shareholderEquity',
};

async function conformBalanceSheet(
  db: Database,
  loadRunId: string,
  rows: RawRow[],
): Promise<QboConformResult> {
  const lookup = await loadDivisionLookup(db);

  const accountRows = await db
    .select({
      accountId: t.dimAccount.accountId,
      balanceSheetLine: t.dimAccount.balanceSheetLine,
    })
    .from(t.dimAccount);
  const bsLine = new Map(
    accountRows
      .filter((row) => row.balanceSheetLine)
      .map((row) => [row.accountId, row.balanceSheetLine as BsColumn]),
  );

  const unmappedClasses = new Set<string>();
  const unmappedAccounts = new Set<string>();
  const months = new Set<string>();
  let written = 0;

  for (const row of rows) {
    const report = row.payload as QboReport;
    const month = monthOf(row, report);
    if (!month) continue;

    const columns = classByColumn(report);
    const cells: Cell[] = [];
    flatten(report.Rows?.Row, null, cells);

    const byDivision = new Map<string, Map<BsColumn, Decimal>>();

    for (const cell of cells) {
      const column = columns.get(cell.column);
      if (!column || IGNORED_COLUMNS.has(column.title.toLowerCase())) continue;

      const divisionCode = divisionForColumn(lookup, column);
      if (!divisionCode) {
        unmappedClasses.add(column.title);
        continue;
      }

      const line = cell.accountId ? bsLine.get(cell.accountId) : undefined;
      if (!line) {
        unmappedAccounts.add(`${cell.accountName}${cell.accountId ? ` (${cell.accountId})` : ''}`);
        continue;
      }

      const bucket = byDivision.get(divisionCode) ?? new Map<BsColumn, Decimal>();
      bucket.set(line, (bucket.get(line) ?? new Decimal(0)).plus(cell.amount));
      byDivision.set(divisionCode, bucket);
    }

    if (byDivision.size > 0) await ensurePeriodExists(db, month);

    for (const [divisionCode, totals] of byDivision) {
      months.add(month);
      const values: Record<string, unknown> = {
        loadRunId: row.loadRunId ?? loadRunId,
      };
      for (const column of BS_COLUMNS) {
        values[BS_FIELD[column]] = (totals.get(column) ?? new Decimal(0)).toFixed(2);
      }

      await db
        .insert(t.factBsActual)
        .values({ periodMonth: month, divisionCode, ...values } as typeof t.factBsActual.$inferInsert)
        .onConflictDoUpdate({
          target: [t.factBsActual.periodMonth, t.factBsActual.divisionCode],
          set: values,
        });
      written += 1;
    }
  }

  return {
    entity: 'balance_sheet',
    written,
    unmappedClasses: [...unmappedClasses],
    unmappedAccounts: [...unmappedAccounts].slice(0, 20),
    months: [...months].sort(),
  };
}

/** Intuit's aging columns, in the order the report presents them. */
const AGING_BUCKETS = ['current', '1_30', '31_60', '61_90', 'over_90'] as const;

function bucketForTitle(title: string): (typeof AGING_BUCKETS)[number] | null {
  const normalised = title.toLowerCase();
  if (normalised.includes('current')) return 'current';
  if (/1\s*-\s*30/.test(normalised)) return '1_30';
  if (/31\s*-\s*60/.test(normalised)) return '31_60';
  if (/61\s*-\s*90/.test(normalised)) return '61_90';
  if (normalised.includes('91') || normalised.includes('over')) return 'over_90';
  return null;
}

async function conformAging(
  db: Database,
  loadRunId: string,
  rows: RawRow[],
  kind: 'AR' | 'AP',
): Promise<QboConformResult> {
  const lookup = await loadDivisionLookup(db);
  const unmappedClasses = new Set<string>();
  const months = new Set<string>();
  let written = 0;
  let sawBucketsWithoutClass = false;

  for (const row of rows) {
    const report = row.payload as QboReport;
    const month = monthOf(row, report);
    if (!month) continue;

    const columns = classByColumn(report);
    const cells: Cell[] = [];
    flatten(report.Rows?.Row, null, cells);

    // QuickBooks will summarise an aging report by bucket OR by class, not
    // both. Whichever it returned decides what can be written: bucket columns
    // give ARG-level aging that cannot be attributed to a division, and class
    // columns give divisional totals with no bucket detail. Guessing a split
    // across divisions would put invented numbers on the Finance dashboard.
    const byDivision = new Map<string, Map<string, Decimal>>();

    for (const cell of cells) {
      const column = columns.get(cell.column);
      if (!column || IGNORED_COLUMNS.has(column.title.toLowerCase())) continue;

      const divisionCode = divisionForColumn(lookup, column);
      if (divisionCode) {
        // A classed aging report: the whole column is one division, and the
        // bucket is carried on the row label instead.
        const bucket = bucketForTitle(cell.accountName) ?? 'current';
        const target = byDivision.get(divisionCode) ?? new Map<string, Decimal>();
        target.set(bucket, (target.get(bucket) ?? new Decimal(0)).plus(cell.amount));
        byDivision.set(divisionCode, target);
        continue;
      }

      if (bucketForTitle(column.title)) sawBucketsWithoutClass = true;
      else unmappedClasses.add(column.title);
    }

    if (byDivision.size > 0) await ensurePeriodExists(db, month);

    for (const [divisionCode, buckets] of byDivision) {
      months.add(month);
      for (const [bucket, amount] of buckets) {
        const values = { amount: amount.toFixed(2), loadRunId: row.loadRunId ?? loadRunId };
        await db
          .insert(t.factAging)
          .values({ periodMonth: month, divisionCode, kind, bucket, ...values })
          .onConflictDoUpdate({
            target: [
              t.factAging.periodMonth,
              t.factAging.divisionCode,
              t.factAging.kind,
              t.factAging.bucket,
            ],
            set: values,
          });
        written += 1;
      }
    }
  }

  if (written === 0 && sawBucketsWithoutClass) {
    unmappedClasses.add(
      'the report came back by aging bucket rather than by class, so it carries no division — nothing was written rather than splitting it across divisions',
    );
  }

  return {
    entity: kind === 'AR' ? 'ar_aging' : 'ap_aging',
    written,
    unmappedClasses: [...unmappedClasses],
    unmappedAccounts: [],
    months: [...months].sort(),
  };
}

/**
 * The chart of accounts.
 *
 * New accounts arrive with `reporting_line` NULL — deliberately. An account
 * that appears in QuickBooks between two closes must be classified by a person
 * before its balance counts towards a reporting line; guessing from the account
 * type is how an expense account silently lands in revenue.
 */
async function conformAccounts(db: Database, rows: RawRow[]): Promise<QboConformResult> {
  let written = 0;
  const unmapped: string[] = [];

  for (const row of rows) {
    const payload = row.payload as {
      QueryResponse?: {
        Account?: Array<{
          Id?: string;
          Name?: string;
          AcctNum?: string;
          AccountType?: string;
          Classification?: string;
          ParentRef?: { value?: string };
          Active?: boolean;
        }>;
      };
    };

    for (const account of payload.QueryResponse?.Account ?? []) {
      if (!account.Id || !account.Name) continue;

      const accountType = mapAccountType(account.Classification, account.AccountType);

      await db
        .insert(t.dimAccount)
        .values({
          accountId: account.Id,
          accountNumber: account.AcctNum ?? null,
          accountName: account.Name,
          accountType,
          parentAccountId: account.ParentRef?.value ?? null,
          isActive: account.Active ?? true,
        })
        .onConflictDoUpdate({
          target: t.dimAccount.accountId,
          set: {
            accountNumber: account.AcctNum ?? null,
            accountName: account.Name,
            accountType,
            parentAccountId: account.ParentRef?.value ?? null,
            isActive: account.Active ?? true,
          },
        });
      written += 1;
    }
  }

  // Report what a person still has to classify.
  const pending = await db
    .select({ accountId: t.dimAccount.accountId, accountName: t.dimAccount.accountName })
    .from(t.dimAccount)
    .where(and(eq(t.dimAccount.isActive, true), isNull(t.dimAccount.reportingLine)));

  for (const account of pending.slice(0, 20)) {
    unmapped.push(`${account.accountName} (${account.accountId})`);
  }

  return {
    entity: 'accounts',
    written,
    unmappedClasses: [],
    unmappedAccounts: unmapped,
    months: [],
  };
}

/**
 * Intuit's classification to this warehouse's account type.
 *
 * Note what this does NOT decide: the reporting line. Knowing an account is an
 * expense says nothing about whether it belongs in COGS or OpEx, and that
 * distinction moves gross profit. A person makes it.
 */
function mapAccountType(
  classification: string | undefined,
  accountType: string | undefined,
): 'INCOME' | 'COGS' | 'EXPENSE' | 'ASSET' | 'LIABILITY' | 'EQUITY' {
  const value = `${classification ?? ''} ${accountType ?? ''}`.toLowerCase();
  if (value.includes('cost of goods')) return 'COGS';
  if (value.includes('revenue') || value.includes('income')) return 'INCOME';
  if (value.includes('expense')) return 'EXPENSE';
  if (value.includes('asset')) return 'ASSET';
  if (value.includes('liability')) return 'LIABILITY';
  if (value.includes('equity')) return 'EQUITY';
  return 'EXPENSE';
}

/** One line for the transcript and the load log. */
export function describeQboConform(result: QboConformResult): string {
  if (result.written === 0) {
    return `Nothing conformed for ${result.entity}${
      result.unmappedClasses.length
        ? ` — no QuickBooks class in the report maps to a division (saw: ${result.unmappedClasses
            .slice(0, 5)
            .join(', ')})`
        : ''
    }.`;
  }

  const parts = [`Conformed ${result.written} ${result.entity} rows`];
  if (result.months.length) {
    parts.push(
      `covering ${result.months[0]!.slice(0, 7)}${
        result.months.length > 1 ? ` to ${result.months[result.months.length - 1]!.slice(0, 7)}` : ''
      }`,
    );
  }
  if (result.unmappedClasses.length) {
    parts.push(
      `${result.unmappedClasses.length} class${
        result.unmappedClasses.length === 1 ? '' : 'es'
      } map to no division (${result.unmappedClasses.slice(0, 5).join(', ')}) and were left out`,
    );
  }
  if (result.unmappedAccounts.length) {
    parts.push(
      `${result.unmappedAccounts.length} account${
        result.unmappedAccounts.length === 1 ? '' : 's'
      } carry no reporting line and were excluded rather than guessed`,
    );
  }
  return `${parts.join('. ')}.`;
}

/** Re-runs conform over everything already landed for a QuickBooks entity. */
export async function reconformLandedQbo(
  db: Database,
  entity: string,
): Promise<QboConformResult> {
  const rows = await db
    .select({
      payload: t.rawPayload.payload,
      loadRunId: t.rawPayload.loadRunId,
      entity: t.rawPayload.entity,
    })
    .from(t.rawPayload)
    .where(and(eq(t.rawPayload.sourceSystem, 'QBO'), inArray(t.rawPayload.entity, [entity])));

  if (rows.length === 0) {
    return { entity, written: 0, unmappedClasses: [], unmappedAccounts: [], months: [] };
  }
  return conformQbo(db, rows[0]!.loadRunId, entity, rows);
}
