import 'server-only';
import Decimal from 'decimal.js';
import { eq, sql } from 'drizzle-orm';
import type { Database } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import { rollUpGl, type ReportingLine } from './rollup';
import { lastDayOfMonth, type RawBatch } from '@/lib/connectors/types';

/**
 * Landed data -> the warehouse the dashboards read.
 *
 * Until this file existed, a confirmed extraction wrote the provider's JSON into
 * `raw_payload` and stopped. The load history said SUCCEEDED, the connector was
 * genuinely connected, and every dashboard carried on showing seeded figures —
 * the worst possible combination, because nothing anywhere said the two were
 * unrelated. Conforming is what makes "connect QuickBooks" and "see ARG's
 * numbers" the same sentence.
 *
 * Three rules run through all of it:
 *
 *   1. **Nothing is guessed.** A QuickBooks class that maps to no division, or
 *      an account with no reporting line, stops the load and names what is
 *      unmapped. Dropping either would understate a division — or ARG Total —
 *      by exactly the amount nobody is looking for.
 *   2. **Closed months are skipped, not overwritten.** The database rejects the
 *      write anyway; skipping them deliberately means the run reports what it
 *      did rather than failing halfway through.
 *   3. **The memo relationship is preserved.** payroll_direct and
 *      payroll_expense are components of COGS and OpEx. They are rolled up
 *      through lib/etl/rollup.ts, the same function the seed uses, so there is
 *      no second place where the identity could be got wrong.
 */

export interface ConformOutcome {
  rowsWritten: number;
  /** Things the operator must know: months skipped, entities not yet conformed. */
  notes: string[];
}

/** Raised when the data cannot be conformed without inventing a mapping. */
export class UnmappedSourceDataError extends Error {
  constructor(
    message: string,
    /** The classes that caused it, carried so they can be offered for mapping. */
    public readonly classNames: string[] = [],
  ) {
    super(message);
    this.name = 'UnmappedSourceDataError';
  }
}

const n = (value: Decimal) => value.toFixed(4);

// ---------------------------------------------------------------------------
// Shared lookups
// ---------------------------------------------------------------------------

interface DivisionLookup {
  /** Class id, class name, division name and legacy code, all lowercased. */
  byKey: Map<string, string>;
  /** Classes an administrator has decided are deliberately not a division. */
  excluded: Set<string>;
  codes: string[];
}

async function divisionLookup(db: Database): Promise<DivisionLookup> {
  const rows = await db.select().from(t.dimDivision).where(eq(t.dimDivision.isActive, true));

  const byKey = new Map<string, string>();
  for (const row of rows) {
    const keys = [
      row.divisionCode,
      row.divisionName,
      ...row.legacyCodes,
      ...row.qboClassIds,
    ];
    for (const key of keys) {
      if (key) byKey.set(key.trim().toLowerCase(), row.divisionCode);
    }
  }

  // Decisions an administrator has recorded, which override nothing but extend
  // everything: a class mapped here reaches its division, and one deliberately
  // excluded stops blocking the month it appears in.
  const excluded = new Set<string>();
  for (const row of await db.select().from(t.dimClassMap)) {
    const keys = [row.classKey, row.classId, row.className];
    for (const key of keys) {
      if (!key) continue;
      const normalised = key.trim().toLowerCase();
      if (row.decision === 'MAPPED' && row.divisionCode) byKey.set(normalised, row.divisionCode);
      if (row.decision === 'EXCLUDED') excluded.add(normalised);
    }
  }

  return { byKey, excluded, codes: rows.map((row) => row.divisionCode) };
}

/**
 * The division a report column belongs to.
 *
 * Matched on the QuickBooks class id first, then on the column's visible title.
 * The id is the durable identifier; the title is what an administrator can
 * actually recognise when they have to add a mapping.
 */
function resolveDivision(
  lookup: DivisionLookup,
  classId: string | undefined,
  title: string | undefined,
): string | null {
  const candidates = [classId, title, title?.split(':').pop()];
  for (const candidate of candidates) {
    const key = candidate?.trim().toLowerCase();
    if (key && lookup.byKey.has(key)) return lookup.byKey.get(key)!;
  }
  return null;
}

/** True when somebody has decided this class is deliberately not a division. */
function isExcluded(lookup: DivisionLookup, classId: string | undefined, title: string | undefined): boolean {
  const candidates = [classId, title, title?.split(':').pop()];
  return candidates.some((candidate) => {
    const key = candidate?.trim().toLowerCase();
    return Boolean(key && lookup.excluded.has(key));
  });
}

/** Periods are a dimension with a foreign key; a month must exist to be written. */
async function ensurePeriods(db: Database, months: string[]): Promise<Set<string>> {
  const closed = new Set<string>();

  for (const month of months) {
    const [year, monthOfYear] = month.split('-').map(Number) as [number, number];
    const daysInMonth = new Date(Date.UTC(year, monthOfYear, 0)).getUTCDate();

    await db
      .insert(t.dimPeriod)
      .values({ periodMonth: month, fiscalYear: year, monthOfYear, daysInMonth })
      .onConflictDoNothing();

    const [row] = await db
      .select({ isClosed: t.dimPeriod.isClosed })
      .from(t.dimPeriod)
      .where(eq(t.dimPeriod.periodMonth, month))
      .limit(1);

    if (row?.isClosed) closed.add(month);
  }

  return closed;
}

// ---------------------------------------------------------------------------
// QuickBooks report shapes
// ---------------------------------------------------------------------------

interface QboCell {
  value?: string;
  id?: string;
}

interface QboColumn {
  ColTitle?: string;
  ColType?: string;
  MetaData?: Array<{ Name?: string; Value?: string }>;
}

interface QboRow {
  Header?: { ColData?: QboCell[] };
  Rows?: { Row?: QboRow[] };
  Summary?: { ColData?: QboCell[] };
  ColData?: QboCell[];
  type?: string;
  group?: string;
}

interface QboReport {
  Header?: { ReportName?: string; StartPeriod?: string; EndPeriod?: string };
  Columns?: { Column?: QboColumn[] };
  Rows?: { Row?: QboRow[] };
}

function amount(cell: QboCell | undefined): Decimal {
  const raw = (cell?.value ?? '').replace(/[$,\s]/g, '');
  if (!raw) return new Decimal(0);
  // QuickBooks renders negatives in parentheses in some locales.
  const negated = /^\(.*\)$/.test(raw);
  const parsed = new Decimal(raw.replace(/[()]/g, '') || '0');
  return negated ? parsed.negated() : parsed;
}

/** True when any money cell (everything after the label) holds a value. */
function carriesAmounts(cells: QboCell[] | undefined): boolean {
  return Boolean(cells?.slice(1).some((cell) => (cell.value ?? '').trim() !== ''));
}

/**
 * Every row of a QuickBooks report that carries its own money, with the section
 * it sits in and the parent accounts above it.
 *
 * The section is what tells revenue from cost — QuickBooks does not repeat that
 * on the row itself. Summary rows are skipped: they are totals of rows already
 * yielded, and including them would double every figure.
 *
 * A parent account's OWN postings are on its section HEADER, not on a child row.
 * QuickBooks draws "Litigation Support Income" as a section whose header carries
 * whatever was posted to the parent directly, with the sub-accounts beneath it
 * and a "Total …" summary of both. Skipping every header — which this used to do
 * — dropped that money outright: $162,462.70 of LITS revenue and $42,998.95 of TP
 * revenue in March 2026 alone, so ARG Total read low by a third and COGS % and
 * net margin were wrong on every view. A header is yielded whenever it carries an
 * amount; grouping headers ("Income", "Current Assets") carry none and are passed
 * over. There is no double count: the header holds only the parent's direct
 * postings, and the sub-accounts are yielded as their own rows.
 */
export function* leafRows(
  rows: QboRow[] | undefined,
  group: string | undefined,
  ancestors: string[] = [],
): Generator<{ group: string | undefined; cells: QboCell[]; ancestors: string[] }> {
  for (const row of rows ?? []) {
    const inherited = row.group ?? group;
    const header = row.Header?.ColData;

    if (header?.length && carriesAmounts(header)) {
      yield { group: inherited, cells: header, ancestors };
    }

    if (row.Rows?.Row?.length) {
      const name = header?.[0]?.value?.trim();
      yield* leafRows(row.Rows.Row, inherited, name ? [...ancestors, name] : ancestors);
      continue;
    }

    if (row.ColData?.length && row.type !== 'Section') {
      yield { group: inherited, cells: row.ColData, ancestors };
    }
  }
}

/** The money columns of a report, with the running Total column held apart. */
function divisionColumns(
  report: QboReport,
  lookup: DivisionLookup,
): {
  columns: Array<{ index: number; divisionCode: string }>;
  unmapped: string[];
  excluded: string[];
  /** QuickBooks' company-level column, or null when the report has none. */
  totalIndex: number | null;
} {
  const all = report.Columns?.Column ?? [];
  const columns: Array<{ index: number; divisionCode: string }> = [];
  const unmapped: string[] = [];
  const excluded: string[] = [];
  let totalIndex: number | null = null;

  all.forEach((column, index) => {
    if (column.ColType !== 'Money') return;

    const title = column.ColTitle ?? '';
    const meta = Object.fromEntries(
      (column.MetaData ?? []).map((entry) => [entry.Name ?? '', entry.Value ?? '']),
    );

    // The total column is a rollup of the others; §3 says ARG Total is never a
    // row of its own, and taking it as one would double the consolidated figure.
    // It is kept aside as QuickBooks' own company figure, which is what the
    // company balance sheet and the P&L tie-out are read from.
    if (!title || /^total$/i.test(title) || meta.ColKey === 'total') {
      if (/^total$/i.test(title) || meta.ColKey === 'total') totalIndex = index;
      return;
    }

    // QuickBooks names the class id `ColKey` on a classed report's columns.
    const classRef = meta.ClassRef ?? meta.ClassId ?? meta.ColKey;
    const divisionCode = resolveDivision(lookup, classRef, title);
    if (divisionCode) columns.push({ index, divisionCode });
    // Deliberately excluded: left out of every divisional figure and out of ARG
    // Total, which is what an allocation or unclassified bucket should do. The
    // caller reports it so under-reporting is stated rather than discovered.
    else if (isExcluded(lookup, classRef, title)) excluded.push(title);
    else unmapped.push(title);
  });

  return { columns, unmapped, excluded, totalIndex };
}

/**
 * Replaces one month of one statement in fact_company_total.
 *
 * Wholesale, like the fact tables: a line that emptied since the last pull goes
 * to zero instead of leaving its old figure standing.
 */
async function writeCompanyTotals(
  db: Database,
  loadRunId: string,
  month: string,
  statement: string,
  lines: Record<string, Decimal>,
): Promise<number> {
  await db
    .delete(t.factCompanyTotal)
    .where(
      sql`${t.factCompanyTotal.periodMonth} = ${month} and ${t.factCompanyTotal.statement} = ${statement}`,
    );

  const rows = Object.entries(lines).map(([line, amount]) => ({
    periodMonth: month,
    statement,
    line,
    amount: n(amount),
    sourceSystem: 'QBO' as const,
    loadRunId,
    loadedAt: new Date(),
  }));
  if (rows.length) await db.insert(t.factCompanyTotal).values(rows);
  return rows.length;
}

const PAYROLL_PARENT = /payroll/i;
const NOT_PAYROLL = /\b(fee|fees|service|services)\b/i;

/**
 * Whether an account is payroll, judged the way ARG's chart is laid out.
 *
 * ARG keeps payroll under parent accounts — "Payroll-Direct" in COGS, "Payroll
 * Expenses" in operating expense — and every account beneath them is payroll:
 * Gross Wages-Direct, Employee Benefits-Direct, Payroll Taxes, 401K. Reading the
 * parent is what fills the two memo rows, which otherwise read $0 every month
 * because no account is ever TYPED as payroll in QuickBooks. A payroll-service
 * fee is a fee, not payroll, and stays in the total it came from.
 */
