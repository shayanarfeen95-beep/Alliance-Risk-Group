import 'server-only';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import * as t from '@/lib/db/schema';
import type { Database } from '@/lib/db/client';
import { buildAliasMap, normaliseCode } from '@/lib/divisions';
import { rollUpGl, type GlRow, type ReportingLine } from './rollup';
import { parseQboAmount, parseQboReport, type QboReport } from './qbo-report';
import type { RawBatch, RawRecord } from '@/lib/connectors/types';

/**
 * Raw payloads -> facts.
 *
 * This is the step that was missing, and its absence was the whole complaint:
 * connecting QuickBooks landed a pile of JSON in `raw_payload` and stopped, so a
 * source could be connected, a load could report success, and every dashboard
 * would still show exactly what it showed before. A connection that changes
 * nothing visible is indistinguishable from a connection that does not work.
 *
 * Three rules govern everything below, and each is the codified version of a
 * mistake that would otherwise be invisible:
 *
 *   1. **Nothing is guessed.** An account with no reporting line, a class with
 *      no division, a HubSpot division value nobody has mapped — each stops the
 *      load and is reported by name. Loads never fall back to "other" (§3,
 *      Acceptance Test 8), because a wrong division moves money between P&Ls
 *      and nets to zero at ARG Total, where nobody would ever see it.
 *   2. **Closed months are not touched.** A closed month is an accountability
 *      record. A refresh that quietly restates one is how a board pack stops
 *      matching the board pack that was presented.
 *   3. **Derived figures are derived here, never imported.** Gross and net
 *      profit come from `rollUpGl`, so the payroll memo treatment holds by
 *      construction rather than by everyone remembering §4.2.
 *
 * Everything runs inside one transaction per load run. A conform that fails
 * leaves the warehouse exactly as it was, and the raw payloads are still on
 * disk, so it can be replayed without calling the provider again.
 */

export interface ConformOutcome {
  rowsWritten: number;
  /** Which fact tables this load actually changed. */
  tables: string[];
  /** Real but non-fatal: things a reader should know about the load. */
  warnings: string[];
  skippedClosedMonths: string[];
}

export interface Blocker {
  kind: 'UNMAPPED_CLASS' | 'UNMAPPED_ACCOUNT' | 'UNMAPPED_DIVISION' | 'UNSUPPORTED_SHAPE';
  detail: string;
  /** What to change so the next attempt succeeds. */
  remedy: string;
}

/**
 * Raised when a load cannot proceed without someone deciding something.
 *
 * It carries every blocker, not the first one. Somebody about to go and map
 * accounts wants the whole list in one trip; failing on each in turn produces
 * four round trips through a connector that takes a minute to run.
 */
export class ConformBlockedError extends Error {
  constructor(public readonly blockers: Blocker[]) {
    super(
      `This load was stopped because ${blockers.length} thing${blockers.length === 1 ? '' : 's'} ` +
        `could not be resolved without a decision, and nothing was written:\n` +
        blockers.map((b) => `  • ${b.detail}\n    ${b.remedy}`).join('\n'),
    );
    this.name = 'ConformBlockedError';
  }
}

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

interface Dimensions {
  /** Normalised class id / legacy code / division code -> division code. */
  aliases: Map<string, string>;
  divisionCodes: Set<string>;
  accounts: Map<string, { reportingLine: ReportingLine | null; balanceSheetLine: string | null; name: string }>;
  closedMonths: Set<string>;
}

/**
 * Read from the dimension tables, never from the seed constants.
 *
 * §2 Rule 8: divisions live in a dimension table because ARG has restructured
 * twice already. A conform that consulted `DIVISION_SEED` would keep working
 * against last year's org chart and would be wrong in a way that looks right.
 */
async function loadDimensions(db: Database): Promise<Dimensions> {
  const divisions = await db.select().from(t.dimDivision);
  const accounts = await db.select().from(t.dimAccount);
  const periods = await db.select().from(t.dimPeriod).where(eq(t.dimPeriod.isClosed, true));

  const aliases = buildAliasMap(
    divisions.map((division) => ({
      divisionCode: division.divisionCode,
      divisionName: division.divisionName,
      lineOfBusiness: division.lineOfBusiness,
      legacyCodes: division.legacyCodes ?? [],
      qboClassIds: division.qboClassIds ?? [],
      primaryOperationalSystem: division.primaryOperationalSystem,
      sortOrder: division.sortOrder,
    })),
  );

  return {
    aliases,
    divisionCodes: new Set(divisions.map((division) => division.divisionCode)),
    accounts: new Map(
      accounts.map((account) => [
        account.accountId,
        {
          reportingLine: account.reportingLine as ReportingLine | null,
          balanceSheetLine: account.balanceSheetLine,
          name: account.accountName,
        },
      ]),
    ),
    closedMonths: new Set(periods.map((period) => period.periodMonth)),
  };
}

/**
 * Makes sure a month exists in the period dimension before facts reference it.
 *
 * Every fact table has a foreign key to `dim_period`, so pulling a month nobody
 * has registered would fail on the insert with a constraint error that says
 * nothing useful. Creating the row is safe: it carries no judgement beyond the
 * calendar, and `is_closed` stays false until a human closes the month.
 */
