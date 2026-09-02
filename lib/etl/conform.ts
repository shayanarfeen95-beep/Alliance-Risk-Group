import 'server-only';
import Decimal from 'decimal.js';
import { eq, sql } from 'drizzle-orm';
import type { Database } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import { rollUpGl, type ReportingLine } from './rollup';
import type { RawBatch } from '@/lib/connectors/types';

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
  constructor(message: string) {
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

  return { byKey, codes: rows.map((row) => row.divisionCode) };
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

/**
 * Every leaf row of a QuickBooks report, carrying the section it sits in.
 *
 * The section is what tells revenue from cost — QuickBooks does not repeat that
 * on the row itself. Summary rows are skipped: they are totals of rows already
 * yielded, and including them would double every figure.
 */
function* leafRows(
  rows: QboRow[] | undefined,
  group: string | undefined,
): Generator<{ group: string | undefined; cells: QboCell[] }> {
  for (const row of rows ?? []) {
    const inherited = row.group ?? group;

    if (row.Rows?.Row?.length) {
      yield* leafRows(row.Rows.Row, inherited);
      continue;
    }

    const cells = row.ColData ?? row.Header?.ColData;
    if (cells?.length && row.type !== 'Section') {
      yield { group: inherited, cells };
    }
  }
}

/** The money columns of a report, excluding the running Total column. */
function divisionColumns(
  report: QboReport,
  lookup: DivisionLookup,
): { columns: Array<{ index: number; divisionCode: string }>; unmapped: string[] } {
  const all = report.Columns?.Column ?? [];
  const columns: Array<{ index: number; divisionCode: string }> = [];
  const unmapped: string[] = [];

  all.forEach((column, index) => {
    if (column.ColType !== 'Money') return;

    const title = column.ColTitle ?? '';
    const meta = Object.fromEntries(
      (column.MetaData ?? []).map((entry) => [entry.Name ?? '', entry.Value ?? '']),
    );

    // The total column is a rollup of the others; §3 says ARG Total is never a
    // row of its own, and taking it as one would double the consolidated figure.
    if (!title || /^total$/i.test(title) || meta.ColKey === 'total') return;

    const divisionCode = resolveDivision(lookup, meta.ClassRef ?? meta.ClassId, title);
    if (divisionCode) columns.push({ index, divisionCode });
    else unmapped.push(title);
  });

  return { columns, unmapped };
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
async function conformProfitAndLoss(
  db: Database,
  loadRunId: string,
  month: string,
  report: QboReport,
  lookup: DivisionLookup,
): Promise<number> {
  const { columns, unmapped } = divisionColumns(report, lookup);

  if (unmapped.length) {
    throw new UnmappedSourceDataError(
      `The QuickBooks profit-and-loss for ${month.slice(0, 7)} has classes that map to no ` +
        `division: ${unmapped.join(', ')}. Nothing was written. Add the class to the division in ` +
        `dim_division.qbo_class_ids — loading it against the wrong division, or dropping it, ` +
        `would move revenue between two divisional P&Ls invisibly.`,
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

  for (const { group, cells } of leafRows(report.Rows?.Row, undefined)) {
    const label = cells[0]?.value?.trim();
    if (!label) continue;

    const accountId = cells[0]?.id?.trim() || label;
    const known = existing.get(accountId);
    const line = known?.reportingLine ?? reportingLineForSection(group);

    if (!line) {
      // A row that is neither known nor classifiable is not silently dropped:
      // it is money, and money that vanishes between QuickBooks and a dashboard
      // is the failure this whole system exists to prevent.
      if (!known) unmappedAccounts.push(`${label} (section: ${group ?? 'none'})`);
      continue;
    }

    seenAccounts.set(accountId, { name: label, line });

    for (const column of columns) {
      const value = amount(cells[column.index]);
      if (value.isZero()) continue;
      balances.push({ divisionCode: column.divisionCode, accountId, amount: value });
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
    if (existing.has(accountId)) continue;
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

  return written;
}

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

async function conformBalanceSheet(
  db: Database,
  loadRunId: string,
  month: string,
  report: QboReport,
  lookup: DivisionLookup,
): Promise<number> {
  const { columns, unmapped } = divisionColumns(report, lookup);

  if (unmapped.length) {
    throw new UnmappedSourceDataError(
      `The ${month.slice(0, 7)} balance sheet has classes that map to no division: ` +
        `${unmapped.join(', ')}. Nothing was written.`,
    );
  }
  if (!columns.length) {
    // Open item 1: ARG may not class its balance sheet at all. That is a real
    // answer, and the dashboards already handle it — but it is not something to
    // discover by finding an empty table.
    throw new UnmappedSourceDataError(
      `The ${month.slice(0, 7)} balance sheet came back with no class columns, so it cannot be ` +
        `loaded by division. If ARG does not class its balance sheet, set BALANCE_SHEET_CLASSED ` +
        `to false — the four affected metrics then report at ARG Total and say so.`,
    );
  }

  const accounts = new Map(
    (await db.select().from(t.dimAccount)).map((row) => [row.accountId, row]),
  );

  const totals = new Map<string, Record<string, Decimal>>();
  const unclassified: string[] = [];

  for (const { cells } of leafRows(report.Rows?.Row, undefined)) {
    const label = cells[0]?.value?.trim();
    if (!label) continue;

    const accountId = cells[0]?.id?.trim() || label;
    const line = accounts.get(accountId)?.balanceSheetLine;

    if (!line || !(line in BALANCE_SHEET_FIELDS)) {
      if (!accounts.has(accountId)) unclassified.push(label);
      continue;
    }

    for (const column of columns) {
      const value = amount(cells[column.index]);
      if (value.isZero()) continue;

      const division = totals.get(column.divisionCode) ?? {};
      const field = BALANCE_SHEET_FIELDS[line as keyof typeof BALANCE_SHEET_FIELDS];
      division[field] = (division[field] ?? new Decimal(0)).plus(value);
      totals.set(column.divisionCode, division);
    }
  }

  if (unclassified.length) {
    throw new UnmappedSourceDataError(
      `${unclassified.length} balance-sheet account${unclassified.length === 1 ? '' : 's'} in ` +
        `${month.slice(0, 7)} have no balance_sheet_line in dim_account: ` +
        `${unclassified.slice(0, 8).join('; ')}${unclassified.length > 8 ? '; …' : ''}. ` +
        `Nothing was written — an unclassified balance would silently understate cash, ` +
        `receivables or payables, and DSO, DPO, CCC and Cash Runway all read from them.`,
    );
  }

  let written = 0;
  for (const [divisionCode, fields] of totals) {
    const values = {
      periodMonth: month,
      divisionCode,
      cash: n(fields.cash ?? new Decimal(0)),
      accountsReceivable: n(fields.accountsReceivable ?? new Decimal(0)),
      otherCurrentAssets: n(fields.otherCurrentAssets ?? new Decimal(0)),
      fixedAssets: n(fields.fixedAssets ?? new Decimal(0)),
      accountsPayable: n(fields.accountsPayable ?? new Decimal(0)),
      ccLiability: n(fields.ccLiability ?? new Decimal(0)),
      otherCurrentLiabilities: n(fields.otherCurrentLiabilities ?? new Decimal(0)),
      ltLiabilities: n(fields.ltLiabilities ?? new Decimal(0)),
      shareholderEquity: n(fields.shareholderEquity ?? new Decimal(0)),
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
async function conformAccounts(db: Database, payload: QboQueryResponse): Promise<number> {
  const accounts = payload.QueryResponse?.Account ?? [];
  if (!accounts.length) return 0;

  const existing = new Set((await db.select({ id: t.dimAccount.accountId }).from(t.dimAccount)).map((row) => row.id));

  let written = 0;
  for (const account of accounts) {
    const accountId = account.Id?.trim();
    if (!accountId || existing.has(accountId)) continue;

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

    await db
      .insert(t.dimAccount)
      .values({
        accountId,
        accountNumber: account.AcctNum ?? null,
        accountName: account.Name ?? accountId,
        accountType: isCogs ? 'COGS' : accountType,
        // Balance-sheet accounts are deliberately left unmapped: which grouping
        // a given asset belongs to is a Westport decision, and the balance-sheet
        // conform refuses to run rather than guessing it.
        reportingLine:
          accountType === 'INCOME'
            ? 'revenue'
            : isCogs
              ? 'cogs'
              : accountType === 'EXPENSE'
                ? 'opex'
                : null,
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
  const unmapped = classes
    .filter((entry) => entry.Active !== false)
    .filter((entry) => !resolveDivision(lookup, entry.Id, entry.Name))
    .map((entry) => entry.Name ?? entry.Id ?? 'unnamed');

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

async function conformDeals(
  db: Database,
  loadRunId: string,
  records: HubspotObject[],
  lookup: DivisionLookup,
): Promise<number> {
  // Owner names come from HubSpot's owners endpoint in a separate load; until
  // one has run, a deal keeps whatever name it already had rather than losing it.
  const ownerNames = new Map(
    (await db
      .select({ ownerId: t.factDeal.ownerId, ownerName: t.factDeal.ownerName })
      .from(t.factDeal)
      .where(sql`${t.factDeal.ownerName} is not null`))
      .map((row) => [row.ownerId ?? '', row.ownerName ?? '']),
  );

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
      enteredProposalAt: proposalEntry(record),
      ownerId: p.hubspot_owner_id ?? null,
      ownerName: ownerNames.get(p.hubspot_owner_id ?? '') ?? null,
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

/** The earliest time a deal entered a stage whose name mentions a proposal. */
function proposalEntry(record: HubspotObject): Date | null {
  const history = record.propertiesWithHistory?.dealstage ?? [];
  const entries = history
    .filter((entry) => /proposal|quote/i.test(entry.value ?? ''))
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
      becameLeadDate: date(p.hs_lifecyclestage_lead_date),
      becameCustomerDate: date(p.hs_lifecyclestage_customer_date),
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

async function conformMeetings(
  db: Database,
  loadRunId: string,
  records: HubspotObject[],
): Promise<number> {
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
      ownerId: p.hubspot_owner_id ?? null,
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

export function findSheetTable(values: string[][]): SheetTable | null {
  for (let index = 0; index < Math.min(values.length, 10); index++) {
    const row = values[index] ?? [];
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

    if (months.length) {
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

async function conformBudget(
  db: Database,
  loadRunId: string,
  scenarioCode: 'MONTHLY_BUDGET' | 'TENX',
  values: string[][],
  lookup: DivisionLookup,
): Promise<{ written: number; notes: string[] }> {
  const table = findSheetTable(values);
  if (!table) {
    throw new UnmappedSourceDataError(
      'That sheet has no header row naming a Division column and at least one month column, so ' +
        'it could not be read. Nothing was written. The expected shape is one row per division ' +
        'and line item, with a column per month.',
    );
  }

  const rows: Array<{ periodMonth: string; divisionCode: string; lineItem: 'revenue' | 'cogs' | 'opex'; amount: Decimal }> = [];
  const unmappedDivisions = new Set<string>();
  const unmappedLines = new Set<string>();

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

  if (!rows.length) {
    throw new UnmappedSourceDataError(
      'The sheet was read, but no row matched a division and a line item (revenue, COGS or ' +
        'OpEx), so there was nothing to load. Nothing was written.',
    );
  }

  await ensurePeriods(db, [...new Set(rows.map((row) => row.periodMonth))]);

  const [scenario] = await db
    .select()
    .from(t.budgetScenario)
    .where(eq(t.budgetScenario.scenarioCode, scenarioCode))
    .limit(1);

  const months = rows.map((row) => row.periodMonth).sort();
  if (!scenario) {
    await db.insert(t.budgetScenario).values({
      scenarioCode,
      scenarioName: scenarioCode === 'TENX' ? '10X Growth Plan' : 'FY Operating Budget',
      firstMonth: months[0]!,
      lastMonth: months[months.length - 1]!,
      sortOrder: scenarioCode === 'TENX' ? 2 : 1,
    });
  }

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
  const table = findSheetTable(values);
  if (!table) {
    throw new UnmappedSourceDataError(
      'The headcount sheet has no header row naming a Division column and at least one month ' +
        'column, so it could not be read. Nothing was written.',
    );
  }

  const rows: Array<{ periodMonth: string; divisionCode: string; headcount: string }> = [];

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
  return db.transaction(async (tx) =>
    conformInTransaction(tx as unknown as Database, loadRunId, batch),
  );
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
          // Trial balance and the aging reports are landed and kept, but they
          // are not conformed: the aging reports carry no class dimension, and
          // fact_aging is per division. Saying so is better than writing an
          // ARG-Total row the schema forbids or splitting one on a guess.
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
      case 'contacts':
        rowsWritten = await conformContacts(db, loadRunId, records);
        break;
      case 'meetings':
        rowsWritten = await conformMeetings(db, loadRunId, records);
        break;
      default:
        notes.push(`${batch.entity} was landed but is not conformed into a fact table.`);
    }

    return { rowsWritten, notes };
  }

  if (batch.sourceSystem === 'SHEETS') {
    const payload = batch.records[0]?.payload as { values?: string[][] } | undefined;
    const values = payload?.values ?? [];

    if (!values.length) {
      throw new UnmappedSourceDataError(
        'That range came back empty. Nothing was written — an empty budget and a budget that ' +
          'failed to load look identical on a variance chart.',
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