export function isPayrollAccount(name: string, ancestors: string[]): boolean {
  if (ancestors.some((parent) => PAYROLL_PARENT.test(parent))) return true;
  return PAYROLL_PARENT.test(name) && !NOT_PAYROLL.test(name);
}

/**
 * Upgrades a COGS or OpEx line to its payroll memo line.
 *
 * Totals cannot move: payroll_direct rolls up INTO cogs and payroll_expense into
 * opex (lib/etl/rollup.ts), so this only decides which memo row an account is
 * also shown on. A line somebody deliberately set to a payroll line stays as is.
 */
function withPayrollMemo(line: ReportingLine, name: string, ancestors: string[]): ReportingLine {
  if (!isPayrollAccount(name, ancestors)) return line;
  if (line === 'cogs') return 'payroll_direct';
  if (line === 'opex') return 'payroll_expense';
  return line;
}

/** QuickBooks' P&L sections, translated to the five reporting lines. */
function reportingLineForSection(group: string | undefined): ReportingLine | null {
  switch ((group ?? '').toLowerCase()) {
    case 'income':
    case 'otherincome':
      return 'revenue';
    case 'cogs':
      return 'cogs';
    case 'expenses':
    case 'otherexpenses':
      return 'opex';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// QuickBooks — Profit & Loss
// ---------------------------------------------------------------------------

/**
 * The P&L, at account level, by class, for one month.
 *
 * Account-level first (fact_gl_balance), then the five lines rolled up from it
 * (fact_pl_actual) — rather than the other way round. That ordering is what
 * makes drill-down possible and what guarantees the two agree: the summary is
 * derived from the detail rather than being loaded alongside it.
 */
/**
 * Notes a class that blocked a load, so the mapping screen can offer it.
 *
 * The class list is loaded weekly and a P&L daily, so a class can appear on a
 * report before the list next runs. Recording it here means the screen offers
 * the thing that actually failed rather than a list that is a week old.
 */
async function noteUnmappedClasses(db: Database, names: string[]): Promise<void> {
  for (const name of names) {
    // Look for the class under its NAME and under any id already recorded for
    // it. A report column carries a title; the class list carries an id. Keying
    // one row by each produced two rows for one class, so mapping the one the
    // screen offered left the other UNMAPPED and the pull refused anyway —
    // which is exactly the "I mapped it and it still did not work" failure.
    const existing = await findClassRow(db, name);
    if (existing) continue;

    await db
      .insert(t.dimClassMap)
      .values({ classKey: name.trim().toLowerCase(), className: name, decision: 'UNMAPPED' })
      .onConflictDoNothing();
  }
}

/** The row for a class, found by key or by the name it displays under. */
export async function findClassRow(
  db: Database,
  identifier: string,
): Promise<{ classKey: string; className: string; decision: string } | null> {
  const key = identifier.trim().toLowerCase();

  const [byKey] = await db
    .select()
    .from(t.dimClassMap)
    .where(eq(t.dimClassMap.classKey, key))
    .limit(1);
  if (byKey) return byKey;

  const [byName] = await db
    .select()
    .from(t.dimClassMap)
    .where(sql`lower(${t.dimClassMap.className}) = ${key}`)
    .limit(1);
  return byName ?? null;
}

async function conformProfitAndLoss(
  db: Database,
  loadRunId: string,
  month: string,
  report: QboReport,
  lookup: DivisionLookup,
): Promise<number> {
  const { columns, unmapped, totalIndex } = divisionColumns(report, lookup);

  if (unmapped.length) {
    throw new UnmappedSourceDataError(
      `The QuickBooks profit-and-loss for ${month.slice(0, 7)} has classes that map to no ` +
        `division: ${unmapped.join(', ')}. Nothing was written — loading them against the wrong ` +
        `division, or dropping them, would move revenue between two divisional P&Ls invisibly. ` +
        `Go to Admin → Class mapping and either assign each one to a division or mark it as not ` +
        `belonging to one, then pull again.`,
      unmapped,
    );
  }

  if (!columns.length) {
    throw new UnmappedSourceDataError(
      `The QuickBooks profit-and-loss for ${month.slice(0, 7)} came back with no class columns, ` +
        `so there is no division dimension to load. Check that ARG classes its profit and loss.`,
    );
  }

  // Existing mappings win. A provisional line is only ever assigned to an
  // account QuickBooks has not shown us before, and it comes from the section
  // the account sits in — which is QuickBooks' own classification, not a guess.
  const existing = new Map(
    (await db.select().from(t.dimAccount)).map((row) => [row.accountId, row]),
  );

  const balances: Array<{ divisionCode: string; accountId: string; amount: Decimal }> = [];
  const seenAccounts = new Map<string, { name: string; line: ReportingLine }>();
  const unmappedAccounts: string[] = [];
  const companyRows: GlRowForTotal[] = [];

  for (const { group, cells, ancestors } of leafRows(report.Rows?.Row, undefined)) {
    const label = cells[0]?.value?.trim();
    if (!label) continue;

    const accountId = cells[0]?.id?.trim() || label;
    const known = existing.get(accountId);
    // A known account with no line is classified from its section rather than
    // skipped. Skipping it was silent — the one path in this function that let
    // money leave without an error — and the section is QuickBooks' own answer.
    const baseLine = known?.reportingLine ?? reportingLineForSection(group);

    if (!baseLine) {
      // A row that cannot be classified at all is not silently dropped: it is
      // money, and money that vanishes between QuickBooks and a dashboard is the
      // failure this whole system exists to prevent.
      const carries =
        columns.some((column) => !amount(cells[column.index]).isZero()) ||
        (totalIndex !== null && !amount(cells[totalIndex]).isZero());
      if (carries) unmappedAccounts.push(`${label} (section: ${group ?? 'none'})`);
      continue;
    }

    const line = withPayrollMemo(baseLine, known?.accountName ?? label, ancestors);
    seenAccounts.set(accountId, { name: label, line });

    for (const column of columns) {
      const value = amount(cells[column.index]);
      if (value.isZero()) continue;
      balances.push({ divisionCode: column.divisionCode, accountId, amount: value });
    }

    if (totalIndex !== null) {
      companyRows.push({ accountId, reportingLine: line, amount: amount(cells[totalIndex]) });
    }
  }

  if (unmappedAccounts.length) {
    throw new UnmappedSourceDataError(
      `${unmappedAccounts.length} account${unmappedAccounts.length === 1 ? '' : 's'} in the ` +
        `${month.slice(0, 7)} profit-and-loss could not be assigned to a reporting line: ` +
        `${unmappedAccounts.slice(0, 8).join('; ')}${unmappedAccounts.length > 8 ? '; …' : ''}. ` +
        `Nothing was written. Map them in dim_account first.`,
    );
  }

  // --- dim_account ---------------------------------------------------------
  for (const [accountId, account] of seenAccounts) {
    const known = existing.get(accountId);
    if (known) {
      // The one change made to an existing mapping: a plain COGS or OpEx account
      // that sits under a payroll parent is marked as the payroll memo line, so
      // drill-down agrees with the memo rows. Totals are unaffected either way.
      if (known.reportingLine !== account.line && (known.reportingLine === 'cogs' || known.reportingLine === 'opex' || known.reportingLine === null)) {
        await db
          .update(t.dimAccount)
          .set({ reportingLine: account.line })
          .where(eq(t.dimAccount.accountId, accountId));
      }
      continue;
    }
    await db
      .insert(t.dimAccount)
      .values({
        accountId,
        accountName: account.name,
        accountType:
          account.line === 'revenue' ? 'INCOME' : account.line === 'cogs' || account.line === 'payroll_direct' ? 'COGS' : 'EXPENSE',
        reportingLine: account.line,
      })
      .onConflictDoNothing();
  }

  // --- fact_gl_balance -----------------------------------------------------
  await db
    .delete(t.factGlBalance)
    .where(eq(t.factGlBalance.periodMonth, month));

  for (let i = 0; i < balances.length; i += 300) {
    const chunk = balances.slice(i, i + 300);
    if (!chunk.length) continue;
    await db.insert(t.factGlBalance).values(
      chunk.map((row) => ({
        periodMonth: month,
        divisionCode: row.divisionCode,
        accountId: row.accountId,
        amount: n(row.amount),
        loadRunId,
      })),
    );
  }

  // --- fact_pl_actual ------------------------------------------------------
  //
  // Rolled up through the same function the seed uses, so the memo-column
  // relationship cannot be got wrong in one place and right in the other.
  let written = balances.length;

  for (const divisionCode of new Set(balances.map((row) => row.divisionCode))) {
    const lines = rollUpGl(
      balances
        .filter((row) => row.divisionCode === divisionCode)
        .map((row) => ({
          accountId: row.accountId,
          reportingLine: seenAccounts.get(row.accountId)!.line,
          amount: row.amount,
        })),
    );

    const values = {
      periodMonth: month,
      divisionCode,
      revenue: n(lines.revenue),
      payrollDirect: n(lines.payrollDirect),
      cogs: n(lines.cogs),
      payrollExpense: n(lines.payrollExpense),
      opex: n(lines.opex),
      sourceSystem: 'QBO' as const,
      loadRunId,
      loadedAt: new Date(),
    };

    await db
      .insert(t.factPlActual)
      .values(values)
      .onConflictDoUpdate({
        target: [t.factPlActual.periodMonth, t.factPlActual.divisionCode],
        set: values,
      });

    written += 1;
  }

  // --- fact_company_total --------------------------------------------------
  //
  // QuickBooks' own TOTAL column, rolled up through the same function. It
  // includes every class — excluded ones too — so it is the figure the P&L is
  // reconciled against, not a second source of divisional truth.
  if (totalIndex !== null) {
    const company = rollUpGl(companyRows);
    written += await writeCompanyTotals(db, loadRunId, month, 'PL', {
      revenue: company.revenue,
      payroll_direct: company.payrollDirect,
      cogs: company.cogs,
      payroll_expense: company.payrollExpense,
      opex: company.opex,
    });
  }

  return written;
}

type GlRowForTotal = { accountId: string; reportingLine: ReportingLine; amount: Decimal };

// ---------------------------------------------------------------------------
// QuickBooks — Balance Sheet
// ---------------------------------------------------------------------------

/** The balance-sheet groupings fact_bs_actual carries, keyed by dim_account. */
const BALANCE_SHEET_FIELDS = {
  cash: 'cash',
  accounts_receivable: 'accountsReceivable',
  other_current_assets: 'otherCurrentAssets',
  fixed_assets: 'fixedAssets',
  accounts_payable: 'accountsPayable',
  cc_liability: 'ccLiability',
  other_current_liabilities: 'otherCurrentLiabilities',
  lt_liabilities: 'ltLiabilities',
  shareholder_equity: 'shareholderEquity',
} as const;

/**
 * QuickBooks' balance-sheet sections, translated to fact_bs_actual's groupings.
 *
 * The fallback for a row with no mapped account — above all "Net Income", the
 * current year's earnings, which QuickBooks prints inside equity with no account
 * id at all. Treating it as an unknown account is what failed every balance-sheet
 * load: equity without it cannot balance, and there is no account to map.
 */
function balanceSheetLineForSection(group: string | undefined): string | null {
  switch ((group ?? '').toLowerCase()) {
    case 'bankaccounts':
      return 'cash';
    case 'ar':
      return 'accounts_receivable';
    case 'othercurrentassets':
      return 'other_current_assets';
    case 'fixedassets':
    case 'otherassets':
      return 'fixed_assets';
    case 'ap':
      return 'accounts_payable';
    case 'creditcards':
      return 'cc_liability';
    case 'othercurrentliabilities':
      return 'other_current_liabilities';
    case 'longtermliabilities':
      return 'lt_liabilities';
    case 'equity':
    case 'netincome':
      return 'shareholder_equity';
    default:
      return null;
  }
}

async function balanceSheetIsClassed(db: Database): Promise<boolean> {
  const [row] = await db
    .select({ value: t.appConfig.value })
    .from(t.appConfig)
    .where(eq(t.appConfig.key, 'BALANCE_SHEET_CLASSED'))
    .limit(1);
  // Unset means the question was never asked; the classed path is the one that
  // refuses loudly, so it is the safe default.
  return row?.value !== 'false';
}

async function conformBalanceSheet(
  db: Database,
  loadRunId: string,
  month: string,
  report: QboReport,
  lookup: DivisionLookup,
  notes: string[],
): Promise<number> {
  const classed = await balanceSheetIsClassed(db);
  const { columns, unmapped, totalIndex: reportedTotal } = divisionColumns(report, lookup);

  // An unclassed report has a single money column and no TOTAL heading.
  const moneyColumns = (report.Columns?.Column ?? [])
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => column.ColType === 'Money');
  const totalIndex =
    reportedTotal ?? (moneyColumns.length === 1 ? moneyColumns[0]!.index : null);

  if (classed) {
    if (unmapped.length) {
      throw new UnmappedSourceDataError(
        `The ${month.slice(0, 7)} balance sheet has classes that map to no division: ` +
          `${unmapped.join(', ')}. Nothing was written. Map them in Admin → Class mapping, or ` +
          `mark them as not belonging to a division.`,
        unmapped,
      );
    }
    if (!columns.length && totalIndex === null) {
      throw new UnmappedSourceDataError(
        `The ${month.slice(0, 7)} balance sheet came back with no money columns at all. ` +
          `Nothing was written.`,
      );
    }
  }

  const accounts = new Map(
    (await db.select().from(t.dimAccount)).map((row) => [row.accountId, row]),
  );

  type Field = (typeof BALANCE_SHEET_FIELDS)[keyof typeof BALANCE_SHEET_FIELDS];
  const totals = new Map<string, Partial<Record<Field, Decimal>>>();
  const company: Partial<Record<Field, Decimal>> = {};
  const unclassified: string[] = [];

  for (const { group, cells } of leafRows(report.Rows?.Row, undefined)) {
    const label = cells[0]?.value?.trim();
    if (!label) continue;

    const accountId = cells[0]?.id?.trim() || label;
    const known = accounts.get(accountId);
    // The account's own mapping wins; QuickBooks' section is the fallback, and
    // it is QuickBooks' classification rather than a guess.
    const mapped = known?.balanceSheetLine;
    const line =
      mapped && mapped in BALANCE_SHEET_FIELDS ? mapped : balanceSheetLineForSection(group);

    if (!line) {
      const indexes = [...columns.map((column) => column.index), ...(totalIndex === null ? [] : [totalIndex])];
      if (indexes.every((index) => amount(cells[index]).isZero())) continue;
      unclassified.push(`${label} (section: ${group ?? 'none'})`);
      continue;
    }

    const field = BALANCE_SHEET_FIELDS[line as keyof typeof BALANCE_SHEET_FIELDS];

    if (totalIndex !== null) {
      const value = amount(cells[totalIndex]);
      if (!value.isZero()) company[field] = (company[field] ?? new Decimal(0)).plus(value);
    }

    if (!classed) continue;
    for (const column of columns) {
      const value = amount(cells[column.index]);
      if (value.isZero()) continue;
      const division = totals.get(column.divisionCode) ?? {};
      division[field] = (division[field] ?? new Decimal(0)).plus(value);
      totals.set(column.divisionCode, division);
    }
  }

  if (unclassified.length) {
    throw new UnmappedSourceDataError(
      `${unclassified.length} balance-sheet row${unclassified.length === 1 ? '' : 's'} in ` +
        `${month.slice(0, 7)} could not be placed on the balance sheet: ` +
        `${unclassified.slice(0, 8).join('; ')}${unclassified.length > 8 ? '; …' : ''}. ` +
        `Nothing was written — an unplaced balance would silently understate cash, ` +
        `receivables or payables, and DSO, DPO, CCC and Cash Runway all read from them.`,
    );
  }

  const zero = new Decimal(0);
  let written = 0;

  // --- company balance sheet, from QuickBooks' TOTAL column ---------------
  if (totalIndex !== null) {
    const lines: Record<string, Decimal> = {};
    for (const [line, field] of Object.entries(BALANCE_SHEET_FIELDS)) {
      lines[line] = company[field as Field] ?? zero;
    }
    written += await writeCompanyTotals(db, loadRunId, month, 'BS', lines);

    const assets = ['cash', 'accounts_receivable', 'other_current_assets', 'fixed_assets'].reduce(
      (sum, line) => sum.plus(lines[line]!),
      zero,
    );
    const liabilitiesAndEquity = [
      'accounts_payable',
      'cc_liability',
      'other_current_liabilities',
      'lt_liabilities',
      'shareholder_equity',
    ].reduce((sum, line) => sum.plus(lines[line]!), zero);
    const gap = assets.minus(liabilitiesAndEquity);
    if (gap.abs().greaterThan(1)) {
      notes.push(
        `The ${month.slice(0, 7)} company balance sheet is out by ${gap.toFixed(2)} ` +
          `(assets ${assets.toFixed(2)}, liabilities and equity ${liabilitiesAndEquity.toFixed(2)}).`,
      );
    }
  }

  if (!classed) {
    notes.push(
      `${month.slice(0, 7)}: balance sheet loaded at company level from QuickBooks' total column. ` +
        `ARG does not class its balance sheet, so no divisional balance sheet was written.`,
    );
    return written;
  }

  for (const [divisionCode, fields] of totals) {
    const values = {
      periodMonth: month,
      divisionCode,
      cash: n(fields.cash ?? zero),
      accountsReceivable: n(fields.accountsReceivable ?? zero),
      otherCurrentAssets: n(fields.otherCurrentAssets ?? zero),
      fixedAssets: n(fields.fixedAssets ?? zero),
      accountsPayable: n(fields.accountsPayable ?? zero),
      ccLiability: n(fields.ccLiability ?? zero),
      otherCurrentLiabilities: n(fields.otherCurrentLiabilities ?? zero),
      ltLiabilities: n(fields.ltLiabilities ?? zero),
      shareholderEquity: n(fields.shareholderEquity ?? zero),
      sourceSystem: 'QBO' as const,
      loadRunId,
      loadedAt: new Date(),
    };

    await db
      .insert(t.factBsActual)
      .values(values)
      .onConflictDoUpdate({
        target: [t.factBsActual.periodMonth, t.factBsActual.divisionCode],
        set: values,
      });

    written += 1;
  }

  return written;
}

// ---------------------------------------------------------------------------
// QuickBooks — A/R and A/P aging
// ---------------------------------------------------------------------------

/**
 * Days past due -> the five buckets fact_aging carries.
 *
 * Arithmetic on a real due date, not a match against a report's column heading —
 * those headings move with the company's aging settings.
 */
export function bucketForDaysPastDue(daysPastDue: number): string {
  if (daysPastDue <= 0) return 'current';
  if (daysPastDue <= 30) return '1_30';
  if (daysPastDue <= 60) return '31_60';
  if (daysPastDue <= 90) return '61_90';
  return 'over_90';
}

const AGING_BUCKETS = ['current', '1_30', '31_60', '61_90', 'over_90'] as const;

/** Whole days between two dates, positive when the first is later. */
export function daysBetween(later: string, earlier: string): number {
  const a = Date.parse(`${later}T00:00:00Z`);
  const b = Date.parse(`${earlier}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.floor((a - b) / 86_400_000);
}

interface QboTransaction {
  Id?: string;
  DocNumber?: string;
  Balance?: number | string;
  DueDate?: string;
  TxnDate?: string;
  ClassRef?: { value?: string; name?: string };
  Line?: Array<{
    Amount?: number | string;
    SalesItemLineDetail?: { ClassRef?: { value?: string; name?: string } };
    AccountBasedExpenseLineDetail?: { ClassRef?: { value?: string; name?: string } };
    ItemBasedExpenseLineDetail?: { ClassRef?: { value?: string; name?: string } };
  }>;
}

/**
 * The single class a transaction belongs to, or null.
 *
 * QuickBooks puts the class in one of two places depending on a company
 * preference: on the transaction itself when it is set to one class per whole
 * transaction, or on each line when it is set to one class per line. Both are
 * read, transaction first.
 *
 * A transaction whose lines carry DIFFERENT classes returns null rather than
 * picking one or splitting the balance across them. The line amounts would make
 * a split look principled, but a part-paid invoice's remaining balance does not
 * belong to its lines in any proportion QuickBooks knows — the payment was
 * against the invoice, not against a line. Reporting it beats inventing it.
 */
export function transactionClass(transaction: QboTransaction): string | null {
  const direct = transaction.ClassRef?.name ?? transaction.ClassRef?.value;
  if (direct) return direct;

  const fromLines = new Set<string>();
  for (const line of transaction.Line ?? []) {
    const reference =
      line.SalesItemLineDetail?.ClassRef ??
      line.AccountBasedExpenseLineDetail?.ClassRef ??
      line.ItemBasedExpenseLineDetail?.ClassRef;
    const name = reference?.name ?? reference?.value;
    if (name) fromLines.add(name);
  }

  return fromLines.size === 1 ? [...fromLines][0]! : null;
}

/**
 * Open invoices and bills -> A/R and A/P by division and bucket.
 *
 * This does not read an aging report, and that is the point. No QuickBooks aging
 * report carries a class: Intuit's documented column list for the DETAIL report
 * has no klass_name, and the SUMMARY report is grouped by customer or vendor.
 * fact_aging is keyed on division, so for as long as the aging came from those
 * reports it could never be filled — which is exactly what "0 rows" and "came
 * back without a class column" were saying, twelve months in a row.
 *
 * An open transaction carries its own ClassRef, Balance and DueDate, so the
 * division is QuickBooks' own attribution and the bucket is arithmetic.
 *
 * One honest limitation, stated on the run rather than buried: open balances are
 * as they stand NOW. A past month's aging cannot be reconstructed from them,
 * because a since-paid invoice no longer has a balance to age. The snapshot is
 * therefore written against one month — the latest in the window — and not
 * spread backwards across months it cannot describe.
 */
async function conformAging(
  db: Database,
  loadRunId: string,
  month: string,
  transactions: QboTransaction[],
  lookup: DivisionLookup,
  kind: 'AR' | 'AP',
  notes: string[],
): Promise<number> {
  const label = kind === 'AR' ? 'A/R' : 'A/P';
  const asOf = lastDayOfMonth(month);

  const totals = new Map<string, Map<string, Decimal>>();
  // Every open balance, whatever its class. The company aging is what "Total
  // A/R" means to ARG, and an unclassed invoice is still money owed to ARG.
  const company = new Map<string, Decimal>(AGING_BUCKETS.map((bucket) => [bucket, new Decimal(0)]));
  const unmapped = new Set<string>();
  let unclassified = new Decimal(0);
  let counted = 0;

  for (const transaction of transactions) {
    const balance = new Decimal(String(transaction.Balance ?? 0));
    if (balance.isZero()) continue;
    counted += 1;

    // A bill with no due date is due on receipt, which is what QuickBooks shows
    // in its own aging. A missing date is not a reason to call it current.
    const due = transaction.DueDate ?? transaction.TxnDate ?? asOf;
    const bucket = bucketForDaysPastDue(daysBetween(asOf, due));
    company.set(bucket, company.get(bucket)!.plus(balance));

    const className = transactionClass(transaction);
    if (!className) {
      unclassified = unclassified.plus(balance);
      continue;
    }

    const divisionCode = resolveDivision(lookup, undefined, className);
    if (!divisionCode) {
      if (!isExcluded(lookup, undefined, className)) unmapped.add(className);
      continue;
    }

    const buckets = totals.get(divisionCode) ?? new Map<string, Decimal>();
    buckets.set(bucket, (buckets.get(bucket) ?? new Decimal(0)).plus(balance));
    totals.set(divisionCode, buckets);
  }

  if (unmapped.size) {
    throw new UnmappedSourceDataError(
      `Open ${label} transactions carry classes that map to no division: ` +
        `${[...unmapped].join(', ')}. Nothing was written — dropping them would understate ` +
        `${label} for whichever division they belong to. Map them in Admin → Class mapping, or ` +
        `mark them as not belonging to a division.`,
      [...unmapped],
    );
  }

  if (counted === 0) {
    notes.push(`No open ${label} transactions, so there is nothing to age. That is a real zero.`);
    return 0;
  }

  if (!unclassified.isZero()) {
    notes.push(
      `${unclassified.toFixed(2)} of open ${label} sits on transactions with no single class — ` +
        `either unclassed, or split across classes on their lines. It is absent from the ` +
        `divisional aging and will read as a gap against the balance sheet. It is never spread ` +
        `across divisions: the remaining balance of a part-paid invoice does not belong to its ` +
        `lines in any proportion QuickBooks knows.`,
    );
  }

  // The month is replaced wholesale for this kind, so a bucket that emptied
  // since the last pull goes to zero rather than leaving its old figure standing.
  await db
    .delete(t.factAging)
    .where(sql`${t.factAging.periodMonth} = ${month} and ${t.factAging.kind} = ${kind}`);

  const rows = [...totals].flatMap(([divisionCode, buckets]) =>
    AGING_BUCKETS.map((bucket) => ({
      periodMonth: month,
      divisionCode,
      kind,
      bucket,
      amount: n(buckets.get(bucket) ?? new Decimal(0)),
      loadRunId,
    })),
  );

  if (rows.length) await db.insert(t.factAging).values(rows);

  // The company aging rides alongside; the run's row count stays the divisional
  // rows, which is what "did the aging land" has always meant.
  await writeCompanyTotals(db, loadRunId, month, kind === 'AR' ? 'AR_AGING' : 'AP_AGING', Object.fromEntries(company));
  return rows.length;
}

// ---------------------------------------------------------------------------
// QuickBooks — reference data
// ---------------------------------------------------------------------------

interface QboQueryResponse {
  QueryResponse?: {
    Account?: Array<{
      Id?: string;
      Name?: string;
      AcctNum?: string;
      Classification?: string;
      AccountType?: string;
      Active?: boolean;
    }>;
    Class?: Array<{ Id?: string; Name?: string; Active?: boolean }>;
  };
}

/**
 * The chart of accounts.
 *
 * New accounts land with a reporting line derived from QuickBooks' own
 * classification, and existing mappings are never overwritten — an account
 * Westport has deliberately tagged as a payroll memo line must stay that way
 * through every subsequent refresh.
 */
/**
 * QuickBooks' AccountType -> the balance-sheet grouping fact_bs_actual carries.
 *
 * This is not a guess and it is not a Westport decision. QuickBooks makes every
 * account declare exactly one of these types, and each one has a single sensible
 * home among the nine columns. Leaving them NULL and waiting for somebody to map
 * 150 accounts by hand is what blocked the balance sheet for months: the P&L
 * side has always derived its reporting line from QuickBooks' own classification
 * in this very function, and holding the balance sheet to a stricter standard
 * bought nothing except an empty Finance dashboard.
 *
 * What remains a real decision is still respected: a line somebody has set is
 * never overwritten, so an account Westport deliberately regroups stays put.
 */
const ACCOUNT_TYPE_TO_BALANCE_SHEET_LINE: Record<string, string> = {
  bank: 'cash',
  'accounts receivable': 'accounts_receivable',
  'other current asset': 'other_current_assets',
  'fixed asset': 'fixed_assets',
  // QuickBooks' "Other Asset" is non-current, and fixed_assets is the only
  // non-current asset column the schema has. Grouping it there keeps total
  // assets right, which is what the balance check and Cash Runway read.
  'other asset': 'fixed_assets',
  'accounts payable': 'accounts_payable',
  'credit card': 'cc_liability',
  'other current liability': 'other_current_liabilities',
  'long term liability': 'lt_liabilities',
  equity: 'shareholder_equity',
};

/** The balance-sheet line implied by an account's QuickBooks type, if any. */
export function balanceSheetLineFor(accountType: string | undefined): string | null {
  const key = (accountType ?? '').trim().toLowerCase();
  return ACCOUNT_TYPE_TO_BALANCE_SHEET_LINE[key] ?? null;
}

/**
 * The chart of accounts.
 *
 * New accounts land with both lines derived from QuickBooks' own classification.
 * Existing accounts are left alone EXCEPT where a line is still NULL, which is
 * filled in — that backfill is what unblocks a warehouse whose accounts were
 * loaded before this mapping existed, without touching a single mapping anybody
 * has actually made.
 */
async function conformAccounts(db: Database, payload: QboQueryResponse): Promise<number> {
  const accounts = payload.QueryResponse?.Account ?? [];
  if (!accounts.length) return 0;

  const existing = new Map(
    (await db.select().from(t.dimAccount)).map((row) => [row.accountId, row]),
  );

  let written = 0;
  for (const account of accounts) {
    const accountId = account.Id?.trim();
    if (!accountId) continue;

    const classification = (account.Classification ?? '').toLowerCase();
    const accountType =
      classification === 'revenue'
        ? 'INCOME'
        : classification === 'expense'
          ? 'EXPENSE'
          : classification === 'asset'
            ? 'ASSET'
            : classification === 'liability'
              ? 'LIABILITY'
              : classification === 'equity'
                ? 'EQUITY'
                : 'EXPENSE';

    // Cost of Goods Sold is its own AccountType in QuickBooks and classifies as
    // an expense, so the reporting line has to come from the type rather than
    // the classification — otherwise every COGS account lands in OpEx and gross
    // margin is wrong on every division, in every month.
    const isCogs = (account.AccountType ?? '').toLowerCase().includes('cost of goods');

    const reportingLine =
      accountType === 'INCOME'
        ? 'revenue'
        : isCogs
          ? 'cogs'
          : accountType === 'EXPENSE'
            ? 'opex'
            : null;

    const balanceSheetLine = balanceSheetLineFor(account.AccountType);

    const known = existing.get(accountId);

    if (known) {
      // Only ever fills a hole. A line already set — by Westport, by an earlier
      // load, by hand — is left exactly as it is.
      const fills: Record<string, unknown> = {};
      if (!known.reportingLine && reportingLine) fills.reportingLine = reportingLine;
      if (!known.balanceSheetLine && balanceSheetLine) fills.balanceSheetLine = balanceSheetLine;
      if (Object.keys(fills).length === 0) continue;

      await db.update(t.dimAccount).set(fills).where(eq(t.dimAccount.accountId, accountId));
      written += 1;
      continue;
    }

    await db
      .insert(t.dimAccount)
      .values({
        accountId,
        accountNumber: account.AcctNum ?? null,
        accountName: account.Name ?? accountId,
        accountType: isCogs ? 'COGS' : accountType,
        reportingLine,
        balanceSheetLine,
        // An inactive account still carries every balance it ever held, so it is
        // loaded and marked inactive rather than skipped. Skipping it does not
        // remove it from a prior balance sheet — it only removes our ability to
        // read one.
        isActive: account.Active ?? true,
      })
      .onConflictDoNothing();

    written += 1;
  }

  return written;
}

/**
 * The class list.
 *
 * Nothing is written: classes map to divisions, and inventing that mapping is
 * exactly what §3 forbids. What this does is report which classes have no
 * division, which is the alert the spec asks for.
 */
async function checkClasses(db: Database, payload: QboQueryResponse): Promise<string[]> {
  const classes = payload.QueryResponse?.Class ?? [];
  if (!classes.length) return [];

  const lookup = await divisionLookup(db);
  const unmapped: string[] = [];

  for (const entry of classes) {
    if (entry.Active === false) continue;

    const name = entry.Name ?? entry.Id ?? 'unnamed';
    // If a refused load already recorded this class under its name, keep that
    // row rather than creating a second one under the id. One class, one row,
    // one decision — whichever route noticed it first.
    const already = await findClassRow(db, entry.Id ?? name) ?? await findClassRow(db, name);
    const key = already?.classKey ?? (entry.Id ?? name).trim().toLowerCase();

    // Every class QuickBooks holds is recorded, whether or not it is mapped, so
    // the admin screen can list them all rather than only the ones that have
    // already caused a failure. A class already decided keeps its decision:
    // this notices classes, it does not overrule people.
    await db
      .insert(t.dimClassMap)
      .values({
        classKey: key,
        classId: entry.Id ?? null,
        className: name,
        decision: resolveDivision(lookup, entry.Id, entry.Name) ? 'MAPPED' : 'UNMAPPED',
        divisionCode: resolveDivision(lookup, entry.Id, entry.Name),
      })
      // Only the identifying fields are refreshed. A decision somebody made is
      // never overwritten by a later class-list load — this notices classes, it
      // does not overrule people.
      .onConflictDoUpdate({
        target: t.dimClassMap.classKey,
        set: { className: name, classId: entry.Id ?? null },
      });

    if (!resolveDivision(lookup, entry.Id, entry.Name) && !isExcluded(lookup, entry.Id, entry.Name)) {
      unmapped.push(name);
    }
  }

  return unmapped;
}

// ---------------------------------------------------------------------------
// HubSpot
// ---------------------------------------------------------------------------

interface HubspotObject {
  id: string;
  properties?: Record<string, string | null>;
  propertiesWithHistory?: Record<
    string,
    Array<{ value?: string; timestamp?: string }> | undefined
  >;
  associations?: Record<string, { results?: Array<{ id?: string; type?: string }> }>;
}

function date(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Deal attribution to a division.
 *
 * §14.3 open item 2. Until Westport confirms the rule, a deal has no division
 * and the sales and marketing dashboards report at ARG Total only — which they
 * already do, and say so. Inventing an attribution rule here would move revenue
 * between divisional P&Ls and be invisible at ARG Total, which is the error that
 * survives for a year.
 */
function dealDivision(
  properties: Record<string, string | null> | undefined,
  lookup: DivisionLookup,
): string | null {
  const property = process.env.HUBSPOT_DIVISION_PROPERTY;
  if (!property) return null;

  const raw = properties?.[property];
  if (!raw) return null;

  return lookup.byKey.get(raw.trim().toLowerCase()) ?? null;
}

/**
 * HubSpot's owners, as a map from owner id to a person's name.
 *
 * The salesperson leaderboard is grouped by this name. Read from the owner rows
 * already loaded, so a deals pull does not depend on the order the entities were
 * fetched in — and a deal whose owner is not among them keeps whatever name it
 * had rather than being demoted to Unassigned by a partial load.
 */
async function ownerNameMap(db: Database): Promise<Map<string, string>> {
  const map = new Map<string, string>();

  // Owners land in raw_payload: they are reference data about people, not a
  // fact, and the leaderboard needs only the name against the id.
  const rows = await db
    .select({ payload: t.rawPayload.payload })
    .from(t.rawPayload)
    .where(eq(t.rawPayload.entity, '/crm/v3/owners'));

  for (const row of rows) {
    const owner = row.payload as {
      id?: string;
      firstName?: string;
      lastName?: string;
      email?: string;
    };
    if (!owner?.id) continue;

    const name = [owner.firstName, owner.lastName].filter(Boolean).join(' ').trim();
    map.set(owner.id, name || owner.email || `Owner ${owner.id}`);
  }

  // Names already attributed to deals fill any gap, so a deals-only refresh
  // never blanks a leaderboard that was populated by an earlier owners load.
  for (const row of await db
    .select({ ownerId: t.factDeal.ownerId, ownerName: t.factDeal.ownerName })
    .from(t.factDeal)
    .where(sql`${t.factDeal.ownerName} is not null`)) {
    if (row.ownerId && row.ownerName && !map.has(row.ownerId)) {
      map.set(row.ownerId, row.ownerName);
    }
  }

  return map;
}


/**
 * Where a deal came from, from whichever property this portal records it on.
 *
 * HubSpot has no standard field for it. ARG uses `zoho_lead_source`, carried
 * over from the CRM they migrated off; a portal built inside HubSpot would use
 * `deal_source`. The candidates are tried in a fixed order and the first one
 * actually present on the record wins, so a portal that later adds the native
 * field does not silently change what the attribution panel is reading —
 * whichever it finds, it finds the same one for every deal in the same load.
 *
 * Null when none is set, which the dashboard shows as "Not recorded" rather
 * than folding into Other. Unattributed pipeline is a thing leadership needs to
 * see the size of.
 */
function sourceLabel(properties: Record<string, string | null | undefined>): string | null {
  for (const candidate of ['zoho_lead_source', 'deal_source', 'lead_source']) {
    const value = properties[candidate]?.trim();
    if (value) return value;
  }
  return null;
}

async function conformDeals(
  db: Database,
  loadRunId: string,
  records: HubspotObject[],
  lookup: DivisionLookup,
): Promise<number> {
  const ownerNames = await ownerNameMap(db);
  const stageLabels = await stageLabelMap(db);

  let written = 0;

  for (const record of records) {
    const p = record.properties ?? {};
    const values = {
      dealId: record.id,
      divisionCode: dealDivision(p, lookup),
      dealName: p.dealname ?? null,
      amount: new Decimal(p.amount || '0').toFixed(4),
      dealstage: p.dealstage ?? null,
      pipeline: p.pipeline ?? null,
      isClosedWon: p.hs_is_closed_won === 'true',
      isClosed: p.hs_is_closed === 'true',
      createdate: date(p.createdate),
      closedate: date(p.closedate),
      enteredProposalAt: stageEntry(record, stageLabels, /proposal|quote/i),
      ownerId: p.hubspot_owner_id ?? null,
      ownerName: ownerNames.get(p.hubspot_owner_id ?? '') ?? null,
      sourceLabel: sourceLabel(p),
      dealType: p.dealtype ?? null,
      companyId: record.associations?.companies?.results?.[0]?.id ?? null,
      contactId: null,
      loadRunId,
    };

    await db
      .insert(t.factDeal)
      .values(values)
      .onConflictDoUpdate({ target: t.factDeal.dealId, set: values });

    written += 1;

    // §5.2: New Proposals Sent needs the timestamp a deal ENTERED a stage, not
    // its current stage. The history is replaced wholesale per deal so a
    // corrected stage change in HubSpot does not leave a stale entry behind.
    const history = record.propertiesWithHistory?.dealstage ?? [];
    if (history.length) {
      await db.delete(t.factDealStageHistory).where(eq(t.factDealStageHistory.dealId, record.id));

      const seen = new Set<string>();
      const rows = history
        .map((entry) => ({
          stage: entry.value ?? '',
          enteredAt: date(entry.timestamp),
        }))
        .filter((entry): entry is { stage: string; enteredAt: Date } =>
          Boolean(entry.stage && entry.enteredAt),
        )
        .filter((entry) => {
          const key = `${entry.stage}|${entry.enteredAt.toISOString()}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .map((entry) => ({
          dealId: record.id,
          stage: entry.stage,
          enteredAt: entry.enteredAt,
          loadRunId,
        }));

      if (rows.length) await db.insert(t.factDealStageHistory).values(rows);
    }
  }

  return written;
}