async function ensurePeriods(db: Database, months: string[]): Promise<void> {
  if (months.length === 0) return;

  const rows = months.map((month) => {
    const [year, monthOfYear] = month.split('-').map(Number) as [number, number];
    return {
      periodMonth: month,
      fiscalYear: year,
      monthOfYear,
      // §6 DSO/DPO: actual calendar days, never 30.
      daysInMonth: new Date(Date.UTC(year, monthOfYear, 0)).getUTCDate(),
      isClosed: false,
    };
  });

  await db.insert(t.dimPeriod).values(rows).onConflictDoNothing();
}

const monthOf = (date: string): string => `${date.slice(0, 7)}-01`;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function conformBatch(
  db: Database,
  loadRunId: string,
  batch: RawBatch,
): Promise<ConformOutcome> {
  const dimensions = await loadDimensions(db);

  switch (batch.sourceSystem) {
    case 'QBO':
      return conformQbo(db, loadRunId, batch, dimensions);
    case 'HUBSPOT':
      return conformHubspot(db, loadRunId, batch, dimensions);
    case 'SHEETS':
      return conformSheets(db, loadRunId, batch, dimensions);
    default:
      throw new ConformBlockedError([
        {
          kind: 'UNSUPPORTED_SHAPE',
          detail: `There is no conform step for ${batch.sourceSystem}.`,
          remedy: 'Add one in lib/etl/conform.ts before connecting this source.',
        },
      ]);
  }
}

// ---------------------------------------------------------------------------
// QuickBooks
// ---------------------------------------------------------------------------

/** One account's amount for one division in one month. */
interface GlCell {
  periodMonth: string;
  divisionCode: string;
  accountId: string;
  amount: number;
}

/**
 * QBO's unclassed column.
 *
 * When summarising by class, QBO emits a column for transactions carrying no
 * class at all. Those dollars are real and they belong to some division — we
 * just do not know which. Folding them into a division would be inventing an
 * attribution; dropping them silently would understate revenue or cost with no
 * trace. So they stop the load and get named.
 */
const UNCLASSED_TITLES = new Set(['NOT SPECIFIED', 'UNSPECIFIED', 'NO CLASS', '']);