/**
 * The earliest time a deal entered a stage whose NAME mentions a proposal.
 *
 * The name, not the id. This matched against the raw stage value before, which
 * works only where the id happens to read like a word — true of HubSpot's
 * defaults and of the seeded dataset, and false of ARG's real portal, where the
 * Proposal stage carries the id `presentationscheduled`. So New Proposals Sent
 * was null for every live deal while the seeded dashboard showed a healthy
 * figure: a bug that could only appear once real data arrived.
 *
 * Labels come from dim_deal_stage, loaded first. A stage whose label is unknown
 * falls back to matching the id, which is no worse than before and still catches
 * a default pipeline.
 */
function stageEntry(
  record: HubspotObject,
  labels: Map<string, string>,
  pattern: RegExp,
): Date | null {
  const history = record.propertiesWithHistory?.dealstage ?? [];
  const entries = history
    .filter((entry) => {
      const stage = entry.value ?? '';
      return pattern.test(labels.get(stage) ?? stage);
    })
    .map((entry) => date(entry.timestamp))
    .filter((value): value is Date => value !== null)
    .sort((a, b) => a.getTime() - b.getTime());

  return entries[0] ?? null;
}

/** Stage id -> label, so downstream code can match on names people recognise. */
async function stageLabelMap(db: Database): Promise<Map<string, string>> {
  const rows = await db
    .select({ stageId: t.dimDealStage.stageId, label: t.dimDealStage.label })
    .from(t.dimDealStage);
  return new Map(rows.map((row) => [row.stageId, row.label]));
}

/**
 * When a contact reached a lifecycle stage.
 *
 * HubSpot documents `hs_lifecyclestage_marketingqualifiedlead_date` and its
 * siblings, and in ARG's portal every one of them is empty — checked across a
 * hundred contacts, none carried a value. Only `lifecyclestage` itself is set.
 * So the transition exists only in that property's history, and the first time
 * a contact entered a stage is the earliest history entry naming it.
 *
 * This is also why leads-by-month has read as empty: `became_lead_date` was
 * reading one of those absent fields, so every contact had a null date and the
 * marketing dashboard counted nothing while the seed showed a full chart.
 */
function lifecycleEntry(record: HubspotObject, stage: string): Date | null {
  const history = record.propertiesWithHistory?.lifecyclestage ?? [];
  const entries = history
    .filter((entry) => (entry.value ?? '').toLowerCase() === stage)
    .map((entry) => date(entry.timestamp))
    .filter((value): value is Date => value !== null)
    .sort((a, b) => a.getTime() - b.getTime());

  return entries[0] ?? null;
}

async function conformContacts(
  db: Database,
  loadRunId: string,
  records: HubspotObject[],
): Promise<number> {
  let written = 0;

  for (const record of records) {
    const p = record.properties ?? {};
    const values = {
      contactId: record.id,
      divisionCode: null,
      lifecycleStage: p.lifecyclestage ?? null,
      originalSource: p.hs_analytics_source ?? null,
      createdate: date(p.createdate),
      // The documented field first, because a portal that populates it gives a
      // cleaner answer than history does; history when it does not.
      becameLeadDate: date(p.hs_lifecyclestage_lead_date) ?? lifecycleEntry(record, 'lead'),
      becameCustomerDate:
        date(p.hs_lifecyclestage_customer_date) ?? lifecycleEntry(record, 'customer'),
      becameMqlDate: lifecycleEntry(record, 'marketingqualifiedlead'),
      becameSqlDate: lifecycleEntry(record, 'salesqualifiedlead'),
      loadRunId,
    };

    await db
      .insert(t.factContact)
      .values(values)
      .onConflictDoUpdate({ target: t.factContact.contactId, set: values });

    written += 1;
  }

  return written;
}