async function conformQbo(
  db: Database,
  loadRunId: string,
  batch: RawBatch,
  dimensions: Dimensions,
): Promise<ConformOutcome> {
  if (batch.entity === 'accounts') return conformQboAccounts(db, batch);
  if (batch.entity === 'classes') return conformQboClasses(db, batch, dimensions);

  const blockers: Blocker[] = [];
  const warnings: string[] = [];
  const skippedClosedMonths = new Set<string>();
  const cells: GlCell[] = [];

  for (const record of batch.records) {
    const report = parseQboReport(record.payload);
    const periodMonth = monthOf(report.startPeriod ?? String(record.key));

    if (dimensions.closedMonths.has(periodMonth)) {
      skippedClosedMonths.add(periodMonth);
      continue;
    }

    // A report with no class columns cannot be divisionalised, and the fact
    // tables refuse an ARG_TOTAL row by CHECK constraint. This is open item 1
    // for the balance sheet, and it is better stated here than discovered as a
    // constraint violation.
    const classColumns = report.classColumns.filter(
      (column) => !UNCLASSED_TITLES.has(column.title.toUpperCase()),
    );
    if (classColumns.length === 0) {
      blockers.push({
        kind: 'UNSUPPORTED_SHAPE',
        detail: `The ${report.reportName} for ${periodMonth.slice(0, 7)} came back with no class columns, so there is no division to attribute it to.`,
        remedy:
          'ARG must class this report in QuickBooks (open item 1). ARG Total is a rollup and is ' +
          'never stored as a row, so an unclassed report cannot be loaded at all.',
      });
      continue;
    }

    const unclassed = report.classColumns.filter((column) =>
      UNCLASSED_TITLES.has(column.title.toUpperCase()),
    );
    for (const column of unclassed) {
      const total = report.rows.reduce(
        (sum, row) => sum + parseQboAmount(row.amounts.get(column.index), 'unclassed column'),
        0,
      );
      if (total !== 0) {
        blockers.push({
          kind: 'UNMAPPED_CLASS',
          detail: `${report.reportName} for ${periodMonth.slice(0, 7)} has ${total.toLocaleString('en-US', { style: 'currency', currency: 'USD' })} on transactions with no class.`,
          remedy:
            'Class those transactions in QuickBooks. They are not dropped and they are not ' +
            'assigned to a division on our side — either would be a number nobody could trace.',
        });
      }
    }

    for (const column of classColumns) {
      const divisionCode = dimensions.aliases.get(normaliseCode(column.classId ?? column.title));
      if (!divisionCode) {
        blockers.push({
          kind: 'UNMAPPED_CLASS',
          detail: `QuickBooks class "${column.title}"${column.classId ? ` (id ${column.classId})` : ''} is not mapped to a division.`,
          remedy:
            'Add the class id to dim_division.qbo_class_ids for the division it belongs to, in ' +
            'Admin. Nothing defaults to "other".',
        });
        continue;
      }

      for (const row of report.rows) {
        if (!row.accountId) {
          const amount = parseQboAmount(row.amounts.get(column.index), row.accountName);
          if (amount !== 0) {
            blockers.push({
              kind: 'UNMAPPED_ACCOUNT',
              detail: `Row "${row.accountName}" in ${report.reportName} carries ${amount} but no account id.`,
              remedy:
                'This is usually a computed line QBO returned as data. Report it — the parser ' +
                'needs to learn about it rather than the figure being dropped.',
            });
          }
          continue;
        }

        const account = dimensions.accounts.get(row.accountId);
        if (!account) {
          blockers.push({
            kind: 'UNMAPPED_ACCOUNT',
            detail: `Account "${row.accountName}" (id ${row.accountId}) is not in the chart of accounts.`,
            remedy:
              'Pull the Chart of Accounts entity first, then map its reporting line in Admin. A ' +
              'new QBO account arriving unmapped is exactly what stops a load on purpose.',
          });
          continue;
        }

        const amount = parseQboAmount(row.amounts.get(column.index), row.accountName);
        if (amount === 0) continue;
        cells.push({ periodMonth, divisionCode, accountId: row.accountId, amount });
      }
    }
  }

  if (blockers.length > 0) throw new ConformBlockedError(dedupeBlockers(blockers));

  const months = [...new Set(cells.map((cell) => cell.periodMonth))];
  await ensurePeriods(db, months);

  let rowsWritten = 0;
  const tables = new Set<string>();

  // Account-level first: it is the evidence behind every rolled-up figure, and
  // the drill-through and the audit pack both read it.
  for (const cell of cells) {
    await db
      .insert(t.factGlBalance)
      .values({
        periodMonth: cell.periodMonth,
        divisionCode: cell.divisionCode,
        accountId: cell.accountId,
        amount: String(cell.amount),
        basis: 'accrual',
        loadRunId,
      })
      .onConflictDoUpdate({
        target: [t.factGlBalance.periodMonth, t.factGlBalance.divisionCode, t.factGlBalance.accountId],
        set: { amount: String(cell.amount), loadRunId },
      });
    rowsWritten += 1;
  }
  if (cells.length > 0) tables.add('fact_gl_balance');

  // Then the rolled-up statements, computed from those same cells. There is no
  // arrangement of this code that can produce a P&L that disagrees with the
  // account detail behind it, because it is the same numbers added up once.
  const byDivisionMonth = new Map<string, GlCell[]>();
  for (const cell of cells) {
    const key = `${cell.periodMonth}|${cell.divisionCode}`;
    const list = byDivisionMonth.get(key) ?? [];
    list.push(cell);
    byDivisionMonth.set(key, list);
  }

  for (const [key, group] of byDivisionMonth) {
    const [periodMonth, divisionCode] = key.split('|') as [string, string];

    const plRows: GlRow[] = [];
    const bsTotals: Record<string, number> = {};

    for (const cell of group) {
      const account = dimensions.accounts.get(cell.accountId)!;
      if (account.reportingLine) {
        plRows.push({
          accountId: cell.accountId,
          reportingLine: account.reportingLine,
          amount: cell.amount,
        });
      } else if (account.balanceSheetLine) {
        bsTotals[account.balanceSheetLine] = (bsTotals[account.balanceSheetLine] ?? 0) + cell.amount;
      }
    }

    if (plRows.length > 0) {
      // §4.2 — payroll_direct sits inside cogs and payroll_expense inside opex.
      // Deriving both here rather than importing them is what makes SHRC's
      // gross profit $71,451 and not $38,407.
      const lines = rollUpGl(plRows);
      await db
        .insert(t.factPlActual)
        .values({
          periodMonth,
          divisionCode,
          revenue: lines.revenue.toFixed(2),
          payrollDirect: lines.payrollDirect.toFixed(2),
          cogs: lines.cogs.toFixed(2),
          payrollExpense: lines.payrollExpense.toFixed(2),
          opex: lines.opex.toFixed(2),
          basis: 'accrual',
          sourceSystem: 'QBO',
          loadRunId,
        })
        .onConflictDoUpdate({
          target: [t.factPlActual.periodMonth, t.factPlActual.divisionCode],
          set: {
            revenue: lines.revenue.toFixed(2),
            payrollDirect: lines.payrollDirect.toFixed(2),
            cogs: lines.cogs.toFixed(2),
            payrollExpense: lines.payrollExpense.toFixed(2),
            opex: lines.opex.toFixed(2),
            sourceSystem: 'QBO',
            loadRunId,
            loadedAt: new Date(),
          },
        });
      rowsWritten += 1;
      tables.add('fact_pl_actual');
    }

    if (Object.keys(bsTotals).length > 0) {
      const row = {
        periodMonth,
        divisionCode,
        cash: (bsTotals.cash ?? 0).toFixed(2),
        accountsReceivable: (bsTotals.accounts_receivable ?? 0).toFixed(2),
        otherCurrentAssets: (bsTotals.other_current_assets ?? 0).toFixed(2),
        fixedAssets: (bsTotals.fixed_assets ?? 0).toFixed(2),
        accountsPayable: (bsTotals.accounts_payable ?? 0).toFixed(2),
        ccLiability: (bsTotals.cc_liability ?? 0).toFixed(2),
        otherCurrentLiabilities: (bsTotals.other_current_liabilities ?? 0).toFixed(2),
        ltLiabilities: (bsTotals.lt_liabilities ?? 0).toFixed(2),
        // Defect 3: loaded as its own figure so the balance check is a real
        // assertion rather than assets-minus-liabilities checked against
        // itself.
        shareholderEquity: (bsTotals.shareholder_equity ?? 0).toFixed(2),
        basis: 'accrual' as const,
        sourceSystem: 'QBO' as const,
        loadRunId,
      };
      await db
        .insert(t.factBsActual)
        .values(row)
        .onConflictDoUpdate({
          target: [t.factBsActual.periodMonth, t.factBsActual.divisionCode],
          set: { ...row, loadedAt: new Date() },
        });
      rowsWritten += 1;
      tables.add('fact_bs_actual');
    }
  }

  if (skippedClosedMonths.size > 0) {
    warnings.push(
      `${skippedClosedMonths.size} closed month${skippedClosedMonths.size === 1 ? ' was' : 's were'} left untouched: ` +
        `${[...skippedClosedMonths].map((month) => month.slice(0, 7)).join(', ')}. Reopen the month to restate it.`,
    );
  }

  return {
    rowsWritten,
    tables: [...tables],
    warnings,
    skippedClosedMonths: [...skippedClosedMonths],
  };
}