/** Companies, for ICP tier and for matching a booking to billed revenue. */
async function conformCompanies(
  db: Database,
  loadRunId: string,
  records: HubspotObject[],
): Promise<number> {
  let written = 0;

  for (const record of records) {
    const p = record.properties ?? {};
    const values = {
      companyId: record.id,
      name: p.name ?? null,
      icpTier: p.hs_ideal_customer_profile ?? null,
      domain: p.domain ?? null,
      divisionCode: null,
      loadRunId,
    };

    await db
      .insert(t.factCompany)
      .values(values)
      .onConflictDoUpdate({ target: t.factCompany.companyId, set: values });

    written += 1;
  }

  return written;
}

/** Stage ids and the names behind them. Loaded before deals, and read by them. */
async function conformDealStages(
  db: Database,
  loadRunId: string,
  records: unknown[],
): Promise<number> {
  let written = 0;

  for (const record of records) {
    const pipeline = record as {
      id?: string;
      label?: string;
      stages?: Array<{
        id?: string;
        label?: string;
        displayOrder?: number;
        metadata?: { isClosed?: string | boolean; probability?: string };
      }>;
    };
    if (!pipeline.id) continue;

    for (const stage of pipeline.stages ?? []) {
      if (!stage.id || !stage.label) continue;

      const isClosed =
        stage.metadata?.isClosed === true || String(stage.metadata?.isClosed) === 'true';
      // HubSpot marks a won stage with probability 1 and a lost one with 0.
      const isWon = isClosed && Number(stage.metadata?.probability ?? 0) === 1;

      const values = {
        stageId: stage.id,
        label: stage.label,
        pipelineId: pipeline.id,
        pipelineLabel: pipeline.label ?? pipeline.id,
        displayOrder: stage.displayOrder ?? 0,
        isClosed,
        isWon,
        loadRunId,
      };

      await db
        .insert(t.dimDealStage)
        .values(values)
        .onConflictDoUpdate({ target: t.dimDealStage.stageId, set: values });

      written += 1;
    }
  }

  return written;
}

async function conformMeetings(
  db: Database,
  loadRunId: string,
  records: HubspotObject[],
): Promise<number> {
  const ownerNames = await ownerNameMap(db);
  let written = 0;

  for (const record of records) {
    const p = record.properties ?? {};
    const meetingDate = date(p.hs_meeting_start_time);
    // A meeting with no start time cannot be counted in a period, and counting
    // it in the wrong one would overstate Meetings Completed for that month.
    if (!meetingDate) continue;

    const values = {
      meetingId: record.id,
      divisionCode: null,
      meetingDate,
      outcome: p.hs_meeting_outcome ?? null,
      // Left null rather than bucketed into "Other": a meeting HubSpot has no
      // type for is a gap in how the team logs meetings, and the dashboard says
      // so. Folding it into a named category would hide the gap and inflate
      // whichever category absorbed it.
      activityType: p.hs_activity_type?.trim() || null,
      ownerId: p.hubspot_owner_id ?? null,
      ownerName: ownerNames.get(p.hubspot_owner_id ?? '') ?? null,
      associatedDealId: record.associations?.deals?.results?.[0]?.id ?? null,
      loadRunId,
    };

    await db
      .insert(t.factMeeting)
      .values(values)
      .onConflictDoUpdate({ target: t.factMeeting.meetingId, set: values });

    written += 1;
  }

  return written;
}

// ---------------------------------------------------------------------------
// Google Sheets
// ---------------------------------------------------------------------------

/**
 * The budget and headcount sheets.
 *
 * The layout expected is the one a budget sheet already has: a header row whose
 * first columns name the division and the line item, and whose remaining columns
 * are months. Headers are matched loosely — "Division", "division", "Div" — and
 * month columns are recognised from their value, so renaming a tab or reordering
 * months does not break the load.
 *
 * A sheet whose header row cannot be found is reported as such rather than
 * loaded as zeroes. A budget of zero and a budget that failed to load look
 * identical on a variance chart, and one of them is a lie.
 */
interface SheetTable {
  headerIndex: number;
  divisionColumn: number;
  lineItemColumn: number | null;
  months: Array<{ index: number; month: string }>;
}

/** Recognises 2026-03, 3/1/2026, "Mar 2026" and a Sheets serial date. */
export function parseMonthHeader(value: unknown): string | null {
  if (value === null || value === undefined) return null;

  if (typeof value === 'number' && value > 20000 && value < 80000) {
    // Google serial dates count from 30 December 1899.
    const epoch = Date.UTC(1899, 11, 30);
    const parsed = new Date(epoch + value * 86_400_000);
    return `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, '0')}-01`;
  }

  const text = String(value).trim();
  if (!text) return null;

  const iso = text.match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/);
  if (iso) return `${iso[1]}-${String(Number(iso[2])).padStart(2, '0')}-01`;

  const parsed = new Date(`${text} 1, 2000`.replace(/\s+1, 2000$/, ' 1, 2000'));
  const named = text.match(/^([A-Za-z]{3,9})[\s-]+(\d{4})$/);
  if (named) {
    const monthIndex = new Date(`${named[1]} 1, 2000`).getMonth();
    if (!Number.isNaN(monthIndex)) {
      return `${named[2]}-${String(monthIndex + 1).padStart(2, '0')}-01`;
    }
  }

  const slashed = text.match(/^(\d{1,2})\/(?:\d{1,2}\/)?(\d{4})$/);
  if (slashed) return `${slashed[2]}-${String(Number(slashed[1])).padStart(2, '0')}-01`;

  void parsed;
  return null;
}

/**
 * Is this row a HEADER, or a row of data that happens to contain a keyword?
 *
 * ARG's sheet is why this exists. Its layout is one row per month per division,
 * with a "Row Type" column whose value is literally "Division". The old detector
 * looked for any cell matching /^div(ision)?$/ and found it — in the DATA. It
 * then scanned that data row for month columns, hit the Excel serial in "Month
 * Start" and the raw figures, and read revenue and headcount numbers as dates.
 *
 * A header row is mostly words. Requiring that is what stops a data row being
 * mistaken for one, and it is checked before anything else is believed.
 */
function looksLikeHeaderRow(row: string[]): boolean {
  const filled = row.map((cell) => String(cell ?? '').trim()).filter(Boolean);
  if (filled.length < 2) return false;

  const numeric = filled.filter((cell) => /^[$(]?-?[\d,.]+%?\)?$/.test(cell)).length;
  // A header may legitimately carry a year or a date as a column title, so this
  // is a majority test rather than an absolute one.
  return numeric * 2 < filled.length;
}

/** A column whose header names one of the five reporting concepts. */
const LONG_VALUE_COLUMNS: Array<{ line: 'revenue' | 'cogs' | 'opex'; pattern: RegExp }> = [
  { line: 'revenue', pattern: /^revenue\b/i },
  { line: 'cogs', pattern: /^(cogs|cost of (goods|sales))\b/i },
  { line: 'opex', pattern: /^(opex|operating expenses?)\b/i },
];

export interface LongSheetTable {
  headerIndex: number;
  monthColumn: number;
  yearColumn: number | null;
  divisionColumn: number;
  rowTypeColumn: number | null;
  /** Reporting line -> the column carrying its figure. */
  valueColumns: Array<{ line: 'revenue' | 'cogs' | 'opex'; index: number }>;
  headcountColumn: number | null;
}

/**
 * The LONG layout: one row per month per division, values across the columns.
 *
 * This is the shape ARG's connector workbook actually uses, and the shape a
 * spreadsheet ends up in whenever somebody maintains it as a list rather than a
 * grid. It is detected before the wide layout because a long sheet also contains
 * a Division column, so the wide detector would half-match it and read the wrong
 * cells — which is exactly what happened.
 */
export function findLongSheetTable(values: string[][]): LongSheetTable | null {
  for (let index = 0; index < Math.min(values.length, 15); index++) {
    const row = (values[index] ?? []).map((cell) => String(cell ?? '').trim());
    if (!looksLikeHeaderRow(row)) continue;

    const lowered = row.map((cell) => cell.toLowerCase());

    const divisionColumn = lowered.findIndex((cell) => /^div(ision)?$/.test(cell));
    if (divisionColumn === -1) continue;

    // A month column names the month, rather than being one month's figures.
    const monthColumn = lowered.findIndex((cell) => /^(month|period|month name)$/.test(cell));
    if (monthColumn === -1) continue;

    const yearColumn = lowered.findIndex((cell) => /^(year|fiscal year|fy)$/.test(cell));
    const rowTypeColumn = lowered.findIndex((cell) => /^(row ?type|type|level)$/.test(cell));

    const valueColumns = LONG_VALUE_COLUMNS.flatMap(({ line, pattern }) => {
      const column = row.findIndex((cell) => pattern.test(cell));
      return column === -1 ? [] : [{ line, index: column }];
    });

    const headcountColumn = row.findIndex((cell) => /^head\s*count\b|^fte\b/i.test(cell));

    if (!valueColumns.length && headcountColumn === -1) continue;

    return {
      headerIndex: index,
      monthColumn,
      yearColumn: yearColumn === -1 ? null : yearColumn,
      divisionColumn,
      rowTypeColumn: rowTypeColumn === -1 ? null : rowTypeColumn,
      valueColumns,
      headcountColumn: headcountColumn === -1 ? null : headcountColumn,
    };
  }

  return null;
}

/**
 * A month from a name plus a year held in a separate column.
 *
 * "JAN" alone is not a month — it is a month NAME. Pairing it with the Year
 * column is what makes it one, and refusing to guess the year is what stops a
 * 2026 budget quietly loading against the current calendar year.
 */
export function monthFromNameAndYear(name: unknown, year: unknown): string | null {
  const text = String(name ?? '').trim();
  const yearText = String(year ?? '').trim();
  if (!text || !/^\d{4}$/.test(yearText)) return null;

  const months = [
    'jan', 'feb', 'mar', 'apr', 'may', 'jun',
    'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
  ];
  const index = months.indexOf(text.slice(0, 3).toLowerCase());
  if (index === -1) return null;

  return `${yearText}-${String(index + 1).padStart(2, '0')}-01`;
}

export function findSheetTable(values: string[][]): SheetTable | null {
  for (let index = 0; index < Math.min(values.length, 10); index++) {
    const row = values[index] ?? [];
    // Checked first: a data row carrying the word "Division" in a Row Type
    // column is not a header, and believing it was is what read ARG's revenue
    // figures as dates.
    if (!looksLikeHeaderRow(row.map((cell) => String(cell ?? '')))) continue;

    const lowered = row.map((cell) => String(cell ?? '').trim().toLowerCase());

    const divisionColumn = lowered.findIndex((cell) => /^div(ision)?$/.test(cell));
    if (divisionColumn === -1) continue;

    const lineItemColumn = lowered.findIndex((cell) => /^(line ?item|line|item|metric)$/.test(cell));

    const months: Array<{ index: number; month: string }> = [];
    row.forEach((cell, columnIndex) => {
      if (columnIndex === divisionColumn || columnIndex === lineItemColumn) return;
      const month = parseMonthHeader(cell);
      if (month) months.push({ index: columnIndex, month });
    });

    // Two months, not one. A single "month" in a header row is far more often a
    // stray year or an id than a genuine one-month report.
    if (months.length >= 2) {
      return { headerIndex: index, divisionColumn, lineItemColumn, months };
    }
  }

  return null;
}

function normaliseLineItem(value: string): 'revenue' | 'cogs' | 'opex' | null {
  const text = value.trim().toLowerCase();
  if (/^rev/.test(text) || text.includes('sales')) return 'revenue';
  if (text.includes('cogs') || text.includes('cost of')) return 'cogs';
  if (text.includes('opex') || text.includes('operating expense') || text.includes('expense')) {
    return 'opex';
  }
  return null;
}

/** What each budget scenario is called on screen. */
const SCENARIO_NAMES: Record<string, { name: string; sortOrder: number }> = {
  QBO_BUDGET: { name: 'QuickBooks Budget', sortOrder: 0 },
  MONTHLY_BUDGET: { name: 'FY Operating Budget (Sheets)', sortOrder: 1 },
  TENX: { name: '10X Growth Plan', sortOrder: 2 },
  FORECAST: { name: 'Forecast', sortOrder: 3 },
};

/** Creates the scenario on first use, and keeps its description current. */
async function ensureScenario(
  db: Database,
  scenarioCode: string,
  months: string[],
  description?: string,
): Promise<void> {
  const sorted = [...months].sort();
  const meta = SCENARIO_NAMES[scenarioCode] ?? { name: scenarioCode, sortOrder: 9 };
  const [existing] = await db
    .select()
    .from(t.budgetScenario)
    .where(eq(t.budgetScenario.scenarioCode, scenarioCode))
    .limit(1);

  if (!existing) {
    await db.insert(t.budgetScenario).values({
      scenarioCode,
      scenarioName: meta.name,
      description: description ?? null,
      firstMonth: sorted[0]!,
      lastMonth: sorted[sorted.length - 1]!,
      sortOrder: meta.sortOrder,
    });
    return;
  }

  await db
    .update(t.budgetScenario)
    .set({
      ...(description ? { description } : {}),
      firstMonth: sorted[0]! < existing.firstMonth ? sorted[0]! : existing.firstMonth,
      lastMonth: sorted[sorted.length - 1]! > existing.lastMonth ? sorted[sorted.length - 1]! : existing.lastMonth,
    })
    .where(eq(t.budgetScenario.scenarioCode, scenarioCode));
}

async function conformBudget(
  db: Database,
  loadRunId: string,
  scenarioCode: 'MONTHLY_BUDGET' | 'TENX' | 'FORECAST',
  values: string[][],
  lookup: DivisionLookup,
): Promise<{ written: number; notes: string[] }> {
  const rows: Array<{ periodMonth: string; divisionCode: string; lineItem: 'revenue' | 'cogs' | 'opex'; amount: Decimal }> = [];
  const unmappedDivisions = new Set<string>();
  const unmappedLines = new Set<string>();

  /**
   * The LONG layout is tried first, and ARG's workbook is in it: one row per
   * month per division, Revenue / COGS / OpEx across the columns.
   *
   * Order matters. A long sheet also has a Division column, so the wide detector
   * half-matches it and then reads whichever numeric cells happen to sit in the
   * serial-date range as months — which is how revenue figures became dates.
   */
  const longTable = findLongSheetTable(values);

  if (longTable) {
    for (let index = longTable.headerIndex + 1; index < values.length; index++) {
      const row = values[index] ?? [];

      // A "Total" row is a rollup of the divisions beside it. Loading it would
      // double every figure; §3 says ARG Total is computed, never stored.
      const rowType =
        longTable.rowTypeColumn === null
          ? ''
          : String(row[longTable.rowTypeColumn] ?? '').trim().toLowerCase();
      if (rowType && rowType !== 'division') continue;

      const divisionLabel = String(row[longTable.divisionColumn] ?? '').trim();
      if (!divisionLabel) continue;

      const divisionCode = lookup.byKey.get(divisionLabel.toLowerCase());
      if (!divisionCode) {
        if (!/^(arg[\s_-]*total|total|consolidated)$/i.test(divisionLabel)) {
          unmappedDivisions.add(divisionLabel);
        }
        continue;
      }

      const periodMonth =
        monthFromNameAndYear(
          row[longTable.monthColumn],
          longTable.yearColumn === null ? null : row[longTable.yearColumn],
        ) ?? parseMonthHeader(row[longTable.monthColumn]);

      if (!periodMonth) continue;

      for (const column of longTable.valueColumns) {
        const raw = String(row[column.index] ?? '').replace(/[$,\s]/g, '');
        if (!raw) continue;
        rows.push({
          periodMonth,
          divisionCode,
          lineItem: column.line,
          amount: new Decimal(raw || '0'),
        });
      }
    }
  }

  const table = longTable ? null : findSheetTable(values);
  if (!longTable && !table) {
    throw new UnmappedSourceDataError(
      'That sheet has no header row this can read. Nothing was written. Two shapes are ' +
        'understood: one row per month per division with Revenue/COGS/OpEx columns, or a grid ' +
        'with Division and Line Item columns and one column per month.',
    );
  }

  if (table) {

  for (let index = table.headerIndex + 1; index < values.length; index++) {
    const row = values[index] ?? [];
    const divisionLabel = String(row[table.divisionColumn] ?? '').trim();
    if (!divisionLabel) continue;

    const divisionCode = lookup.byKey.get(divisionLabel.toLowerCase());
    if (!divisionCode) {
      // ARG Total rows in a budget sheet are a rollup, not a division. Skipping
      // them is correct; anything else unrecognised is reported.
      if (!/^(arg[\s_-]*total|total|consolidated)$/i.test(divisionLabel)) {
        unmappedDivisions.add(divisionLabel);
      }
      continue;
    }

    const lineLabel =
      table.lineItemColumn === null ? '' : String(row[table.lineItemColumn] ?? '').trim();
    const lineItem = normaliseLineItem(lineLabel);
    if (!lineItem) {
      if (lineLabel) unmappedLines.add(lineLabel);
      continue;
    }

    for (const month of table.months) {
      const raw = String(row[month.index] ?? '').replace(/[$,\s]/g, '');
      if (!raw) continue;
      rows.push({
        periodMonth: month.month,
        divisionCode,
        lineItem,
        amount: new Decimal(raw || '0'),
      });
    }
  }
  }

  if (!rows.length) {
    throw new UnmappedSourceDataError(
      'The sheet was read, but no row matched a division and a line item (revenue, COGS or ' +
        'OpEx), so there was nothing to load. Nothing was written.',
    );
  }

  await ensurePeriods(db, [...new Set(rows.map((row) => row.periodMonth))]);

  await ensureScenario(
    db,
    scenarioCode,
    rows.map((row) => row.periodMonth),
    `Google Sheets, loaded ${new Date().toISOString().slice(0, 10)}`,
  );

  for (const row of rows) {
    const values = {
      scenarioCode,
      periodMonth: row.periodMonth,
      divisionCode: row.divisionCode,
      lineItem: row.lineItem,
      amount: n(row.amount),
      sourceSystem: 'SHEETS' as const,
      loadRunId,
    };

    await db
      .insert(t.factBudget)
      .values(values)
      .onConflictDoUpdate({
        target: [
          t.factBudget.scenarioCode,
          t.factBudget.periodMonth,
          t.factBudget.divisionCode,
          t.factBudget.lineItem,
        ],
        set: values,
      });
  }

  const notes: string[] = [];
  if (unmappedDivisions.size) {
    notes.push(
      `Skipped rows for ${[...unmappedDivisions].join(', ')} — no division of that name. ` +
        `Add it to dim_division, or correct the sheet.`,
    );
  }
  if (unmappedLines.size) {
    notes.push(
      `Skipped line items not recognised as revenue, COGS or OpEx: ${[...unmappedLines].join(', ')}.`,
    );
  }

  return { written: rows.length, notes };
}