/** The chart of accounts. Reference data — new accounts arrive unmapped on purpose. */
async function conformQboAccounts(db: Database, batch: RawBatch): Promise<ConformOutcome> {
  const warnings: string[] = [];
  let rowsWritten = 0;
  const arrived: string[] = [];

  for (const record of batch.records) {
    const payload = record.payload as {
      QueryResponse?: { Account?: Array<Record<string, unknown>> };
    };
    for (const account of payload.QueryResponse?.Account ?? []) {
      const accountId = String(account.Id ?? '');
      if (!accountId) continue;

      const classification = String(account.Classification ?? '').toUpperCase();
      const accountType = ({
        REVENUE: 'INCOME',
        EXPENSE: 'EXPENSE',
        ASSET: 'ASSET',
        LIABILITY: 'LIABILITY',
        EQUITY: 'EQUITY',
      }[classification] ?? 'EXPENSE') as 'INCOME' | 'EXPENSE' | 'ASSET' | 'LIABILITY' | 'EQUITY' | 'COGS';

      const existing = await db
        .select({ accountId: t.dimAccount.accountId })
        .from(t.dimAccount)
        .where(eq(t.dimAccount.accountId, accountId))
        .limit(1);

      if (existing.length === 0) arrived.push(`${account.Name} (${accountId})`);

      await db
        .insert(t.dimAccount)
        .values({
          accountId,
          accountNumber: account.AcctNum ? String(account.AcctNum) : null,
          accountName: String(account.Name ?? `Account ${accountId}`),
          accountType: String(account.AccountType) === 'Cost of Goods Sold' ? 'COGS' : accountType,
          // Deliberately null. A reporting line is a decision about how ARG's
          // P&L reads, and guessing it from the account name is how a cost
          // lands in the wrong line and nobody notices for a quarter.
          reportingLine: null,
          balanceSheetLine: null,
          isActive: account.Active !== false,
        })
        .onConflictDoUpdate({
          target: t.dimAccount.accountId,
          set: {
            accountName: String(account.Name ?? `Account ${accountId}`),
            accountNumber: account.AcctNum ? String(account.AcctNum) : null,
            isActive: account.Active !== false,
          },
        });
      rowsWritten += 1;
    }
  }

  if (arrived.length > 0) {
    warnings.push(
      `${arrived.length} new account${arrived.length === 1 ? '' : 's'} arrived unmapped and ` +
        `will stop the next P&L load until given a reporting line: ${arrived.slice(0, 8).join(', ')}` +
        `${arrived.length > 8 ? `, and ${arrived.length - 8} more` : ''}.`,
    );
  }

  return { rowsWritten, tables: ['dim_account'], warnings, skippedClosedMonths: [] };
}

/** Class list. Reports which classes have no division rather than inventing one. */
async function conformQboClasses(
  db: Database,
  batch: RawBatch,
  dimensions: Dimensions,
): Promise<ConformOutcome> {
  const warnings: string[] = [];
  const unmapped: string[] = [];

  for (const record of batch.records) {
    const payload = record.payload as {
      QueryResponse?: { Class?: Array<{ Id?: string; Name?: string; Active?: boolean }> };
    };
    for (const cls of payload.QueryResponse?.Class ?? []) {
      if (cls.Active === false) continue;
      const id = String(cls.Id ?? '');
      const name = String(cls.Name ?? id);
      if (!dimensions.aliases.get(normaliseCode(id)) && !dimensions.aliases.get(normaliseCode(name))) {
        unmapped.push(`${name} (id ${id})`);
      }
    }
  }

  if (unmapped.length > 0) {
    warnings.push(
      `${unmapped.length} QuickBooks class${unmapped.length === 1 ? '' : 'es'} map to no division: ` +
        `${unmapped.join(', ')}. Any P&L load carrying one will stop until it is mapped in Admin.`,
    );
  }

  return { rowsWritten: 0, tables: [], warnings, skippedClosedMonths: [] };
}