async function conformHeadcount(
  db: Database,
  loadRunId: string,
  values: string[][],
  lookup: DivisionLookup,
): Promise<number> {
  const rows: Array<{ periodMonth: string; divisionCode: string; headcount: string }> = [];

  // The LONG layout first, for the same reason as the budget: a long sheet has a
  // Division column too, so the wide detector half-matches it and then reads a
  // headcount figure that happens to fall in the serial-date range as a month.
  const longTable = findLongSheetTable(values);

  if (longTable && longTable.headcountColumn !== null) {
    for (let index = longTable.headerIndex + 1; index < values.length; index++) {
      const row = values[index] ?? [];

      const rowType =
        longTable.rowTypeColumn === null
          ? ''
          : String(row[longTable.rowTypeColumn] ?? '').trim().toLowerCase();
      if (rowType && rowType !== 'division') continue;

      const divisionCode = lookup.byKey.get(
        String(row[longTable.divisionColumn] ?? '').trim().toLowerCase(),
      );
      if (!divisionCode) continue;

      const periodMonth =
        monthFromNameAndYear(
          row[longTable.monthColumn],
          longTable.yearColumn === null ? null : row[longTable.yearColumn],
        ) ?? parseMonthHeader(row[longTable.monthColumn]);
      if (!periodMonth) continue;

      const raw = String(row[longTable.headcountColumn] ?? '').replace(/[,\s]/g, '');
      if (!raw) continue;
      rows.push({ periodMonth, divisionCode, headcount: new Decimal(raw).toFixed(2) });
    }
  }

  const table = longTable ? null : findSheetTable(values);
  if (!longTable && !table) {
    throw new UnmappedSourceDataError(
      'The headcount sheet has no header row this can read. Nothing was written. Two shapes are ' +
        'understood: one row per month per division with a Headcount column, or a grid with a ' +
        'Division column and one column per month.',
    );
  }

  if (table) {
    for (let index = table.headerIndex + 1; index < values.length; index++) {
      const row = values[index] ?? [];
      const divisionCode = lookup.byKey.get(
        String(row[table.divisionColumn] ?? '').trim().toLowerCase(),
      );
      if (!divisionCode) continue;

      for (const month of table.months) {
        const raw = String(row[month.index] ?? '').replace(/[,\s]/g, '');
        if (!raw) continue;
        rows.push({ periodMonth: month.month, divisionCode, headcount: new Decimal(raw).toFixed(2) });
      }
    }
  }

  if (!rows.length) return 0;

  await ensurePeriods(db, [...new Set(rows.map((row) => row.periodMonth))]);

  for (const row of rows) {
    const values = {
      periodMonth: row.periodMonth,
      divisionCode: row.divisionCode,
      headcount: row.headcount,
      sourceSystem: 'SHEETS' as const,
      loadRunId,
    };

    await db
      .insert(t.factHeadcount)
      .values(values)
      .onConflictDoUpdate({
        target: [t.factHeadcount.periodMonth, t.factHeadcount.divisionCode],
        set: values,
      });
  }

  return rows.length;
}

// ---------------------------------------------------------------------------
// QuickBooks — budgets
// ---------------------------------------------------------------------------

interface QboBudget {
  Id?: string;
  Name?: string;
  StartDate?: string;
  EndDate?: string;
  BudgetType?: string;
  BudgetEntryType?: string;
  Active?: boolean;
  MetaData?: { LastUpdatedTime?: string };
  BudgetDetail?: Array<{
    BudgetDate?: string;
    Amount?: number | string;
    AccountRef?: { value?: string; name?: string };
    ClassRef?: { value?: string; name?: string };
  }>;
}

const FORECAST_NAME = /forecast|outlook|fcst/i;

/** The months a detail's amount belongs to, and the share of it each gets. */
function budgetMonths(date: string, entryType: string | undefined): string[] {
  const first = `${date.slice(0, 7)}-01`;
  const span = /quarter/i.test(entryType ?? '') ? 3 : /annual|year/i.test(entryType ?? '') ? 12 : 1;
  const [year, month] = first.split('-').map(Number) as [number, number];
  return Array.from({ length: span }, (_, offset) => {
    const shifted = new Date(Date.UTC(year, month - 1 + offset, 1));
    return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-01`;
  });
}

/**
 * Which budgets are current: one per scenario per year, the most recently edited.
 *
 * QuickBooks keeps every budget anybody ever made — last year's, a draft, the
 * one revised in June. Summing them would double the plan; picking by name would
 * break the first time someone renames one. The newest active profit-and-loss
 * budget for each year wins, and a budget whose name says "forecast" is the
 * forecast rather than the budget.
 */
export function currentBudgets(budgets: QboBudget[]): Array<{ scenario: 'QBO_BUDGET' | 'FORECAST'; budget: QboBudget }> {
  const chosen = new Map<string, { scenario: 'QBO_BUDGET' | 'FORECAST'; budget: QboBudget }>();
  for (const budget of budgets) {
    if (budget.Active === false) continue;
    if (budget.BudgetType && !/profit/i.test(budget.BudgetType)) continue;
    const scenario = FORECAST_NAME.test(budget.Name ?? '') ? 'FORECAST' : 'QBO_BUDGET';
    const year = (budget.StartDate ?? budget.BudgetDetail?.[0]?.BudgetDate ?? '').slice(0, 4);
    const key = `${scenario}|${year}`;
    const current = chosen.get(key);
    const stamp = budget.MetaData?.LastUpdatedTime ?? '';
    if (!current || stamp > (current.budget.MetaData?.LastUpdatedTime ?? '')) {
      chosen.set(key, { scenario, budget });
    }
  }
  return [...chosen.values()];
}

async function conformQboBudgets(
  db: Database,
  loadRunId: string,
  budgets: QboBudget[],
  lookup: DivisionLookup,
  notes: string[],
): Promise<number> {
  const selected = currentBudgets(budgets);
  if (!selected.length) {
    notes.push(
      budgets.length
        ? 'QuickBooks holds budgets, but none is an active profit-and-loss budget, so none was loaded.'
        : 'QuickBooks holds no budgets. Budget columns stay blank until one is created in QuickBooks ' +
            '(or a budget tab is loaded from Google Sheets).',
    );
    return 0;
  }

  const accounts = new Map((await db.select().from(t.dimAccount)).map((row) => [row.accountId, row]));
  const budgetLine = (line: string | null | undefined): 'revenue' | 'cogs' | 'opex' | null =>
    line === 'revenue' ? 'revenue' : line === 'cogs' || line === 'payroll_direct' ? 'cogs' : line === 'opex' || line === 'payroll_expense' ? 'opex' : null;

  let written = 0;

  for (const { scenario, budget } of selected) {
    const divisional = new Map<string, Decimal>();
    const company = new Map<string, Decimal>();
    const unplacedAccounts = new Set<string>();
    const unmappedClasses = new Set<string>();

    for (const detail of budget.BudgetDetail ?? []) {
      if (!detail.BudgetDate) continue;
      const value = new Decimal(String(detail.Amount ?? 0));
      if (value.isZero()) continue;

      const accountId = detail.AccountRef?.value ?? '';
      const line = budgetLine(accounts.get(accountId)?.reportingLine);
      if (!line) {
        // A balance-sheet account in a P&L budget, or one not yet in the chart.
        unplacedAccounts.add(detail.AccountRef?.name ?? accountId);
        continue;
      }

      const months = budgetMonths(detail.BudgetDate, budget.BudgetEntryType);
      const share = value.div(months.length);

      const classRef = detail.ClassRef;
      const divisionCode = classRef
        ? resolveDivision(lookup, classRef.value, classRef.name)
        : null;
      if (classRef && !divisionCode && !isExcluded(lookup, classRef.value, classRef.name)) {
        unmappedClasses.add(classRef.name ?? classRef.value ?? '?');
      }

      for (const month of months) {
        const companyKey = `${month}|${line}`;
        company.set(companyKey, (company.get(companyKey) ?? new Decimal(0)).plus(share));
        if (divisionCode) {
          const k = `${month}|${divisionCode}|${line}`;
          divisional.set(k, (divisional.get(k) ?? new Decimal(0)).plus(share));
        }
      }
    }

    const months = [...new Set([...company.keys()].map((k) => k.split('|')[0]!))].sort();
    if (!months.length) {
      notes.push(`The QuickBooks budget "${budget.Name}" has no profit-and-loss amounts to load.`);
      continue;
    }

    await ensurePeriods(db, months);
    await ensureScenario(
      db,
      scenario,
      months,
      `QuickBooks budget “${budget.Name ?? budget.Id}”${budget.MetaData?.LastUpdatedTime ? `, last edited ${budget.MetaData.LastUpdatedTime.slice(0, 10)}` : ''}`,
    );

    // The chosen budget replaces the scenario for its months wholesale, so a line
    // somebody deleted from the budget goes to zero instead of lingering.
    await db
      .delete(t.factBudget)
      .where(
        sql`${t.factBudget.scenarioCode} = ${scenario} and ${t.factBudget.periodMonth} >= ${months[0]} and ${t.factBudget.periodMonth} <= ${months[months.length - 1]}`,
      );

    for (const [k, value] of divisional) {
      const [periodMonth, divisionCode, lineItem] = k.split('|') as [string, string, 'revenue' | 'cogs' | 'opex'];
      await db.insert(t.factBudget).values({
        scenarioCode: scenario,
        periodMonth,
        divisionCode,
        lineItem,
        amount: n(value),
        sourceSystem: 'QBO',
        loadRunId,
      });
      written += 1;
    }

    // The whole budget, whatever its class — what ARG Total is measured against.
    for (const month of months) {
      written += await writeCompanyTotals(db, loadRunId, month, scenario, {
        revenue: company.get(`${month}|revenue`) ?? new Decimal(0),
        cogs: company.get(`${month}|cogs`) ?? new Decimal(0),
        opex: company.get(`${month}|opex`) ?? new Decimal(0),
      });
    }

    notes.push(
      `Loaded the QuickBooks ${scenario === 'FORECAST' ? 'forecast' : 'budget'} “${budget.Name}” ` +
        `for ${months[0]!.slice(0, 7)} → ${months[months.length - 1]!.slice(0, 7)}` +
        (divisional.size ? '.' : ' at company level only — it is not split by class, so divisions show no budget.'),
    );
    if (unplacedAccounts.size) {
      notes.push(
        `Budget lines on accounts with no P&L reporting line were left out: ${[...unplacedAccounts].slice(0, 8).join(', ')}.`,
      );
    }
    if (unmappedClasses.size) {
      notes.push(
        `Budget lines on classes that map to no division count toward ARG Total only: ${[...unmappedClasses].join(', ')}.`,
      );
    }
  }

  return written;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Conforms one landed batch into the warehouse.
 *
 * Called immediately after the raw payloads are stored, inside the same load
 * run, so `rows_written` on the run means rows in the fact tables rather than
 * rows in a landing table nothing reads.
 */
export async function conformBatch(
  db: Database,
  loadRunId: string,
  batch: RawBatch,
): Promise<ConformOutcome> {
  // One transaction per batch. Conforming a month replaces its account-level
  // balances, so a failure partway through would otherwise leave that month
  // holding some of the new figures and none of the old ones — a month that
  // silently reads low, which is worse than a month that failed to load.
  try {
    return await db.transaction(async (tx) =>
      conformInTransaction(tx as unknown as Database, loadRunId, batch),
    );
  } catch (error) {
    // A refusal rolls the transaction back, and that has to include the fact
    // tables — but NOT the record of which class caused it. Written here, on
    // the outer connection, so the class survives the rollback and reaches the
    // mapping screen. Otherwise the pull fails, names a class, and offers
    // nowhere to decide it: the exact dead end this was built to remove.
    if (error instanceof UnmappedSourceDataError && error.classNames.length) {
      await noteUnmappedClasses(db, error.classNames).catch(() => {
        // Recording the class is a convenience; the refusal is the point, and
        // it must not be replaced by a failure to write a hint about it.
      });
    }
    throw error;
  }
}


/**
 * The months a batch of HubSpot records falls into, within believable bounds.
 *
 * Open deals legitimately carry close dates in the future, so the forward bound
 * is generous rather than absent — but a mistyped date should not conjure a
 * period in 2087 and a month selector that runs to the next century. Anything
 * outside the range is ignored here; the record itself is still written, and the
 * date it carries is still the date it carries.
 */
function hubspotMonths(records: HubspotObject[]): string[] {
  const now = new Date();
  const floor = Date.UTC(now.getUTCFullYear() - 10, now.getUTCMonth(), 1);
  const ceiling = Date.UTC(now.getUTCFullYear() + 2, now.getUTCMonth(), 1);

  const months = new Set<string>();

  for (const record of records) {
    const p = record.properties ?? {};
    for (const raw of [p.closedate, p.createdate, p.hs_meeting_start_time, p.hs_timestamp]) {
      const parsed = date(raw);
      if (!parsed) continue;

      const stamp = Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), 1);
      if (stamp < floor || stamp > ceiling) continue;

      months.add(
        `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, '0')}-01`,
      );
    }
  }

  return [...months].sort();
}

async function conformInTransaction(
  db: Database,
  loadRunId: string,
  batch: RawBatch,
): Promise<ConformOutcome> {
  const lookup = await divisionLookup(db);
  const notes: string[] = [];
  let rowsWritten = 0;

  if (batch.sourceSystem === 'QBO') {
    /**
     * Aging is a SNAPSHOT, so it is handled before the per-month loop.
     *
     * Open balances are as they stand now. A past month's aging cannot be
     * reconstructed from them — a since-paid invoice has no balance left to age
     * — so the snapshot is written against one month rather than repeated into
     * every month of the window, which would state twelve different months of
     * history that all happen to be today.
     */
    if (batch.entity === 'ar_aging' || batch.entity === 'ap_aging') {
      const kind = batch.entity === 'ar_aging' ? 'AR' : 'AP';
      const entityName = kind === 'AR' ? 'Invoice' : 'Bill';

      const transactions = batch.records.flatMap((record) => {
        const payload = record.payload as { QueryResponse?: Record<string, unknown[]> };
        return (payload.QueryResponse?.[entityName] ?? []) as QboTransaction[];
      });

      const snapshotMonth = `${batch.window.end.slice(0, 7)}-01`;
      const closedSnapshot = await ensurePeriods(db, [snapshotMonth]);

      if (closedSnapshot.has(snapshotMonth)) {
        notes.push(
          `${snapshotMonth.slice(0, 7)} is closed, so the ${kind === 'AR' ? 'A/R' : 'A/P'} aging ` +
            `snapshot was not written into it.`,
        );
        return { rowsWritten, notes };
      }

      rowsWritten += await conformAging(
        db,
        loadRunId,
        snapshotMonth,
        transactions,
        lookup,
        kind,
        notes,
      );
      notes.push(
        `Aged against ${lastDayOfMonth(snapshotMonth)} from ${transactions.length.toLocaleString()} ` +
          `open ${entityName.toLowerCase()}${transactions.length === 1 ? '' : 's'}. This is today's ` +
          `position, not a reconstruction of that month.`,
      );
      return { rowsWritten, notes };
    }

    if (batch.entity === 'budgets') {
      const budgets = batch.records.flatMap((record) => {
        const payload = record.payload as { QueryResponse?: { Budget?: QboBudget[] } };
        return payload.QueryResponse?.Budget ?? [];
      });
      rowsWritten += await conformQboBudgets(db, loadRunId, budgets, lookup, notes);
      return { rowsWritten, notes };
    }

    // One record per month for the report entities; the month is the record key.
    const months = batch.records.map((record) => record.key).filter((key) => /^\d{4}-\d{2}-\d{2}$/.test(key));
    const closed = months.length ? await ensurePeriods(db, months) : new Set<string>();

    for (const record of batch.records) {
      if (closed.has(record.key)) {
        notes.push(`${record.key.slice(0, 7)} is closed and was left untouched.`);
        continue;
      }

      switch (batch.entity) {
        case 'profit_and_loss':
          rowsWritten += await conformProfitAndLoss(
            db,
            loadRunId,
            record.key,
            record.payload as QboReport,
            lookup,
          );
          break;
        case 'balance_sheet':
          rowsWritten += await conformBalanceSheet(
            db,
            loadRunId,
            record.key,
            record.payload as QboReport,
            lookup,
            notes,
          );
          break;
        case 'accounts':
          rowsWritten += await conformAccounts(db, record.payload as QboQueryResponse);
          break;
        case 'classes': {
          const unmapped = await checkClasses(db, record.payload as QboQueryResponse);
          notes.push(
            unmapped.length
              ? `${unmapped.length} QuickBooks class${unmapped.length === 1 ? '' : 'es'} map to no ` +
                  `division: ${unmapped.join(', ')}. Any figure carried on them is currently ` +
                  `excluded from ARG Total.`
              : 'Every active QuickBooks class maps to a division.',
          );
          break;
        }
        default:
          // The trial balance is landed and kept but not conformed: QuickBooks
          // gives it no class dimension at all, so it produces no divisional
          // rows. It is the company-level tie-out against the classed P&L and
          // balance sheet, which is what the audit pack uses it for.
          notes.push(
            `${batch.entity.replace(/_/g, ' ')} was landed in full and is available in the audit ` +
              `pack, but it is not yet conformed into a fact table.`,
          );
          return { rowsWritten, notes };
      }
    }

    return { rowsWritten, notes };
  }

  if (batch.sourceSystem === 'HUBSPOT') {
    const records = batch.records.map((record) => record.payload as HubspotObject);

    // Register the months this batch actually falls into.
    //
    // A period is a month the business has data for, and HubSpot creates them
    // exactly as QuickBooks does — but only the QuickBooks and budget paths ever
    // called ensurePeriods, so dim_period stopped at the end of the seeded
    // history. Deals closing after that had no period to belong to, the month
    // selector could not offer those months, and a warehouse full of live
    // pipeline read as zero on every screen.
    const months = hubspotMonths(records);
    if (months.length) await ensurePeriods(db, months);

    switch (batch.entity) {
      case 'deals':
        rowsWritten = await conformDeals(db, loadRunId, records, lookup);
        if (!process.env.HUBSPOT_DIVISION_PROPERTY) {
          notes.push(
            'Deals loaded without a division: HUBSPOT_DIVISION_PROPERTY is unset (open item 2), ' +
              'so sales and marketing report at ARG Total only rather than on an invented ' +
              'attribution rule.',
          );
        }
        break;
      case 'deal_stages':
        rowsWritten = await conformDealStages(db, loadRunId, batch.records.map((r) => r.payload));
        notes.push(
          rowsWritten
            ? `${rowsWritten} deal stages named. Stage ids are opaque, so "reached Proposal" cannot be evaluated without these.`
            : 'HubSpot returned no pipelines, so stage names are unknown and proposal counts will be empty.',
        );
        break;
      case 'companies':
        rowsWritten = await conformCompanies(db, loadRunId, records);
        break;
      case 'contacts':
        rowsWritten = await conformContacts(db, loadRunId, records);
        break;
      case 'meetings':
        rowsWritten = await conformMeetings(db, loadRunId, records);
        break;
      case 'owners': {
        // Owners are reference data, already landed in raw_payload by the
        // caller. What conforming means here is attaching the names to the deals
        // that carry their ids, so the salesperson leaderboard has something to
        // group by.
        const names = await ownerNameMap(db);
        for (const [ownerId, ownerName] of names) {
          await db
            .update(t.factDeal)
            .set({ ownerName })
            .where(eq(t.factDeal.ownerId, ownerId));
        }
        rowsWritten = names.size;
        notes.push(
          names.size
            ? `${names.size} salespeople named; the leaderboard groups deals by these.`
            : 'HubSpot returned no owners, so deals will show as Unassigned on the leaderboard.',
        );
        break;
      }
      default:
        notes.push(`${batch.entity} was landed but is not conformed into a fact table.`);
    }

    return { rowsWritten, notes };
  }

  if (batch.sourceSystem === 'SHEETS') {
    const payload = batch.records[0]?.payload as
      | { values?: string[][]; absent?: boolean; tabs?: string[] }
      | undefined;
    const values = payload?.values ?? [];

    if (payload?.absent) {
      notes.push(
        `No ${batch.entity.replace(/_/g, ' ')} tab in the connected spreadsheet, so none was loaded. ` +
          `Tabs it has: ${(payload.tabs ?? []).join(', ') || '(none listed)'}. A tab with "Forecast" ` +
          `in its name is picked up on the next pull.`,
      );
      return { rowsWritten, notes };
    }

    if (!values.length) {
      const range = (batch.records[0]?.payload as { range?: string } | undefined)?.range;
      throw new UnmappedSourceDataError(
        `The range ${range ?? 'requested'} came back empty. Nothing was written — an empty budget ` +
          `and a budget that failed to load look identical on a variance chart. The connector ` +
          `picks the tab from the spreadsheet's real tab names, so an empty result here means the ` +
          `tab it matched genuinely has no rows, not that the tab is missing.`,
      );
    }

    switch (batch.entity) {
      case 'monthly_budget': {
        const result = await conformBudget(db, loadRunId, 'MONTHLY_BUDGET', values, lookup);
        rowsWritten = result.written;
        notes.push(...result.notes);
        break;
      }
      case 'tenx_budget': {
        const result = await conformBudget(db, loadRunId, 'TENX', values, lookup);
        rowsWritten = result.written;
        notes.push(...result.notes);
        break;
      }
      case 'forecast': {
        const result = await conformBudget(db, loadRunId, 'FORECAST', values, lookup);
        rowsWritten = result.written;
        notes.push(...result.notes);
        break;
      }
      case 'headcount':
        rowsWritten = await conformHeadcount(db, loadRunId, values, lookup);
        break;
      default:
        notes.push(`${batch.entity} was landed but is not conformed into a fact table.`);
    }

    return { rowsWritten, notes };
  }

  return { rowsWritten, notes: [`${batch.sourceSystem} has no conform step.`] };
}