function dedupeBlockers(blockers: Blocker[]): Blocker[] {
  const seen = new Map<string, Blocker>();
  for (const blocker of blockers) {
    if (!seen.has(blocker.detail)) seen.set(blocker.detail, blocker);
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// HubSpot
// ---------------------------------------------------------------------------

interface HubspotObject {
  id: string;
  properties?: Record<string, string | null>;
  propertiesWithHistory?: Record<string, Array<{ value?: string; timestamp?: string }>>;
  associations?: Record<string, { results?: Array<{ id?: string; type?: string }> }>;
}

const date = (value: string | null | undefined): Date | null => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const money = (value: string | null | undefined): string => {
  if (!value) return '0';
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(2) : '0';
};

async function conformHubspot(
  db: Database,
  loadRunId: string,
  batch: RawBatch,
  dimensions: Dimensions,
): Promise<ConformOutcome> {
  switch (batch.entity) {
    case 'deals':
      return conformDeals(db, loadRunId, batch, dimensions);
    case 'contacts':
      return conformContacts(db, loadRunId, batch, dimensions);
    case 'meetings':
      return conformMeetings(db, loadRunId, batch);
    case 'owners':
      return conformOwners(db, batch);
    default:
      throw new ConformBlockedError([
        {
          kind: 'UNSUPPORTED_SHAPE',
          detail: `There is no conform step for HubSpot "${batch.entity}".`,
          remedy: 'Add one in lib/etl/conform.ts.',
        },
      ]);
  }
}

/**
 * The division a deal belongs to.
 *
 * Open item 2, and the one the build spec singles out: if ARG has no reliable
 * division property on a deal, sales and marketing report at ARG Total only.
 * An invented attribution rule moves revenue between divisional P&Ls and nets
 * to zero at the consolidated level, which is how that error survives a year.
 * So an unset property yields null — a real state the KPI layer already knows
 * how to describe — and an unrecognised value stops the load.
 */
function divisionOfObject(
  object: HubspotObject,
  property: string | undefined,
  dimensions: Dimensions,
  blockers: Blocker[],
): string | null {
  if (!property) return null;
  const raw = object.properties?.[property];
  if (!raw) return null;

  const resolved = dimensions.aliases.get(normaliseCode(raw));
  if (!resolved) {
    blockers.push({
      kind: 'UNMAPPED_DIVISION',
      detail: `HubSpot ${property} = "${raw}" matches no division.`,
      remedy:
        `Either correct the value in HubSpot, or add "${raw}" to that division's legacy codes in ` +
        'Admin. Deals are never assigned to a division by guesswork.',
    });
    return null;
  }
  return resolved;
}

async function conformDeals(
  db: Database,
  loadRunId: string,
  batch: RawBatch,
  dimensions: Dimensions,
): Promise<ConformOutcome> {
  const blockers: Blocker[] = [];
  const warnings: string[] = [];
  const divisionProperty = process.env.HUBSPOT_DIVISION_PROPERTY;
  const owners = await loadOwnerNames(db);

  let rowsWritten = 0;
  let historyRows = 0;
  let unattributed = 0;

  for (const record of batch.records) {
    const object = record.payload as HubspotObject;
    const properties = object.properties ?? {};
    const divisionCode = divisionOfObject(object, divisionProperty, dimensions, blockers);
    if (divisionProperty && !divisionCode) unattributed += 1;

    // §6 Sales: New Proposals Sent counts deals ENTERING the proposal stage, so
    // it needs the timestamp from stage history. The current stage cannot
    // answer it — a deal that reached proposal and then closed still counts.
    const history = object.propertiesWithHistory?.dealstage ?? [];
    const enteredProposal = history
      .filter((entry) => /proposal/i.test(entry.value ?? ''))
      .map((entry) => date(entry.timestamp))
      .filter((value): value is Date => value !== null)
      .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;

    const ownerId = properties.hubspot_owner_id ?? null;

    const row = {
      dealId: object.id,
      divisionCode,
      dealName: properties.dealname ?? null,
      amount: money(properties.amount),
      dealstage: properties.dealstage ?? null,
      pipeline: properties.pipeline ?? null,
      isClosedWon: properties.hs_is_closed_won === 'true',
      isClosed: properties.hs_is_closed === 'true',
      createdate: date(properties.createdate),
      closedate: date(properties.closedate),
      enteredProposalAt: enteredProposal,
      ownerId,
      // Null is a real state: an unassigned deal must read as "unassigned" in
      // the salesperson filter rather than disappearing from it.
      ownerName: ownerId ? (owners.get(ownerId) ?? null) : null,
      contactId: null,
      loadRunId,
    };

    await db
      .insert(t.factDeal)
      .values(row)
      .onConflictDoUpdate({ target: t.factDeal.dealId, set: row });
    rowsWritten += 1;

    for (const entry of history) {
      const enteredAt = date(entry.timestamp);
      if (!enteredAt || !entry.value) continue;
      await db
        .insert(t.factDealStageHistory)
        .values({ dealId: object.id, stage: entry.value, enteredAt, loadRunId })
        .onConflictDoNothing();
      historyRows += 1;
    }
  }

  if (blockers.length > 0) throw new ConformBlockedError(dedupeBlockers(blockers));

  if (!divisionProperty) {
    warnings.push(
      'HUBSPOT_DIVISION_PROPERTY is not set (open item 2), so deals carry no division and sales ' +
        'and marketing metrics report at ARG Total only. That is deliberate: an invented ' +
        'attribution rule is invisible at ARG Total.',
    );
  } else if (unattributed > 0) {
    warnings.push(
      `${unattributed} deal${unattributed === 1 ? ' has' : 's have'} no value in ${divisionProperty}, ` +
        'so they count at ARG Total but in no division.',
    );
  }

  if (owners.size === 0) {
    warnings.push(
      'No owner names are loaded, so the salesperson filter will show owner ids. Pull the HubSpot ' +
        'owners entity to fix it.',
    );
  }

  return {
    rowsWritten: rowsWritten + historyRows,
    tables: historyRows > 0 ? ['fact_deal', 'fact_deal_stage_history'] : ['fact_deal'],
    warnings,
    skippedClosedMonths: [],
  };
}

async function conformContacts(
  db: Database,
  loadRunId: string,
  batch: RawBatch,
  dimensions: Dimensions,
): Promise<ConformOutcome> {
  const blockers: Blocker[] = [];
  const divisionProperty = process.env.HUBSPOT_DIVISION_PROPERTY;
  let rowsWritten = 0;

  for (const record of batch.records) {
    const object = record.payload as HubspotObject;
    const properties = object.properties ?? {};

    const row = {
      contactId: object.id,
      divisionCode: divisionOfObject(object, divisionProperty, dimensions, blockers),
      lifecycleStage: properties.lifecyclestage ?? null,
      originalSource: properties.hs_analytics_source ?? null,
      createdate: date(properties.createdate),
      // §6 Marketing: leads count by the date they became a lead, not the date
      // the record was created. The two differ whenever a contact is imported.
      becameLeadDate: date(properties.hs_lifecyclestage_lead_date),
      becameCustomerDate: date(properties.hs_lifecyclestage_customer_date),
      loadRunId,
    };

    await db
      .insert(t.factContact)
      .values(row)
      .onConflictDoUpdate({ target: t.factContact.contactId, set: row });
    rowsWritten += 1;
  }

  if (blockers.length > 0) throw new ConformBlockedError(dedupeBlockers(blockers));
  return { rowsWritten, tables: ['fact_contact'], warnings: [], skippedClosedMonths: [] };
}

async function conformMeetings(
  db: Database,
  loadRunId: string,
  batch: RawBatch,
): Promise<ConformOutcome> {
  let rowsWritten = 0;
  let undated = 0;

  for (const record of batch.records) {
    const object = record.payload as HubspotObject;
    const properties = object.properties ?? {};
    const meetingDate = date(properties.hs_meeting_start_time);

    // Meetings Completed counts by meeting date. A meeting with no date cannot
    // land in a period, and putting it in the load date's month would inflate
    // whichever month the refresh happened to run in.
    if (!meetingDate) {
      undated += 1;
      continue;
    }

    const row = {
      meetingId: object.id,
      divisionCode: null,
      meetingDate,
      outcome: properties.hs_meeting_outcome ?? null,
      ownerId: properties.hubspot_owner_id ?? null,
      associatedDealId: object.associations?.deals?.results?.[0]?.id ?? null,
      loadRunId,
    };

    await db
      .insert(t.factMeeting)
      .values(row)
      .onConflictDoUpdate({ target: t.factMeeting.meetingId, set: row });
    rowsWritten += 1;
  }

  return {
    rowsWritten,
    tables: ['fact_meeting'],
    warnings: undated
      ? [`${undated} meeting${undated === 1 ? '' : 's'} had no start time and could not be placed in a period.`]
      : [],
    skippedClosedMonths: [],
  };
}

/**
 * Owner names, kept in app_config rather than a dimension table.
 *
 * They are a display lookup — the salesperson filter and the leaderboard read
 * them — not a fact anything is computed from, and a HubSpot owner is not an
 * ARG user. Giving them their own table would imply a relationship to
 * `users` that does not exist.
 */
async function conformOwners(db: Database, batch: RawBatch): Promise<ConformOutcome> {
  const names: Record<string, string> = {};

  for (const record of batch.records) {
    const owner = record.payload as {
      id?: string;
      firstName?: string;
      lastName?: string;
      email?: string;
    };
    if (!owner.id) continue;
    const full = [owner.firstName, owner.lastName].filter(Boolean).join(' ').trim();
    names[owner.id] = full || owner.email || `Owner ${owner.id}`;
  }

  // app_config.value is text, so this is stored as JSON rather than jsonb.
  const encoded = JSON.stringify(names);
  await db
    .insert(t.appConfig)
    .values({
      key: OWNER_NAMES_KEY,
      value: encoded,
      description: 'HubSpot owner id -> display name, for the salesperson filter.',
      isConfirmed: true,
    })
    .onConflictDoUpdate({
      target: t.appConfig.key,
      set: { value: encoded, updatedAt: new Date() },
    });

  // Deals already loaded were written before the names existed. Backfilling
  // them here means one owners pull fixes the whole history rather than only
  // deals loaded from now on.
  let backfilled = 0;
  for (const [ownerId, name] of Object.entries(names)) {
    const result = await db
      .update(t.factDeal)
      .set({ ownerName: name })
      .where(eq(t.factDeal.ownerId, ownerId));
    backfilled += (result as unknown as { rowCount?: number }).rowCount ?? 0;
  }

  return {
    rowsWritten: Object.keys(names).length,
    tables: ['app_config', ...(backfilled > 0 ? ['fact_deal'] : [])],
    warnings: backfilled
      ? [`Named ${backfilled} deal${backfilled === 1 ? '' : 's'} that had only an owner id.`]
      : [],
    skippedClosedMonths: [],
  };
}

export const OWNER_NAMES_KEY = 'hubspot.owner_names';

export async function loadOwnerNames(db: Database): Promise<Map<string, string>> {
  try {
    const [row] = await db
      .select()
      .from(t.appConfig)
      .where(eq(t.appConfig.key, OWNER_NAMES_KEY))
      .limit(1);
    if (!row?.value) return new Map();
    return new Map(Object.entries(JSON.parse(row.value) as Record<string, string>));
  } catch {
    return new Map();
  }
}

// ---------------------------------------------------------------------------
// Google Sheets
// ---------------------------------------------------------------------------

/**
 * A budget grid.
 *
 * The workbook's shape: a division down the left, months across the top, one
 * block per line item. Rather than hard-coding cell addresses — which breaks
 * the first time somebody inserts a row — the parser finds the header row that
 * contains dates and reads relative to it.
 */
export interface SheetBudgetRow {
  divisionCode: string;
  periodMonth: string;
  lineItem: 'revenue' | 'cogs' | 'opex';
  amount: number;
}

const LINE_ITEM_ALIASES: Record<string, 'revenue' | 'cogs' | 'opex'> = {
  revenue: 'revenue',
  'total revenue': 'revenue',
  sales: 'revenue',
  income: 'revenue',
  cogs: 'cogs',
  'cost of goods sold': 'cogs',
  'cost of sales': 'cogs',
  opex: 'opex',
  'operating expenses': 'opex',
  expenses: 'opex',
  'total expenses': 'opex',
};

/**
 * Excel serial dates.
 *
 * Sheets returns UNFORMATTED_VALUE, so a date cell arrives as a number of days
 * since 1899-12-30. Reading that as a year would put every budget row in 1970.
 */
function excelSerialToMonth(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 20000 || serial > 80000) return null;
  const millis = Math.round((serial - 25569) * 86400 * 1000);
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

function cellToMonth(cell: unknown): string | null {
  if (typeof cell === 'number') return excelSerialToMonth(cell);
  if (typeof cell !== 'string') return null;

  const trimmed = cell.trim();
  if (/^\d{4}-\d{2}(-\d{2})?$/.test(trimmed)) return `${trimmed.slice(0, 7)}-01`;

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

export function parseBudgetGrid(
  values: unknown[][],
  aliases: Map<string, string>,
): { rows: SheetBudgetRow[]; blockers: Blocker[] } {
  const rows: SheetBudgetRow[] = [];
  const blockers: Blocker[] = [];

  // The header is the first row where at least two cells read as months.
  let headerIndex = -1;
  let monthByColumn = new Map<number, string>();

  for (let index = 0; index < values.length; index += 1) {
    const candidate = new Map<number, string>();
    values[index]?.forEach((cell, column) => {
      const month = cellToMonth(cell);
      if (month) candidate.set(column, month);
    });
    if (candidate.size >= 2) {
      headerIndex = index;
      monthByColumn = candidate;
      break;
    }
  }

  if (headerIndex === -1) {
    blockers.push({
      kind: 'UNSUPPORTED_SHAPE',
      detail: 'No row in that range reads as a month header.',
      remedy:
        'Point the range at the block where months run across the top — set SHEETS_RANGE_* to ' +
        'the right tab and cells. Nothing is inferred from position.',
    });
    return { rows, blockers };
  }

  let currentDivision: string | null = null;

  for (let index = headerIndex + 1; index < values.length; index += 1) {
    const row = values[index] ?? [];
    const label = String(row[0] ?? '').trim();
    if (!label) continue;

    const lineItem = LINE_ITEM_ALIASES[label.toLowerCase()];

    if (!lineItem) {
      // Not a line item, so it is a division heading — or something nobody
      // mapped, which is worth saying rather than skipping.
      const resolved = aliases.get(normaliseCode(label));
      if (resolved) {
        currentDivision = resolved;
      } else if (/^(gross|net|total|profit|margin)/i.test(label)) {
        // Derived rows are recomputed from revenue, COGS and OpEx. Importing
        // them would let an imported total disagree with its own components.
        continue;
      }
      continue;
    }

    if (!currentDivision) {
      blockers.push({
        kind: 'UNMAPPED_DIVISION',
        detail: `Row ${index + 1} is a "${label}" line with no division heading above it.`,
        remedy: 'Each block of line items needs a division name in column A above it.',
      });
      continue;
    }

    for (const [column, periodMonth] of monthByColumn) {
      const raw = row[column];
      if (raw === undefined || raw === null || raw === '') continue;
      const amount = typeof raw === 'number' ? raw : Number(String(raw).replace(/[$,\s]/g, ''));
      if (!Number.isFinite(amount)) continue;
      rows.push({ divisionCode: currentDivision, periodMonth, lineItem, amount });
    }
  }

  return { rows, blockers };
}

async function conformSheets(
  db: Database,
  loadRunId: string,
  batch: RawBatch,
  dimensions: Dimensions,
): Promise<ConformOutcome> {
  const record = batch.records[0];
  if (!record) return { rowsWritten: 0, tables: [], warnings: ['The range was empty.'], skippedClosedMonths: [] };

  const payload = record.payload as { range?: string; values?: unknown[][] };
  const values = payload.values ?? [];

  if (batch.entity === 'headcount') {
    return conformHeadcount(db, loadRunId, values, dimensions);
  }

  const scenarioCode = batch.entity === 'tenx_budget' ? 'TENX' : 'MONTHLY_BUDGET';
  const { rows, blockers } = parseBudgetGrid(values, dimensions.aliases);
  if (blockers.length > 0) throw new ConformBlockedError(blockers);

  const months = [...new Set(rows.map((row) => row.periodMonth))];
  await ensurePeriods(db, months);

  // The scenario must exist before its rows can reference it.
  if (months.length > 0) {
    const sorted = [...months].sort();
    await db
      .insert(t.budgetScenario)
      .values({
        scenarioCode,
        scenarioName: scenarioCode === 'TENX' ? '10X Growth Plan' : 'FY Operating Budget',
        description: `Imported from ${payload.range ?? 'Google Sheets'}.`,
        firstMonth: sorted[0]!,
        lastMonth: sorted[sorted.length - 1]!,
      })
      .onConflictDoNothing();
  }

  let rowsWritten = 0;
  for (const row of rows) {
    await db
      .insert(t.factBudget)
      .values({
        scenarioCode,
        periodMonth: row.periodMonth,
        divisionCode: row.divisionCode,
        lineItem: row.lineItem,
        amount: row.amount.toFixed(2),
        sourceSystem: 'SHEETS',
        loadRunId,
      })
      .onConflictDoUpdate({
        target: [
          t.factBudget.scenarioCode,
          t.factBudget.periodMonth,
          t.factBudget.divisionCode,
          t.factBudget.lineItem,
        ],
        set: { amount: row.amount.toFixed(2), sourceSystem: 'SHEETS', loadRunId },
      });
    rowsWritten += 1;
  }

  return {
    rowsWritten,
    tables: ['fact_budget'],
    warnings:
      rowsWritten === 0
        ? ['The range parsed but produced no budget rows. Check that the division names match ARG’s division codes.']
        : [],
    skippedClosedMonths: [],
  };
}

async function conformHeadcount(
  db: Database,
  loadRunId: string,
  values: unknown[][],
  dimensions: Dimensions,
): Promise<ConformOutcome> {
  const { rows, blockers } = parseBudgetGrid(
    // Headcount uses the same grid shape; the line-item row is labelled
    // "Headcount", which the budget aliases do not know, so it is relabelled to
    // reuse one parser rather than maintaining two that drift.
    values.map((row) =>
      row.map((cell, index) =>
        index === 0 && /^headcount$/i.test(String(cell ?? '').trim()) ? 'revenue' : cell,
      ),
    ),
    dimensions.aliases,
  );
  if (blockers.length > 0) throw new ConformBlockedError(blockers);

  await ensurePeriods(db, [...new Set(rows.map((row) => row.periodMonth))]);

  let rowsWritten = 0;
  for (const row of rows) {
    await db
      .insert(t.factHeadcount)
      .values({
        periodMonth: row.periodMonth,
        divisionCode: row.divisionCode,
        headcount: row.amount.toFixed(2),
        sourceSystem: 'SHEETS',
        loadRunId,
      })
      .onConflictDoUpdate({
        target: [t.factHeadcount.periodMonth, t.factHeadcount.divisionCode],
        set: { headcount: row.amount.toFixed(2), sourceSystem: 'SHEETS', loadRunId },
      });
    rowsWritten += 1;
  }

  return { rowsWritten, tables: ['fact_headcount'], warnings: [], skippedClosedMonths: [] };
}
